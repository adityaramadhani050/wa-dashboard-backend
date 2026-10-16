// API follow-up: daftar tugas (hari ini / terlambat / akan datang / selesai),
// lonceng, kartu follow-up di chat, penyelesaian tugas + hasil, template.
import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  STEPS, NURTURE, STEP_META, OUTCOMES, OBJECTIONS, completeTask, wibDayStart,
} from '../services/followup.js';

const router = Router();
const DAY = 86400000;

// ── Template pesan per tahap ────────────────────────────────────────────────
export const DEFAULT_TEMPLATES = {
  confirm: 'Halo Kak {{nama}}, kami ingin memastikan penawaran yang kami kirim sudah diterima dengan baik. Apakah ada yang ingin didiskusikan lebih lanjut? 🙏',
  feedback: 'Halo Kak {{nama}}, bagaimana pendapat Kakak tentang penawaran kami? Adakah bagian yang perlu kami jelaskan lebih detail?',
  objection: 'Halo Kak {{nama}}, boleh kami tahu apa yang masih menjadi pertimbangan Kakak, misalnya dari sisi harga, spesifikasi, atau waktu pemasangan? Kami siap bantu carikan solusinya.',
  values: 'Halo Kak {{nama}}, sebagai bahan pertimbangan, kami siapkan [simulasi penghematan / perbandingan opsi / studi kasus] yang sesuai dengan kebutuhan Kakak. Boleh kami kirimkan?',
  reactivation: 'Halo Kak {{nama}}, apa kabar? Kami ingin menanyakan apakah rencana pemasangannya masih berjalan, berubah, atau ditunda dulu? Kami siap membantu kapan pun Kakak siap.',
  nurture: 'Halo Kak {{nama}}, semoga sehat selalu. Kami ingin menyapa kembali, apakah ada rencana yang bisa kami bantu dalam waktu dekat?',
};

function parseTemplates(raw) {
  let v = {};
  try { v = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { v = {}; }
  const t = v.templates || v;
  const out = {};
  for (const k of Object.keys(DEFAULT_TEMPLATES)) {
    out[k] = typeof t[k] === 'string' && t[k].trim() ? t[k].trim().slice(0, 1500) : DEFAULT_TEMPLATES[k];
  }
  return out;
}

async function getTemplates() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'followup_settings').maybeSingle();
  return parseTemplates(data?.value);
}

const isAdmin = (req) => req.user?.role === 'admin';

// ── Ambil tugas sesuai cakupan user ─────────────────────────────────────────
async function fetchAll(build) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

const TASK_COLS = `id, sequence_id, conversation_id, step, status, due_at, done_at, done_by, outcome,
  objection_category, note, next_contact_at, created_at,
  conversation:conversations (id, status, region, assigned_to,
    contact:contacts (name, phone, manual_wa_number, region),
    agents:assigned_to (id, name))`;

// Tugas aktif (pending/paused) + selesai 90 hari terakhir, difilter per user.
async function fetchScopedTasks(req) {
  const since = new Date(Date.now() - 90 * DAY).toISOString();
  const [open, done] = await Promise.all([
    fetchAll(() => supabase.from('followup_tasks').select(TASK_COLS)
      .in('status', ['pending', 'paused']).order('id', { ascending: true })),
    fetchAll(() => supabase.from('followup_tasks').select(TASK_COLS)
      .eq('status', 'done').gte('done_at', since).order('id', { ascending: true })),
  ]);
  let rows = [...open, ...done];
  if (req.user && !isAdmin(req)) {
    rows = rows.filter((t) => String(t.conversation?.assigned_to) === String(req.user.id));
  } else {
    const { agent_id, region } = req.query;
    if (agent_id === 'unassigned') rows = rows.filter((t) => !t.conversation?.assigned_to);
    else if (agent_id) rows = rows.filter((t) => String(t.conversation?.assigned_to) === String(agent_id));
    if (region) rows = rows.filter((t) => (t.conversation?.region || t.conversation?.contact?.region) === region);
  }
  return rows;
}

function shape(t, lastByConv = {}) {
  const c = t.conversation || {};
  const last = lastByConv[t.conversation_id];
  return {
    id: t.id,
    step: t.step,
    step_label: STEP_META[t.step]?.label || t.step,
    status: t.status,
    due_at: t.due_at,
    done_at: t.done_at,
    outcome: t.outcome,
    outcome_label: t.outcome ? OUTCOMES[t.outcome] : null,
    objection_category: t.objection_category,
    note: t.note,
    next_contact_at: t.next_contact_at,
    conversation: {
      id: c.id || t.conversation_id,
      status: c.status,
      region: c.region || c.contact?.region || null,
      contact_name: c.contact?.name || c.contact?.manual_wa_number || c.contact?.phone || 'Customer',
      phone: c.contact?.manual_wa_number || c.contact?.phone || null,
      agent: c.agents ? { id: c.agents.id, name: c.agents.name } : null,
    },
    last: last && last.id !== t.id ? {
      step_label: STEP_META[last.step]?.label || last.step,
      outcome_label: OUTCOMES[last.outcome] || null,
      objection_category: last.objection_category,
      note: last.note,
      done_at: last.done_at,
    } : null,
  };
}

function lastDoneByConv(rows) {
  const map = {};
  rows.filter((t) => t.status === 'done').forEach((t) => {
    if (!map[t.conversation_id] || t.done_at > map[t.conversation_id].done_at) map[t.conversation_id] = t;
  });
  return map;
}

function bucket(t, todayStart) {
  if (t.status === 'done') return 'done';
  if (t.status === 'paused' || !t.due_at) return 'upcoming';
  const due = new Date(t.due_at).getTime();
  if (due < todayStart) return 'overdue';
  if (due < todayStart + DAY) return 'today';
  return 'upcoming';
}

// GET /tasks?view=today|overdue|upcoming|done&agent_id=&region=
router.get('/tasks', async (req, res) => {
  try {
    const view = ['today', 'overdue', 'upcoming', 'done'].includes(req.query.view) ? req.query.view : 'today';
    const rows = await fetchScopedTasks(req);
    const todayStart = wibDayStart(Date.now());
    const lastBy = lastDoneByConv(rows);
    let list = rows.filter((t) => bucket(t, todayStart) === view);
    if (view === 'done') list.sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''));
    else list.sort((a, b) => (a.status === 'paused') - (b.status === 'paused') || (a.due_at || '').localeCompare(b.due_at || ''));
    const counts = { today: 0, overdue: 0, upcoming: 0, done: 0 };
    rows.forEach((t) => { counts[bucket(t, todayStart)]++; });
    res.json({ view, counts, tasks: list.slice(0, 500).map((t) => shape(t, lastBy)) });
  } catch (err) {
    console.error('GET /followup/tasks error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /summary — ringkasan per agent (admin)
router.get('/summary', requireAdmin, async (req, res) => {
  try {
    const rows = await fetchScopedTasks(req);
    const todayStart = wibDayStart(Date.now());
    const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
    const per = {};
    rows.forEach((t) => {
      const a = t.conversation?.agents;
      const key = a?.id || 'unassigned';
      const p = (per[key] = per[key] || { agent_id: a?.id || null, name: a?.name || 'Belum di-assign', today: 0, overdue: 0, upcoming: 0, done_week: 0 });
      const b = bucket(t, todayStart);
      if (b === 'done') { if (t.done_at >= weekAgo) p.done_week++; } else p[b]++;
    });
    res.json(Object.values(per).sort((x, y) => y.overdue - x.overdue || y.today - x.today));
  } catch (err) {
    console.error('GET /followup/summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /due — untuk lonceng: tugas hari ini & terlambat milik user (admin: semua)
router.get('/due', async (req, res) => {
  try {
    const rows = await fetchScopedTasks(req);
    const todayStart = wibDayStart(Date.now());
    const due = rows
      .filter((t) => t.status === 'pending' && t.due_at && new Date(t.due_at).getTime() < todayStart + DAY)
      .sort((a, b) => (a.due_at || '').localeCompare(b.due_at || ''));
    res.json({ count: due.length, tasks: due.slice(0, 50).map((t) => shape(t)) });
  } catch (err) {
    // Tabel belum dimigrasi -> lonceng kosong (jangan ganggu UI)
    if (/followup_/.test(err?.message || '')) return res.json({ count: 0, tasks: [] });
    console.error('GET /followup/due error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /conversation/:id — kartu follow-up di chat
router.get('/conversation/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [{ data: seq }, { data: tasks, error }] = await Promise.all([
      supabase.from('followup_sequences').select('*').eq('conversation_id', id).maybeSingle(),
      supabase.from('followup_tasks')
        .select('id, sequence_id, step, status, due_at, done_at, outcome, objection_category, note, next_contact_at, created_at')
        .eq('conversation_id', id).order('created_at', { ascending: true }),
    ]);
    if (error) throw error;
    const all = (tasks || []).map((t) => ({
      ...t,
      step_label: STEP_META[t.step]?.label || t.step,
      outcome_label: t.outcome ? OUTCOMES[t.outcome] : null,
    }));
    // Progres hanya untuk putaran urutan yang sedang berjalan
    const runStart = seq?.started_at || null;
    const run = all.filter((t) => t.sequence_id && t.sequence_id === seq?.id && (!runStart || t.created_at >= runStart));
    const current = all.filter((t) => t.status === 'pending' || t.status === 'paused')
      .sort((a, b) => (a.due_at || '9').localeCompare(b.due_at || '9'))[0] || null;
    res.json({ sequence: seq || null, current, run, history: all.filter((t) => t.status === 'done').reverse() });
  } catch (err) {
    if (/followup_/.test(err?.message || '')) return res.json({ sequence: null, current: null, run: [], history: [], migrated: false });
    console.error('GET /followup/conversation/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /tasks/:id/complete — body: { outcome, objection_category?, note?, next_contact_at? }
router.post('/tasks/:id/complete', async (req, res) => {
  try {
    if (req.user && !isAdmin(req)) {
      const { data: t } = await supabase.from('followup_tasks')
        .select('conversation:conversations (assigned_to)').eq('id', req.params.id).maybeSingle();
      if (t && String(t.conversation?.assigned_to) !== String(req.user.id)) {
        return res.status(403).json({ error: 'Tugas ini bukan milik Anda' });
      }
    }
    const result = await completeTask(req.params.id, req.body || {}, req.user?.id || null);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /followup/tasks/:id/complete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /settings — template + daftar tahap/hasil/keberatan untuk UI
router.get('/settings', async (req, res) => {
  try {
    res.json({
      templates: await getTemplates(),
      steps: [...STEPS, NURTURE].map((s) => ({ key: s.key, label: s.label, day: s.day ?? null, every: s.every ?? null, goal: s.goal })),
      outcomes: OUTCOMES,
      objections: OBJECTIONS,
    });
  } catch (err) {
    console.error('GET /followup/settings error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/settings', requireAdmin, async (req, res) => {
  try {
    const templates = parseTemplates(req.body?.templates || {});
    const { error } = await supabase.from('app_settings')
      .upsert({ key: 'followup_settings', value: JSON.stringify({ templates }), updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    res.json({ templates });
  } catch (err) {
    console.error('PUT /followup/settings error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
