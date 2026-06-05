import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supabase } from '../db/supabase.js';

const router = Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi' });

  const { data, error } = await supabase
    .from('agents')
    .select('id, name, email, username, role, password_hash')
    .eq('username', username.trim().toLowerCase())
    .single();

  if (error || !data) return res.status(401).json({ error: 'Username tidak ditemukan' });

  if (!data.password_hash) {
    return res.status(401).json({ error: 'Password belum diset. Hubungi admin.' });
  }

  const valid = await bcrypt.compare(password, data.password_hash);
  if (!valid) return res.status(401).json({ error: 'Password salah' });

  const { password_hash, ...user } = data;
  res.json({ user });
});

export default router;
