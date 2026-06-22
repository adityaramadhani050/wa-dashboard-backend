import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select(`
        id, name, phone, first_seen, manual_wa_number,
        conversations (updated_at)
      `)
      .order('first_seen', { ascending: false });

    if (error) throw error;

    const enriched = data
      .map(c => {
        const dates = (c.conversations || []).map(cv => cv.updated_at).filter(Boolean);
        const last_message_at = dates.length
          ? dates.reduce((a, b) => (a > b ? a : b))
          : c.first_seen;
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          first_seen: c.first_seen,
          manual_wa_number: c.manual_wa_number,
          last_message_at,
        };
      })
      .sort((a, b) => {
        const ad = a.last_message_at || '';
        const bd = b.last_message_at || '';
        return bd.localeCompare(ad);
      });

    res.json(enriched);
  } catch (err) {
    console.error('GET /contacts error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, manual_wa_number } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (manual_wa_number !== undefined) updates.manual_wa_number = manual_wa_number?.trim() || null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Tidak ada field yang diupdate' });
    }

    const { data, error } = await supabase
      .from('contacts')
      .update(updates)
      .eq('id', id)
      .select('id, name, phone, first_seen, manual_wa_number')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Kontak tidak ditemukan' });
    res.json(data);
  } catch (err) {
    console.error('PATCH /contacts/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
