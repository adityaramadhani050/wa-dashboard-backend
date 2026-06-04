import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('agents')
      .select('id, name, email, role')
      .order('name');

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('GET /agents error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
