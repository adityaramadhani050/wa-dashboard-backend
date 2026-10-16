// API follow-up: daftar tugas (hari ini / terlambat / akan datang / selesai),
// lonceng, kartu follow-up di chat, penyelesaian tugas + hasil, template.
import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  STEPS, NURTURE, STEP_META, OUTCOMES, OBJECTIONS, completeTask, wibDayStart,
  getFollowupConfig, parseFollowupSettings, getWorkDays, lateWorkDays,
} from '../services/followup.js';

const router = Router();
const DAY = 86400000;

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

// late = { nowMs, workDays, lateDays } -> tambahkan hari kerja terlambat + flag peringatan
function shape(t, lastByConv = {}, late = null) {
  const c = t.conversation || {};
  const last = lastByConv[t.conversation_id];
  const lateDays = late && t.status === 'pending' && t.due_at && new Date(t.due_at).getTime() < wibDayStart(late.nowMs)
    ? lateWorkDays(t.due_at, late.nowMs, late.workDays) : 0;
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
    late_days: lateDays,
    alert: !!late && lateDays > late.lateDays,
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

// Konteks keterlambatan: hari kerja + ambang peringatan (N hari kerja)
async function lateCtx() {
  const [{ alert }, workDays] = await Promise.all([getFollowupConfig(), getWorkDays()]);
  return { nowMs: Date.now(), workDays, lateDays: alert.late_days, enabled: alert.enabled };
}
const isAlert = (t, ctx) => t.status === 'pending' && !!t.due_at
  && new Date(t.due_at).getTime() < wibDayStart(ctx.nowMs)
  && lateWorkDays(t.due_at, ctx.nowMs, ctx.workDays) > ctx.lateDays;

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
    const [rows, ctx] = await Promise.all([fetchScopedTasks(req), lateCtx()]);
    const todayStart = wibDayStart(Date.now());
    const lastBy = lastDoneByConv(rows);
    let list = rows.filter((t) => bucket(t, todayStart) === view);
    if (view === 'done') list.sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''));
    else list.sort((a, b) => (a.status === 'paused') - (b.status === 'paused') || (a.due_at || '').localeCompare(b.due_at || ''));
    const counts = { today: 0, overdue: 0, upcoming: 0, done: 0 };
    rows.forEach((t) => { counts[bucket(t, todayStart)]++; });
    res.json({
      view,
      counts,
      alert_days: ctx.lateDays,
      alert_count: rows.filter((t) => isAlert(t, ctx)).length,
      tasks: list.slice(0, 500).map((t) => shape(t, lastBy, ctx)),
    });
  } catch (err) {
    console.error('GET /followup/tasks error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /summary — ringkasan per agent (admin)
router.get('/summary', requireAdmin, async (req, res) => {
  try {
    const [rows, ctx] = await Promise.all([fetchScopedTasks(req), lateCtx()]);
    const todayStart = wibDayStart(Date.now());
    const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
    const per = {};
    rows.forEach((t) => {
      const a = t.conversation?.agents;
      const key = a?.id || 'unassigned';
      const p = (per[key] = per[key] || { agent_id: a?.id || null, name: a?.name || 'Belum di-assign', today: 0, overdue: 0, upcoming: 0, done_week: 0, late_alert: 0 });
      const b = bucket(t, todayStart);
      if (isAlert(t, ctx)) p.late_alert++;
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
    const [rows, ctx] = await Promise.all([fetchScopedTasks(req), lateCtx()]);
    const todayStart = wibDayStart(Date.now());
    const due = rows
      .filter((t) => t.status === 'pending' && t.due_at && new Date(t.due_at).getTime() < todayStart + DAY)
      .sort((a, b) => (a.due_at || '').localeCompare(b.due_at || ''));
    // Admin: ringkasan tugas yang terlambat > N hari kerja (peringatan)
    let alert = null;
    if (isAdmin(req) && ctx.enabled) {
      const per = {};
      const late = due.filter((t) => isAlert(t, ctx));
      late.forEach((t) => {
        const n = t.conversation?.agents?.name || 'Belum di-assign';
        per[n] = (per[n] || 0) + 1;
      });
      alert = {
        late_days: ctx.lateDays,
        count: late.length,
        by_agent: Object.entries(per).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      };
    }
    res.json({ count: due.length, alert, tasks: due.slice(0, 50).map((t) => shape(t, {}, ctx)) });
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

// GET /settings — template + peringatan + daftar tahap/hasil/keberatan untuk UI
router.get('/settings', async (req, res) => {
  try {
    const { templates, alert } = await getFollowupConfig();
    res.json({
      templates,
      alert,
      steps: [...STEPS, NURTURE].map((s) => ({ key: s.key, label: s.label, day: s.day ?? null, every: s.every ?? null, goal: s.goal })),
      outcomes: OUTCOMES,
      objections: OBJECTIONS,
    });
  } catch (err) {
    console.error('GET /followup/settings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /settings — body: { templates?, alert? }; bagian yang tidak dikirim tetap
router.put('/settings', requireAdmin, async (req, res) => {
  try {
    const cur = await getFollowupConfig();
    const next = parseFollowupSettings({
      templates: req.body?.templates || cur.templates,
      alert: { ...cur.alert, ...(req.body?.alert || {}) },
    });
    const { error } = await supabase.from('app_settings')
      .upsert({ key: 'followup_settings', value: JSON.stringify(next), updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    res.json(next);
  } catch (err) {
    console.error('PUT /followup/settings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Laporan follow-up (Analytics) ──────────────────────────────────────────
// GET /report?from=YYYY-MM-DD&to=YYYY-MM-DD&region=barat|timur
//  - Kepatuhan per agent: tugas yang jatuh tempo di rentang -> tepat waktu / telat / belum.
//    Tugas yang belum lewat hari jatuh temponya tidak dihitung.
//  - Hasil per tahap: tugas yang dikerjakan di rentang -> dibalas, keberatan, dan
//    berapa yang berujung Survey/Deal atau Lost. Hasil akhir dicatat pada tahap
//    follow-up TERAKHIR yang dikerjakan sebelum urutan berhenti.
//  - Sebaran alasan keberatan (unik per chat).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function seqResult(s) {
  if (!s || s.status !== 'stopped') return null;
  const r = s.stop_reason || '';
  if (r === 'outcome:interested') return 'converted';
  if (r === 'outcome:lost') return 'lost';
  if (r.startsWith('tag:')) {
    const name = r.slice(4);
    if (/surv/i.test(name) || /\bdeal\b/i.test(name)) return 'converted';
    if (/fail|gagal|batal|lost/i.test(name)) return 'lost';
  }
  return null;
}

async function fetchAgentsForReport() {
  let r = await supabase.from('agents').select('id, name, role, region');
  if (r.error) r = await supabase.from('agents').select('id, name, role');
  return r.data || [];
}

router.get('/report', requireAdmin, async (req, res) => {
  try {
    const nowMs = Date.now();
    const todayWib = new Date(nowMs + 7 * 3600000).toISOString().slice(0, 10);
    const toStr = DATE_RE.test(req.query.to || '') ? req.query.to : todayWib;
    const fromStr = DATE_RE.test(req.query.from || '') ? req.query.from
      : new Date(Date.parse(`${toStr}T00:00:00Z`) - 29 * DAY).toISOString().slice(0, 10);
    const fromMs = Date.parse(`${fromStr}T00:00:00+07:00`);
    const toMs = Date.parse(`${toStr}T00:00:00+07:00`) + DAY;
    const region = ['barat', 'timur'].includes(req.query.region) ? req.query.region : null;
    const inRange = (iso) => {
      if (!iso) return false;
      const t = new Date(iso).getTime();
      return t >= fromMs && t < toMs;
    };

    const [ctx, tasksAll, seqs, agentsList, tags] = await Promise.all([
      lateCtx(),
      fetchAll(() => supabase.from('followup_tasks')
        .select(`id, sequence_id, conversation_id, step, status, due_at, done_at, outcome, objection_category,
          conversation:conversations (assigned_to, region, contact:contacts (region))`)
        .order('id', { ascending: true })),
      fetchAll(() => supabase.from('followup_sequences')
        .select('id, conversation_id, status, stop_reason, updated_at').order('id', { ascending: true })),
      fetchAgentsForReport(),
      fetchAll(() => supabase.from('tags').select('id, name').order('id', { ascending: true })),
    ]);
    const dealTagIds = tags.filter((t) => /\bdeal\b/i.test(t.name || '')).map((t) => t.id);
    const dealConvs = new Set(dealTagIds.length
      ? (await fetchAll(() => supabase.from('conversation_tags').select('conversation_id')
        .in('tag_id', dealTagIds).order('conversation_id', { ascending: true }))).map((r) => r.conversation_id)
      : []);

    const tasks = region
      ? tasksAll.filter((t) => (t.conversation?.region || t.conversation?.contact?.region) === region)
      : tasksAll;
    const seqById = Object.fromEntries(seqs.map((s) => [s.id, s]));
    const nameById = Object.fromEntries(agentsList.map((a) => [a.id, a.name]));
    const todayStart = wibDayStart(nowMs);

    // Baris per agent (semua agent ditampilkan walau 0)
    const per = {};
    const row = (id) => {
      const key = id || 'unassigned';
      if (!per[key]) {
        per[key] = {
          agent_id: id || null, name: id ? (nameById[id] || 'Agent') : 'Belum di-assign',
          due: 0, on_time: 0, late_done: 0, open_late: 0, done: 0, late_alert: 0,
        };
      }
      return per[key];
    };
    agentsList.filter((a) => a.role === 'agent' && (!region || a.region === region)).forEach((a) => row(a.id));

    // Tugas follow-up terakhir yang dikerjakan per urutan (untuk atribusi hasil akhir)
    const lastDoneBySeq = {};
    tasks.forEach((t) => {
      if (t.status !== 'done' || !t.sequence_id || t.step === 'manual') return;
      const cur = lastDoneBySeq[t.sequence_id];
      if (!cur || (t.done_at || '') > (cur.done_at || '')) lastDoneBySeq[t.sequence_id] = t;
    });

    const stepList = [...STEPS, NURTURE];
    const steps = Object.fromEntries(stepList.map((s) => [s.key, {
      step: s.key, label: s.label, day: s.day ?? null, done: 0, replied: 0, objection: 0, converted: 0, deal: 0, lost: 0,
    }]));
    const outcomeCount = Object.fromEntries(Object.keys(OUTCOMES).map((k) => [k, 0]));
    const objConvs = {};
    const running = new Set();
    let doneTotal = 0;

    for (const t of tasks) {
      const r = row(t.conversation?.assigned_to || null);
      if (t.status === 'pending' || t.status === 'paused') running.add(t.conversation_id);
      if (isAlert(t, ctx)) r.late_alert++;

      if (inRange(t.due_at) && (t.status === 'done'
        || (t.status === 'pending' && new Date(t.due_at).getTime() < todayStart))) {
        r.due++;
        if (t.status === 'pending') r.open_late++;
        else if (t.done_at && wibDayStart(t.done_at) <= wibDayStart(t.due_at)) r.on_time++;
        else r.late_done++;
      }

      if (t.status !== 'done' || !inRange(t.done_at)) continue;
      r.done++;
      doneTotal++;
      if (outcomeCount[t.outcome] != null) outcomeCount[t.outcome]++;
      if (t.outcome === 'objection' && t.objection_category) {
        (objConvs[t.objection_category] = objConvs[t.objection_category] || new Set()).add(t.conversation_id);
      }
      const st = steps[t.step];
      if (!st) continue; // pengingat manual lama
      st.done++;
      if (t.outcome && t.outcome !== 'no_reply') st.replied++;
      if (t.outcome === 'objection') st.objection++;
      const seq = seqById[t.sequence_id];
      const result = seqResult(seq);
      if (result && lastDoneBySeq[seq.id]?.id === t.id) {
        if (result === 'converted') {
          st.converted++;
          if (dealConvs.has(t.conversation_id)) st.deal++;
        } else st.lost++;
      }
    }

    // Lanjut Survey/Deal di rentang ini sebelum ada follow-up yang dikerjakan
    const convsInScope = new Set(tasks.map((t) => t.conversation_id));
    const preFollowup = seqs.filter((s) => seqResult(s) === 'converted' && inRange(s.updated_at)
      && convsInScope.has(s.conversation_id) && !lastDoneBySeq[s.id]).length;

    const agents = Object.values(per)
      .filter((a) => a.agent_id || a.due || a.done || a.late_alert)
      .map((a) => ({ ...a, on_time_pct: a.due ? Math.round((a.on_time / a.due) * 100) : null }))
      .sort((a, b) => (!a.agent_id) - (!b.agent_id) || b.due - a.due || a.name.localeCompare(b.name));
    const stepRows = stepList.map((s) => ({ ...steps[s.key], converted_pct: steps[s.key].done ? Math.round((steps[s.key].converted / steps[s.key].done) * 100) : null }));
    const sumA = (k) => agents.reduce((acc, a) => acc + a[k], 0);
    const sumS = (k) => stepRows.reduce((acc, s) => acc + s[k], 0);
    const due = sumA('due');
    const stepDone = sumS('done');

    res.json({
      from: fromStr,
      to: toStr,
      region,
      alert_days: ctx.lateDays,
      totals: {
        done: doneTotal,
        due,
        on_time: sumA('on_time'),
        late_done: sumA('late_done'),
        open_late: sumA('open_late'),
        on_time_pct: due ? Math.round((sumA('on_time') / due) * 100) : null,
        replied: sumS('replied'),
        replied_pct: stepDone ? Math.round((sumS('replied') / stepDone) * 100) : null,
        converted: sumS('converted'),
        deal: sumS('deal'),
        lost: sumS('lost'),
        pre_followup: preFollowup,
        running: running.size,
        late_alert: sumA('late_alert'),
      },
      agents,
      steps: stepRows,
      objections: Object.entries(OBJECTIONS)
        .map(([key, label]) => ({ key, label, count: objConvs[key]?.size || 0 }))
        .sort((a, b) => b.count - a.count),
      outcomes: Object.entries(OUTCOMES).map(([key, label]) => ({ key, label, count: outcomeCount[key] })),
    });
  } catch (err) {
    if (/followup_/.test(err?.message || '')) return res.json({ migrated: false });
    console.error('GET /followup/report error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
