// Hak akses agent ke sebuah chat: agent hanya boleh membuka & membalas chat yang
// di-assign ke dirinya (chat yang dipindah ke agent lain tidak bisa dibuka lagi).
// Admin & token service selalu boleh.
import { supabase } from '../db/supabase.js';

export async function agentCanAccess(user, conversationId) {
  if (!user || user.role !== 'agent' || conversationId == null) return true;
  const { data } = await supabase.from('conversations').select('assigned_to').eq('id', conversationId).maybeSingle();
  return !!data && String(data.assigned_to) === String(user.id);
}

// true = lanjut; false = respons 403 sudah dikirim.
export async function guardConversation(req, res, conversationId) {
  if (await agentCanAccess(req.user, conversationId)) return true;
  res.status(403).json({ error: 'Chat ini sudah dipindahkan ke agent lain.', code: 'NOT_ASSIGNED' });
  return false;
}
