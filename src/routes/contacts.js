import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const { agent_id } = req.query;

    const { data, error } = await supabase
      .from('contacts')
      .select(`
        id, name, phone, first_seen, manual_wa_number,
        conversations (updated_at, assigned_to)
      `)
      .order('first_seen', { ascending: false });

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
