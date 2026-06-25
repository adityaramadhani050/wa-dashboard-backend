import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

// List tags
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tags')
      .select('*')
      .order('name');

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('GET /tags error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create tag
router.post('/', async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name wajib diisi' });
    }

    const { data, error } = await supabase
      .from('tags')
      .insert({
        name,
        color: color || null,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('POST /tags error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update tag
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, color } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (color !== undefined) updates.color = color || null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Tidak ada field yang diupdate' });
    }

    const { data, error } = await supabase
      .from('tags')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Tag tidak ditemukan' });
    res.json(data);
  } catch (err) {
    console.error('PUT /tags/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete tag
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('tags').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /tags/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
