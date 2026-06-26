import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

// List products
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('GET /products error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create product
router.post('/', async (req, res) => {
  try {
    const { name, category, capacity, price, specs, active } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name wajib diisi' });
    }

    const { data, error } = await supabase
      .from('products')
      .insert({
        name,
        category: category || null,
        capacity: capacity || null,
        price: price || null,
        specs: specs || null,
        active: active === undefined ? true : !!active,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('POST /products error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update product
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, capacity, price, specs, active } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (category !== undefined) updates.category = category || null;
    if (capacity !== undefined) updates.capacity = capacity || null;
    if (price !== undefined) updates.price = price || null;
    if (specs !== undefined) updates.specs = specs || null;
    if (active !== undefined) updates.active = !!active;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Tidak ada field yang diupdate' });
    }

    const { data, error } = await supabase
      .from('products')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    res.json(data);
  } catch (err) {
    console.error('PUT /products/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete product
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('products').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /products/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
