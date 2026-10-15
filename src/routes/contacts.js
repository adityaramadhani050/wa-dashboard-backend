import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

const REGIONS = ['barat', 'timur'];
const PAGE = 1000; // batas baris per query Supabase

// Ambil semua baris secara bertahap (Supabase membatasi 1000 baris per query).
async function fetchAllContacts(cols) {
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('contacts')
      .select(cols)
      .order('first_seen', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { data: all, error: null };
}

router.get('/', async (req, res) => {
  try {
    const { agent_id } = req.query;

    // Kolom lokasi (city/province/region) dari migrasi regional -> fallback bila belum ada
    let { data, error } = await fetchAllContacts(`
      id, name, phone, first_seen, manual_wa_number, city, province, region,
      conversations (updated_at, assigned_to, region)
    `);
    if (error) {
      ({ data, error } = await fetchAllContacts(`
        id, name, phone, first_seen, manual_wa_number,
        conversations (updated_at, assigned_to)
      `));
    }
    if (error) throw error;

    const filtered = agent_id
      ? data.filter(c => (c.conversations || []).some(cv => cv.assigned_to === agent_id))
      : data;

    const enriched = filtered
      .map(c => {
        const dates = (c.conversations || []).map(cv => cv.updated_at).filter(Boolean);
        const last_message_at = dates.length
          ? dates.reduce((a, b) => (a > b ? a : b))
          : c.first_seen;
        const convRegion = (c.conversations || []).map(cv => cv.region).find(Boolean) || null;
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          first_seen: c.first_seen,
          manual_wa_number: c.manual_wa_number,
          city: c.city || null,
          province: c.province || null,
          region: c.region || convRegion,
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

// Ubah regional banyak kontak sekaligus (admin). Regional percakapan kontak
// tersebut ikut diperbarui agar badge & routing konsisten.
// body: { ids: [contactId...], region: 'barat' | 'timur' | null }
router.post('/bulk-region', requireAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => x != null) : [];
    const region = REGIONS.includes(req.body?.region) ? req.body.region : null;
    if (!ids.length) return res.status(400).json({ error: 'Pilih minimal satu kontak' });

    let updated = 0;
    for (let i = 0; i < ids.length; i += 150) {
      const batch = ids.slice(i, i + 150);
      const { data, error } = await supabase.from('contacts').update({ region }).in('id', batch).select('id');
      if (error) throw error;
      updated += (data || []).length;
      await supabase.from('conversations').update({ region }).in('contact_id', batch);
    }
    res.json({ success: true, updated, region });
  } catch (err) {
    console.error('POST /contacts/bulk-region error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, manual_wa_number, region, city } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (manual_wa_number !== undefined) updates.manual_wa_number = manual_wa_number?.trim() || null;
    if (region !== undefined) updates.region = REGIONS.includes(region) ? region : null;
    if (city !== undefined) updates.city = city?.trim() || null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Tidak ada field yang diupdate' });
    }

    const cols = updates.region !== undefined || updates.city !== undefined
      ? 'id, name, phone, first_seen, manual_wa_number, city, province, region'
      : 'id, name, phone, first_seen, manual_wa_number';
    const { data, error } = await supabase
      .from('contacts')
      .update(updates)
      .eq('id', id)
      .select(cols)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Kontak tidak ditemukan' });
    if (updates.region !== undefined) {
      await supabase.from('conversations').update({ region: updates.region }).eq('contact_id', id);
    }
    res.json(data);
  } catch (err) {
    console.error('PATCH /contacts/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('contact_notes')
      .select('*, agents(name)')
      .eq('contact_id', id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error(`GET /contacts/${req.params.id}/notes error:`, err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/conversations', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('conversations')
      .select('id, status, updated_at, created_at')
      .eq('contact_id', id)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    const conversationIds = (data || []).map((c) => c.id);
    let lastMsgByConv = {};
    if (conversationIds.length > 0) {
      const results = await Promise.all(
        conversationIds.map((cid) =>
          supabase
            .from('messages')
            .select('body, timestamp')
            .eq('conversation_id', cid)
            .order('timestamp', { ascending: false })
            .limit(1)
            .maybeSingle()
            .then(({ data: msg }) => ({ cid, msg }))
        )
      );
      results.forEach(({ cid, msg }) => { lastMsgByConv[cid] = msg || null; });
    }

    const enriched = (data || []).map((conv) => ({
      ...conv,
      lastMessage: lastMsgByConv[conv.id]?.body || null,
      lastMessageAt: lastMsgByConv[conv.id]?.timestamp || conv.updated_at,
    }));

    res.json(enriched);
  } catch (err) {
    console.error(`GET /contacts/${req.params.id}/conversations error:`, err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const { agent_id, body } = req.body;
    if (!body) return res.status(400).json({ error: 'body wajib diisi' });

    const { data, error } = await supabase
      .from('contact_notes')
      .insert({
        contact_id: id,
        agent_id: agent_id || null,
        body,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error(`POST /contacts/${req.params.id}/notes error:`, err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
