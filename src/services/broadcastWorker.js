// Broadcast worker — mengirim campaign promo ke calon customer secara bertahap
// dengan proteksi anti-blokir WhatsApp:
//  - batas harian (daily_limit) per campaign, dihitung account-wide (aman blokir)
//  - jeda ACAK antar pesan (8–25 dtk) supaya tidak terdeteksi pola bot
//  - hanya berjalan di jam kerja (setting work_hours), zona waktu Asia/Jakarta
//  - cooldown per nomor via tabel broadcast_log (default 14 hari)
//  - skip nomor yang tidak terdaftar di WhatsApp (onWhatsApp)
//  - personalisasi {{nama}} agar tiap pesan sedikit berbeda
//
// Loop menjadwalkan dirinya sendiri (setTimeout) sehingga delay acak antar
// kirim otomatis menjadi throttle-nya.

import { supabase } from '../db/supabase.js';
import { getSock, bumpConvOutgoing, broadcast } from '../baileys/connection.js';

const MIN_DELAY_MS = 8_000;   // jeda minimum antar pesan
const MAX_DELAY_MS = 25_000;  // jeda maksimum antar pesan
const IDLE_POLL_MS = 15_000;  // poll saat tidak ada yang dikirim

let timer = null;
let ticking = false;

function randomDelay() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

function personalize(text, name) {
  if (!text) return text;
  const nama = (name && String(name).trim()) || 'Kak';
  return text.replace(/\{\{\s*nama\s*\}\}/gi, nama);
}

// Waktu sekarang dalam zona Asia/Jakarta (WIB). Railway berjalan UTC.
function nowJakarta() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = parseInt(map.hour, 10) % 24;
  const minute = parseInt(map.minute, 10);
  return { day: dayMap[map.weekday], minutes: hour * 60 + minute };
}

function hhmmToMinutes(s) {
  const [h, m] = String(s || '').split(':').map((x) => parseInt(x, 10));
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

async function getWorkHours() {
  try {
    const { data } = await supabase
      .from('app_settings').select('value').eq('key', 'work_hours').maybeSingle();
    if (!data?.value) return { enabled: false };
    return JSON.parse(data.value);
  } catch { return { enabled: false }; }
}

function isWithinWorkHours(wh) {
  if (!wh?.enabled) return true; // jam kerja tidak diaktifkan -> boleh kapan saja
  const { day, minutes } = nowJakarta();
  const days = Array.isArray(wh.days) ? wh.days : [1, 2, 3, 4, 5];
  if (!days.includes(day)) return false;
  const start = hhmmToMinutes(wh.start) ?? 480;
  const end = hhmmToMinutes(wh.end) ?? 1020;
  return minutes >= start && minutes < end;
}

function startOfTodayJakartaISO() {
  // Awal hari WIB dinyatakan dalam UTC (WIB = UTC+7 -> 00:00 WIB = 17:00 UTC hari sebelumnya)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}T00:00:00+07:00`;
}

// Jumlah pesan broadcast yang sudah terkirim hari ini (account-wide) — dipakai
// sebagai penegak batas harian lintas campaign untuk keamanan akun.
async function sentTodayCount() {
  const since = startOfTodayJakartaISO();
  const { count } = await supabase
    .from('broadcast_log')
    .select('id', { count: 'exact', head: true })
    .gte('sent_at', since);
  return count || 0;
}

// Apakah nomor masih dalam cooldown (pernah dikirim < cooldownDays hari lalu)
async function inCooldown(waJid, cooldownDays) {
  const since = new Date(Date.now() - cooldownDays * 86400_000).toISOString();
  const { data } = await supabase
    .from('broadcast_log')
    .select('id')
    .eq('wa_jid', waJid)
    .gte('sent_at', since)
    .limit(1);
  return (data?.length || 0) > 0;
}

async function markRecipient(id, patch) {
  await supabase.from('broadcast_recipients').update(patch).eq('id', id);
}

async function bumpCampaign(id, field) {
  // Increment aman via RPC tidak tersedia -> baca-tulis ringan
  const { data } = await supabase
    .from('broadcast_campaigns').select(field).eq('id', id).single();
  const next = (data?.[field] || 0) + 1;
  await supabase.from('broadcast_campaigns').update({ [field]: next }).eq('id', id);
}

async function buildBaileysMsg(campaign, name) {
  const caption = personalize(campaign.message_body, name);
  if (campaign.message_type === 'quick_media' && campaign.quick_media_id) {
    const { data: qm } = await supabase
      .from('quick_media').select('*').eq('id', campaign.quick_media_id).single();
    if (!qm) return null;
    if (qm.media_type === 'image') return { msg: { image: { url: qm.media_url }, caption }, qm };
    if (qm.media_type === 'video') return { msg: { video: { url: qm.media_url }, caption, mimetype: qm.mimetype }, qm };
    return { msg: { document: { url: qm.media_url }, mimetype: qm.mimetype, fileName: qm.label, caption }, qm };
  }
  return { msg: { text: caption || '' }, qm: null };
}

// Aktifkan campaign 'scheduled' yang waktunya sudah tiba.
async function promoteScheduled() {
  const nowIso = new Date().toISOString();
  await supabase
    .from('broadcast_campaigns')
    .update({ status: 'running', started_at: nowIso })
    .eq('status', 'scheduled')
    .lte('start_at', nowIso);
}

// Proses satu langkah. Return true bila sebuah pesan benar-benar dikirim
// (agar loop memakai delay acak), false bila idle/skip.
async function tick() {
  await promoteScheduled();

  const { data: campaign } = await supabase
    .from('broadcast_campaigns')
    .select('*')
    .eq('status', 'running')
    .order('started_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!campaign) return false;

  // Ambil satu penerima pending
  const { data: recipient } = await supabase
    .from('broadcast_recipients')
    .select('*')
    .eq('campaign_id', campaign.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!recipient) {
    // Tidak ada lagi yang pending -> selesai
    await supabase.from('broadcast_campaigns')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', campaign.id);
    console.log(`[Broadcast] Campaign "${campaign.name}" selesai.`);
    return false;
  }

  // Jam kerja
  const wh = await getWorkHours();
  if (!isWithinWorkHours(wh)) return false; // tunggu, jangan skip penerima

  // Batas harian (account-wide)
  const sentToday = await sentTodayCount();
  if (sentToday >= (campaign.daily_limit || 40)) return false; // stop hari ini

  // Cooldown
  if (await inCooldown(recipient.wa_jid, campaign.cooldown_days || 14)) {
    await markRecipient(recipient.id, { status: 'skipped', skip_reason: 'cooldown' });
    await bumpCampaign(campaign.id, 'skipped_count');
    return false;
  }

  const sock = getSock();
  if (!sock) return false; // WA belum tersambung -> tunggu

  // Validasi nomor terdaftar di WhatsApp
  try {
    const check = await sock.onWhatsApp(recipient.wa_jid);
    if (!check?.[0]?.exists) {
      await markRecipient(recipient.id, { status: 'skipped', skip_reason: 'invalid_number' });
      await bumpCampaign(campaign.id, 'skipped_count');
      return false;
    }
  } catch { /* biarkan lanjut coba kirim */ }

  // Kirim
  try {
    const built = await buildBaileysMsg(campaign, recipient.name);
    if (!built) throw new Error('quick_media tidak ditemukan');
    const sent = await sock.sendMessage(recipient.wa_jid, built.msg);
    const waMessageId = sent?.key?.id || null;
    const nowIso = new Date().toISOString();
    const qm = built.qm;
    const bodyText = qm
      ? (personalize(campaign.message_body, recipient.name) || `[${qm.media_type}] ${qm.label}`)
      : personalize(campaign.message_body, recipient.name);

    // Catat sebagai pesan keluar agar muncul di percakapan
    if (recipient.conversation_id) {
      const { data: saved } = await supabase.from('messages').insert({
        conversation_id: recipient.conversation_id,
        from_me: true,
        body: bodyText,
        timestamp: nowIso,
        status: 'sent',
        wa_message_id: waMessageId,
        media_type: qm?.media_type || null,
        media_url: qm?.media_url || null,
        media_filename: qm?.label || null,
        media_mimetype: qm?.mimetype || null,
      }).select().single();
      await bumpConvOutgoing(recipient.conversation_id, bodyText).catch(() => {});
      if (saved) broadcast('new_message', { message: saved, conversationId: recipient.conversation_id }).catch(() => {});
    }

    // Catat ke log broadcast (sumber cooldown) + tandai terkirim
    await supabase.from('broadcast_log').insert({
      wa_jid: recipient.wa_jid, phone: recipient.phone, campaign_id: campaign.id, sent_at: nowIso,
    });
    await markRecipient(recipient.id, { status: 'sent', sent_at: nowIso });
    await bumpCampaign(campaign.id, 'sent_count');
    console.log(`[Broadcast] Terkirim ke ${recipient.phone} (campaign "${campaign.name}")`);
    return true;
  } catch (err) {
    await markRecipient(recipient.id, { status: 'failed', error: err?.message || String(err) });
    await bumpCampaign(campaign.id, 'failed_count');
    console.error(`[Broadcast] Gagal kirim ke ${recipient.phone}:`, err?.message || err);
    return true; // tetap pakai delay agar tidak spam retry
  }
}

function scheduleNext(delayMs) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(runLoop, delayMs);
}

async function runLoop() {
  if (ticking) { scheduleNext(IDLE_POLL_MS); return; }
  ticking = true;
  let sent = false;
  try {
    sent = await tick();
  } catch (err) {
    console.error('[Broadcast] worker error:', err?.message || err);
  } finally {
    ticking = false;
  }
  scheduleNext(sent ? randomDelay() : IDLE_POLL_MS);
}

export function startBroadcastWorker() {
  console.log('[Broadcast] worker started');
  scheduleNext(IDLE_POLL_MS);
}
