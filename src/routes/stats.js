import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

router.get('/daily', async (req, res) => {
  try {
    const { from, to } = req.query;

    let query = supabase
      .from('daily_stats')
      .select('*')
      .order('date', { ascending: false });

    if (from) query = query.gte('date', from);
    if (to) query = query.lte('date', to);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('GET /stats/daily error:', err);
    res.status(500).json({ error: err.message });
  }
});

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
      if (!agentId) continue;

      if (!agentMap[agentId]) {
        agentMap[agentId] = {
          agent: conv.agents,
          total: 0,
          open: 0,
          in_progress: 0,
          resolved: 0,
        };
      }

      agentMap[agentId].total += 1;
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
