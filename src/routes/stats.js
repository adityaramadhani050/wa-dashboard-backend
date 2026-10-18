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
// - Lead Baru / Lead Lama / Total Lead, Aktif, Resolved, Prospek, Deal:
//   lihat blok "Lead periode" di dalam loop. Waktu resolve dari
//   kolom resolved_at, waktu tag dari conversation_tags.created_at + riwayat
//   conversation_tag_events (fallback updated_at bila belum dimigrasi).
// - Konversi      : Lead -> Prospek -> Deal.
// - Respons       : per chat, waktu dari pesan customer pertama dalam periode
//                   sampai balasan agent pertama, dihitung dalam jam kerja bila
//                   Jam Kerja aktif. Pesan bot tidak dihitung balasan.
// ─────────────────────────────────────────────────────────────────────────────

const TZ = 7 * 3600 * 1000;
const DAY = 86400000;
const KPI_MINUTES = 5;
const REGIONS = ['barat', 'timur'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const FAIL_RE = /fail|gagal|batal|lost|cancel/i;
const NONCLIENT_RE = /non[\s_-]*client/i;
const STAGES = [
  // Tag "Prospek" (dulu "Penawaran"; tag Survey lama ikut dianggap Prospek)
  { key: 'prospek', re: /prospek|penawaran|quote|quotation|surv/i },
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

  // Tag yang menempel sekarang (+ waktu pasang bila kolom created_at sudah ada)
  let ctRows = [];
  let tagTimes = true;
  let tagHistory = false;
  let tagEvents = [];
  if (relevantTagIds.length) {
    const build = (cols) => supabase.from('conversation_tags').select(cols)
      .in('tag_id', relevantTagIds)
      .order('conversation_id', { ascending: true })
      .order('tag_id', { ascending: true });
    let r = await fetchAll(() => build('conversation_id, tag_id, created_at'));
    if (r.error) { tagTimes = false; r = await fetchAll(() => build('conversation_id, tag_id')); }
    if (r.error) throw r.error;
    ctRows = r.data;

    // Riwayat pasang/lepas tag (tabel conversation_tag_events, opsional): tag
    // yang sudah dilepas (mis. Prospek diganti Deal/Fail) tetap terhitung.
    const ev = await fetchAll(() => supabase.from('conversation_tag_events')
      .select('id, conversation_id, tag_id, action, created_at')
      .in('tag_id', relevantTagIds.map(String))
      .order('id', { ascending: true }));
    if (!ev.error) { tagHistory = true; tagEvents = ev.data; }
  }
  const nonClient = new Set();
  const stageEvents = {}; // conv_id -> [{ key, at }]
  const pushStage = (convId, tagId, at) => {
    const key = tagStage[tagId]; // kunci objek = String(id), cocok untuk id angka maupun teks
    if (!key || !Number.isFinite(at)) return;
    (stageEvents[convId] = stageEvents[convId] || []).push({ key, at });
  };
  for (const r of ctRows) {
    if (nonClientTagIds.has(r.tag_id)) { nonClient.add(r.conversation_id); continue; }
    pushStage(r.conversation_id, r.tag_id, tsOf(r.created_at) || tsOf(convById.get(r.conversation_id)?.updated_at));
  }
  // Tag yang dipasang lalu dilepas < 1 jam dianggap salah pasang -> diabaikan.
  const removedAt = {};
  for (const e of tagEvents) {
    if (e.action === 'remove') (removedAt[`${e.conversation_id}|${e.tag_id}`] ||= []).push(tsOf(e.created_at));
  }
  for (const e of tagEvents) {
    if (e.action !== 'add') continue;
    const at = tsOf(e.created_at);
    const removes = removedAt[`${e.conversation_id}|${e.tag_id}`] || [];
    if (removes.some((rm) => rm >= at && rm - at < 3600000)) continue;
    pushStage(e.conversation_id, e.tag_id, at);
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

  // Akhir periode (batas waktu tag): hari ini -> saat ini.
  const nowMs = Date.now();
  const live = toMs > nowMs;
  const endMs = Math.min(toMs, nowMs);

  // Baris agent (hanya role agent; filter regional = regional agent)
  const agentName = {};
  agentsList.forEach((a) => { agentName[a.id] = a.name; });
  const LEAD_KEYS = ['new_contacts', 'old_chats', 'total_leads', 'active', 'resolved', 'awaiting',
    'prospek', 'deal', 'fail'];
  const zeroLead = () => Object.fromEntries(LEAD_KEYS.map((k) => [k, 0]));
  const rows = {};
  for (const a of agentsList) {
    if (a.role === 'admin') continue;
    if (region && a.region !== region) continue;
    rows[a.id] = {
      id: a.id, name: a.name, email: a.email,
      ...zeroLead(),
      replies: 0, kpi_met: 0, unreplied: 0, _times: [],
    };
  }

  // Grafik harian
  const days = {};
  for (let d = fromMs; d < toMs; d += DAY) {
    const key = wibKey(d);
    days[key] = { date: key, messages: 0, incoming: 0, outgoing: 0, new_contacts: 0, resolved_chats: 0 };
  }

  const summary = {
    from: fromStr, to: toStr, region, live,
    ...zeroLead(),
    new_assigned: 0, new_unassigned: 0, total_contacts: 0,
  };
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
    const status = c.status || 'open';
    const isActiveNow = status === 'open' || status === 'in_progress';
    const add = (k) => { summary[k]++; if (row) row[k]++; };

    if (!seenContacts.has(contactKey)) { seenContacts.add(contactKey); if (!nc) summary.total_contacts++; }

    // ── Lead periode ──────────────────────────────────────────────────────
    // Lead Baru : kontak yang pertama kali chat dalam periode (dihitung sekali).
    // Lead Lama : kontak sebelum periode yang DIHUBUNGI AGENT dalam periode
    //             (ada pesan agent, bukan bot) dan belum Deal sebelum periode.
    // Total Lead = Lead Baru + Lead Lama. Dari Total Lead:
    // - Aktif / Resolved : hari ini = status saat ini; periode lampau = sudah/belum
    //   di-resolve sejak periode itu (Aktif + Resolved = Total Lead).
    // - Prospek : sudah diberi tag Prospek sampai akhir periode, atau langsung Deal.
    // - Deal/Fail : tag dipasang antara awal dan akhir periode.
    if (!nc) {
      const evs = stageEvents[c.id] || [];
      const first = (key, min = -Infinity) =>
        evs.reduce((m, e) => (e.key === key && e.at >= min && e.at < m ? e.at : m), Infinity);
      let kind = null;
      if (inRange(created) && !seenLeadContacts.has(contactKey)) kind = 'new_contacts';
      else if (!(created >= fromMs) && !(first('deal') < fromMs)
        && convMsgs.some((m) => m.from_me && !m.sent_by_bot && inRange(tsOf(m.timestamp)))) kind = 'old_chats';

      if (kind) {
        if (kind === 'new_contacts') {
          seenLeadContacts.add(contactKey);
          if (c.assigned_to) summary.new_assigned++; else summary.new_unassigned++;
          days[wibKey(created)].new_contacts++;
        }
        add(kind);
        add('total_leads');

        // Hari ini: status saat ini. Periode lampau: Resolved bila chat sudah
        // di-resolve setelah aktivitas terakhirnya di periode itu, walau kini aktif
        // lagi karena aktivitas baru (aktivitas baru itu masuk periode berikutnya).
        let resolved = !isActiveNow;
        if (!live && isActiveNow) {
          const lastAct = convMsgs.reduce((m, x) => {
            const t = tsOf(x.timestamp);
            return inRange(t) && t > m ? t : m;
          }, Number.isFinite(created) && inRange(created) ? created : fromMs);
          // Selain resolved_at (hanya resolve TERAKHIR, kosong untuk resolve sebelum
          // migrasi), jeda >= 24 jam tanpa pesan setelah aktivitas itu berarti chat
          // sudah ditutup auto-resolve lalu dibuka lagi oleh aktivitas baru.
          let closedByGap = false;
          let prev = lastAct;
          for (const x of convMsgs) {
            const t = tsOf(x.timestamp);
            if (t <= lastAct) continue;
            if (t - prev >= DAY) { closedByGap = true; break; }
            prev = t;
          }
          // Pesan diambil sampai 3 hari setelah periode: sunyi >= 24 jam di ujungnya juga berarti tertutup
          if (!closedByGap && Math.min(toMs + 3 * DAY, nowMs) - prev >= DAY) closedByGap = true;
          resolved = closedByGap || tsOf(c.resolved_at) >= lastAct;
        }
        add(resolved ? 'resolved' : 'active');
        if (live && isActiveNow && c.last_from_me === false) add('awaiting');

        const deal = first('deal', fromMs) <= endMs;
        if (deal) add('deal');
        if (first('prospek') <= endMs || deal) add('prospek');
        if (first('fail', fromMs) <= endMs) add('fail');
      }
    }

    // Resolved per hari (grafik, semua chat)
    if (!nc && status === 'resolved') {
      const at = tsOf(c.resolved_at) || tsOf(c.updated_at);
      if (inRange(at)) days[wibKey(at)].resolved_chats++;
    }

    // Respons agent: per CHAT, balasan pertama atas pesan customer pertama
    // (sesi tunggu pertama) yang dimulai dalam periode.
    if (!nc) {
      const key = c.assigned_to || 'unassigned';
      const s = waitSessions(convMsgs).find((x) => inRange(x.start));
      if (s) {
        const ka = (kpiAgents[key] = kpiAgents[key] || { total: 0, met: 0, unreplied: 0 });
        if (s.end == null) {
          // Belum dibalas sama sekali; hanya dihitung bila chat masih aktif
          if (isActiveNow) { unreplied++; ka.unreplied++; if (row) row.unreplied++; }
        } else {
          const mins = workMinutes(s.from, s.end, wh);
          const ok = mins <= KPI_MINUTES;
          kpiTotal++; ka.total++;
          if (ok) { kpiMet++; ka.met++; }
          if (row) { row.replies++; if (ok) row.kpi_met++; row._times.push(mins); }
        }
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
    lead: a.total_leads,
    total: a.total_leads,
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
      { stage: 'Total Lead', count: summary.total_leads },
      { stage: 'Prospek', count: summary.prospek },
      { stage: 'Deal', count: summary.deal },
    ],
    fail: summary.fail,
    conversion: { lead: summary.total_leads, prospek: summary.prospek, deal: summary.deal },
  };
  summary.tag_times = tagTimes;
  summary.tag_history = tagHistory;

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

// KPI respons: % chat yang balasan pertamanya <= 5 menit
router.get('/response-kpi', handle('response-kpi', (a) => a.kpi));

// Funnel: Total Lead -> Prospek -> Deal (+ Fail)
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
