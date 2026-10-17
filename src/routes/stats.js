import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

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

const REGIONS = ['barat', 'timur'];

// Himpunan id percakapan milik regional tertentu (regional chat, atau regional
// kontaknya). null = tanpa filter regional.
async function regionConvSet(region) {
  if (!REGIONS.includes(region)) return null;
  const { data, error } = await fetchAll(() => supabase
    .from('conversations').select('id, region, contact:contacts (region)').order('id', { ascending: true }));
  if (error) return new Set(); // kolom regional belum dimigrasi
  return new Set(data.filter((c) => (c.region || c.contact?.region) === region).map((c) => c.id));
}

// Pesan per percakapan untuk menghitung waktu respons (urut waktu, per batch).
// Kolom sent_by_bot (migrasi regional) opsional -> fallback bila belum ada.
async function fetchMsgsByConv(convIds) {
  const byConv = {};
  for (let i = 0; i < convIds.length; i += 100) {
    const batch = convIds.slice(i, i + 100);
    // 100 percakapan bisa > 1000 pesan -> ambil bertahap agar KPI tidak terpotong
    const run = (cols) => fetchAll(() => supabase.from('messages').select(cols)
      .in('conversation_id', batch)
      .order('timestamp', { ascending: true })
      .order('id', { ascending: true }));
    let { data, error } = await run('id, conversation_id, from_me, timestamp, sent_by_bot');
    if (error) ({ data } = await run('id, conversation_id, from_me, timestamp'));
    (data || []).forEach((m) => { (byConv[m.conversation_id] = byConv[m.conversation_id] || []).push(m); });
  }
  return byConv;
}

// Waktu respons agent (menit) dalam satu percakapan, atau null bila belum dibalas.
// Pesan bot bukan balasan agent. Waktu tanya-jawab dengan bot lokasi tidak
// dibebankan ke agent: hitungan dimulai dari pesan bot terakhir sebelum balasan
// agent pertama (≈ saat chat di-assign). Tanpa bot -> sejak pesan pertama customer.
function agentResponseMinutes(msgs) {
  const firstIn = msgs.find((m) => !m.from_me);
  if (!firstIn) return null;
  const firstOut = msgs.find((m) => m.from_me && !m.sent_by_bot && m.timestamp > firstIn.timestamp);
  if (!firstOut) return null;
  const botBefore = msgs.filter((m) => m.sent_by_bot && m.timestamp > firstIn.timestamp && m.timestamp < firstOut.timestamp);
  const start = botBefore.length ? botBefore[botBefore.length - 1].timestamp : firstIn.timestamp;
  return (new Date(firstOut.timestamp) - new Date(start)) / 60000;
}

// Map contact_id -> agent yang di-assign, untuk kontak yang dibuat dalam rentang
// hari WIB fromStr..toStr (default 30 hari terakhir). Kontak tanpa percakapan
// ter-assign tidak masuk map.
async function newContactAssignments(fromStr, toStr, region) {
  const TZ = 7 * 3600 * 1000;
  const to = toStr || new Date(Date.now() + TZ).toISOString().slice(0, 10);
  const from = fromStr || new Date(new Date(to + 'T00:00:00Z').getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const { data: contacts, error } = await fetchAll(() => supabase
    .from('contacts')
    .select(region ? 'id, region' : 'id')
    .gte('created_at', new Date(from + 'T00:00:00+07:00').toISOString())
    .lte('created_at', new Date(to + 'T23:59:59+07:00').toISOString())
    .order('id', { ascending: true }));
  const map = new Map();
  if (error || !contacts?.length) return map;
  const ids = contacts.filter((c) => !region || c.region === region).map((c) => c.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { data: convs } = await supabase
      .from('conversations')
      .select('contact_id, assigned_to')
      .in('contact_id', ids.slice(i, i + 100))
      .not('assigned_to', 'is', null);
    (convs || []).forEach((c) => { if (!map.has(c.contact_id)) map.set(c.contact_id, c.assigned_to); });
  }
  return map;
}

// Daily message stats — supports ?from=YYYY-MM-DD&to=YYYY-MM-DD
// Also upserts each day's stats into daily_stats table
router.get('/daily', async (req, res) => {
  try {
    // Bucketing pakai zona WIB (UTC+7) supaya batas hari sesuai waktu lokal user
    const TZ = 7 * 3600 * 1000;
    const wibKey = (iso) => {
      if (!iso) return null;
      const t = new Date(iso).getTime();
      if (Number.isNaN(t)) return null;
      return new Date(t + TZ).toISOString().slice(0, 10);
    };

    const todayWib = new Date(Date.now() + TZ).toISOString().slice(0, 10);
    const toStr = req.query.to || todayWib;
    const fromStr = req.query.from ||
      new Date(new Date(toStr + 'T00:00:00Z').getTime() - 13 * 86400000).toISOString().slice(0, 10);

    // Batas UTC yang mencakup rentang hari WIB
    const qFromIso = new Date(fromStr + 'T00:00:00+07:00').toISOString();
    const qToIso = new Date(toStr + 'T23:59:59+07:00').toISOString();

    const regionSet = await regionConvSet(req.query.region);

    let { data: messages, error } = await fetchAll(() => supabase
      .from('messages')
      .select('id, timestamp, from_me, conversation_id')
      .gte('timestamp', qFromIso)
      .lte('timestamp', qToIso)
      .order('id', { ascending: true }));

    if (error) throw error;
    if (regionSet) messages = messages.filter((m) => regionSet.has(m.conversation_id));

    // Bangun daftar hari (WIB) inklusif dari fromStr..toStr
    const byDate = {};
    let cursor = new Date(fromStr + 'T00:00:00Z');
    const end = new Date(toStr + 'T00:00:00Z');
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      byDate[key] = { date: key, messages: 0, incoming: 0, outgoing: 0 };
      cursor = new Date(cursor.getTime() + 86400000);
    }

    for (const msg of messages) {
      const key = wibKey(msg.timestamp);
      if (!key || !byDate[key]) continue;
      byDate[key].messages++;
      if (msg.from_me) byDate[key].outgoing++;
      else byDate[key].incoming++;
    }

    const result = Object.values(byDate);

    // Kontak baru & resolved per hari (WIB)
    let { data: contacts } = await fetchAll(() => supabase
      .from('contacts')
      .select(regionSet ? 'id, created_at, region' : 'id, created_at')
      .gte('created_at', qFromIso)
      .lte('created_at', qToIso)
      .order('id', { ascending: true }));
    if (regionSet) contacts = (contacts || []).filter((c) => c.region === req.query.region);

    let { data: resolved } = await fetchAll(() => supabase
      .from('conversations')
      .select('id, updated_at')
      .eq('status', 'resolved')
      .gte('updated_at', qFromIso)
      .lte('updated_at', qToIso)
      .order('id', { ascending: true }));
    if (regionSet) resolved = (resolved || []).filter((c) => regionSet.has(c.id));

    const contactsByDate = {};
    for (const c of (contacts || [])) {
      const key = wibKey(c.created_at);
      if (key) contactsByDate[key] = (contactsByDate[key] || 0) + 1;
    }
    const resolvedByDate = {};
    for (const c of (resolved || [])) {
      const key = wibKey(c.updated_at);
      if (key) resolvedByDate[key] = (resolvedByDate[key] || 0) + 1;
    }

    // Upsert into daily_stats for each day in range
    const upsertRows = result.map(d => ({
      date: d.date,
      total_messages: d.messages,
      new_contacts: contactsByDate[d.date] || 0,
      resolved_chats: resolvedByDate[d.date] || 0,
    }));

    // Fire and forget — don't block the response. Hanya untuk data global
    // (tanpa filter regional) agar tabel daily_stats tidak tertimpa angka sebagian.
    if (!regionSet) {
      supabase.from('daily_stats')
        .upsert(upsertRows, { onConflict: 'date' })
        .then(({ error: e }) => { if (e) console.warn('daily_stats upsert warn:', e.message); });
    }

    // Attach extra fields to result
    const enriched = result.map(d => ({
      ...d,
      new_contacts: contactsByDate[d.date] || 0,
      resolved_chats: resolvedByDate[d.date] || 0,
    }));

    res.json(enriched);
  } catch (err) {
    console.error('GET /stats/daily error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Contacts summary: total and new today
router.get('/contacts', async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const region = REGIONS.includes(req.query.region) ? req.query.region : null;
    const base = () => {
      const q = supabase.from('contacts').select('*', { count: 'exact', head: true });
      return region ? q.eq('region', region) : q;
    };

    const [{ count: total, error: e1 }, { count: newToday, error: e2 }] = await Promise.all([
      base(),
      base().gte('created_at', todayStart.toISOString()),
    ]);

    if (e1) throw e1;
    if (e2) throw e2;

    res.json({ total: total || 0, newToday: newToday || 0 });
  } catch (err) {
    // Filter regional tapi kolom belum dimigrasi -> jangan tampilkan angka global
    if (REGIONS.includes(req.query.region)) return res.json({ total: 0, newToday: 0 });
    // Fallback to conversations table
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const [{ count: total }, { count: newToday }] = await Promise.all([
        supabase.from('conversations').select('*', { count: 'exact', head: true }),
        supabase.from('conversations')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', todayStart.toISOString()),
      ]);
      res.json({ total: total || 0, newToday: newToday || 0 });
    } catch (e2) {
      res.status(500).json({ error: err.message });
    }
  }
});

// Agent performance stats — mendukung filter periode ?from=YYYY-MM-DD&to=YYYY-MM-DD
// (memfilter percakapan berdasarkan updated_at, konsisten dgn funnel & response-kpi)
router.get('/agents', async (req, res) => {
  try {
    const region = REGIONS.includes(req.query.region) ? req.query.region : null;
    const buildConv = () => {
      let q = supabase.from('conversations').select('id, assigned_to, status').order('id', { ascending: true });
      if (req.query.from || req.query.to) {
        const toDate = req.query.to ? new Date(req.query.to) : new Date();
        const fromDate = req.query.from ? new Date(req.query.from) : new Date(toDate.getTime() - 29 * 86400000);
        fromDate.setHours(0, 0, 0, 0);
        toDate.setHours(23, 59, 59, 999);
        q = q.gte('updated_at', fromDate.toISOString()).lte('updated_at', toDate.toISOString());
      }
      return q;
    };

    let agentsRes = await supabase.from('agents').select('id, name, email, role, region');
    if (agentsRes.error) agentsRes = await supabase.from('agents').select('id, name, email, role');
    const { data: agentsList, error: ae } = agentsRes;
    const { data: convs, error: ce } = await fetchAll(buildConv);
    if (ae) throw ae;
    if (ce) throw ce;

    const agentById = {};
    for (const a of (agentsList || [])) {
      if (a.role === 'admin') continue; // tampilkan hanya agent, bukan admin
      if (region && a.region !== region) continue; // filter regional: hanya agent regional tsb
      agentById[a.id] = {
        id: a.id, name: a.name, email: a.email,
        total: 0, open: 0, in_progress: 0, resolved: 0,
        penawaran: 0, survey: 0, deal: 0,
        _responseTimes: [],
      };
    }

    const assignedConvIds = (convs || [])
      .filter(c => c.assigned_to && agentById[c.assigned_to])
      .map(c => c.id);

    const msgsByConv = assignedConvIds.length > 0 ? await fetchMsgsByConv(assignedConvIds) : {};

    // Funnel per agent berbasis tag (Penawaran / Survey / Deal). Lead = total percakapan.
    const { data: tags } = await supabase.from('tags').select('id, name');
    const stageDefs = [
      { key: 'penawaran', re: /penawaran|quote|quotation/i },
      { key: 'survey', re: /surv/i },
      { key: 'deal', re: /deal|clos|menang|berhasil|won|jadi/i },
    ];
    const stageTagIds = {};
    stageDefs.forEach((d) => {
      stageTagIds[d.key] = new Set((tags || []).filter((t) => d.re.test(t.name || '')).map((t) => t.id));
    });
    const tagsByConv = {};
    if (assignedConvIds.length > 0) {
      for (let i = 0; i < assignedConvIds.length; i += 100) {
        const batch = assignedConvIds.slice(i, i + 100);
        const { data: ct } = await supabase
          .from('conversation_tags')
          .select('conversation_id, tag_id')
          .in('conversation_id', batch);
        (ct || []).forEach((r) => {
          (tagsByConv[r.conversation_id] = tagsByConv[r.conversation_id] || []).push(r.tag_id);
        });
      }
    }

    for (const conv of (convs || [])) {
      const agent = agentById[conv.assigned_to];
      if (!agent) continue;

      agent.total++;
      const s = conv.status || 'open';
      if (s === 'open') agent.open++;
      else if (s === 'in_progress') agent.in_progress++;
      else if (s === 'resolved') agent.resolved++;

      const ctags = tagsByConv[conv.id] || [];
      if (ctags.some((id) => stageTagIds.penawaran.has(id))) agent.penawaran++;
      if (ctags.some((id) => stageTagIds.survey.has(id))) agent.survey++;
      if (ctags.some((id) => stageTagIds.deal.has(id))) agent.deal++;

      const diffMin = agentResponseMinutes(msgsByConv[conv.id] || []);
      if (diffMin != null) agent._responseTimes.push(diffMin);
    }

    // Kontak baru dalam periode (batas hari WIB, sama dengan kartu "Kontak Baru")
    // yang percakapannya di-assign ke agent. Satu kontak dihitung sekali.
    for (const a of Object.values(agentById)) a.new_contacts = 0;
    const newContactAgent = await newContactAssignments(req.query.from, req.query.to, region);
    for (const agentId of newContactAgent.values()) {
      if (agentById[agentId]) agentById[agentId].new_contacts++;
    }

    const result = Object.values(agentById)
      .map(({ _responseTimes, ...a }) => ({
        ...a,
        lead: a.total,
        avgResponse: _responseTimes.length > 0
          ? Math.round(_responseTimes.reduce((s, t) => s + t, 0) / _responseTimes.length)
          : null,
      }));

    res.json(result);
  } catch (err) {
    console.error('GET /stats/agents error:', err);
    res.status(500).json({ error: err.message });
  }
});

// KPI Response Time: % percakapan yang dibalas pertama kali <= 5 menit
router.get('/response-kpi', async (req, res) => {
  try {
    const KPI_MINUTES = 5;
    const toDate = req.query.to ? new Date(req.query.to) : new Date();
    const fromDate = req.query.from ? new Date(req.query.from) : new Date(toDate.getTime() - 29 * 86400000);
    fromDate.setHours(0, 0, 0, 0);
    toDate.setHours(23, 59, 59, 999);

    const [{ data: agentsList }, convRes, regionSet] = await Promise.all([
      supabase.from('agents').select('id, name'),
      fetchAll(() => supabase.from('conversations')
        .select('id, assigned_to, updated_at')
        .gte('updated_at', fromDate.toISOString())
        .lte('updated_at', toDate.toISOString())
        .order('id', { ascending: true })),
      regionConvSet(req.query.region),
    ]);
    let convs = convRes.data || [];
    if (regionSet) convs = convs.filter((c) => regionSet.has(c.id));

    const agentName = {};
    (agentsList || []).forEach((a) => { agentName[a.id] = a.name; });

    const convIds = (convs || []).map((c) => c.id);
    const assignedByConv = {};
    (convs || []).forEach((c) => { assignedByConv[c.id] = c.assigned_to || null; });

    // Supabase .in() per batch agar URL tidak kepanjangan (di dalam helper)
    const msgsByConv = convIds.length ? await fetchMsgsByConv(convIds) : {};

    let total = 0, met = 0;
    const perAgent = {}; // key agentId|'unassigned'
    for (const cid of convIds) {
      const diffMin = agentResponseMinutes(msgsByConv[cid] || []);
      if (diffMin == null) continue;
      total++;
      const ok = diffMin <= KPI_MINUTES;
      if (ok) met++;
      const key = assignedByConv[cid] || 'unassigned';
      const a = (perAgent[key] = perAgent[key] || { total: 0, met: 0 });
      a.total++; if (ok) a.met++;
    }

    const agents = Object.entries(perAgent).map(([key, v]) => ({
      agent_id: key === 'unassigned' ? null : key,
      name: key === 'unassigned' ? 'Belum di-assign' : (agentName[key] || 'Agent'),
      total: v.total,
      met: v.met,
      percent: v.total ? Math.round((v.met / v.total) * 100) : 0,
    })).sort((a, b) => b.total - a.total);

    res.json({
      kpiMinutes: KPI_MINUTES,
      total,
      met,
      percent: total ? Math.round((met / total) * 100) : 0,
      agents,
    });
  } catch (err) {
    console.error('GET /stats/response-kpi error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Funnel konversi berbasis tag: Lead -> Penawaran -> Survey -> Deal (+ Fail)
router.get('/funnel', async (req, res) => {
  try {
    const toDate = req.query.to ? new Date(req.query.to) : new Date();
    const fromDate = req.query.from ? new Date(req.query.from) : new Date(toDate.getTime() - 29 * 86400000);
    fromDate.setHours(0, 0, 0, 0);
    toDate.setHours(23, 59, 59, 999);

    const [{ data: convs }, regionSet] = await Promise.all([
      fetchAll(() => supabase
        .from('conversations')
        .select('id')
        .gte('updated_at', fromDate.toISOString())
        .lte('updated_at', toDate.toISOString())
        .order('id', { ascending: true })),
      regionConvSet(req.query.region),
    ]);
    const convIds = new Set((convs || []).map((c) => c.id).filter((id) => !regionSet || regionSet.has(id)));
    const totalLeads = convIds.size;

    const { data: tags } = await supabase.from('tags').select('id, name');
    const stageDefs = [
      { stage: 'Penawaran', re: /penawaran|quote|quotation/i },
      { stage: 'Survey', re: /surv/i },
      { stage: 'Deal', re: /deal|clos|menang|berhasil|won|jadi/i },
      { stage: 'Fail', re: /fail|gagal|batal|lost/i },
    ];
    const stageTagIds = stageDefs.map((d) => ({
      stage: d.stage,
      ids: (tags || []).filter((t) => d.re.test(t.name || '')).map((t) => t.id),
    }));

    // ambil semua relasi conversation_tags untuk tag yang relevan
    const allStageTagIds = [...new Set(stageTagIds.flatMap((s) => s.ids))];
    let ctRows = [];
    if (allStageTagIds.length) {
      const { data } = await fetchAll(() => supabase
        .from('conversation_tags')
        .select('conversation_id, tag_id')
        .in('tag_id', allStageTagIds)
        .order('conversation_id', { ascending: true })
        .order('tag_id', { ascending: true }));
      ctRows = data || [];
    }

    const countStage = (ids) => {
      if (!ids.length) return 0;
      const set = new Set();
      ctRows.forEach((r) => {
        if (ids.includes(r.tag_id) && convIds.has(r.conversation_id)) set.add(r.conversation_id);
      });
      return set.size;
    };

    const stages = [
      { stage: 'Lead', count: totalLeads },
      ...stageTagIds
        .filter((s) => s.stage !== 'Fail')
        .map((s) => ({ stage: s.stage, count: countStage(s.ids) })),
    ];
    const failDef = stageTagIds.find((s) => s.stage === 'Fail');
    const fail = failDef ? countStage(failDef.ids) : 0;

    res.json({ stages, fail });
  } catch (err) {
    console.error('GET /stats/funnel error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
