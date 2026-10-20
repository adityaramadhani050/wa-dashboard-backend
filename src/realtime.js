// Pengiriman event realtime (Socket.io) berdasarkan hak akses:
// - Event per chat (pesan baru, status centang, update/hapus pesan, perubahan
//   chat, assign) hanya ke ADMIN + AGENT pemegang chat (room `agent:<id>`).
//   Saat chat dipindah, agent lama ikut menerima event assign agar chat
//   langsung hilang dari daftarnya.
// - Event WhatsApp (QR, status, sinkron) : QR hanya admin, sisanya semua.
// Room diisi saat socket tersambung (lihat index.js: autentikasi token).
import { supabase } from './db/supabase.js';

let io = null;
export function setRealtimeIO(instance) { io = instance; }

const SCOPED = new Set(['new_message', 'message_status', 'message_updated', 'message_deleted', 'conversation_updated', 'conversation_assigned']);
const ADMIN_ONLY = new Set(['qr']);

// Cache pemegang chat (dipakai banyak event berturut-turut)
const assignee = new Map(); // convId -> { id, at }
const TTL_MS = 15000;
async function assigneeOf(convId) {
  const c = assignee.get(convId);
  if (c && Date.now() - c.at < TTL_MS) return c.id;
  const { data } = await supabase.from('conversations').select('assigned_to').eq('id', convId).maybeSingle();
  const id = data?.assigned_to ? String(data.assigned_to) : null;
  assignee.set(convId, { id, at: Date.now() });
  if (assignee.size > 5000) assignee.clear();
  return id;
}

function convIdOf(data) {
  const v = data?.conversationId ?? data?.conversation_id ?? data?.message?.conversation_id;
  return v != null ? String(v) : null;
}

// Info ringkas untuk notifikasi agent yang baru menerima chat
async function assignInfo(convId) {
  const { data } = await supabase.from('conversations')
    .select('last_message, last_from_me, contact:contacts (name, phone)').eq('id', convId).maybeSingle();
  if (!data) return {};
  return {
    contactName: data.contact?.name || data.contact?.phone || null,
    lastMessage: data.last_message ?? null,
    lastFromMe: data.last_from_me ?? null,
  };
}

// Kirim ke socket di instance ini sesuai hak akses.
export async function emitLocal(channel, data) {
  if (!io) return;
  if (ADMIN_ONLY.has(channel)) { io.to('admins').emit(channel, data); return; }
  if (!SCOPED.has(channel)) { io.emit(channel, data); return; }
  const convId = convIdOf(data);
  const rooms = new Set(['admins']);
  let payload = data;
  try {
    if (convId) {
      if (channel === 'conversation_assigned') {
        const prev = data.prevAgentId != null ? String(data.prevAgentId) : assignee.get(convId)?.id;
        const next = data.agent?.id != null ? String(data.agent.id) : null;
        if (prev) rooms.add(`agent:${prev}`);
        if (next) rooms.add(`agent:${next}`);
        assignee.set(convId, { id: next, at: Date.now() });
        if (next && data.contactName === undefined) payload = { ...data, ...(await assignInfo(convId)) };
      } else {
        const who = data.assignedTo !== undefined ? (data.assignedTo ? String(data.assignedTo) : null) : await assigneeOf(convId);
        if (who) rooms.add(`agent:${who}`);
        if (data.prevAgentId) rooms.add(`agent:${data.prevAgentId}`);
      }
    }
  } catch (e) {
    console.warn('[Realtime] gagal menentukan penerima:', e?.message || e);
  }
  io.to([...rooms]).emit(channel, payload);
}

// Masukkan socket ke room sesuai user.
export function joinRooms(socket, user) {
  if (!user) return;
  if (user.role === 'admin') socket.join('admins');
  if (user.id != null) socket.join(`agent:${user.id}`);
}
