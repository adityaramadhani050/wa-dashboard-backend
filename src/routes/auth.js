import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

router.post('/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const { data, error } = await supabase
    .from('agents')
    .select('id, name, email, role')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (error || !data) return res.status(401).json({ error: 'Agent not found' });
  res.json({ user: data });
});

export default router;
