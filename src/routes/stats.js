import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

// Daily message stats from last 14 days — computed from messages table
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

    // Build date map for last 14 days (fill gaps with zeros)
    const byDate = {};
    for (let i = 0; i < 14; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().split('T')[0];
      byDate[key] = { date: key, messages: 0, incoming: 0, outgoing: 0 };
    }

    for (const msg of messages) {
      const key = msg.timestamp.split('T')[0];
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
    const { data, error } = await supabase
      .from('conversations')
      .select(`
        assigned_to,
        status,
        agents:assigned_to (id, name, email)
      `);

    if (error) throw error;

    const agentMap = {};
    for (const conv of data) {
      const agentId = conv.assigned_to;
      if (!agentId || !conv.agents) continue;

      if (!agentMap[agentId]) {
        agentMap[agentId] = {
          id: agentId,
          name: conv.agents.name,
          email: conv.agents.email,
          total: 0,
          open: 0,
          in_progress: 0,
          resolved: 0,
        };
      }

      agentMap[agentId].total++;
      if (conv.status) {
        agentMap[agentId][conv.status] = (agentMap[agentId][conv.status] || 0) + 1;
      }
    }

    res.json(Object.values(agentMap));
  } catch (err) {
    console.error('GET /stats/agents error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
