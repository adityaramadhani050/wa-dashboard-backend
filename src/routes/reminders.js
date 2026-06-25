import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

// Create reminder
router.post('/', async (req, res) => {
  try {
    const { conversation_id, agent_id, remind_at, note } = req.body;
    if (!conversation_id || !remind_at) {
      return res.status(400).json({ error: 'conversation_id dan remind_at wajib diisi' });
    }

    const { data, error } = await supabase
      .from('reminders')
      .insert({
        conversation_id,
        agent_id: agent_id || null,
        remind_at,
        note: note || null,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('POST /reminders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Due reminders
router.get('/due', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reminders')
      .select(`
        *,
        conversations (id, contact:contacts (name, phone, manual_wa_number))
      `)
      .lte('remind_at', new Date().toISOString())
      .eq('done', false)
      .order('remind_at', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('GET /reminders/due error:', err);
    res.status(500).json({ error: err.message });
  }
});

// List reminders
router.get('/', async (req, res) => {
  try {
    const { conversation_id } = req.query;

    let query = supabase
      .from('reminders')
      .select('*')
      .order('remind_at', { ascending: true });

    if (conversation_id) query = query.eq('conversation_id', conversation_id);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('GET /reminders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update reminder
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { done, note, remind_at } = req.body;

    const updates = {};
    if (done !== undefined) updates.done = done;
    if (note !== undefined) updates.note = note;
    if (remind_at !== undefined) updates.remind_at = remind_at;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Tidak ada field yang diupdate' });
    }

    const { data, error } = await supabase
      .from('reminders')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Reminder tidak ditemukan' });
    res.json(data);
  } catch (err) {
    console.error('PATCH /reminders/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
