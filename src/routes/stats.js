import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

// Daily message stats from last 14 days
router.get('/daily', async (req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 13);
    since.setHours(0, 0, 0, 0);

    const { data: messages, error } = await supabase
      .from('messages')
      .select('timestamp, from_me')
      .gte('timestamp', since.toISOString());

    if (error) throw error;

    const byDate = {};
    for (let i = 0; i < 14; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().split('T')[0];
      byDate[key] = { date: key, messages: 0, incoming: 0, outgoing: 0 };
    }

    for (const msg of messages) {
      const key = (msg.timestamp || '').split('T')[0];
      if (!byDate[key]) continue;
      byDate[key].messages++;
      if (msg.from_me) byDate[key].outgoing++;
      else byDate[key].incoming++;
    }

    res.json(Object.values(byDate));
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
    console.error('GET /stats/contacts error:', err);
    // Fallback: try conversations table
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

// Agent performance stats
router.get('/agents', async (req, res) => {
  try {
    const [{ data: agentsList, error: ae }, { data: convs, error: ce }] = await Promise.all([
      supabase.from('agents').select('id, name, email'),
      supabase.from('conversations').select('id, assigned_to, status'),
    ]);
    if (ae) throw ae;
    if (ce) throw ce;

    const agentById = {};
    for (const a of (agentsList || [])) {
      agentById[a.id] = {
        id: a.id, name: a.name, email: a.email,
        total: 0, open: 0, in_progress: 0, resolved: 0,
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

    for (const conv of (convs || [])) {
      const agent = agentById[conv.assigned_to];
      if (!agent) continue;

      agent.total++;
      const s = conv.status || 'open';
      if (s === 'open') agent.open++;
      else if (s === 'in_progress') agent.in_progress++;
      else if (s === 'resolved') agent.resolved++;

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

export default router;
