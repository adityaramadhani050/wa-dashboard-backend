import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supabase } from '../db/supabase.js';

const router = Router();

// List agents
router.get('/', async (req, res) => {
  try {
    let { data, error } = await supabase
      .from('agents')
      .select('id, name, username, email, role, available, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      // Kolom `available` mungkin belum ada -> fallback & default tersedia
      ({ data, error } = await supabase
        .from('agents')
        .select('id, name, username, email, role, created_at')
        .order('created_at', { ascending: false }));
      if (error) throw error;
      (data || []).forEach((a) => { a.available = true; });
    }
    res.json(data || []);
  } catch (err) {
    console.error('GET /agents error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Set ketersediaan (aktif/non-aktif untuk auto-assign) agent tertentu (admin)
router.patch('/:id/availability', async (req, res) => {
  try {
    const { id } = req.params;
    const available = !!req.body.available;
    const { data, error } = await supabase
      .from('agents')
      .update({ available })
      .eq('id', id)
      .select('id, available')
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('PATCH /agents/:id/availability error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create agent
router.post('/', async (req, res) => {
  try {
    const { name, username, email, role = 'agent', password } = req.body;
    if (!name || !username || !password) {
      return res.status(400).json({ error: 'name, username, dan password wajib diisi' });
    }

    const cleanUsername = username.trim().toLowerCase();

    // Check duplicate username
    const { data: existing } = await supabase
      .from('agents').select('id').eq('username', cleanUsername).maybeSingle();
    if (existing) return res.status(409).json({ error: 'Username sudah digunakan' });

    const password_hash = await bcrypt.hash(password, 10);

    const { data, error } = await supabase
      .from('agents')
      .insert({
        name,
        username: cleanUsername,
        email: email ? email.toLowerCase().trim() : null,
        role,
        password_hash,
      })
      .select('id, name, username, email, role, created_at')
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('POST /agents error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update agent
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, username, email, role, password } = req.body;

    const updates = {};
    if (name) updates.name = name;
    if (username) updates.username = username.trim().toLowerCase();
    if (email !== undefined) updates.email = email ? email.toLowerCase().trim() : null;
    if (role) updates.role = role;
    if (password) updates.password_hash = await bcrypt.hash(password, 10);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Tidak ada field yang diupdate' });
    }

    const { data, error } = await supabase
      .from('agents')
      .update(updates)
      .eq('id', id)
      .select('id, name, username, email, role, created_at')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Agent tidak ditemukan' });
    res.json(data);
  } catch (err) {
    console.error('PUT /agents/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete agent
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Unassign this agent from related records first — agents.id is referenced
    // by FK from conversations/contact_notes/reminders, so a plain delete would
    // fail with a foreign key violation if any of these still point to it.
    await supabase.from('conversations').update({ assigned_to: null }).eq('assigned_to', id);
    await supabase.from('contact_notes').update({ agent_id: null }).eq('agent_id', id);
    await supabase.from('reminders').update({ agent_id: null }).eq('agent_id', id);

    const { error } = await supabase.from('agents').delete().eq('id', id);
    if (error) {
      if (error.code === '23503') {
        return res.status(409).json({ error: 'Agent masih terkait dengan data lain dan tidak dapat dihapus.' });
      }
      throw error;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /agents/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
