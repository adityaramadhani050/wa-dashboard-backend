import { Router } from 'express';
import { supabase } from '../db/supabase.js';

const router = Router();

// Agent hanya boleh mengubah/menghapus template buatannya sendiri; admin semua.
// Kolom created_by opsional (migrasi) -> tanpa kolom, agent tidak bisa mengubah.
export async function canModify(table, id, user) {
  if (!user || user.role === 'admin') return true;
  const { data, error } = await supabase.from(table).select('created_by').eq('id', id).maybeSingle();
  if (error || !data) return false;
  return data.created_by != null && String(data.created_by) === String(user.id);
}

// Insert dengan created_by; ulangi tanpa kolom itu bila belum dimigrasi.
export async function insertOwned(table, row, user) {
  const run = (r) => supabase.from(table).insert(r).select().single();
  if (!user?.id || user.type === 'service') return run(row);
  const res = await run({ ...row, created_by: user.id });
  return res.error && /created_by/.test(res.error.message || '') ? run(row) : res;
}

// List templates
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('message_templates')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('GET /templates error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create template
router.post('/', async (req, res) => {
  try {
    const { title, body, shortcut, category } = req.body;
    if (!title || !body) {
      return res.status(400).json({ error: 'title dan body wajib diisi' });
    }

    const { data, error } = await insertOwned('message_templates', {
      title,
      body,
      shortcut: shortcut ? shortcut.trim().toLowerCase() : null,
      category: category || null,
    }, req.user);

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('POST /templates error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Top templates by usage_count — for "Template Terpopuler" analytics
router.get('/top', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 5;
    const { data, error } = await supabase
      .from('message_templates')
      .select('*')
      .order('usage_count', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('GET /templates/top error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Increment usage_count when a template is inserted into a chat
router.post('/:id/use', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: current, error: fetchErr } = await supabase
      .from('message_templates')
      .select('usage_count')
      .eq('id', id)
      .single();

    if (fetchErr) throw fetchErr;
    if (!current) return res.status(404).json({ error: 'Template tidak ditemukan' });

    const { data, error } = await supabase
      .from('message_templates')
      .update({ usage_count: (current.usage_count || 0) + 1 })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(`POST /templates/${req.params.id}/use error:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Update template
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, body, shortcut, category } = req.body;

    const updates = {};
    if (title !== undefined) updates.title = title;
    if (body !== undefined) updates.body = body;
    if (shortcut !== undefined) updates.shortcut = shortcut ? shortcut.trim().toLowerCase() : null;
    if (category !== undefined) updates.category = category || null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Tidak ada field yang diupdate' });
    }
    if (!(await canModify('message_templates', id, req.user))) {
      return res.status(403).json({ error: 'Hanya pembuat template atau admin yang dapat mengubahnya.' });
    }

    const { data, error } = await supabase
      .from('message_templates')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Template tidak ditemukan' });
    res.json(data);
  } catch (err) {
    console.error('PUT /templates/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete template
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await canModify('message_templates', id, req.user))) {
      return res.status(403).json({ error: 'Hanya pembuat template atau admin yang dapat menghapusnya.' });
    }
    const { error } = await supabase.from('message_templates').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /templates/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
