// Follow-up otomatis untuk chat bertag Follow-Up.
//
// Urutan dimulai saat chat RESOLVED:
//   H+1 CONFIRM → H+3 FEEDBACK → H+7 OBJECTION → H+14 VALUES → H+30 REACTIVATION
//   → NURTURE tiap 30 hari sampai Deal/Fail.
//
// Status urutan (followup_sequences.status):
//   waiting  -> tag pemicu ada, menunggu chat Resolved
//   active   -> ada tugas berjalan
//   paused   -> customer membalas; lanjut saat chat Resolved lagi (jadwal dihitung
//               ulang dari tanggal resolved yang baru, tahap selesai tidak diulang)
//   stopped  -> berhenti (tag Survey/Deal/Fail/Non-Client, tag pemicu dilepas,
//               atau hasil "Tertarik lanjut" / "Tidak jadi")
//
// Status tugas (followup_tasks.status): pending | paused | done | skipped | cancelled
// Catatan: pesan dari AGENT tidak menjeda urutan (mengirim follow-up memang
// membuat chat Aktif) — hanya balasan CUSTOMER yang menjeda.
import { supabase } from '../db/supabase.js';
import { sendToAgents } from '../push/fcm.js';
import { sendWebPushToAgents } from '../push/webpush.js';

export const STEPS = [
  { key: 'confirm', day: 1, label: 'CONFIRM', goal: 'Konfirmasi kembali terkait penawaran atau diskusi terakhir.' },
  { key: 'feedback', day: 3, label: 'FEEDBACK', goal: 'Tanyakan pendapat customer tentang penawaran; bagian mana yang masih perlu dijelaskan.' },
  { key: 'objection', day: 7, label: 'OBJECTION', goal: 'Gali alasan customer belum memutuskan (harga, spek, kebutuhan, timing, approval, kompetitor).' },
  { key: 'values', day: 14, label: 'VALUES', goal: 'Beri informasi tambahan sesuai keberatan: simulasi, perbandingan opsi, penjelasan teknis, atau studi kasus.' },
  { key: 'reactivation', day: 30, label: 'REACTIVATION', goal: 'Jangan anggap lost: tanyakan apakah kebutuhan masih berjalan, berubah, atau ditunda.' },
];
export const NURTURE = { key: 'nurture', every: 30, label: 'NURTURE', goal: 'Sapaan berkala: cek apakah rencana/kebutuhan customer sudah siap dilanjutkan.' };
export const STEP_META = {
  ...Object.fromEntries(STEPS.map((s) => [s.key, s])),
  nurture: NURTURE,
  manual: { key: 'manual', label: 'PENGINGAT', goal: 'Pengingat lama (dipindahkan dari fitur pengingat manual).' },
};

export const OUTCOMES = {
  no_reply: 'Tidak dibalas',
  considering: 'Dibalas, masih pertimbangan',
  objection: 'Keberatan',
  later: 'Minta dihubungi nanti',
  interested: 'Tertarik lanjut / Deal',
  lost: 'Tidak jadi / Lost',
};
export const OBJECTIONS = {
  harga: 'Harga', spek: 'Spek', kebutuhan: 'Kebutuhan',
  timing: 'Timing', approval: 'Approval', kompetitor: 'Kompetitor',
};

// ── Pengaturan (template pesan + peringatan keterlambatan) ─────────────────
export const DEFAULT_TEMPLATES = {
  confirm: 'Halo Kak {{nama}}, kami ingin memastikan penawaran yang kami kirim sudah diterima dengan baik. Apakah ada yang ingin didiskusikan lebih lanjut? 🙏',
  feedback: 'Halo Kak {{nama}}, bagaimana pendapat Kakak tentang penawaran kami? Adakah bagian yang perlu kami jelaskan lebih detail?',
  objection: 'Halo Kak {{nama}}, boleh kami tahu apa yang masih menjadi pertimbangan Kakak, misalnya dari sisi harga, spesifikasi, atau waktu pemasangan? Kami siap bantu carikan solusinya.',
  values: 'Halo Kak {{nama}}, sebagai bahan pertimbangan, kami siapkan [simulasi penghematan / perbandingan opsi / studi kasus] yang sesuai dengan kebutuhan Kakak. Boleh kami kirimkan?',
  reactivation: 'Halo Kak {{nama}}, apa kabar? Kami ingin menanyakan apakah rencana pemasangannya masih berjalan, berubah, atau ditunda dulu? Kami siap membantu kapan pun Kakak siap.',
  nurture: 'Halo Kak {{nama}}, semoga sehat selalu. Kami ingin menyapa kembali, apakah ada rencana yang bisa kami bantu dalam waktu dekat?',
};
// Peringatan ke admin: tugas terlambat lebih dari `late_days` hari kerja.
export const DEFAULT_ALERT = { enabled: true, late_days: 2 };

export function parseFollowupSettings(raw) {
  let v = {};
  try { v = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { v = {}; }
  const t = v.templates || {};
  const templates = {};
  for (const k of Object.keys(DEFAULT_TEMPLATES)) {
    templates[k] = typeof t[k] === 'string' && t[k].trim() ? t[k].trim().slice(0, 1500) : DEFAULT_TEMPLATES[k];
  }
  const a = v.alert || {};
  const days = parseInt(a.late_days, 10);
  const alert = {
    enabled: typeof a.enabled === 'boolean' ? a.enabled : DEFAULT_ALERT.enabled,
    late_days: Number.isFinite(days) ? Math.min(14, Math.max(1, days)) : DEFAULT_ALERT.late_days,
  };
  return { templates, alert };
}

export async function getFollowupConfig() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'followup_settings').maybeSingle();
  return parseFollowupSettings(data?.value);
}

const TRIGGER_RE = /follow[\s_-]*up/i;
const STOP_RES = [/surv/i, /\bdeal\b/i, /fail|gagal|batal|lost/i, /non[\s_-]*client/i];
export const isTriggerTag = (name) => TRIGGER_RE.test(name || '');
export const isStopTag = (name) => STOP_RES.some((re) => re.test(name || ''));

// ── Tanggal (WIB, UTC+7 tanpa DST) ─────────────────────────────────────────
const TZ = 7 * 3600 * 1000;
const DAY = 86400000;
export const wibDayStart = (ts) => Math.floor((new Date(ts).getTime() + TZ) / DAY) * DAY - TZ;
const wibDow = (ms) => new Date(ms + TZ).getUTCDay();

let workCache = { val: null, at: 0 };
// Pengaturan Jam & Hari Kerja: days = hari kerja (null = tidak dibatasi),
// start = jam mulai kerja (menit sejak 00:00 WIB, default 08:00).
async function getWorkCfg() {
  if (workCache.val && Date.now() - workCache.at < 60000) return workCache.val;
  const val = { days: null, start: 480 };
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'work_hours').maybeSingle();
    const wh = data?.value ? JSON.parse(data.value) : null;
    if (wh?.enabled) {
      if (Array.isArray(wh.days) && wh.days.length) val.days = wh.days;
      const [h, m] = String(wh.start || '').split(':').map((x) => parseInt(x, 10));
      if (!Number.isNaN(h)) val.start = h * 60 + (m || 0);
    }
  } catch { /* pakai default */ }
  workCache = { val, at: Date.now() };
  return val;
}
export async function getWorkDays() {
  return (await getWorkCfg()).days;
}

// Jumlah hari kerja sejak hari jatuh tempo sampai hari ini (WIB).
// Jatuh tempo Jumat, dicek Senin (Sabtu-Minggu libur) -> 1.
export function lateWorkDays(dueIso, nowMs, workDays) {
  if (!dueIso) return 0;
  const today = wibDayStart(nowMs);
  let n = 0;
  for (let d = wibDayStart(dueIso) + DAY, i = 0; d <= today && i < 400; d += DAY, i++) {
    if (!workDays || workDays.includes(wibDow(d))) n++;
  }
  return n;
}

function shiftToWorkDay(ms, workDays) {
  if (!workDays) return ms;
  for (let i = 0; i < 7 && !workDays.includes(wibDow(ms)); i++) ms += DAY;
  return ms;
}

// Jatuh tempo = awal hari (WIB) anchor + offset, minimal sehari setelah kontak
// terakhir (hindari menghubungi customer 2x sehari), digeser ke hari kerja.
export function computeDue(anchorMs, offsetDays, { minAfterMs = null, workDays = null } = {}) {
  let ms = wibDayStart(anchorMs) + offsetDays * DAY;
  if (minAfterMs != null) ms = Math.max(ms, wibDayStart(minAfterMs) + DAY);
  return new Date(shiftToWorkDay(ms, workDays)).toISOString();
}

// ── Utilitas data ───────────────────────────────────────────────────────────
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

async function tagNamesOf(conversationId) {
  const { data } = await supabase.from('conversation_tags').select('tags (name)').eq('conversation_id', conversationId);
  return (data || []).map((r) => r.tags?.name).filter(Boolean);
}

async function lastDoneAt(sequenceId) {
  const { data } = await supabase.from('followup_tasks').select('done_at')
    .eq('sequence_id', sequenceId).eq('status', 'done')
    .order('done_at', { ascending: false }).limit(1);
  return data?.[0]?.done_at ? new Date(data[0].done_at).getTime() : null;
}

async function insertTask(row) {
  const { error } = await supabase.from('followup_tasks').insert(row);
  if (error) throw error;
}

// ── Operasi urutan ──────────────────────────────────────────────────────────
// Mulai urutan. Bila chat sudah lama Resolved (data lama), langsung masuk tahap
// sesuai umurnya; tahap sebelumnya dicatat "terlewat" (bukan "selesai").
async function startSequence(conversationId, anchorMs, { existingId = null, workDays } = {}) {
  const nowIso = new Date().toISOString();
  const seqFields = { status: 'active', anchor_at: new Date(anchorMs).toISOString(), started_at: nowIso, paused_at: null, stop_reason: null, updated_at: nowIso };
  let seqId = existingId;
  if (seqId) {
    const { error } = await supabase.from('followup_sequences').update(seqFields).eq('id', seqId);
    if (error) throw error;
  } else {
    const { data, error } = await supabase.from('followup_sequences')
      .insert({ conversation_id: conversationId, ...seqFields }).select('id').single();
    if (error) {
      if (error.code === '23505') return null; // sudah dibuat proses lain
      throw error;
    }
    seqId = data.id;
  }

  const todayStart = wibDayStart(Date.now());
  const ageDays = Math.floor((todayStart - wibDayStart(anchorMs)) / DAY);
  let idx = 0;
  let due = computeDue(anchorMs, STEPS[0].day, { workDays });
  if (ageDays >= 1) {
    idx = STEPS.reduce((acc, s, i) => (s.day <= ageDays ? i : acc), 0);
    for (let i = 0; i < idx; i++) {
      await insertTask({ sequence_id: seqId, conversation_id: conversationId, step: STEPS[i].key, status: 'skipped', due_at: computeDue(anchorMs, STEPS[i].day) });
    }
    due = new Date(shiftToWorkDay(todayStart, workDays)).toISOString();
  }
  await insertTask({ sequence_id: seqId, conversation_id: conversationId, step: STEPS[idx].key, status: 'pending', due_at: due });
  return seqId;
}

async function stopSequence(seqId, reason) {
  const nowIso = new Date().toISOString();
  await supabase.from('followup_sequences').update({ status: 'stopped', stop_reason: reason, updated_at: nowIso }).eq('id', seqId);
  await supabase.from('followup_tasks').update({ status: 'cancelled' }).eq('sequence_id', seqId).in('status', ['pending', 'paused']);
}

// Lanjutkan urutan yang dijeda: jadwal dihitung ulang dari tanggal resolved baru.
async function resumeSequence(seq, workDays) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  await supabase.from('followup_sequences').update({ status: 'active', anchor_at: nowIso, paused_at: null, updated_at: nowIso }).eq('id', seq.id);
  const { data: paused } = await supabase.from('followup_tasks').select('id, step')
    .eq('sequence_id', seq.id).eq('status', 'paused');
  const lastDone = await lastDoneAt(seq.id);
  for (const t of paused || []) {
    const offset = t.step === 'nurture' ? NURTURE.every : (STEP_META[t.step]?.day || 1);
    const due = computeDue(nowMs, offset, { minAfterMs: lastDone, workDays });
    await supabase.from('followup_tasks').update({ status: 'pending', due_at: due }).eq('id', t.id);
  }
}

// Customer membalas -> jeda urutan (dipanggil dari handler pesan masuk).
export async function pauseOnCustomerReply(conversationId) {
  const { data: seq, error } = await supabase.from('followup_sequences').select('id, status')
    .eq('conversation_id', conversationId).maybeSingle();
  if (error || !seq || seq.status !== 'active') return;
  const nowIso = new Date().toISOString();
  await supabase.from('followup_sequences').update({ status: 'paused', paused_at: nowIso, updated_at: nowIso }).eq('id', seq.id);
  await supabase.from('followup_tasks').update({ status: 'paused' }).eq('sequence_id', seq.id).eq('status', 'pending');
}

// Tag chat berubah -> berhenti / mulai ulang / tunggu Resolved.
export async function onTagsChanged(conversationId) {
  const names = await tagNamesOf(conversationId);
  const { data: seq } = await supabase.from('followup_sequences').select('id, status')
    .eq('conversation_id', conversationId).maybeSingle();
  const running = seq && ['waiting', 'active', 'paused'].includes(seq.status);

  const stopTag = names.find(isStopTag);
  if (stopTag || !names.some(isTriggerTag)) {
    if (running) await stopSequence(seq.id, stopTag ? `tag:${stopTag}` : 'trigger_removed');
    return;
  }
  if (running) return; // urutan sudah berjalan

  const { data: conv } = await supabase.from('conversations').select('status').eq('id', conversationId).maybeSingle();
  if (conv?.status === 'resolved') {
    // Tag pemicu baru dipasang pada chat yang sudah selesai -> mulai dari H+1 sejak sekarang
    await startSequence(conversationId, Date.now(), { existingId: seq?.id || null, workDays: await getWorkDays() });
  } else if (seq) {
    await supabase.from('followup_sequences').update({ status: 'waiting', stop_reason: null, updated_at: new Date().toISOString() }).eq('id', seq.id);
  } else {
    await supabase.from('followup_sequences').insert({ conversation_id: conversationId, status: 'waiting' });
  }
}

// AI Sales: perbarui hasil tugas follow-up yang dikirim AI berdasarkan balasan
// customer (tugas sudah 'done' dengan hasil sementara 'Tidak dibalas').
export async function applyAiOutcome(taskId, outcome, objectionCategory = null) {
  if (!['considering', 'objection', 'later', 'interested', 'lost'].includes(outcome)) return false;
  const { data: task } = await supabase.from('followup_tasks').select('id, sequence_id').eq('id', taskId).maybeSingle();
  if (!task) return false;
  await supabase.from('followup_tasks').update({
    outcome,
    objection_category: outcome === 'objection' && OBJECTIONS[objectionCategory] ? objectionCategory : null,
  }).eq('id', taskId);
  if ((outcome === 'interested' || outcome === 'lost') && task.sequence_id) await stopSequence(task.sequence_id, `outcome:${outcome}`);
  return true;
}

// Agent menyelesaikan tugas + hasil (wajib).
export async function completeTask(taskId, { outcome, objection_category, note, next_contact_at } = {}, userId = null) {
  if (!OUTCOMES[outcome]) throw Object.assign(new Error('Pilih hasil follow-up'), { status: 400 });
  if (outcome === 'objection' && !OBJECTIONS[objection_category])
    throw Object.assign(new Error('Pilih kategori keberatan'), { status: 400 });
  let nextAt = null;
  if (outcome === 'later') {
    nextAt = next_contact_at ? new Date(next_contact_at) : null;
    if (!nextAt || Number.isNaN(nextAt.getTime())) throw Object.assign(new Error('Pilih tanggal untuk dihubungi kembali'), { status: 400 });
  }

  const { data: task } = await supabase.from('followup_tasks').select('*').eq('id', taskId).maybeSingle();
  if (!task) throw Object.assign(new Error('Tugas tidak ditemukan'), { status: 404 });
  if (!['pending', 'paused'].includes(task.status)) throw Object.assign(new Error('Tugas ini sudah selesai'), { status: 409 });

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const { error } = await supabase.from('followup_tasks').update({
    status: 'done', done_at: nowIso, done_by: userId, outcome,
    objection_category: outcome === 'objection' ? objection_category : null,
    note: note ? String(note).slice(0, 1000) : task.note,
    next_contact_at: nextAt ? nextAt.toISOString() : null,
  }).eq('id', taskId);
  if (error) throw error;

  if (task.step === 'manual' || !task.sequence_id) return { done: true };

  const { data: seq } = await supabase.from('followup_sequences').select('*').eq('id', task.sequence_id).maybeSingle();
  if (!seq) return { done: true };
  if (outcome === 'interested' || outcome === 'lost') {
    await stopSequence(seq.id, `outcome:${outcome}`);
    return { done: true, stopped: outcome };
  }

  // Tahap berikutnya
  const idx = STEPS.findIndex((s) => s.key === task.step);
  const next = idx >= 0 && idx < STEPS.length - 1 ? STEPS[idx + 1] : NURTURE;
  const workDays = await getWorkDays();
  const row = { sequence_id: seq.id, conversation_id: task.conversation_id, step: next.key, status: 'pending', due_at: null };
  if (nextAt) {
    row.due_at = computeDue(nextAt.getTime(), 0, { minAfterMs: nowMs, workDays });
  } else if (seq.status === 'paused') {
    row.status = 'paused'; // dijadwalkan saat chat Resolved lagi
  } else if (next.key === 'nurture') {
    row.due_at = computeDue(nowMs, NURTURE.every, { workDays });
  } else {
    row.due_at = computeDue(new Date(seq.anchor_at).getTime(), next.day, { minAfterMs: nowMs, workDays });
  }
  await insertTask(row);
  return { done: true, next: { step: next.key, due_at: row.due_at, status: row.status } };
}

// ── Rekonsiliasi berkala ───────────────────────────────────────────────────
// Menangani semua jalur Resolved (manual, auto-resolve 24 jam, tag Deal) tanpa
// perlu mengait tiap jalur: mulai urutan, lanjutkan yang dijeda, hentikan yang
// sudah tidak memenuhi syarat.
export async function reconcileFollowups() {
  const tags = await fetchAll(() => supabase.from('tags').select('id, name').order('id', { ascending: true }));
  const triggerIds = tags.filter((t) => isTriggerTag(t.name)).map((t) => t.id);
  const stopTags = tags.filter((t) => isStopTag(t.name));
  const stopIds = stopTags.map((t) => t.id);
  const stopNameById = Object.fromEntries(stopTags.map((t) => [t.id, t.name]));

  const ctTrigger = triggerIds.length ? await fetchAll(() => supabase.from('conversation_tags')
    .select('conversation_id').in('tag_id', triggerIds).order('conversation_id', { ascending: true })) : [];
  const ctStop = stopIds.length ? await fetchAll(() => supabase.from('conversation_tags')
    .select('conversation_id, tag_id').in('tag_id', stopIds).order('conversation_id', { ascending: true })) : [];
  const stopByConv = {};
  ctStop.forEach((r) => { stopByConv[r.conversation_id] = stopNameById[r.tag_id]; });
  const eligible = new Set(ctTrigger.map((r) => r.conversation_id).filter((id) => !stopByConv[id]));

  const seqs = await fetchAll(() => supabase.from('followup_sequences')
    .select('id, conversation_id, status, paused_at').order('id', { ascending: true }));
  const seqByConv = Object.fromEntries(seqs.map((s) => [s.conversation_id, s]));

  let started = 0, resumed = 0, stopped = 0;
  // 1) Hentikan yang tidak lagi memenuhi syarat
  for (const s of seqs) {
    if (!['waiting', 'active', 'paused'].includes(s.status) || eligible.has(s.conversation_id)) continue;
    await stopSequence(s.id, stopByConv[s.conversation_id] ? `tag:${stopByConv[s.conversation_id]}` : 'trigger_removed');
    stopped++;
  }

  // 2) Mulai (belum ada urutan / menunggu) & 3) lanjutkan yang dijeda — butuh status chat
  const needConv = [...eligible].filter((id) => {
    const s = seqByConv[id];
    return !s || s.status === 'waiting' || s.status === 'paused';
  });
  const convById = {};
  for (let i = 0; i < needConv.length; i += 150) {
    const { data } = await supabase.from('conversations').select('id, status, updated_at').in('id', needConv.slice(i, i + 150));
    (data || []).forEach((c) => { convById[c.id] = c; });
  }
  const workDays = await getWorkDays();
  for (const id of needConv) {
    const conv = convById[id];
    if (!conv || conv.status !== 'resolved') continue;
    const s = seqByConv[id];
    const resolvedMs = new Date(conv.updated_at || Date.now()).getTime();
    try {
      if (!s || s.status === 'waiting') {
        if (await startSequence(id, resolvedMs, { existingId: s?.id || null, workDays })) started++;
      } else if (s.status === 'paused' && (!s.paused_at || resolvedMs > new Date(s.paused_at).getTime())) {
        await resumeSequence(s, workDays);
        resumed++;
      }
    } catch (e) {
      console.warn(`[Followup] gagal memproses conv=${id}:`, e.message);
    }
  }
  if (started || resumed || stopped) console.log(`[Followup] mulai=${started} lanjut=${resumed} berhenti=${stopped}`);
  return { started, resumed, stopped };
}

// ── Peringatan keterlambatan untuk admin ───────────────────────────────────
const ALERT_STATE_KEY = 'followup_alert_state';

// Tugas pending yang terlambat lebih dari `lateDays` hari kerja.
export async function collectLateTasks(lateDays, workDays, nowMs = Date.now()) {
  const rows = await fetchAll(() => supabase.from('followup_tasks')
    .select('id, due_at, conversation:conversations (assigned_to, agents:assigned_to (id, name))')
    .eq('status', 'pending').lt('due_at', new Date(wibDayStart(nowMs)).toISOString())
    .order('id', { ascending: true }));
  return rows.filter((t) => lateWorkDays(t.due_at, nowMs, workDays) > lateDays);
}

// Kirim notifikasi ke semua admin sekali sehari (hari kerja, mulai jam kerja)
// bila ada tugas yang terlambat lebih dari N hari kerja.
export async function checkLateAlerts(nowMs = Date.now()) {
  const { alert } = await getFollowupConfig();
  if (!alert.enabled) return null;
  const { days, start } = await getWorkCfg();
  const wib = nowMs + TZ;
  if (days && !days.includes(new Date(wib).getUTCDay())) return null;
  if (Math.floor((wib % DAY) / 60000) < start) return null;

  const today = new Date(wib).toISOString().slice(0, 10);
  const { data: st } = await supabase.from('app_settings').select('value').eq('key', ALERT_STATE_KEY).maybeSingle();
  let lastDate = null;
  try { lastDate = JSON.parse(st?.value || '{}').date || null; } catch { lastDate = null; }
  if (lastDate === today) return null;

  const late = await collectLateTasks(alert.late_days, days, nowMs);
  // Catat dulu supaya tidak terkirim dua kali (mis. restart di hari yang sama)
  await supabase.from('app_settings').upsert(
    { key: ALERT_STATE_KEY, value: JSON.stringify({ date: today, count: late.length }), updated_at: new Date(nowMs).toISOString() },
    { onConflict: 'key' },
  );
  if (!late.length) return { sent: false, count: 0 };

  const per = {};
  late.forEach((t) => {
    const name = t.conversation?.agents?.name || 'Belum di-assign';
    per[name] = (per[name] || 0) + 1;
  });
  const parts = Object.entries(per).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`);
  const title = 'Follow-up terlambat';
  const body = `${late.length} tugas terlambat lebih dari ${alert.late_days} hari kerja: ${parts.slice(0, 4).join(', ')}${parts.length > 4 ? ', …' : ''}`;
  const { data: admins } = await supabase.from('agents').select('id').eq('role', 'admin');
  const ids = (admins || []).map((a) => a.id);
  if (ids.length) {
    const data = { url: '/followup?tab=overdue&late=1', tag: 'followup-alert' };
    await Promise.allSettled([
      sendToAgents(ids, { title, body, data }),
      sendWebPushToAgents(ids, { title, body, data }),
    ]);
  }
  console.log(`[Followup] peringatan terlambat: ${late.length} tugas -> ${ids.length} admin`);
  return { sent: ids.length > 0, count: late.length, body };
}

export function startFollowupJob(intervalMs = 5 * 60 * 1000) {
  // Tabel belum dimigrasi -> diam saja (fitur belum aktif)
  const quiet = (label) => (e) => {
    if (!/followup_/.test(e?.message || '')) console.warn(`[Followup] ${label} gagal:`, e?.message || e);
  };
  const run = async () => {
    await reconcileFollowups().catch(quiet('rekonsiliasi'));
    await checkLateAlerts().catch(quiet('peringatan terlambat'));
  };
  setTimeout(run, 60 * 1000);
  setInterval(run, intervalMs);
  console.log('[Followup] job aktif (cek tiap', Math.round(intervalMs / 60000), 'menit)');
}
