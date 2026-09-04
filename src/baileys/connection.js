import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  jidNormalizedUser,
  proto,
} from '@whiskeysockets/baileys'
import { createHmac, createDecipheriv } from 'crypto'
import { Boom } from '@hapi/boom'
import { supabase } from '../db/supabase.js'
import { publish, redisAvailable } from '../db/redis.js'
import { sendToAgents, sendToAll, isPushEnabled } from '../push/fcm.js'
import { sendWebPushToAgents, sendWebPushToAll, isWebPushEnabled } from '../push/webpush.js'
import { autoAssignConversation } from '../services/autoAssign.js'
import { compressImage, makeThumbnail } from '../utils/media.js'
import QRCode from 'qrcode'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Folder penyimpanan sesi/kunci WhatsApp. WAJIB diarahkan ke storage PERMANEN
// (mis. Railway Volume) via env WA_AUTH_DIR agar sesi tidak hilang tiap
// restart/redeploy — folder default di bawah project bersifat ephemeral di
// Railway sehingga kunci enkripsi hilang -> penerima lihat "message unavailable".
const AUTH_FOLDER = process.env.WA_AUTH_DIR || path.join(__dirname, '../../.wa_auth')

// Logger senyap untuk Baileys (pino-compatible). Memakai `console` membuat
// Baileys mencetak stack trace penuh untuk tiap operasi TRACE (mis. "updated
// cache" / "loading from store") -> log jadi penuh & terlihat seperti error.
// Di sini trace/debug/info di-nonaktifkan; hanya warn/error yang tampil.
const waLogger = {
  level: 'warn',
  trace() {}, debug() {}, info() {},
  warn: (...a) => console.warn('[WA]', ...a.filter(x => typeof x !== 'object')),
  error: (...a) => console.error('[WA]', ...a.filter(x => typeof x !== 'object')),
  fatal: (...a) => console.error('[WA]', ...a.filter(x => typeof x !== 'object')),
  child() { return waLogger },
}

let sock = null
let ioInstance = null
let isConnected = false
let syncing = false
let latestQr = null // QR terbaru (data URL) — dikirim ke dashboard yang baru connect
let reconnectFails = 0 // hitung gagal reconnect beruntun -> reset sesi bila terlalu banyak

export function getLatestQr() { return isConnected ? null : latestQr }

const lidToPhone = new Map()

export function setIO(io) { ioInstance = io }
export function getSock() { return sock }
export function getIsConnected() { return isConnected }
export function getSyncing() { return syncing }

function setSyncing(val) {
  syncing = val
  ioInstance?.emit('wa_sync', { syncing: val })
}

// Sinkronisasi manual: reconnect socket (tanpa logout) supaya WhatsApp
// mengirim ulang pesan yang masuk saat sempat disconnect.
export async function triggerSync() {
  if (syncing) return { ok: true, already: true }
  setSyncing(true)
  // Safety: matikan indikator kalau 'open' tak kunjung datang
  setTimeout(() => { if (syncing) setSyncing(false) }, 25000)
  try {
    if (sock) {
      try { sock.end(new Error('manual-sync-reconnect')) } catch {}
      // 'close' handler akan reconnect otomatis (sesi dipertahankan)
    } else {
      connectToWhatsApp()
    }
  } catch (e) {
    setSyncing(false)
    throw e
  }
  return { ok: true }
}

// Perbarui ringkasan percakapan setelah pesan KELUAR (dipakai route pengiriman).
// Menjaga denormalisasi last_message dll. agar daftar chat tetap 1 query.
export async function bumpConvOutgoing(conversationId, body) {
  const now = new Date().toISOString()
  try {
    // Chat deal/non-client dianggap selesai -> jangan jadi Aktif, biarkan Resolved.
    const closed = await closedTagState(conversationId)
    await supabase.from('conversations').update({
      status: closed ? 'resolved' : 'in_progress', updated_at: now,
      last_message: body || '[media]', last_message_at: now,
      last_from_me: true, awaiting_since: null,
    }).eq('id', conversationId)
  } catch { /* kolom ringkasan mungkin belum ada -> abaikan */ }
}

// Broadcast event ke semua dashboard (Redis pub/sub + fallback Socket.io langsung)
export async function broadcast(channel, data) {
  const published = await publish(channel, data)
  if (!published) ioInstance?.emit(channel, data)
}

async function clearAuthFolder() {
  try {
    await fs.rm(AUTH_FOLDER, { recursive: true, force: true })
    console.log('[Auth] Auth folder cleared')
  } catch (err) {
    console.warn('[Auth] Could not clear auth folder:', err.message)
  }
}

export async function resetSession() {
  if (sock) {
    try { sock.ev.removeAllListeners(); sock.end() } catch (e) {}
    sock = null
  }
  isConnected = false
  ioInstance?.emit('wa_status', { connected: false })
  await clearAuthFolder()
  setTimeout(() => connectToWhatsApp(), 500)
}

// Mutex sederhana per-nomor (antrian promise) supaya upsert kontak/percakapan
// untuk nomor yang sama tidak balapan -> mencegah duplikat percakapan.
const phoneLocks = new Map()
function withPhoneLock(key, fn) {
  const prev = phoneLocks.get(key) || Promise.resolve()
  const run = prev.then(fn, fn) // jalankan fn setelah antrian sebelumnya selesai
  const tail = run.then(() => {}, () => {}) // ekor yang tak pernah reject untuk dirantai
  phoneLocks.set(key, tail)
  tail.then(() => { if (phoneLocks.get(key) === tail) phoneLocks.delete(key) })
  return run
}

function resolvePhone(jid) {
  const raw = jid.split('@')[0]
  if (!jid.endsWith('@lid')) return raw
  return lidToPhone.get(raw) || raw
}

// Cek apakah percakapan punya tag "Non-Client" (bukan calon klien -> tak perlu balasan cepat)
async function hasNonClientTag(conversationId) {
  try {
    const { data } = await supabase
      .from('conversation_tags')
      .select('tags (name)')
      .eq('conversation_id', conversationId)
    return (data || []).some((r) => /non[\s_-]*client/i.test(r.tags?.name || ''))
  } catch {
    return false
  }
}

// Status "tertutup" berdasarkan tag: 'non_client' | 'deal' | null.
// Chat deal/non-client dianggap selesai -> tidak boleh berstatus Aktif.
async function closedTagState(conversationId) {
  try {
    const { data } = await supabase
      .from('conversation_tags')
      .select('tags (name)')
      .eq('conversation_id', conversationId)
    const names = (data || []).map((r) => (r.tags?.name || '').toLowerCase())
    if (names.some((n) => /non[\s_-]*client/.test(n))) return 'non_client'
    if (names.some((n) => n === 'deal' || /^deal\b/.test(n) || /\bdeal\b/.test(n))) return 'deal'
    return null
  } catch {
    return null
  }
}

// Ambil contextInfo (info reply/quote) dari berbagai tipe pesan
function getContextInfo(message) {
  if (!message) return null
  for (const k of Object.keys(message)) {
    const v = message[k]
    if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo
  }
  return null
}

function extractBody(message) {
  if (!message) return null
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    message.templateButtonReplyMessage?.selectedDisplayText ||
    message.reactionMessage?.text ||
    null
  )
}

// Deteksi pesan yang diedit (dari WhatsApp). Mengembalikan id pesan asli &
// konten baru, atau null. Edit bisa datang langsung sbg protocolMessage atau
// dibungkus editedMessage.
function getEditInfo(message) {
  if (!message) return null
  // Edit bisa datang langsung sbg protocolMessage, atau dibungkus editedMessage.message
  const container = message.editedMessage?.message || message
  const proto = container.protocolMessage
  // type 14 = MESSAGE_EDIT
  if (proto && (proto.type === 14 || proto.editedMessage) && proto.key?.id) {
    return { originalId: proto.key.id, newContent: proto.editedMessage || null }
  }
  return null
}

// Edit terenkripsi (WhatsApp baru): secretEncryptedMessage bertipe MESSAGE_EDIT.
// Kembalikan objek secret bila ada.
function getSecretEdit(message) {
  const sec = message?.secretEncryptedMessage
  if (sec && String(sec.secretEncType) === 'MESSAGE_EDIT' && sec.targetMessageKey?.id) {
    return sec
  }
  return null
}

// Author sebuah key: pesan sendiri -> jid kita; kalau bukan -> participant/remoteJid.
function keyAuthor(key, meJid) {
  if (!key) return meJid || ''
  if (key.fromMe) return meJid || ''
  return jidNormalizedUser(key.participant || key.remoteJid || '')
}

function hmac256(key, data) { return createHmac('sha256', key).update(data).digest() }
function gcmDecrypt(ciphertext, key, iv, aad) {
  const buf = Buffer.from(ciphertext)
  const enc = buf.slice(0, buf.length - 16)
  const tag = buf.slice(buf.length - 16)
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(tag)
  return Buffer.concat([d.update(enc), d.final()])
}

// Dekripsi payload secret (skema mengikuti decryptPollVote Baileys).
// useCase string untuk edit belum resmi terdokumentasi -> coba beberapa kandidat.
function decryptSecretEdit({ sec, messageSecret, meJid }) {
  const targetId = sec.targetMessageKey.id
  const origSender = keyAuthor(sec.targetMessageKey, meJid)
  const editorJid = origSender // edit dikirim oleh pengirim pesan asli
  const aad = Buffer.from(`${targetId}\u0000${editorJid}`)
  const key0 = hmac256(Buffer.alloc(32), Buffer.from(messageSecret))
  for (const useCase of ['Message Edit', 'Edit', 'message edit']) {
    try {
      const sign = Buffer.concat([
        Buffer.from(targetId), Buffer.from(origSender), Buffer.from(editorJid),
        Buffer.from(useCase), Buffer.from([1]),
      ])
      const decKey = hmac256(key0, sign)
      const plain = gcmDecrypt(sec.encPayload, decKey, sec.encIv, aad)
      const decoded = proto.Message.decode(plain)
      const text = extractBody(decoded) || extractBody(decoded.editedMessage) ||
        extractBody(decoded.protocolMessage?.editedMessage)
      if (text != null) return { text, useCase }
    } catch { /* coba useCase berikutnya */ }
  }
  return null
}

function getMediaInfo(message) {
  if (message.imageMessage)
    return { type: 'image', msgObj: message.imageMessage, ext: 'jpg', filename: null }
  if (message.videoMessage)
    return { type: 'video', msgObj: message.videoMessage, ext: 'mp4', filename: null }
  if (message.audioMessage) {
    return {
      type: 'audio', msgObj: message.audioMessage,
      ext: message.audioMessage.ptt ? 'ogg' : 'mp3', filename: null,
    }
  }
  if (message.documentMessage) {
    const doc = message.documentMessage
    const ext = doc.fileName?.split('.').pop() || 'bin'
    return { type: 'document', msgObj: doc, ext, filename: doc.fileName }
  }
  if (message.documentWithCaptionMessage?.message?.documentMessage) {
    const doc = message.documentWithCaptionMessage.message.documentMessage
    const ext = doc.fileName?.split('.').pop() || 'bin'
    return { type: 'document', msgObj: doc, ext, filename: doc.fileName }
  }
  return null
}

async function uploadToStorage(buffer, filename, mimetype) {
  try {
    const { error } = await supabase.storage
      .from('wa-media')
      .upload(filename, buffer, { contentType: mimetype, upsert: true })
    if (error) throw error
    const { data: { publicUrl } } = supabase.storage.from('wa-media').getPublicUrl(filename)
    return publicUrl
  } catch (err) {
    console.warn('[Storage] Upload error:', err.message)
    return null
  }
}

async function upsertContact(phone, pushName) {
  const { data: existing } = await supabase
    .from('contacts')
    .select('id, name, phone')
    .eq('phone', phone)
    .single()

  if (existing) {
    if (pushName && pushName !== phone && existing.name === existing.phone) {
      await supabase.from('contacts').update({ name: pushName }).eq('id', existing.id)
    }
    return existing.id
  }

  const { data, error } = await supabase
    .from('contacts')
    .insert({ phone, name: pushName || phone, first_seen: new Date().toISOString() })
    .select('id')
    .single()

  if (error) throw error
  return data.id
}

async function upsertConversation(contactId, waJid) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id, wa_jid')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (existing) {
    if (waJid && existing.wa_jid !== waJid) {
      await supabase.from('conversations').update({ wa_jid: waJid }).eq('id', existing.id)
    }
    return existing.id
  }

  const { data, error } = await supabase
    .from('conversations')
    .insert({
      contact_id: contactId,
      status: 'open',
      wa_jid: waJid || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id
}

async function saveMessage({ conversationId, fromMe, body, timestamp, waMessageId, mediaType, mediaUrl, mediaFilename, mediaMimetype, replyToWaId, replyToBody, replyToFromMe }) {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      from_me: fromMe,
      body: body || null,
      timestamp: new Date(timestamp * 1000).toISOString(),
      status: fromMe ? 'sent' : null,
      wa_message_id: waMessageId || null,
      media_type: mediaType || null,
      media_url: mediaUrl || null,
      media_filename: mediaFilename || null,
      media_mimetype: mediaMimetype || null,
      reply_to_wa_id: replyToWaId || null,
      reply_to_body: replyToBody || null,
      reply_to_from_me: replyToFromMe ?? null,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

async function incrementDailyStats() {
  try {
    const today = new Date().toISOString().split('T')[0]
    await supabase.rpc('increment_daily_stats', { stat_date: today })
  } catch (err) {
    console.warn('increment_daily_stats RPC error:', err.message)
  }
}

// Kirim push untuk pesan masuk baru.
// Aturan: ADMIN selalu dapat notifikasi semua chat; AGENT hanya dapat
// notifikasi chat yang di-assign ke dirinya. Chat tanpa admin sama sekali
// (edge case) -> kirim ke semua device.
async function pushNewMessage(payload) {
  if (!isPushEnabled() && !isWebPushEnabled()) return
  const { conversationId, contactName, phone, message } = payload
  const title = contactName || phone || 'Pesan baru'
  const body = message?.body || 'Pesan baru masuk'
  const data = { conversationId: String(conversationId) }
  try {
    const { data: conv } = await supabase
      .from('conversations')
      .select('assigned_to')
      .eq('id', conversationId)
      .maybeSingle()

    // Target notifikasi: agent yang menangani + SEMUA admin (admin memantau semua chat).
    const ids = new Set()
    if (conv?.assigned_to) ids.add(conv.assigned_to)
    const { data: admins } = await supabase.from('agents').select('id').eq('role', 'admin')
    ;(admins || []).forEach((a) => ids.add(a.id))
    const targetIds = [...ids]

    console.log(`[Push] new message conv=${conversationId} assigned_to=${conv?.assigned_to || '(unassigned)'} targets=${targetIds.length || 'ALL'}`)

    if (targetIds.length) {
      await Promise.all([
        sendToAgents(targetIds, { title, body, data }),       // FCM (Android)
        sendWebPushToAgents(targetIds, { title, body, data }), // Web Push (PWA)
      ])
    } else {
      await Promise.all([
        sendToAll({ title, body, data }),
        sendWebPushToAll({ title, body, data }),
      ])
    }
  } catch (e) {
    console.warn('[Push] pushNewMessage gagal:', e.message)
  }
}

// Simpan satu pesan WA (dipakai oleh messages.upsert & messaging-history.set).
// isLive: pesan real-time (notify) -> boleh push/auto-assign/stats.
// Non-live (append / history sync) -> hanya disimpan & broadcast, batasi recency.
async function persistMessage(msg, { isLive }) {
  if (!msg?.message) return

  // Pesan diedit di WhatsApp -> update pesan asli (bukan simpan baris baru).
  const edit = getEditInfo(msg.message)
  if (edit) {
    const newBody = extractBody(edit.newContent)
    if (newBody != null) {
      let updated = null
      // Coba dgn kolom `edited`; jika kolom belum ada, ulangi tanpa itu.
      let res = await supabase.from('messages')
        .update({ body: newBody, edited: true })
        .eq('wa_message_id', edit.originalId)
        .select('id, conversation_id, body, edited').maybeSingle()
      if (res.error) {
        res = await supabase.from('messages')
          .update({ body: newBody })
          .eq('wa_message_id', edit.originalId)
          .select('id, conversation_id, body').maybeSingle()
      }
      updated = res.data
      if (updated) {
        const p = { message: updated, conversationId: updated.conversation_id }
        const pub = await publish('message_updated', p)
        if (!pub) ioInstance?.emit('message_updated', p)
      }
    }
    return
  }

  // Edit terenkripsi (secretEncryptedMessage MESSAGE_EDIT). Coba dekripsi teks
  // baru pakai messageSecret pesan asli; kalau gagal -> tandai "diedit" saja.
  const secretEdit = getSecretEdit(msg.message)
  if (secretEdit) {
    const { data: orig } = await supabase.from('messages')
      .select('id, conversation_id, body, edited, message_secret')
      .eq('wa_message_id', secretEdit.targetMessageKey.id).maybeSingle()

    let newBody = null
    if (orig?.message_secret) {
      try {
        const meJid = jidNormalizedUser(sock?.user?.id || '')
        const secretBuf = Buffer.from(orig.message_secret, 'base64')
        const dec = decryptSecretEdit({ sec: secretEdit, messageSecret: secretBuf, meJid })
        if (dec) { newBody = dec.text; console.log(`[Edit] dekripsi sukses (useCase=${dec.useCase})`) }
        else console.warn('[Edit] dekripsi gagal untuk semua kandidat useCase')
      } catch (e) { console.warn('[Edit] error dekripsi:', e.message) }
    } else {
      console.warn('[Edit] message_secret pesan asli tidak tersimpan, tak bisa dekripsi')
    }

    const patch = newBody != null ? { body: newBody, edited: true } : { edited: true }
    let res = await supabase.from('messages').update(patch)
      .eq('wa_message_id', secretEdit.targetMessageKey.id)
      .select('id, conversation_id, body, edited').maybeSingle()
    if (res.error && newBody != null) {
      res = await supabase.from('messages').update({ body: newBody })
        .eq('wa_message_id', secretEdit.targetMessageKey.id)
        .select('id, conversation_id, body').maybeSingle()
    }
    if (!res.error && res.data) {
      const p = { message: res.data, conversationId: res.data.conversation_id }
      const pub = await publish('message_updated', p)
      if (!pub) ioInstance?.emit('message_updated', p)
    }
    return
  }

  const msgKeys = Object.keys(msg.message)
  const isProtocol = msgKeys.every(k =>
    ['messageContextInfo', 'protocolMessage', 'senderKeyDistributionMessage', 'reactionMessage', 'secretEncryptedMessage'].includes(k)
  )
  if (isProtocol) return

  const fromMe = msg.key.fromMe
  const jid = msg.key.remoteJid
  if (!jid || jid === 'status@broadcast') return
  if (jid.endsWith('@broadcast') || jid.endsWith('@temp')) return

  const isGroup = jid.endsWith('@g.us')
  const waMessageId = msg.key.id

  if (waMessageId) {
    const { data: dup } = await supabase
      .from('messages').select('id').eq('wa_message_id', waMessageId).maybeSingle()
    if (dup) return
  }

  // Pesan menyusul (append/history): hanya yang <=7 hari (hindari impor riwayat lama massal)
  if (!isLive) {
    const tsMs = Number(msg.messageTimestamp || 0) * 1000
    if (tsMs && (Date.now() - tsMs) > 7 * 24 * 60 * 60 * 1000) return
  }

  let phone, contactName
  if (isGroup) {
    phone = jid.split('@')[0]
    try {
      const meta = await sock.groupMetadata(jid)
      contactName = meta?.subject || phone
    } catch { contactName = phone }
  } else {
    phone = resolvePhone(jid)
    contactName = fromMe ? null : (msg.pushName || null)
  }

  const tStart = Date.now()
  const body = extractBody(msg.message)
  const timestamp = msg.messageTimestamp
  const mediaInfo = getMediaInfo(msg.message)

  // Diagnostik: pesan tanpa teks & tanpa media terdeteksi -> tersimpan '[media]'.
  // Log struktur agar tipe pesan yang belum ditangani (mis. edit) bisa dikenali.
  if (body == null && !mediaInfo) {
    try {
      console.warn('[UnknownMsg] keys=', Object.keys(msg.message),
        'sample=', JSON.stringify(msg.message).slice(0, 600))
    } catch {}
  }

  const ctx = getContextInfo(msg.message)
  let replyToWaId = null, replyToBody = null, replyToFromMe = null
  if (ctx?.stanzaId) {
    replyToWaId = ctx.stanzaId
    replyToBody = extractBody(ctx.quotedMessage)
    const { data: q } = await supabase
      .from('messages').select('from_me, body').eq('wa_message_id', replyToWaId).maybeSingle()
    if (q) { replyToFromMe = q.from_me; if (!replyToBody) replyToBody = q.body }
  }

  const mediaMimetype = mediaInfo ? (mediaInfo.msgObj.mimetype || 'application/octet-stream') : null
  const storageFilename = mediaInfo ? `${Date.now()}-${waMessageId}.${mediaInfo.ext}` : null
  const mediaFilename = mediaInfo ? (mediaInfo.filename || storageFilename) : null

  const { contactId, conversationId } = await withPhoneLock(phone, async () => {
    const cId = await upsertContact(phone, contactName)
    const convId = await upsertConversation(cId, jid)
    return { contactId: cId, conversationId: convId }
  })
  const tDb = Date.now()

  const savedMessage = await saveMessage({
    conversationId, fromMe,
    body: body || (mediaInfo ? `[${mediaInfo.type}]` : '[media]'),
    timestamp, waMessageId,
    mediaType: mediaInfo?.type || null,
    mediaUrl: null,
    mediaFilename, mediaMimetype,
    replyToWaId, replyToBody, replyToFromMe,
  })

  // Simpan messageSecret (untuk mendekripsi edit terenkripsi nanti). Best-effort:
  // jika kolom belum ada, abaikan tanpa mengganggu penyimpanan pesan.
  const messageSecret = msg.message?.messageContextInfo?.messageSecret
  if (messageSecret && savedMessage?.id) {
    const b64 = Buffer.from(messageSecret).toString('base64')
    supabase.from('messages').update({ message_secret: b64 }).eq('id', savedMessage.id)
      .then(({ error }) => { if (error) { /* kolom mungkin belum ada */ } }, () => {})
  }

  const payload = { message: savedMessage, conversationId, contactId, contactName: contactName || phone, phone }
  const published = await publish('new_message', payload)
  if (!published) ioInstance?.emit('new_message', payload)
  console.log(`[Recv${isLive ? '' : '/sync'}] ${fromMe ? 'out' : 'in '} conv=${conversationId} db=${tDb - tStart}ms${mediaInfo ? ` media=${mediaInfo.type}(bg)` : ''}`)

  // Denormalisasi ringkasan percakapan (mempercepat daftar chat -> 1 query).
  const tsIso = new Date((Number(timestamp) || Math.floor(Date.now() / 1000)) * 1000).toISOString()
  const summaryBody = body || (mediaInfo ? `[${mediaInfo.type}]` : '[media]')
  const convSummary = {
    updated_at: new Date().toISOString(),
    last_message: summaryBody,
    last_message_at: tsIso,
    last_from_me: fromMe,
  }
  if (fromMe) convSummary.awaiting_since = null
  supabase.from('conversations').update(convSummary).eq('id', conversationId)
    .then(({ error }) => { if (error) { /* kolom ringkasan mungkin belum ada */ } }, () => {})
  // Pesan masuk: set awaiting_since bila belum ada (kolom terpisah agar tak menimpa)
  if (!fromMe) {
    supabase.from('conversations').update({ awaiting_since: tsIso })
      .eq('id', conversationId).is('awaiting_since', null)
      .then(() => {}, () => {})
  }

  if (isLive) {
    incrementDailyStats().catch(() => {})
    if (!fromMe) {
      // Chat bertag Deal / Non-Client dianggap SELESAI -> tidak boleh Aktif.
      // Paksa Resolved & lewati reaktivasi + auto-assign. Non-Client tanpa notif;
      // Deal tetap diberi notif agar agent tahu ada balasan (mis. koordinasi kirim).
      const closed = await closedTagState(conversationId)
      if (closed) {
        supabase.from('conversations').update({ status: 'resolved' })
          .eq('id', conversationId).neq('status', 'resolved')
          .then(() => {}, () => {})
        if (closed === 'deal') pushNewMessage(payload).catch(() => {})
      } else {
        // Reaktivasi chat resolved
        supabase.from('conversations').update({ status: 'in_progress' })
          .eq('id', conversationId).eq('status', 'resolved').not('assigned_to', 'is', null)
          .then(() => {}, () => {})
        supabase.from('conversations').update({ status: 'open' })
          .eq('id', conversationId).eq('status', 'resolved').is('assigned_to', null)
          .then(() => {}, () => {})
        // Auto-assign + push
        autoAssignConversation(conversationId)
          .then(async (agent) => {
            if (agent) {
              const ap = { conversationId, agent }
              const pub = await publish('conversation_assigned', ap)
              if (!pub) ioInstance?.emit('conversation_assigned', ap)
            }
          })
          .catch(() => null)
          .finally(() => { pushNewMessage(payload).catch(() => {}) })
      }
    }
  }

  // Download + upload media di background, lalu broadcast update URL-nya
  if (mediaInfo) {
    ;(async () => {
      try {
        let buffer = await downloadMediaMessage(
          msg, 'buffer', {},
          { logger: waLogger, reuploadRequest: sock.updateMediaMessage }
        )
        let uploadName = storageFilename
        let uploadMime = mediaMimetype
        // Kompres gambar sebelum simpan -> hemat storage
        if (mediaInfo.type === 'image') {
          const c = await compressImage(buffer, mediaMimetype)
          if (c) {
            buffer = c.buffer
            uploadMime = c.mimetype
            uploadName = storageFilename.replace(/\.[^.]+$/, `.${c.ext}`)
          }
        }
        const mediaUrl = await uploadToStorage(buffer, uploadName, uploadMime)
        if (!mediaUrl) return
        // Thumbnail kecil untuk preview cepat (best-effort)
        let thumbUrl = null
        if (mediaInfo.type === 'image') {
          const t = await makeThumbnail(buffer, uploadMime)
          if (t) thumbUrl = await uploadToStorage(t.buffer, `thumb_${uploadName}`, t.mimetype)
        }
        const { data: updated } = await supabase
          .from('messages').update({ media_url: mediaUrl, media_mimetype: uploadMime }).eq('id', savedMessage.id).select().single()
        // media_thumb_url terpisah (kolom mungkin belum ada -> best-effort)
        if (thumbUrl) {
          supabase.from('messages').update({ media_thumb_url: thumbUrl }).eq('id', savedMessage.id).then(() => {}, () => {})
        }
        const baseMsg = updated || { ...savedMessage, media_url: mediaUrl }
        const upPayload = { message: { ...baseMsg, media_thumb_url: thumbUrl || baseMsg.media_thumb_url || null }, conversationId, contactId }
        const pub2 = await publish('message_updated', upPayload)
        if (!pub2) ioInstance?.emit('message_updated', upPayload)
      } catch (err) {
        console.warn('[Media] Background download/upload failed:', err.message)
      }
    })()
  }
}

// Ambil versi WA terbaru (WAJIB — versi usang ditolak WhatsApp dengan 405).
// Di-cache agar reconnect tidak fetch ulang. Retry singkat bila gagal.
let cachedWaVersion = null
async function getWaVersion() {
  if (cachedWaVersion) return cachedWaVersion
  for (let i = 0; i < 3; i++) {
    try {
      const { version } = await fetchLatestBaileysVersion()
      cachedWaVersion = version
      return cachedWaVersion
    } catch (e) {
      console.warn(`[WA] gagal ambil versi (percobaan ${i + 1}):`, e.message)
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  // Tetap coba fetch sekali lagi (biarkan error naik bila benar-benar gagal)
  const { version } = await fetchLatestBaileysVersion()
  cachedWaVersion = version
  return cachedWaVersion
}

export async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
  const version = await getWaVersion()

  sock = makeWASocket({
    version,
    logger: waLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, waLogger),
    },
    // printQRInTerminal dihapus (deprecated) — QR ditangani via connection.update
    syncFullHistory: false,
    getMessage: async (key) => {
      try {
        if (!key.id) return undefined
        const { data } = await supabase
          .from('messages')
          .select('body')
          .eq('wa_message_id', key.id)
          .maybeSingle()
        if (data?.body) return { conversation: data.body }
      } catch {}
      return { conversation: 'message unavailable' }
    },
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      if (!contact.id) continue
      const phone = contact.id.split('@')[0]
      if (contact.lid) {
        const lid = contact.lid.split('@')[0]
        lidToPhone.set(lid, phone)
      }
      if (contact.id.endsWith('@lid') && contact.notify) {
        const realPhone = contact.notify.replace(/\D/g, '')
        if (realPhone) lidToPhone.set(phone, realPhone)
      }
    }
  })

  sock.ev.on('contacts.update', (updates) => {
    for (const update of updates) {
      if (!update.id || !update.lid) continue
      const phone = update.id.split('@')[0]
      const lid = update.lid.split('@')[0]
      lidToPhone.set(lid, phone)
    }
  })

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      try {
        latestQr = await QRCode.toDataURL(qr)
        ioInstance?.emit('qr', latestQr)
      } catch (err) {
        console.error('QR generation error:', err)
      }
    }

    if (connection === 'open') {
      console.log('WhatsApp connected!')
      isConnected = true
      latestQr = null
      reconnectFails = 0
      ioInstance?.emit('wa_status', { connected: true })
      // Bila sedang sinkronisasi manual, beri waktu pesan offline mengalir lalu matikan indikator
      if (syncing) setTimeout(() => setSyncing(false), 8000)
    }

    if (connection === 'close') {
      isConnected = false
      ioInstance?.emit('wa_status', { connected: false })
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut
      console.warn(`[WA] connection close (statusCode=${statusCode}, loggedOut=${loggedOut}, fails=${reconnectFails})`)
      // 405 = versi client ditolak WhatsApp -> ambil ulang versi terbaru
      if (statusCode === 405) cachedWaVersion = null
      if (loggedOut) {
        // Sesi dihapus dari HP -> bersihkan & reconnect untuk QR baru
        reconnectFails = 0
        await clearAuthFolder()
        setTimeout(() => connectToWhatsApp(), 500)
      } else if (statusCode === DisconnectReason.restartRequired) {
        // Normal setelah scan/awal koneksi -> reconnect cepat, jangan dihitung gagal
        setTimeout(() => connectToWhatsApp(), 300)
      } else {
        // Gangguan sementara (stream error / jaringan / sesi diambil alih sesaat).
        // JANGAN hapus auth di sini: menghapus creds sehat = kunci enkripsi berganti
        // -> penerima lihat "message unavailable". Cukup reconnect dengan backoff;
        // creds lama dipakai ulang sehingga sesi tetap sinkron. Reset sesi hanya
        // saat benar-benar loggedOut (di atas) atau manual via POST /api/wa/reset.
        reconnectFails++
        const delay = Math.min(2000 * reconnectFails, 30000) // 2s..30s
        setTimeout(() => connectToWhatsApp(), delay)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = pesan live; 'append' = pesan menyusul saat reconnect (offline/sinkron)
    if (type !== 'notify' && type !== 'append') return
    const isLive = type === 'notify'
    for (const msg of messages) {
      try { await persistMessage(msg, { isLive }) }
      catch (err) { console.error('Error processing message:', err) }
    }
  })

  // Sinkronisasi riwayat/offline: WhatsApp mengirim pesan yang masuk saat
  // device offline lewat event ini saat reconnect. Diproses sebagai non-live.
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    if (!Array.isArray(messages) || !messages.length) return
    console.log(`[Sync] messaging-history.set: ${messages.length} pesan`)
    for (const msg of messages) {
      try { await persistMessage(msg, { isLive: false }) }
      catch (err) { console.warn('[Sync] gagal proses pesan history:', err.message) }
    }
  })

  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (!key.fromMe || !update.status) continue
      try {
        let status = 'sent'
        if (update.status >= 4) status = 'read'
        else if (update.status >= 3) status = 'delivered'

        const { data: updated } = await supabase
          .from('messages')
          .update({ status })
          .eq('wa_message_id', key.id)
          .select('id, conversation_id')
          .maybeSingle()

        if (updated) {
          const payload = {
            messageId: updated.id,
            conversationId: updated.conversation_id,
            waMessageId: key.id,
            status,
          }
          const published = await publish('message_status', payload)
          if (!published) ioInstance?.emit('message_status', payload)
        }
      } catch (err) {
        console.warn('[Receipt] Update error:', err.message)
      }
    }
  })

  return sock
}
