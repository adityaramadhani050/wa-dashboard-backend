import { Router } from 'express';
import { supabase } from '../db/supabase.js';

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
    res.json(data);
  } catch (err) {
    console.error('PATCH /me/availability error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
