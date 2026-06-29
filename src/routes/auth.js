import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supabase } from '../db/supabase.js';
import { signToken, signServiceToken, requireAdmin } from '../middleware/auth.js';

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
  const token = signToken(user);
  res.json({ user, token });
});

// Generate token bot/service (tanpa kedaluwarsa) untuk integrasi mesin-ke-mesin,
// mis. WA Bot Notifikasi RenusPro. Khusus admin (requireAdmin).
router.post('/bot-token', requireAdmin, (req, res) => {
  try {
    // Selalu wajib admin walau AUTH_ENFORCED masih false (mencegah eskalasi hak).
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Akses khusus admin.' });
    }
    const name = (req.body?.name || 'Bot Notif WA').toString().slice(0, 60);
    const token = signServiceToken({ name });
    res.json({ success: true, token, name });
  } catch (err) {
    console.error('POST /auth/bot-token error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
