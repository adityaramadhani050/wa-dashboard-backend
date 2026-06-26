import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

// Daftarkan / perbarui device token milik user yang login
router.post('/', async (req, res) => {
  try {
    const { token, platform } = req.body;
    if (!token) return res.status(400).json({ error: 'token wajib diisi' });
    const agent_id = req.user?.id || null;

    const { data, error } = await supabase
      .from('device_tokens')
      .upsert(
        { token, platform: platform || 'android', agent_id },
        { onConflict: 'token' }
      )
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('POST /devices error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Hapus token (mis. saat logout)
router.delete('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { error } = await supabase.from('device_tokens').delete().eq('token', token);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /devices/:token error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
