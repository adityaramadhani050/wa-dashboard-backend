// Pengetahuan AI Sales: skill/playbook (.md), pelajaran dari koreksi admin,
// memori customer. Kelola = admin; lihat memori = semua user yang login.
import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  invalidateKnowledgeCache, pickSkills, suggestKeywords, getMemory, saveMemory,
} from '../services/aiKnowledge.js';
import { usageSummary, AI_FEATURES } from '../services/aiUsage.js';
import { generate, listModels, keyStatus, aiEnabled } from '../services/llm.js';
import { listTeamRequests, closeTeamRequest, checkPicNumbers, getAiTeamConfig } from '../services/aiTeam.js';

const router = Router();

const fail = (res, label, err) => {
  console.error(`${label} error:`, err);
  const missing = /ai_skills|ai_lessons|ai_customer_memory|ai_usage_log|ai_team_requests/.test(err?.message || '') && /exist|schema cache/i.test(err?.message || '');
  res.status(500).json({ error: missing ? 'Tabel pengetahuan AI belum dibuat. Jalankan SQL migrasi di Supabase.' : err.message });
};

function skillPayload(b) {
  const out = {};
  if (b.title !== undefined) out.title = String(b.title || '').trim().slice(0, 120);
  if (b.when_to_use !== undefined) out.when_to_use = String(b.when_to_use || '').trim().slice(0, 500);
  if (b.keywords !== undefined) out.keywords = String(b.keywords || '').trim().slice(0, 600);
  if (b.content !== undefined) out.content = String(b.content || '').slice(0, 20000);
  if (b.always !== undefined) out.always = !!b.always;
  if (b.active !== undefined) out.active = !!b.active;
  return out;
}

// ── Skill / Playbook ──────────────────────────────────────────────────────
router.get('/skills', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('ai_skills').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { fail(res, 'GET /ai-sales/skills', err); }
});

router.post('/skills', requireAdmin, async (req, res) => {
  try {
    const row = skillPayload(req.body || {});
    if (!row.title || !row.content?.trim()) return res.status(400).json({ error: 'Judul dan isi skill wajib diisi.' });
    // Tanpa kata kunci -> minta AI menyarankan agar skill mudah terpilih
    if (!row.keywords) row.keywords = await suggestKeywords(row).catch(() => '');
    const { data, error } = await supabase.from('ai_skills').insert(row).select().single();
    if (error) throw error;
    invalidateKnowledgeCache();
    res.status(201).json(data);
  } catch (err) { fail(res, 'POST /ai-sales/skills', err); }
});

router.put('/skills/:id', requireAdmin, async (req, res) => {
  try {
    const row = { ...skillPayload(req.body || {}), updated_at: new Date().toISOString() };
    if (row.title === '' || (row.content !== undefined && !row.content.trim())) return res.status(400).json({ error: 'Judul dan isi skill wajib diisi.' });
    const { data, error } = await supabase.from('ai_skills').update(row).eq('id', req.params.id).select().single();
    if (error) throw error;
    invalidateKnowledgeCache();
    res.json(data);
  } catch (err) { fail(res, 'PUT /ai-sales/skills/:id', err); }
});

router.delete('/skills/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('ai_skills').delete().eq('id', req.params.id);
    if (error) throw error;
    invalidateKnowledgeCache();
    res.json({ success: true });
  } catch (err) { fail(res, 'DELETE /ai-sales/skills/:id', err); }
});

router.post('/skills/suggest-keywords', requireAdmin, async (req, res) => {
  try {
    res.json({ keywords: await suggestKeywords(skillPayload(req.body || {})) });
  } catch (err) { fail(res, 'POST /ai-sales/skills/suggest-keywords', err); }
});

// Uji: skill mana yang akan dipakai untuk contoh pesan customer
router.post('/skills/test', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('ai_skills').select('id, title, when_to_use, keywords, content, always').eq('active', true);
    if (error) throw error;
    const picked = pickSkills(data || [], String(req.body?.text || ''));
    res.json(picked.map((x) => ({ id: x.s.id, title: x.s.title, always: !!x.s.always, score: x.score, hits: x.hits })));
  } catch (err) { fail(res, 'POST /ai-sales/skills/test', err); }
});

// ── Pelajaran dari koreksi admin ──────────────────────────────────────────
router.get('/lessons', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('ai_lessons').select('*').order('created_at', { ascending: false }).limit(300);
    if (error) throw error;
    res.json(data || []);
  } catch (err) { fail(res, 'GET /ai-sales/lessons', err); }
});

// body: { message_id, better_reply, note } — koreksi atas satu balasan AI
router.post('/lessons', requireAdmin, async (req, res) => {
  try {
    const better = String(req.body?.better_reply || '').trim();
    if (!better) return res.status(400).json({ error: 'Balasan yang benar wajib diisi.' });
    const { data: msg } = await supabase.from('messages')
      .select('id, conversation_id, body, timestamp').eq('id', req.body?.message_id).maybeSingle();
    if (!msg) return res.status(404).json({ error: 'Pesan tidak ditemukan.' });
    // Pesan customer yang sedang dijawab = pesan masuk terakhir sebelum balasan AI
    const { data: prev } = await supabase.from('messages').select('body, from_me')
      .eq('conversation_id', msg.conversation_id).lt('timestamp', msg.timestamp)
      .order('timestamp', { ascending: false }).limit(6);
    const asked = [];
    for (const m of prev || []) { if (m.from_me) { if (asked.length) break; continue; } asked.unshift(m.body || ''); }
    const row = {
      conversation_id: msg.conversation_id, message_id: String(msg.id),
      customer_message: asked.join(' / ').slice(0, 1000), ai_reply: String(msg.body || '').slice(0, 1500),
      better_reply: better.slice(0, 1500), note: String(req.body?.note || '').trim().slice(0, 500),
      created_by: req.user?.type === 'service' ? null : (req.user?.id || null),
    };
    let { data, error } = await supabase.from('ai_lessons').insert(row).select().single();
    if (error && /created_by/.test(error.message || '')) {
      delete row.created_by;
      ({ data, error } = await supabase.from('ai_lessons').insert(row).select().single());
    }
    if (error) throw error;
    invalidateKnowledgeCache();
    res.status(201).json(data);
  } catch (err) { fail(res, 'POST /ai-sales/lessons', err); }
});

router.put('/lessons/:id', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const row = {};
    if (b.better_reply !== undefined) {
      row.better_reply = String(b.better_reply || '').trim().slice(0, 1500);
      if (!row.better_reply) return res.status(400).json({ error: 'Balasan yang benar wajib diisi.' });
    }
    if (b.note !== undefined) row.note = String(b.note || '').trim().slice(0, 500);
    if (b.active !== undefined) row.active = !!b.active;
    const { data, error } = await supabase.from('ai_lessons').update(row).eq('id', req.params.id).select().single();
    if (error) throw error;
    invalidateKnowledgeCache();
    res.json(data);
  } catch (err) { fail(res, 'PUT /ai-sales/lessons/:id', err); }
});

router.delete('/lessons/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('ai_lessons').delete().eq('id', req.params.id);
    if (error) throw error;
    invalidateKnowledgeCache();
    res.json({ success: true });
  } catch (err) { fail(res, 'DELETE /ai-sales/lessons/:id', err); }
});

// ── Memori customer ───────────────────────────────────────────────────────
router.get('/memory/:contactId', async (req, res) => {
  try {
    res.json((await getMemory(req.params.contactId)) || { contact_id: req.params.contactId, summary: '' });
  } catch (err) { fail(res, 'GET /ai-sales/memory', err); }
});

router.put('/memory/:contactId', requireAdmin, async (req, res) => {
  try {
    await saveMemory(req.params.contactId, String(req.body?.summary || ''));
    res.json(await getMemory(req.params.contactId));
  } catch (err) { fail(res, 'PUT /ai-sales/memory', err); }
});

// ── Pemakaian token AI ────────────────────────────────────────────────────
router.get('/usage', requireAdmin, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    res.json(await usageSummary(days));
  } catch (err) { fail(res, 'GET /ai-sales/usage', err); }
});

// ── Model AI (OpenRouter) ─────────────────────────────────────────────────
router.get('/models', requireAdmin, async (req, res) => {
  try {
    res.json({ models: await listModels(), features: AI_FEATURES });
  } catch (err) {
    console.error('GET /ai-sales/models error:', err);
    res.status(502).json({ error: `Gagal mengambil daftar model OpenRouter: ${err.message}` });
  }
});

router.get('/openrouter', requireAdmin, async (req, res) => {
  try { res.json(await keyStatus()); } catch (err) { fail(res, 'GET /ai-sales/openrouter', err); }
});

// Tes satu model dengan contoh chat customer (tanpa cadangan) -> lihat gaya & kecepatannya
router.post('/models/test', requireAdmin, async (req, res) => {
  const model = String(req.body?.model || '').trim();
  if (!model) return res.status(400).json({ error: 'Model wajib diisi.' });
  if (!aiEnabled()) return res.status(500).json({ error: 'OPENROUTER_API_KEY belum diset di server' });
  const sample = String(req.body?.message || 'halo, mau tanya pasang panel surya buat rumah kira2 berapa ya? tagihan listrik saya sekitar 800rb sebulan').slice(0, 500);
  const started = Date.now();
  try {
    const out = await generate(req.body?.feature in AI_FEATURES ? req.body.feature : 'suggest_reply', {
      models: [model],
      system: 'Kamu sales PLTS (panel surya) di Indonesia yang membalas chat WhatsApp customer. Tulis seperti manusia mengetik di HP: santai, sopan, huruf kecil semua, 1-2 kalimat pendek, sapa "bapak/ibu" (jangan "kak" atau "Anda"), tanyakan 1 hal untuk menggali kebutuhan. Balas HANYA isi pesannya.',
      prompt: `Customer: ${sample}`,
      maxTokens: 200,
      temperature: 0.8,
    });
    res.json({ ok: true, model: out.model, text: out.text, ms: Date.now() - started });
  } catch (err) {
    res.json({ ok: false, model, error: err.message, status: err.status || null, ms: Date.now() - started });
  }
});

// ── Tanya Tim ─────────────────────────────────────────────────────────────
// Riwayat per chat boleh dilihat semua user; daftar semua chat khusus admin.
router.get('/team-requests', async (req, res) => {
  try {
    const conversationId = req.query.conversation_id || null;
    if (!conversationId && req.user?.role !== 'admin') return res.status(403).json({ error: 'Khusus admin' });
    res.json(await listTeamRequests({ conversationId, limit: Math.min(100, parseInt(req.query.limit, 10) || 30) }));
  } catch (err) { fail(res, 'GET /ai-sales/team-requests', err); }
});

router.post('/team-requests/:id/close', requireAdmin, async (req, res) => {
  try { res.json(await closeTeamRequest(req.params.id)); }
  catch (err) { fail(res, 'POST /ai-sales/team-requests/:id/close', err); }
});

router.post('/team-check', requireAdmin, async (req, res) => {
  try { res.json(await checkPicNumbers(await getAiTeamConfig())); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

export default router;
