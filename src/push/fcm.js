import admin from 'firebase-admin';
import { supabase } from '../db/supabase.js';

let messaging = null;

// Init firebase-admin dari env FIREBASE_SERVICE_ACCOUNT (isi JSON service account).
// Bila tidak diset, push dimatikan (no-op) supaya app tetap jalan.
function init() {
  if (messaging) return messaging;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const serviceAccount = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    messaging = admin.messaging();
    return messaging;
  } catch (e) {
    console.warn('[FCM] init gagal:', e.message);
    return null;
  }
}

export function isPushEnabled() {
  return !!init();
}

async function sendToTokens(tokens, { title, body, data }) {
  const fcm = init();
  if (!fcm || !tokens.length) return;
  try {
    const resp = await fcm.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high' },
    });
    // Bersihkan token yang sudah tidak valid
    const invalid = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || '';
        if (/registration-token-not-registered|invalid-argument/i.test(code)) invalid.push(tokens[i]);
      }
    });
    if (invalid.length) {
      await supabase.from('device_tokens').delete().in('token', invalid);
    }
  } catch (e) {
    console.warn('[FCM] send gagal:', e.message);
  }
}

// Kirim push ke 1 agent (semua device-nya)
export async function sendToAgent(agentId, payload) {
  if (!init() || !agentId) return;
  const { data } = await supabase.from('device_tokens').select('token').eq('agent_id', agentId);
  await sendToTokens((data || []).map((d) => d.token), payload);
}

// Kirim push ke semua device terdaftar (mis. percakapan belum di-assign)
export async function sendToAll(payload) {
  if (!init()) return;
  const { data } = await supabase.from('device_tokens').select('token');
  await sendToTokens((data || []).map((d) => d.token), payload);
}
