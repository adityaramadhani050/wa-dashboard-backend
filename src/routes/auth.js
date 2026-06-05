import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supabase } from '../db/supabase.js';

const router = Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib diisi' });

  const { data, error } = await supabase
    .from('agents')
    .select('id, name, email, role, password_hash')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (error || !data) return res.status(401).json({ error: 'Email tidak ditemukan' });

  if (!data.password_hash) {
    return res.status(401).json({ error: 'Password belum diset. Hubungi admin.' });
  }

  const valid = await bcrypt.compare(password, data.password_hash);
  if (!valid) return res.status(401).json({ error: 'Password salah' });

  const { password_hash, ...user } = data;
  res.json({ user });
});

export default router;
