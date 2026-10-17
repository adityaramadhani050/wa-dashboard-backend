import { supabase } from '../db/supabase.js';

// Cache kecil untuk status on/off (kurangi query per pesan masuk)
let cache = { val: false, at: 0 };
const ACTIVE_STATUSES = ['open', 'in_progress'];
// Percakapan yang sedang ditangani bot lokasi / menunggu keputusan admin
// tidak boleh dibagikan otomatis.
const BOT_HOLD_STATES = ['awaiting_location', 'unresolved'];

export async function isAutoAssignEnabled() {
  const now = Date.now();
  if (now - cache.at < 10000) return cache.val;
  try {
    const { data } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'auto_assign')
      .maybeSingle();
    cache = { val: data?.value === 'true', at: now };
  } catch {
    cache = { val: false, at: now };
  }
  return cache.val;
}

export function invalidateAutoAssignCache() {
  cache.at = 0;
}

// Daftar agent (role agent) + regional & ketersediaannya. Toleran bila kolom
// `available` / `region` belum ada di database.
async function fetchAgents() {
  for (const cols of ['id, name, available, region', 'id, name, available', 'id, name']) {
    const res = await supabase.from('agents').select(cols).eq('role', 'agent');
    if (!res.error) return res.data || [];
  }
  return [];
}

// Ambil semua baris (Supabase membatasi 1000 baris per query).
async function fetchAll(build) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) return all;
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

// Awal hari ini dalam WIB (UTC+7) sebagai ISO UTC.
function todayStartWibIso() {
  const day = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  return new Date(day + 'T00:00:00+07:00').toISOString();
}

// Jumlah kontak baru hari ini (WIB) yang percakapannya di-assign ke tiap agent.
// Satu kontak dihitung sekali.
async function newContactCountsToday() {
  const contacts = await fetchAll(() => supabase
    .from('contacts').select('id')
    .gte('created_at', todayStartWibIso())
    .order('id', { ascending: true }));
  const ids = contacts.map((c) => c.id);
  const byContact = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase
      .from('conversations')
      .select('contact_id, assigned_to')
      .in('contact_id', ids.slice(i, i + 100))
      .not('assigned_to', 'is', null);
    (data || []).forEach((c) => { if (!byContact.has(c.contact_id)) byContact.set(c.contact_id, c.assigned_to); });
  }
  const counts = {};
  for (const agentId of byContact.values()) counts[agentId] = (counts[agentId] || 0) + 1;
  return counts;
}

// Beban tiap agent = jumlah KONTAK BARU hari ini (WIB) yang sudah di-assign ke dia.
// Chat aktif tidak dipakai sebagai dasar karena bisa berasal dari follow-up
// customer lama; hanya jadi penentu bila jumlah kontak baru sama.
// Hanya agent TERSEDIA (available !== false) yang ikut. Bila `region` diisi,
// hanya agent di regional tersebut.
async function agentLoads({ region = null, excludeId = null } = {}) {
  let agents = (await fetchAgents()).filter((a) => a.available !== false); // null/true = tersedia
  if (region) agents = agents.filter((a) => a.region === region);
  if (excludeId != null) agents = agents.filter((a) => String(a.id) !== String(excludeId));
  if (!agents.length) return [];

  const [newCounts, convs] = await Promise.all([
    newContactCountsToday(),
    fetchAll(() => supabase
      .from('conversations')
      .select('id, assigned_to')
      .in('status', ACTIVE_STATUSES)
      .not('assigned_to', 'is', null)
      .order('id', { ascending: true })),
  ]);

  const active = {};
  convs.forEach((c) => { active[c.assigned_to] = (active[c.assigned_to] || 0) + 1; });
  return agents.map((a) => ({
    id: a.id, name: a.name, region: a.region || null,
    load: newCounts[a.id] || 0,
    active: active[a.id] || 0,
  }));
}

function sortByLoad(arr) {
  arr.sort((a, b) => a.load - b.load || a.active - b.active || (String(a.id) < String(b.id) ? -1 : 1));
  return arr;
}

// Tulis assignment dengan guard anti-balapan. `expectAgentId` null = hanya bila
// belum ter-assign; selain itu hanya bila masih dipegang agent tsb (reassign).
async function writeAssignment(conversationId, agentId, { expectAgentId = null } = {}) {
  const now = new Date().toISOString();
  const base = { assigned_to: agentId, status: 'in_progress', updated_at: now };
  const run = (patch) => {
    let q = supabase.from('conversations').update(patch).eq('id', conversationId);
    q = expectAgentId != null ? q.eq('assigned_to', expectAgentId) : q.is('assigned_to', null);
    return q.select('id').maybeSingle();
  };
  let res = await run({ ...base, assigned_at: now });
  if (res.error) res = await run(base); // kolom assigned_at belum ada
  return !!res.data;
}

// Assign satu percakapan unassigned ke agent paling sedikit beban.
// `region` diisi -> hanya agent regional tsb; kosong -> semua agent (global).
// Return { id, name, region } | null (null = tetap di antrian).
export async function routeConversation(conversationId, { region = null } = {}) {
  if (!(await isAutoAssignEnabled())) return null;
  const { data: conv } = await supabase
    .from('conversations')
    .select('assigned_to')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv || conv.assigned_to) return null; // sudah ada agent / tidak ada

  const loads = sortByLoad(await agentLoads({ region }));
  if (!loads.length) return null; // regional ini sedang tidak punya agent tersedia
  const agent = loads[0];
  const ok = await writeAssignment(conversationId, agent.id);
  return ok ? { id: agent.id, name: agent.name, region: agent.region } : null;
}

// Kompatibilitas: auto-assign global (tanpa regional).
export async function autoAssignConversation(conversationId) {
  return routeConversation(conversationId, {});
}

// Customer lama kembali, tapi agent yang memegang chat-nya sedang TIDAK tersedia
// -> pindahkan ke agent lain se-regional (atau global bila regional tak diketahui).
// Bila tidak ada pengganti, chat tetap di agent lama (tidak ditelantarkan).
export async function rerouteIfAgentUnavailable(conversationId, currentAgentId, { region = null } = {}) {
  if (!currentAgentId || !(await isAutoAssignEnabled())) return null;
  const agents = await fetchAgents();
  const current = agents.find((a) => String(a.id) === String(currentAgentId));
  if (!current || current.available !== false) return null; // masih tersedia / bukan agent
  const targetRegion = region || current.region || null;
  const loads = sortByLoad(await agentLoads({ region: targetRegion, excludeId: currentAgentId }));
  if (!loads.length) return null;
  const agent = loads[0];
  const ok = await writeAssignment(conversationId, agent.id, { expectAgentId: currentAgentId });
  return ok ? { id: agent.id, name: agent.name, region: agent.region } : null;
}

// Bagikan SEMUA percakapan unassigned aktif secara seimbang (dipanggil saat fitur
// diaktifkan atau saat ada agent yang kembali tersedia). Chat yang sedang
// ditangani bot / menunggu keputusan admin dilewati; chat ber-regional hanya
// diberikan ke agent regional yang sama.
export async function distributeUnassigned() {
  if (!(await isAutoAssignEnabled())) return { assigned: 0 };

  let res = await supabase
    .from('conversations')
    .select('id, region, bot_state, contact:contacts (created_at)')
    .is('assigned_to', null)
    .in('status', ACTIVE_STATUSES)
    .order('updated_at', { ascending: true });
  if (res.error) {
    res = await supabase
      .from('conversations')
      .select('id, contact:contacts (created_at)')
      .is('assigned_to', null)
      .in('status', ACTIVE_STATUSES)
      .order('updated_at', { ascending: true });
  }
  const unassigned = (res.data || []).filter((c) => !BOT_HOLD_STATES.includes(c.bot_state));
  if (!unassigned.length) return { assigned: 0 };

  // Beban (kontak baru hari ini + chat aktif) dihitung sekali per regional lalu
  // diperbarui lokal tiap assignment.
  const loadsByRegion = {};
  const loadsFor = async (region) => {
    const key = region || '__all__';
    if (!loadsByRegion[key]) loadsByRegion[key] = await agentLoads({ region });
    return loadsByRegion[key];
  };

  const todayStart = new Date(todayStartWibIso()).getTime();
  let count = 0;
  for (const conv of unassigned) {
    const created = conv.contact?.created_at ? new Date(conv.contact.created_at).getTime() : 0;
    const isNewToday = created >= todayStart;
    const loads = sortByLoad(await loadsFor(conv.region || null));
    if (!loads.length) continue;
    const target = loads[0];
    if (await writeAssignment(conv.id, target.id)) {
      // Agent yang sama bisa muncul di daftar global & regional -> sinkronkan bebannya
      for (const list of Object.values(loadsByRegion)) {
        const same = list.find((a) => String(a.id) === String(target.id));
        if (same) { if (isNewToday) same.load++; same.active++; }
      }
      count++;
    }
  }
  return { assigned: count };
}
