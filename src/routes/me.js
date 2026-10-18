import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supabase } from '../db/supabase.js';
import { signToken, invalidatePwdCache } from '../middleware/auth.js';
import { distributeUnassigned } from '../services/autoAssign.js';

const router = Router();

// Ketersediaan (aktif/non-aktif untuk auto-assign) milik user yang login.
// Dipakai agent untuk mengatur status sendiri (izin/sakit/cuti) dari header inbox.

router.get('/availability', async (req, res) => {
  try {
    const id = req.user?.id;
    if (!id) return res.json({ available: true });
    const { data, error } = await supabase
      .from('agents').select('available').eq('id', id).maybeSingle();
    if (error) return res.json({ available: true }); // kolom belum ada -> anggap tersedia
    res.json({ available: data?.available !== false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/availability', async (req, res) => {
  try {
    const id = req.user?.id;
    if (!id) return res.status(401).json({ error: 'Tidak terautentikasi.' });
    const available = !!req.body.available;
    const { data, error } = await supabase
      .from('agents').update({ available }).eq('id', id)
      .select('id, available').single();
    if (error) throw error;
    // Kembali tersedia -> bagikan chat yang menunggu di antrian (termasuk antrian regional)
    if (available) distributeUnassigned().catch(() => {});
    res.json(data);
  } catch (err) {
    console.error('PATCH /me/availability error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Ganti kata sandi sendiri. Wajib kata sandi lama. Sesi di perangkat lain
// otomatis berakhir (password_changed_at); perangkat ini diberi token baru.
router.post('/password', async (req, res) => {
  try {
    const id = req.user?.id;
    if (!id || req.user?.type === 'service') return res.status(401).json({ error: 'Tidak terautentikasi. Silakan login ulang.' });
    const current = String(req.body?.current_password || '');
    const next = String(req.body?.new_password || '');
    if (!current || !next) return res.status(400).json({ error: 'Kata sandi lama dan baru wajib diisi.' });
    if (next.length < 8) return res.status(400).json({ error: 'Kata sandi baru minimal 8 karakter.' });
    if (next.length > 72) return res.status(400).json({ error: 'Kata sandi baru maksimal 72 karakter.' });
    if (next === current) return res.status(400).json({ error: 'Kata sandi baru harus berbeda dari yang lama.' });

    const { data: agent, error } = await supabase
      .from('agents').select('id, name, email, username, role, password_hash').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!agent) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    if (!agent.password_hash || !(await bcrypt.compare(current, agent.password_hash))) {
      return res.status(400).json({ error: 'Kata sandi lama salah.' });
    }

    const updates = { password_hash: await bcrypt.hash(next, 10), password_changed_at: new Date().toISOString() };
    let { error: upErr } = await supabase.from('agents').update(updates).eq('id', id);
    if (upErr) { // kolom password_changed_at belum ada
      delete updates.password_changed_at;
      ({ error: upErr } = await supabase.from('agents').update(updates).eq('id', id));
    }
    if (upErr) throw upErr;
    invalidatePwdCache(id);

    const { password_hash, ...user } = agent;
    // Token baru (iat >= password_changed_at) -> perangkat ini tetap login
    res.json({ success: true, token: signToken(user) });
  } catch (err) {
    console.error('POST /me/password error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
