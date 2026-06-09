import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select(`
        id, name, phone, first_seen,
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

export default router;
