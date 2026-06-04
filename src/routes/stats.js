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

// Agent performance stats
router.get('/agents', async (req, res) => {
  try {
    // Separate queries to avoid join silently returning null
    const [{ data: agentsList, error: ae }, { data: convs, error: ce }] = await Promise.all([
      supabase.from('agents').select('id, name, email'),
      supabase.from('conversations').select('id, assigned_to, status'),
    ]);
    if (ae) throw ae;
    if (ce) throw ce;

    // Build agent lookup
    const agentById = {};
    for (const a of (agentsList || [])) {
      agentById[a.id] = {
        id: a.id, name: a.name, email: a.email,
        total: 0, open: 0, in_progress: 0, resolved: 0,
        _responseTimes: [],
      };
    }

    // Collect assigned conversation IDs
    const assignedConvIds = (convs || [])
      .filter(c => c.assigned_to && agentById[c.assigned_to])
      .map(c => c.id);

    // Fetch messages for response time — only for assigned convs
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

    // Aggregate per agent
    for (const conv of (convs || [])) {
      const agent = agentById[conv.assigned_to];
      if (!agent) continue;

      agent.total++;
      const s = conv.status || 'open';
      if (s === 'open') agent.open++;
      else if (s === 'in_progress') agent.in_progress++;
      else if (s === 'resolved') agent.resolved++;

      // Compute first-response time for this conversation
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
