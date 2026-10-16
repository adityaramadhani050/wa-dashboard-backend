// Bot routing regional: menanyakan lokasi customer baru, menentukan regional
// cabang (Barat/Timur), lalu meng-assign ke agent regional tersebut.
//
// Status percakapan (conversations.bot_state):
//   null / 'done'          -> tidak ada bot aktif
//   'awaiting_location'    -> bot sudah bertanya, menunggu jawaban lokasi
//   'unresolved'           -> gagal ditentukan -> antrian admin
import { randomBytes } from 'crypto';
import { supabase } from '../db/supabase.js';
import { getSock, broadcast, pushNewMessage } from '../baileys/connection.js';
import { detectLocation, detectFromIntro, matchLocation, REGION_LABEL } from './regional.js';
import { routeConversation, autoAssignConversation, rerouteIfAgentUnavailable } from './autoAssign.js';

// Pesan beruntun dalam X detik setelah bot bertanya dianggap kelanjutan
// pesan pembuka (customer belum sempat membaca pertanyaan) -> tidak dihitung gagal.
const GRACE_MS = 20 * 1000;
const MAX_ATTEMPTS = 2; // tanya awal + 1x tanya ulang

// ── Pengaturan ──────────────────────────────────────────────────────────────
export const DEFAULT_REGIONAL_SETTINGS = {
  enabled: false,
  timeout_minutes: 30,
  internal_numbers: [],
  msg_ask: 'Halo Kak {{nama}} 👋 Terima kasih telah menghubungi kami. Boleh kami tahu Kakak berlokasi di kota/kabupaten mana? (contoh: Surabaya, Bekasi, Denpasar)',
  msg_retry: 'Mohon maaf Kak, lokasinya belum kami kenali 🙏 Bisa ketik nama kota atau kabupatennya saja? (contoh: Malang, Bandung, Makassar)',
  msg_confirm: 'Terima kasih Kak! Kakak akan dibantu oleh {{agent}} dari tim Regional {{regional}} kami, mohon tunggu sebentar ya 🙏',
  // Dipakai bila regional terdeteksi tapi belum ada agent tersedia (antrian regional)
  msg_confirm_queue: 'Terima kasih Kak! Kakak akan dibantu tim Regional {{regional}} kami, mohon tunggu sebentar ya 🙏',
  msg_fail: 'Terima kasih Kak, tim kami akan segera menghubungi Kakak 🙏',
};
// Teks konfirmasi bawaan versi lama (tanpa nama agent). Bila admin belum
// mengubahnya, otomatis diganti versi baru yang menyebut nama agent.
const LEGACY_CONFIRM = 'Terima kasih Kak! Kakak akan dibantu tim Regional {{regional}} kami, mohon tunggu sebentar ya 🙏';

export function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;
  return d;
}

export function parseRegionalSettings(raw) {
  let v = {};
  try { v = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { v = {}; }
  const D = DEFAULT_REGIONAL_SETTINGS;
  const text = (x, d) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 1000) : d);
  const nums = Array.isArray(v.internal_numbers) ? v.internal_numbers : String(v.internal_numbers || '').split(/[\s,;]+/);
  return {
    enabled: !!v.enabled,
    // 0 = timeout dinonaktifkan; kosong/tidak valid = bawaan; selain itu 5..1440 menit
    timeout_minutes: (() => {
      const t = parseInt(v.timeout_minutes, 10);
      if (Number.isNaN(t)) return D.timeout_minutes;
      return t <= 0 ? 0 : Math.min(1440, Math.max(5, t));
    })(),
    internal_numbers: [...new Set(nums.map(normalizePhone).filter((n) => n.length >= 8))],
    msg_ask: text(v.msg_ask, D.msg_ask),
    msg_retry: text(v.msg_retry, D.msg_retry),
    msg_confirm: v.msg_confirm === LEGACY_CONFIRM ? D.msg_confirm : text(v.msg_confirm, D.msg_confirm),
    msg_confirm_queue: text(v.msg_confirm_queue, D.msg_confirm_queue),
    msg_fail: text(v.msg_fail, D.msg_fail),
  };
}

let settingsCache = { val: null, at: 0 };
export async function getRegionalSettings() {
  if (settingsCache.val && Date.now() - settingsCache.at < 15000) return settingsCache.val;
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'regional_routing').maybeSingle();
    settingsCache = { val: parseRegionalSettings(data?.value), at: Date.now() };
  } catch {
    settingsCache = { val: parseRegionalSettings(null), at: Date.now() };
  }
  return settingsCache.val;
}
export function invalidateRegionalSettingsCache() { settingsCache.at = 0; }

// ── Utilitas ────────────────────────────────────────────────────────────────
function fill(tpl, { nama, regional, agent } = {}) {
  let s = String(tpl || '');
  s = s.replace(/\{\{\s*regional\s*\}\}/gi, regional || '');
  s = s.replace(/\{\{\s*agent\s*\}\}/gi, agent ? String(agent).trim() : 'tim kami');
  const n = nama && !/^\+?\d[\d\s-]*$/.test(nama) ? String(nama).trim() : '';
  s = s.replace(/\s*\{\{\s*nama\s*\}\}/gi, n ? ` ${n}` : '');
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

function titleCase(s) {
  return String(s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

async function setConv(conversationId, patch) {
  const { error } = await supabase.from('conversations').update(patch).eq('id', conversationId);
  if (error) console.warn('[RegionalBot] update conversation gagal:', error.message);
}

// ID pesan bot dicatat sebelum dikirim, agar handler pesan masuk tidak
// menyimpan ulang pesan keluar milik bot (sudah disimpan di sini).
const botMsgIds = new Set();
export function isBotMessageId(id) { return !!id && botMsgIds.has(id); }

async function sendBot(conversationId, jid, text) {
  const sock = getSock();
  if (!sock) throw new Error('WhatsApp belum tersambung');
  const id = '3EB0' + randomBytes(9).toString('hex').toUpperCase();
  botMsgIds.add(id);
  setTimeout(() => botMsgIds.delete(id), 5 * 60 * 1000);
  try {
    await sock.sendMessage(jid, { text }, { messageId: id });
  } catch (e) {
    botMsgIds.delete(id);
    throw e;
  }

  const nowIso = new Date().toISOString();
  const row = {
    conversation_id: conversationId, from_me: true, body: text,
    timestamp: nowIso, status: 'sent', wa_message_id: id, sent_by_bot: true,
  };
  let res = await supabase.from('messages').insert(row).select().single();
  if (res.error) {
    delete row.sent_by_bot; // kolom belum ada -> simpan tanpa penanda
    res = await supabase.from('messages').insert(row).select().single();
  }
  // Pesan bot bukan balasan agent: chat tidak dianggap "menunggu balasan agent"
  // selama bot menunggu jawaban customer.
  await setConv(conversationId, {
    last_message: text, last_message_at: nowIso, last_from_me: true,
    awaiting_since: null, updated_at: nowIso,
  });
  if (res.data) broadcast('new_message', { message: res.data, conversationId }).catch(() => {});
  return res.data;
}

function emitConvUpdate(conversationId, patch) {
  broadcast('conversation_updated', { conversationId, ...patch }).catch(() => {});
}

async function announceAssignment(conversationId, agent) {
  if (agent) broadcast('conversation_assigned', { conversationId, agent }).catch(() => {});
}

// Simpan lokasi ke kontak & percakapan.
async function applyRegion(contactId, conversationId, hit) {
  const city = titleCase(hit.matched).slice(0, 80) || null;
  const contactPatch = { city, province: hit.province || null, region: hit.region };
  const { error } = await supabase.from('contacts').update(contactPatch).eq('id', contactId);
  if (error) console.warn('[RegionalBot] update kontak gagal:', error.message);
  await setConv(conversationId, { region: hit.region });
  emitConvUpdate(conversationId, { region: hit.region, city, province: hit.province || null });
}

// Kontak lama belum punya regional -> isi otomatis dari regional agent-nya.
async function backfillRegionFromAgent(contactId, conversationId, agentId) {
  const { data: agent, error } = await supabase.from('agents').select('region').eq('id', agentId).maybeSingle();
  if (error || !agent?.region) return null;
  await supabase.from('contacts').update({ region: agent.region }).eq('id', contactId).is('region', null);
  await supabase.from('conversations').update({ region: agent.region }).eq('id', conversationId).is('region', null);
  emitConvUpdate(conversationId, { region: agent.region });
  return agent.region;
}

// Assign ke agent regional, lalu (opsional) konfirmasi bot yang menyebut nama
// agent yang ditugaskan. KPI agent mulai dari sini.
async function assignRegional(ctx, region, settings, { confirm }) {
  const { conversationId, jid } = ctx;
  const agent = await routeConversation(conversationId, { region });
  if (confirm) {
    const tpl = agent ? settings.msg_confirm : settings.msg_confirm_queue;
    await sendBot(conversationId, jid, fill(tpl, { nama: ctx.contactName, regional: REGION_LABEL[region], agent: agent?.name }))
      .catch((e) => console.warn('[RegionalBot] kirim konfirmasi gagal:', e.message));
  }
  const nowIso = new Date().toISOString();
  await setConv(conversationId, { awaiting_since: nowIso, last_from_me: false });
  await announceAssignment(conversationId, agent);
  if (!agent) console.log(`[RegionalBot] conv=${conversationId} masuk antrian regional ${region} (tidak ada agent tersedia / auto-assign mati)`);
  pushNewMessage(ctx.payload).catch(() => {});
}

// Gagal menentukan regional -> antrian admin. Klaim status dulu agar tidak
// diproses dua kali (mis. timeout bersamaan dengan pesan masuk).
// silent: tanpa pesan ke customer (dipakai saat timeout — customer tidak sedang
// membalas, jadi tidak perlu dikirimi pesan penutup).
async function markUnresolved({ conversationId, jid, contactName, phone, payload }, settings, { silent = false } = {}) {
  const { data: claimed } = await supabase.from('conversations')
    .update({ bot_state: 'unresolved' })
    .eq('id', conversationId).eq('bot_state', 'awaiting_location')
    .select('id').maybeSingle();
  if (!claimed) return;

  if (jid && !silent) {
    await sendBot(conversationId, jid, fill(settings.msg_fail, { nama: contactName }))
      .catch((e) => console.warn('[RegionalBot] kirim pesan gagal-deteksi gagal:', e.message));
  }
  // Tampil sebagai "menunggu balasan" agar admin segera menindaklanjuti.
  await setConv(conversationId, { awaiting_since: new Date().toISOString(), last_from_me: false });
  emitConvUpdate(conversationId, { bot_state: 'unresolved' });
  pushNewMessage(payload || {
    conversationId, contactName, phone,
    message: { body: 'Regional belum diketahui — perlu ditentukan admin' },
  }).catch(() => {});
  console.log(`[RegionalBot] conv=${conversationId} ${silent ? 'timeout (tanpa pesan)' : 'regional tidak terdeteksi'} -> antrian admin`);
}

// Apakah admin/agent (bukan bot) sudah membalas sejak bot bertanya?
async function humanRepliedSince(conversationId, sinceIso) {
  let q = supabase.from('messages').select('id, sent_by_bot')
    .eq('conversation_id', conversationId).eq('from_me', true);
  if (sinceIso) q = q.gt('timestamp', sinceIso);
  const { data, error } = await q.limit(20);
  if (error) return true; // ragu -> anggap sudah ditangani manusia (jangan menyela)
  return (data || []).some((m) => !m.sent_by_bot);
}

async function startBot(ctx, settings) {
  const nowIso = new Date().toISOString();
  // Set status sebelum mengirim agar balasan cepat customer sudah tercatat sebagai jawaban.
  await setConv(ctx.conversationId, { bot_state: 'awaiting_location', bot_attempts: 0, bot_asked_at: nowIso });
  try {
    await sendBot(ctx.conversationId, ctx.jid, fill(settings.msg_ask, { nama: ctx.contactName }));
    emitConvUpdate(ctx.conversationId, { bot_state: 'awaiting_location' });
    console.log(`[RegionalBot] conv=${ctx.conversationId} bot menanyakan lokasi`);
  } catch (e) {
    // Bot gagal mengirim -> jangan biarkan customer menggantung: pakai auto-assign biasa.
    console.warn('[RegionalBot] gagal mengirim pertanyaan lokasi:', e.message);
    await setConv(ctx.conversationId, { bot_state: null });
    await legacyAssign(ctx);
  }
}

async function handleLocationAnswer(ctx, conv, settings) {
  const askedAt = conv.bot_asked_at ? new Date(conv.bot_asked_at).getTime() : 0;
  const withinGrace = !!askedAt && Date.now() - askedAt < GRACE_MS;
  const hit = await detectLocation(ctx.body, { useAI: !withinGrace });

  if (hit) {
    await applyRegion(ctx.contactId, ctx.conversationId, hit);
    await setConv(ctx.conversationId, { bot_state: 'done' });
    console.log(`[RegionalBot] conv=${ctx.conversationId} lokasi="${hit.matched}" -> ${hit.province || '-'} (${hit.region})${hit.viaAI ? ' [AI]' : ''}`);
    return assignRegional(ctx, hit.region, settings, { confirm: true });
  }
  if (withinGrace) return; // pesan beruntun sebelum customer sempat membaca pertanyaan

  const attempts = (conv.bot_attempts || 0) + 1;
  if (attempts < MAX_ATTEMPTS) {
    await setConv(ctx.conversationId, { bot_attempts: attempts, bot_asked_at: new Date().toISOString() });
    await sendBot(ctx.conversationId, ctx.jid, fill(settings.msg_retry, { nama: ctx.contactName }))
      .catch((e) => console.warn('[RegionalBot] kirim tanya ulang gagal:', e.message));
    return;
  }
  await setConv(ctx.conversationId, { bot_attempts: attempts });
  return markUnresolved(ctx, settings);
}

// Perilaku lama: auto-assign global ke agent paling sedikit beban.
async function legacyAssign(ctx) {
  try {
    const agent = await autoAssignConversation(ctx.conversationId);
    await announceAssignment(ctx.conversationId, agent);
  } catch { /* abaikan */ }
  pushNewMessage(ctx.payload).catch(() => {});
}

function isInternalNumber(phone, settings) {
  const p = normalizePhone(phone);
  return !!p && settings.internal_numbers.includes(p);
}

// ── Titik masuk: dipanggil untuk setiap pesan MASUK live yang bukan chat
// Deal/Non-Client. ctx: { conversationId, contactId, jid, phone, contactName,
// body, isNewContact, isGroup, wasResolved, payload }
export async function routeIncoming(ctx) {
  const settings = await getRegionalSettings();
  if (!settings.enabled || ctx.isGroup) return legacyAssign(ctx);

  // Nomor internal (staf/teknisi/penerima notifikasi): tanpa bot, tanpa assign, tanpa notif.
  if (isInternalNumber(ctx.phone, settings)) return;

  let convRes = await supabase.from('conversations')
    .select('assigned_to, region, bot_state, bot_attempts, bot_asked_at')
    .eq('id', ctx.conversationId).maybeSingle();
  if (convRes.error) {
    // Kolom regional belum dimigrasi -> jangan ganggu alur lama.
    console.warn('[RegionalBot] kolom regional belum ada, pakai auto-assign biasa:', convRes.error.message);
    return legacyAssign(ctx);
  }
  const conv = convRes.data || {};
  const { data: contact } = await supabase.from('contacts').select('region').eq('id', ctx.contactId).maybeSingle();

  // 1) Bot sedang menunggu jawaban lokasi
  if (conv.bot_state === 'awaiting_location') {
    if (conv.assigned_to) {
      // Admin sudah meng-assign manual -> hentikan bot, simpan lokasi bila terdeteksi.
      const hit = matchLocation(ctx.body);
      if (hit) await applyRegion(ctx.contactId, ctx.conversationId, hit);
      await setConv(ctx.conversationId, { bot_state: 'done' });
      pushNewMessage(ctx.payload).catch(() => {});
      return;
    }
    return handleLocationAnswer(ctx, conv, settings);
  }

  // 2) Antrian admin: regional belum diketahui, menunggu keputusan admin.
  // Bila customer belakangan menyebut kotanya (mis. menjawab pertanyaan bot
  // setelah timeout) dan belum ada balasan manusia, langsung arahkan ke
  // agent regionalnya. Hanya kamus kota (tanpa AI) agar hemat kuota.
  if (conv.bot_state === 'unresolved' && !conv.assigned_to) {
    const late = matchLocation(ctx.body);
    if (late && !(await humanRepliedSince(ctx.conversationId, conv.bot_asked_at))) {
      await applyRegion(ctx.contactId, ctx.conversationId, late);
      await setConv(ctx.conversationId, { bot_state: 'done' });
      console.log(`[RegionalBot] conv=${ctx.conversationId} jawaban lokasi terlambat="${late.matched}" -> ${late.region}`);
      return assignRegional(ctx, late.region, settings, { confirm: true });
    }
    pushNewMessage(ctx.payload).catch(() => {});
    return;
  }

  // 3) Nomor benar-benar baru -> deteksi dari pesan pertama, atau bot bertanya
  if (ctx.isNewContact && !contact?.region && !conv.assigned_to) {
    const intro = detectFromIntro(ctx.body);
    if (intro) {
      await applyRegion(ctx.contactId, ctx.conversationId, intro);
      await setConv(ctx.conversationId, { bot_state: 'done' });
      return assignRegional(ctx, intro.region, settings, { confirm: false });
    }
    return startBot(ctx, settings);
  }

  // 4) Kontak lama / percakapan berjalan
  let region = contact?.region || conv.region || null;
  if (conv.assigned_to) {
    if (!region) region = await backfillRegionFromAgent(ctx.contactId, ctx.conversationId, conv.assigned_to);
    if (ctx.wasResolved) {
      // Customer kembali tapi agent lamanya tidak tersedia -> pindah ke agent se-regional
      const moved = await rerouteIfAgentUnavailable(ctx.conversationId, conv.assigned_to, { region });
      await announceAssignment(ctx.conversationId, moved);
    }
    pushNewMessage(ctx.payload).catch(() => {});
    return;
  }

  // Belum ter-assign: ke regional kontak bila diketahui, selain itu global.
  const agent = await routeConversation(ctx.conversationId, { region });
  await announceAssignment(ctx.conversationId, agent);
  pushNewMessage(ctx.payload).catch(() => {});
}

// Dipanggil saat admin mengubah regional sebuah chat secara manual.
// Simpan regional & (bila belum ada agent) arahkan ke agent regional tsb.
export async function setRegionManually(conversationId, region) {
  const { data: conv } = await supabase.from('conversations')
    .select('contact_id, assigned_to').eq('id', conversationId).maybeSingle();
  if (!conv) return null;
  await setConv(conversationId, { region, bot_state: 'done' });
  if (conv.contact_id) await supabase.from('contacts').update({ region }).eq('id', conv.contact_id);
  emitConvUpdate(conversationId, { region, bot_state: 'done' });
  let agent = null;
  if (!conv.assigned_to) {
    agent = await routeConversation(conversationId, { region });
    await announceAssignment(conversationId, agent);
  }
  return { region, agent };
}

// ── Job: jawaban lokasi tidak datang dalam batas waktu -> antrian admin ────
async function checkBotTimeouts() {
  const settings = await getRegionalSettings();
  if (!settings.enabled || !settings.timeout_minutes) return; // 0 = timeout dinonaktifkan
  const cutoff = new Date(Date.now() - settings.timeout_minutes * 60000).toISOString();
  const { data, error } = await supabase.from('conversations')
    .select('id, wa_jid, assigned_to, contact:contacts (name, phone)')
    .eq('bot_state', 'awaiting_location')
    .lt('bot_asked_at', cutoff)
    .limit(50);
  if (error || !data?.length) return;
  for (const c of data) {
    if (c.assigned_to) { await setConv(c.id, { bot_state: 'done' }); continue; }
    const phone = c.contact?.phone;
    const jid = c.wa_jid || (phone ? `${String(phone).split('@')[0]}@s.whatsapp.net` : null);
    // Timeout: customer tidak sedang membalas -> masuk antrian admin TANPA pesan ke customer
    await markUnresolved({ conversationId: c.id, jid, contactName: c.contact?.name, phone }, settings, { silent: true });
  }
}

export function startRegionalBotJob(intervalMs = 60 * 1000) {
  setInterval(() => { checkBotTimeouts().catch((e) => console.warn('[RegionalBot] job timeout gagal:', e.message)); }, intervalMs);
  console.log('[RegionalBot] job timeout aktif (cek tiap 1 menit)');
}
