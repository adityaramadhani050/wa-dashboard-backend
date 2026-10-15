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

// Beban tiap agent = jumlah percakapan aktif (open/in_progress) yang di-assign ke dia.
// Hanya agent TERSEDIA (available !== false) yang ikut. Bila `region` diisi,
// hanya agent di regional tersebut.
async function agentLoads({ region = null, excludeId = null } = {}) {
  let agents = (await fetchAgents()).filter((a) => a.available !== false); // null/true = tersedia
  if (region) agents = agents.filter((a) => a.region === region);
  if (excludeId != null) agents = agents.filter((a) => String(a.id) !== String(excludeId));
  if (!agents.length) return [];

  const { data: convs } = await supabase
    .from('conversations')
    .select('assigned_to, status')
    .in('status', ACTIVE_STATUSES);

  const load = {};
  agents.forEach((a) => { load[a.id] = 0; });
  (convs || []).forEach((c) => {
    if (c.assigned_to != null && load[c.assigned_to] != null) load[c.assigned_to]++;
  });
  return agents.map((a) => ({ id: a.id, name: a.name, region: a.region || null, load: load[a.id] || 0 }));
}

function sortByLoad(arr) {
  arr.sort((a, b) => a.load - b.load || (String(a.id) < String(b.id) ? -1 : 1));
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
    .select('id, region, bot_state')
    .is('assigned_to', null)
    .in('status', ACTIVE_STATUSES)
    .order('updated_at', { ascending: true });
  if (res.error) {
    res = await supabase
      .from('conversations')
      .select('id')
      .is('assigned_to', null)
      .in('status', ACTIVE_STATUSES)
      .order('updated_at', { ascending: true });
  }
  const unassigned = (res.data || []).filter((c) => !BOT_HOLD_STATES.includes(c.bot_state));
  if (!unassigned.length) return { assigned: 0 };

  // Beban dihitung sekali per regional lalu diperbarui lokal tiap assignment.
  const loadsByRegion = {};
  const loadsFor = async (region) => {
    const key = region || '__all__';
    if (!loadsByRegion[key]) loadsByRegion[key] = await agentLoads({ region });
    return loadsByRegion[key];
  };

  let count = 0;
  for (const conv of unassigned) {
    const loads = sortByLoad(await loadsFor(conv.region || null));
    if (!loads.length) continue;
    const target = loads[0];
    if (await writeAssignment(conv.id, target.id)) {
      // Agent yang sama bisa muncul di daftar global & regional -> sinkronkan bebannya
      for (const list of Object.values(loadsByRegion)) {
        const same = list.find((a) => String(a.id) === String(target.id));
        if (same) same.load++;
      }
      count++;
    }
  }
  return { assigned: count };
}
