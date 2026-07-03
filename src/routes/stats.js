import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

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

    const { data: messages, error } = await supabase
      .from('messages')
      .select('timestamp, from_me')
      .gte('timestamp', qFromIso)
      .lte('timestamp', qToIso);

    if (error) throw error;

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
    const { data: contacts } = await supabase
      .from('contacts')
      .select('created_at')
      .gte('created_at', qFromIso)
      .lte('created_at', qToIso);

    const { data: resolved } = await supabase
      .from('conversations')
      .select('updated_at')
      .eq('status', 'resolved')
      .gte('updated_at', qFromIso)
      .lte('updated_at', qToIso);

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

    // Fire and forget — don't block the response
    supabase.from('daily_stats')
      .upsert(upsertRows, { onConflict: 'date' })
      .then(({ error: e }) => { if (e) console.warn('daily_stats upsert warn:', e.message); });

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

    const [{ count: total, error: e1 }, { count: newToday, error: e2 }] = await Promise.all([
      supabase.from('contacts').select('*', { count: 'exact', head: true }),
      supabase.from('contacts')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', todayStart.toISOString()),
    ]);

    if (e1) throw e1;
    if (e2) throw e2;

    res.json({ total: total || 0, newToday: newToday || 0 });
  } catch (err) {
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
    let convQuery = supabase.from('conversations').select('id, assigned_to, status');
    if (req.query.from || req.query.to) {
      const toDate = req.query.to ? new Date(req.query.to) : new Date();
      const fromDate = req.query.from ? new Date(req.query.from) : new Date(toDate.getTime() - 29 * 86400000);
      fromDate.setHours(0, 0, 0, 0);
      toDate.setHours(23, 59, 59, 999);
      convQuery = convQuery
        .gte('updated_at', fromDate.toISOString())
        .lte('updated_at', toDate.toISOString());
    }

    const [{ data: agentsList, error: ae }, { data: convs, error: ce }] = await Promise.all([
      supabase.from('agents').select('id, name, email'),
      convQuery,
    ]);
    if (ae) throw ae;
    if (ce) throw ce;

    const agentById = {};
    for (const a of (agentsList || [])) {
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

    let msgsByConv = {};
    if (assignedConvIds.length > 0) {
      const { data: msgs } = await supabase
        .from('messages')
        .select('conversation_id, from_me, timestamp')
        .in('conversation_id', assignedConvIds)
        .order('timestamp', { ascending: true });

      for (const m of (msgs || [])) {
        if (!msgsByConv[m.conversation_id]) msgsByConv[m.conversation_id] = [];
        msgsByConv[m.conversation_id].push(m);
      }
    }

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

      const msgs = msgsByConv[conv.id] || [];
      const firstIn = msgs.find(m => !m.from_me);
      if (firstIn) {
        const firstOut = msgs.find(m => m.from_me && m.timestamp > firstIn.timestamp);
        if (firstOut) {
          const diffMin = (new Date(firstOut.timestamp) - new Date(firstIn.timestamp)) / 60000;
          agent._responseTimes.push(diffMin);
        }
      }
    }

    const result = Object.values(agentById)
      .filter(a => a.total > 0)
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

    const [{ data: agentsList }, { data: convs }] = await Promise.all([
      supabase.from('agents').select('id, name'),
      supabase.from('conversations')
        .select('id, assigned_to, updated_at')
        .gte('updated_at', fromDate.toISOString())
        .lte('updated_at', toDate.toISOString()),
    ]);

    const agentName = {};
    (agentsList || []).forEach((a) => { agentName[a.id] = a.name; });

    const convIds = (convs || []).map((c) => c.id);
    const assignedByConv = {};
    (convs || []).forEach((c) => { assignedByConv[c.id] = c.assigned_to || null; });

    const msgsByConv = {};
    if (convIds.length) {
      // Supabase .in() per batch agar URL tidak kepanjangan
      for (let i = 0; i < convIds.length; i += 100) {
        const batch = convIds.slice(i, i + 100);
        const { data: msgs } = await supabase
          .from('messages')
          .select('conversation_id, from_me, timestamp')
          .in('conversation_id', batch)
          .order('timestamp', { ascending: true });
        (msgs || []).forEach((m) => {
          (msgsByConv[m.conversation_id] = msgsByConv[m.conversation_id] || []).push(m);
        });
      }
    }

    let total = 0, met = 0;
    const perAgent = {}; // key agentId|'unassigned'
    for (const cid of convIds) {
      const msgs = msgsByConv[cid] || [];
      const firstIn = msgs.find((m) => !m.from_me);
      if (!firstIn) continue;
      const firstOut = msgs.find((m) => m.from_me && m.timestamp > firstIn.timestamp);
      if (!firstOut) continue;
      const diffMin = (new Date(firstOut.timestamp) - new Date(firstIn.timestamp)) / 60000;
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

    const { data: convs } = await supabase
      .from('conversations')
      .select('id')
      .gte('updated_at', fromDate.toISOString())
      .lte('updated_at', toDate.toISOString());
    const convIds = new Set((convs || []).map((c) => c.id));
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
      const { data } = await supabase
        .from('conversation_tags')
        .select('conversation_id, tag_id')
        .in('tag_id', allStageTagIds);
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
