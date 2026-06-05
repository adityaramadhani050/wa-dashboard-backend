import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { supabase } from '../db/supabase.js';

const router = Router();

// List agents (no password_hash exposed)
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('agents')
      .select('id, name, email, role, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('GET /agents error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create agent
router.post('/', async (req, res) => {
  try {
    const { name, email, role = 'agent', password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, dan password wajib diisi' });
    }

    // Check duplicate email
    const { data: existing } = await supabase
      .from('agents').select('id').eq('email', email.toLowerCase().trim()).maybeSingle();
    if (existing) return res.status(409).json({ error: 'Email sudah terdaftar' });

    const password_hash = await bcrypt.hash(password, 10);

    const { data, error } = await supabase
      .from('agents')
      .insert({ name, email: email.toLowerCase().trim(), role, password_hash })
      .select('id, name, email, role, created_at')
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('POST /agents error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update agent (name, email, role; password optional)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, role, password } = req.body;

    const updates = {};
    if (name) updates.name = name;
    if (email) updates.email = email.toLowerCase().trim();
    if (role) updates.role = role;
    if (password) updates.password_hash = await bcrypt.hash(password, 10);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Tidak ada field yang diupdate' });
    }

    const { data, error } = await supabase
      .from('agents')
      .update(updates)
      .eq('id', id)
      .select('id, name, email, role, created_at')
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
    const { error } = await supabase.from('agents').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /agents/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
