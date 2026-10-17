import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Semua angka Analytics dihitung dari SATU fungsi (buildAnalytics) supaya kartu,
// tabel agent, KPI respons, funnel, dan grafik harian saling cocok.
//
// Aturan umum:
// - Periode = hari WIB (UTC+7) from..to inklusif.
// - Chat grup WhatsApp tidak dihitung. Chat bertag Non-Client tidak dihitung
//   sebagai lead / resolved / respons (bukan calon customer).
// - Filter regional = regional chat (atau regional kontaknya). Tabel agent hanya
//   menampilkan agent di regional tersebut.
//
// Definisi:
// - Lead Baru     : kontak yang PERTAMA KALI chat dalam periode.
// - Chat Lama     : chat customer lama (kontak dibuat sebelum periode) yang ada
//                   pesan agent/customer dalam periode (mis. follow-up).
// - Aktif         : chat berstatus Open/Aktif SAAT INI (tidak tergantung periode).
// - Resolved      : chat yang di-resolve dalam periode (kolom resolved_at;
//                   fallback updated_at bila kolom belum dimigrasi).
// - Penawaran/Survey/Deal/Fail : tag ditambahkan dalam periode
//                   (conversation_tags.created_at; fallback updated_at chat).
// - Respons       : tiap pesan customer yang menunggu balasan (sesi) dalam
//                   periode -> waktu sampai agent membalas, dihitung dalam jam
//                   kerja bila Jam Kerja aktif. Pesan bot tidak dihitung balasan.
// ─────────────────────────────────────────────────────────────────────────────

const TZ = 7 * 3600 * 1000;
const DAY = 86400000;
const KPI_MINUTES = 5;
const REGIONS = ['barat', 'timur'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const FAIL_RE = /fail|gagal|batal|lost|cancel/i;
const NONCLIENT_RE = /non[\s_-]*client/i;
const STAGES = [
  { key: 'penawaran', re: /penawaran|quote|quotation/i },
  { key: 'survey', re: /surv/i },
  { key: 'deal', re: /\bdeal\b|closing|closed|menang|berhasil|\bwon\b/i, not: /fail|gagal|batal|lost|cancel|tidak|non/i },
  { key: 'fail', re: FAIL_RE },
];

// Ambil semua baris secara bertahap. Supabase membatasi 1000 baris per query,
// jadi tanpa ini statistik rentang panjang (mis. 30 hari) terpotong diam-diam.
// `build` harus mengembalikan query BARU yang sudah berurutan (order) tiap dipanggil.
async function fetchAll(build) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) return { data: null, error };
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { data: all, error: null };
}

// Coba beberapa daftar kolom berurutan (kolom hasil migrasi bersifat opsional).
async function fetchAllCols(colsList, build) {
  let lastErr;
  for (const cols of colsList) {
    const r = await fetchAll(() => build(cols));
    if (!r.error) return r.data;
    lastErr = r.error;
  }
  throw lastErr;
}

const wibKey = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
const tsOf = (iso) => (iso ? new Date(iso).getTime() : NaN);

// Rentang hari WIB [fromMs, toMs) dari ?from&to (YYYY-MM-DD). Default 30 hari terakhir.
function parseRange(q) {
  const toStr = DATE_RE.test(q.to || '') ? q.to : wibKey(Date.now());
  let fromStr = DATE_RE.test(q.from || '') ? q.from : wibKey(Date.parse(`${toStr}T00:00:00+07:00`) - 29 * DAY);
  if (fromStr > toStr) fromStr = toStr;
  return {
    fromStr, toStr,
    fromMs: Date.parse(`${fromStr}T00:00:00+07:00`),
    toMs: Date.parse(`${toStr}T00:00:00+07:00`) + DAY,
  };
}

// Jam kerja aktif -> { days|null, start, end } (menit sejak 00:00 WIB); nonaktif -> null.
async function getWorkHours() {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'work_hours').maybeSingle();
    const v = data?.value ? JSON.parse(data.value) : null;
    if (!v?.enabled) return null;
    const toMin = (s, def) => {
      const [h, m] = String(s || def).split(':').map((x) => parseInt(x, 10));
      return Number.isNaN(h) ? toMin(def, def) : h * 60 + (m || 0);
    };
    const start = toMin(v.start, '08:00');
    const end = toMin(v.end, '17:00');
    if (end <= start) return null;
    return { days: Array.isArray(v.days) && v.days.length ? v.days : null, start, end };
  } catch {
    return null;
  }
}

// Menit antara a..b. Bila jam kerja aktif, hanya menit di dalam jam & hari kerja
// yang dihitung (pesan jam 22.00 dibalas 08.03 = 3 menit).
export function workMinutes(aMs, bMs, wh) {
  if (!(bMs > aMs)) return 0;
  if (!wh) return (bMs - aMs) / 60000;
  let total = 0;
  const first = Math.floor((aMs + TZ) / DAY) * DAY - TZ;
  for (let d = first, i = 0; d < bMs && i < 400; d += DAY, i++) {
    if (wh.days && !wh.days.includes(new Date(d + TZ).getUTCDay())) continue;
    const s = Math.max(aMs, d + wh.start * 60000);
    const e = Math.min(bMs, d + wh.end * 60000);
    if (e > s) total += (e - s) / 60000;
  }
  return total;
}

// Sesi tunggu dalam satu percakapan (pesan urut waktu): dimulai pesan customer
// pertama setelah balasan terakhir, selesai saat agent (bukan bot) membalas.
// Bila bot lokasi sempat membalas, hitungan dimulai dari pesan bot terakhir
// (≈ saat chat di-assign) agar tanya-jawab dengan bot tidak dibebankan ke agent.
export function waitSessions(msgs) {
  const out = [];
  let start = null, bot = null;
  for (const m of msgs) {
    const t = tsOf(m.timestamp);
    if (!m.from_me) {
      if (start == null) { start = t; bot = null; }
    } else if (m.sent_by_bot) {
      if (start != null) bot = t;
    } else if (start != null) {
      out.push({ start, from: bot ?? start, end: t });
      start = null; bot = null;
    }
  }
  if (start != null) out.push({ start, from: bot ?? start, end: null });
  return out;
}

async function fetchAgents() {
  for (const cols of ['id, name, email, role, region', 'id, name, email, role']) {
    const r = await supabase.from('agents').select(cols);
    if (!r.error) return r.data || [];
  }
  return [];
}

export async function buildAnalytics({ fromStr, toStr, fromMs, toMs }, region) {
  const inRange = (ms) => ms >= fromMs && ms < toMs;

  const [agentsList, tagsRes, convs, wh] = await Promise.all([
    fetchAgents(),
    supabase.from('tags').select('id, name'),
    fetchAllCols([
      'id, contact_id, assigned_to, status, region, wa_jid, updated_at, resolved_at, last_from_me, contact:contacts (created_at, region)',
      'id, contact_id, assigned_to, status, region, wa_jid, updated_at, last_from_me, contact:contacts (created_at, region)',
      'id, contact_id, assigned_to, status, region, wa_jid, updated_at, contact:contacts (created_at, region)',
      'id, contact_id, assigned_to, status, wa_jid, updated_at, contact:contacts (created_at)',
    ], (cols) => supabase.from('conversations').select(cols).order('id', { ascending: true })),
    getWorkHours(),
  ]);
  const tags = tagsRes.data || [];

  // Tag tahap + Non-Client
  const tagStage = {}; // tag_id -> key
  const nonClientTagIds = new Set();
  for (const t of tags) {
    const name = t.name || '';
    if (NONCLIENT_RE.test(name)) { nonClientTagIds.add(t.id); continue; }
    const st = STAGES.find((s) => s.re.test(name) && !(s.not && s.not.test(name)));
    if (st) tagStage[t.id] = st.key;
  }
  const relevantTagIds = tags.filter((t) => tagStage[t.id] || nonClientTagIds.has(t.id)).map((t) => t.id);
  const convById = new Map(convs.map((c) => [c.id, c]));

  let ctRows = [];
  if (relevantTagIds.length) {
    ctRows = await fetchAllCols(['conversation_id, tag_id, created_at', 'conversation_id, tag_id'],
      (cols) => supabase.from('conversation_tags').select(cols)
        .in('tag_id', relevantTagIds)
        .order('conversation_id', { ascending: true })
        .order('tag_id', { ascending: true }));
  }
  const nonClient = new Set();
  const stageEvents = {}; // conv_id -> [{ key, at }]
  for (const r of ctRows) {
    if (nonClientTagIds.has(r.tag_id)) { nonClient.add(r.conversation_id); continue; }
    const key = tagStage[r.tag_id];
    if (!key) continue;
    const at = tsOf(r.created_at) || tsOf(convById.get(r.conversation_id)?.updated_at);
    (stageEvents[r.conversation_id] = stageEvents[r.conversation_id] || []).push({ key, at });
  }

  // Pesan sejak 3 hari sebelum periode (agar sesi tunggu yang dimulai sebelum
  // periode dikenali) sampai 3 hari setelahnya (balasan yang menyeberang hari).
  const msgs = await fetchAllCols(
    ['conversation_id, from_me, timestamp, sent_by_bot', 'conversation_id, from_me, timestamp'],
    (cols) => supabase.from('messages').select(cols)
      .gte('timestamp', new Date(fromMs - 3 * DAY).toISOString())
      .lt('timestamp', new Date(toMs + 3 * DAY).toISOString())
      .order('timestamp', { ascending: true })
      .order('id', { ascending: true }));
  const msgsByConv = {};
  for (const m of msgs) (msgsByConv[m.conversation_id] = msgsByConv[m.conversation_id] || []).push(m);

  // Baris agent (hanya role agent; filter regional = regional agent)
  const agentName = {};
  agentsList.forEach((a) => { agentName[a.id] = a.name; });
  const rows = {};
  for (const a of agentsList) {
    if (a.role === 'admin') continue;
    if (region && a.region !== region) continue;
    rows[a.id] = {
      id: a.id, name: a.name, email: a.email,
      new_contacts: 0, old_chats: 0,
      open: 0, in_progress: 0, awaiting: 0,
      resolved: 0, penawaran: 0, survey: 0, deal: 0, fail: 0,
      replies: 0, kpi_met: 0, unreplied: 0, _times: [],
    };
  }

  // Grafik harian
  const days = {};
  for (let d = fromMs; d < toMs; d += DAY) {
    const key = wibKey(d);
    days[key] = { date: key, messages: 0, incoming: 0, outgoing: 0, new_contacts: 0, resolved_chats: 0, deals: 0 };
  }

  const summary = {
    from: fromStr, to: toStr, region,
    new_contacts: 0, new_assigned: 0, new_unassigned: 0,
    old_chats: 0,
    active: 0, awaiting: 0, active_unassigned: 0,
    resolved: 0, total_contacts: 0,
  };
  const stageSets = { penawaran: new Set(), survey: new Set(), deal: new Set(), fail: new Set() };
  const kpiAgents = {}; // agentId | 'unassigned' -> { total, met, unreplied }
  let kpiTotal = 0, kpiMet = 0, unreplied = 0;
  const seenContacts = new Set();
  const seenLeadContacts = new Set();

  for (const c of convs) {
    if ((c.wa_jid || '').endsWith('@g.us')) continue; // grup
    if (region && (c.region || c.contact?.region) !== region) continue;
    const nc = nonClient.has(c.id);
    const row = rows[c.assigned_to];
    const convMsgs = msgsByConv[c.id] || [];
    const created = tsOf(c.contact?.created_at);
    const contactKey = c.contact_id || `conv:${c.id}`;

    if (!seenContacts.has(contactKey)) { seenContacts.add(contactKey); if (!nc) summary.total_contacts++; }

    // Lead baru (satu kontak dihitung sekali)
    const isNewLead = !nc && inRange(created) && !seenLeadContacts.has(contactKey);
    if (isNewLead) {
      seenLeadContacts.add(contactKey);
      summary.new_contacts++;
      if (c.assigned_to) summary.new_assigned++; else summary.new_unassigned++;
      days[wibKey(created)].new_contacts++;
      if (row) row.new_contacts++;
    }

    // Chat lama yang aktif dalam periode
    if (!nc && !(created >= fromMs) && convMsgs.some((m) => !m.sent_by_bot && inRange(tsOf(m.timestamp)))) {
      summary.old_chats++;
      if (row) row.old_chats++;
    }

    // Aktif saat ini
    const status = c.status || 'open';
    const isActive = status === 'open' || status === 'in_progress';
    if (isActive) {
      if (c.assigned_to) {
        summary.active++;
        if (c.last_from_me === false) summary.awaiting++;
      } else summary.active_unassigned++;
      if (row) {
        row[status]++;
        if (c.last_from_me === false) row.awaiting++;
      }
    }

    // Resolved dalam periode
    if (!nc && status === 'resolved') {
      const at = tsOf(c.resolved_at) || tsOf(c.updated_at);
      if (inRange(at)) {
        summary.resolved++;
        days[wibKey(at)].resolved_chats++;
        if (row) row.resolved++;
      }
    }

    // Tag tahap dalam periode (satu chat dihitung sekali per tahap)
    if (!nc) {
      const done = new Set();
      for (const ev of stageEvents[c.id] || []) {
        if (!inRange(ev.at) || done.has(ev.key)) continue;
        done.add(ev.key);
        stageSets[ev.key].add(c.id);
        if (row) row[ev.key]++;
        if (ev.key === 'deal') days[wibKey(ev.at)].deals++;
      }
    }

    // Respons agent
    if (!nc) {
      const key = c.assigned_to || 'unassigned';
      for (const s of waitSessions(convMsgs)) {
        if (!inRange(s.start)) continue;
        const ka = (kpiAgents[key] = kpiAgents[key] || { total: 0, met: 0, unreplied: 0 });
        if (s.end == null) {
          // Hanya chat yang masih aktif = benar-benar menunggu balasan
          if (isActive) { unreplied++; ka.unreplied++; if (row) row.unreplied++; }
          continue;
        }
        const mins = workMinutes(s.from, s.end, wh);
        const ok = mins <= KPI_MINUTES;
        kpiTotal++; ka.total++;
        if (ok) { kpiMet++; ka.met++; }
        if (row) { row.replies++; if (ok) row.kpi_met++; row._times.push(mins); }
      }
    }

    // Volume pesan (grafik)
    for (const m of convMsgs) {
      const t = tsOf(m.timestamp);
      if (!inRange(t)) continue;
      const d = days[wibKey(t)];
      d.messages++;
      if (m.from_me) d.outgoing++; else d.incoming++;
    }
  }

  const agents = Object.values(rows).map(({ _times, ...a }) => ({
    ...a,
    lead: a.new_contacts,
    total: a.new_contacts + a.old_chats,
    avgResponse: _times.length ? Math.round(_times.reduce((s, t) => s + t, 0) / _times.length) : null,
  }));

  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const kpi = {
    kpiMinutes: KPI_MINUTES,
    workHours: !!wh,
    total: kpiTotal,
    met: kpiMet,
    percent: pct(kpiMet, kpiTotal),
    unreplied,
    agents: Object.entries(kpiAgents)
      .filter(([, v]) => v.total > 0)
      .map(([key, v]) => ({
        agent_id: key === 'unassigned' ? null : key,
        name: key === 'unassigned' ? 'Belum di-assign' : (agentName[key] || 'Agent'),
        total: v.total, met: v.met, unreplied: v.unreplied,
        percent: pct(v.met, v.total),
      }))
      .sort((a, b) => b.total - a.total),
  };

  const funnel = {
    stages: [
      { stage: 'Lead', count: summary.new_contacts },
      { stage: 'Penawaran', count: stageSets.penawaran.size },
      { stage: 'Survey', count: stageSets.survey.size },
      { stage: 'Deal', count: stageSets.deal.size },
    ],
    fail: stageSets.fail.size,
  };
  summary.deal = stageSets.deal.size;

  return { summary, agents, kpi, funnel, daily: Object.values(days) };
}

// Cache singkat: halaman Analytics memanggil beberapa endpoint sekaligus dengan
// parameter sama -> dihitung sekali.
const cache = new Map();
function getAnalytics(query) {
  const range = parseRange(query);
  const region = REGIONS.includes(query.region) ? query.region : null;
  const key = `${range.fromStr}|${range.toStr}|${region || ''}`;
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > 20000) cache.delete(k);
  const hit = cache.get(key);
  if (hit) return hit.promise;
  const promise = buildAnalytics(range, region);
  cache.set(key, { at: now, promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

const handle = (label, pick) => async (req, res) => {
  try {
    res.json(pick(await getAnalytics(req.query), req));
  } catch (err) {
    console.error(`GET /stats/${label} error:`, err);
    res.status(500).json({ error: err.message });
  }
};

// Ringkasan untuk kartu Analytics
router.get('/summary', handle('summary', (a) => a.summary));

// Statistik harian (WIB). Data global juga disimpan ke tabel daily_stats.
router.get('/daily', handle('daily', (a, req) => {
  if (!REGIONS.includes(req.query.region)) {
    supabase.from('daily_stats')
      .upsert(a.daily.map((d) => ({
        date: d.date, total_messages: d.messages, new_contacts: d.new_contacts, resolved_chats: d.resolved_chats,
      })), { onConflict: 'date' })
      .then(({ error }) => { if (error) console.warn('daily_stats upsert warn:', error.message); }, () => {});
  }
  return a.daily;
}));

// Performa per agent dalam periode
router.get('/agents', handle('agents', (a) => a.agents));

// KPI respons: % pesan customer yang dibalas agent <= 5 menit
router.get('/response-kpi', handle('response-kpi', (a) => a.kpi));

// Funnel: Lead baru -> Penawaran -> Survey -> Deal (+ Fail), tag dalam periode
router.get('/funnel', handle('funnel', (a) => a.funnel));

// Total kontak & kontak baru hari ini (WIB)
router.get('/contacts', async (req, res) => {
  try {
    const todayStart = new Date(`${wibKey(Date.now())}T00:00:00+07:00`).toISOString();
    const region = REGIONS.includes(req.query.region) ? req.query.region : null;
    const base = () => {
      const q = supabase.from('contacts').select('*', { count: 'exact', head: true });
      return region ? q.eq('region', region) : q;
    };
    const [{ count: total, error: e1 }, { count: newToday, error: e2 }] = await Promise.all([
      base(),
      base().gte('created_at', todayStart),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    res.json({ total: total || 0, newToday: newToday || 0 });
  } catch (err) {
    // Filter regional tapi kolom belum dimigrasi -> jangan tampilkan angka global
    if (REGIONS.includes(req.query.region)) return res.json({ total: 0, newToday: 0 });
    res.status(500).json({ error: err.message });
  }
});

export default router;
