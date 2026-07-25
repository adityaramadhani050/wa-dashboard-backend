import { supabase } from '../db/supabase.js';

// Cache kecil untuk status on/off (kurangi query per pesan masuk)
let cache = { val: false, at: 0 };
const ACTIVE_STATUSES = ['open', 'in_progress'];

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

// Beban tiap agent = jumlah percakapan aktif (open/in_progress) yang di-assign ke dia.
// Hanya agent yang TERSEDIA (available !== false) yang ikut auto-assign.
async function agentLoads() {
  let ares = await supabase.from('agents').select('id, name, available').eq('role', 'agent');
  let agents;
  if (ares.error) {
    // Kolom `available` belum ada -> anggap semua tersedia (kompatibilitas).
    const fb = await supabase.from('agents').select('id, name').eq('role', 'agent');
    agents = fb.data || [];
  } else {
    agents = (ares.data || []).filter((a) => a.available !== false); // null/true = tersedia
  }
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
  return agents.map((a) => ({ id: a.id, name: a.name, load: load[a.id] || 0 }));
}

function sortByLoad(arr) {
  arr.sort((a, b) => a.load - b.load || (String(a.id) < String(b.id) ? -1 : 1));
  return arr;
}

// Assign satu percakapan unassigned ke agent paling sedikit beban. Return agentId|null.
export async function autoAssignConversation(conversationId) {
  if (!(await isAutoAssignEnabled())) return null;
  const { data: conv } = await supabase
    .from('conversations')
    .select('assigned_to')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv || conv.assigned_to) return null; // sudah ada agent / tidak ada

  const loads = sortByLoad(await agentLoads());
  if (!loads.length) return null;
  const agent = loads[0];

  // Guard .is('assigned_to', null) mencegah balapan double-assign.
  // Di-assign -> langsung "Aktif" (in_progress).
  const { data: updated } = await supabase
    .from('conversations')
    .update({ assigned_to: agent.id, status: 'in_progress', updated_at: new Date().toISOString() })
    .eq('id', conversationId)
    .is('assigned_to', null)
    .select('id')
    .maybeSingle();

  return updated ? { id: agent.id, name: agent.name } : null;
}

// Saat fitur diaktifkan: bagikan SEMUA percakapan unassigned aktif secara seimbang
export async function distributeUnassigned() {
  const loads = sortByLoad(await agentLoads());
  if (!loads.length) return { assigned: 0 };

  const { data: unassigned } = await supabase
    .from('conversations')
    .select('id')
    .is('assigned_to', null)
    .in('status', ACTIVE_STATUSES)
    .order('updated_at', { ascending: true });

  let count = 0;
  for (const conv of unassigned || []) {
    sortByLoad(loads);
    const target = loads[0];
    const { data: updated } = await supabase
      .from('conversations')
      .update({ assigned_to: target.id, status: 'in_progress', updated_at: new Date().toISOString() })
      .eq('id', conv.id)
      .is('assigned_to', null)
      .select('id')
      .maybeSingle();
    if (updated) { target.load++; count++; }
  }
  return { assigned: count };
}
