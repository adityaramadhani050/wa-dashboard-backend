import webpush from 'web-push';
import { supabase } from '../db/supabase.js';

let configured = false;

function init() {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@wa-dashboard.local',
      pub,
      priv
    );
    configured = true;
    return true;
  } catch (e) {
    console.warn('[WebPush] init gagal:', e.message);
    return false;
  }
}

export function isWebPushEnabled() {
  return init();
}

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

async function sendToSubs(rows, payload, label = '') {
  if (!init() || !rows.length) {
    console.log(`[WebPush] ${label} tidak ada langganan / belum dikonfigurasi (rows=${rows.length})`);
    return;
  }
  const body = JSON.stringify(payload);
  const dead = [];
  let ok = 0, fail = 0;
  await Promise.all(
    rows.map(async (row) => {
      try {
        const sub = JSON.parse(row.token);
        await webpush.sendNotification(sub, body);
        ok++;
      } catch (e) {
        fail++;
        const code = e?.statusCode;
        console.warn(`[WebPush] gagal kirim (status=${code}): ${String(e?.body || e?.message || e).slice(0, 120)}`);
        // 404/410 = subscription kedaluwarsa → hapus
        if (code === 404 || code === 410) dead.push(row.token);
      }
    })
  );
  console.log(`[WebPush] ${label} terkirim ok=${ok} gagal=${fail} dihapus=${dead.length}`);
  if (dead.length) {
    await supabase.from('device_tokens').delete().in('token', dead);
  }
}

// Kirim web push ke semua langganan web milik 1 agent
export async function sendWebPushToAgent(agentId, payload) {
  if (!init() || !agentId) return;
  const { data } = await supabase
    .from('device_tokens')
    .select('token')
    .eq('agent_id', agentId)
    .eq('platform', 'web');
  await sendToSubs(data || [], payload, `agent=${agentId}`);
}

// Kirim web push ke semua langganan web (mis. percakapan belum di-assign)
export async function sendWebPushToAll(payload) {
  if (!init()) return;
  const { data } = await supabase
    .from('device_tokens')
    .select('token')
    .eq('platform', 'web');
  await sendToSubs(data || [], payload, 'all');
}
