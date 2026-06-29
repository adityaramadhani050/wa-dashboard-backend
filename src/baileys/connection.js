import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { supabase } from '../db/supabase.js'
import { publish, redisAvailable } from '../db/redis.js'
import { sendToAgents, sendToAll, isPushEnabled } from '../push/fcm.js'
import { sendWebPushToAgents, sendWebPushToAll, isWebPushEnabled } from '../push/webpush.js'
import { autoAssignConversation } from '../services/autoAssign.js'
import QRCode from 'qrcode'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_FOLDER = path.join(__dirname, '../../.wa_auth')

let sock = null
let ioInstance = null
let isConnected = false

const lidToPhone = new Map()

export function setIO(io) { ioInstance = io }
export function getSock() { return sock }
export function getIsConnected() { return isConnected }

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

async function saveMessage({ conversationId, fromMe, body, timestamp, waMessageId, mediaType, mediaUrl, mediaFilename, mediaMimetype }) {
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

export async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, console),
    },
    printQRInTerminal: true,
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
        const qrDataURL = await QRCode.toDataURL(qr)
        ioInstance?.emit('qr', qrDataURL)
      } catch (err) {
        console.error('QR generation error:', err)
      }
    }

    if (connection === 'open') {
      console.log('WhatsApp connected!')
      isConnected = true
      ioInstance?.emit('wa_status', { connected: true })
    }

    if (connection === 'close') {
      isConnected = false
      ioInstance?.emit('wa_status', { connected: false })
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut
      if (loggedOut) {
        await clearAuthFolder()
        setTimeout(() => connectToWhatsApp(), 1000)
      } else {
        setTimeout(() => connectToWhatsApp(), 3000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = pesan live; 'append' = pesan menyusul saat reconnect (offline/sinkron).
    // Keduanya diproses agar pesan yang masuk saat WA sempat disconnect tetap tersimpan.
    if (type !== 'notify' && type !== 'append') return
    const isLive = type === 'notify'

    for (const msg of messages) {
      try {
        if (!msg.message) continue

        const msgKeys = Object.keys(msg.message)
        const isProtocol = msgKeys.every(k =>
          ['messageContextInfo', 'protocolMessage', 'senderKeyDistributionMessage', 'reactionMessage'].includes(k)
        )
        if (isProtocol) continue

        const fromMe = msg.key.fromMe
        const jid = msg.key.remoteJid

        if (jid === 'status@broadcast') continue
        if (jid.endsWith('@broadcast') || jid.endsWith('@temp')) continue

        const isGroup = jid.endsWith('@g.us')
        const waMessageId = msg.key.id

        if (waMessageId) {
          const { data: dup } = await supabase
            .from('messages').select('id').eq('wa_message_id', waMessageId).maybeSingle()
          if (dup) continue
        }

        // Untuk pesan menyusul (append/sinkron), batasi hanya yang masih baru
        // (<=7 hari) supaya tidak mengimpor riwayat lama secara massal.
        if (!isLive) {
          const tsMs = Number(msg.messageTimestamp || 0) * 1000
          if (tsMs && (Date.now() - tsMs) > 7 * 24 * 60 * 60 * 1000) continue
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

        // Metadata media bisa dibaca tanpa download (mimetype/nama/ext).
        // File-nya diunduh di background supaya pesan tampil instan.
        const mediaMimetype = mediaInfo ? (mediaInfo.msgObj.mimetype || 'application/octet-stream') : null
        const storageFilename = mediaInfo ? `${Date.now()}-${waMessageId}.${mediaInfo.ext}` : null
        const mediaFilename = mediaInfo ? (mediaInfo.filename || storageFilename) : null

        // Serialize per nomor: cegah balapan yang bikin 1 kontak punya banyak
        // percakapan saat pesan datang beruntun (burst).
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
          mediaUrl: null, // menyusul via background download
          mediaFilename, mediaMimetype,
        })

        const payload = { message: savedMessage, conversationId, contactId, contactName: contactName || phone, phone }
        const published = await publish('new_message', payload)
        if (!published) ioInstance?.emit('new_message', payload)
        const tEmit = Date.now()
        console.log(`[Recv] ${fromMe ? 'out' : 'in '} conv=${conversationId} db=${tDb - tStart}ms emit=${tEmit - tStart}ms${mediaInfo ? ` media=${mediaInfo.type}(bg)` : ''}`)

        supabase.from('conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', conversationId)
          .then(() => {}).catch(() => {})
        incrementDailyStats().catch(() => {})

        // Pesan masuk pada chat "Resolved" -> reaktivasi: "Aktif" bila masih
        // di-assign ke agent, atau "Open" bila belum di-assign.
        if (!fromMe) {
          supabase.from('conversations')
            .update({ status: 'in_progress' })
            .eq('id', conversationId)
            .eq('status', 'resolved')
            .not('assigned_to', 'is', null)
            .then(() => {}, () => {})
          supabase.from('conversations')
            .update({ status: 'open' })
            .eq('id', conversationId)
            .eq('status', 'resolved')
            .is('assigned_to', null)
            .then(() => {}, () => {})
        }

        // Auto-assign (bila aktif) lalu push — supaya agent yang baru di-assign
        // langsung menerima notifikasi. Non-blocking terhadap alur utama.
        if (!fromMe) {
          autoAssignConversation(conversationId)
            .then(async (agent) => {
              if (agent) {
                // Broadcast assignment baru supaya badge agent muncul realtime
                const ap = { conversationId, agent }
                const pub = await publish('conversation_assigned', ap)
                if (!pub) ioInstance?.emit('conversation_assigned', ap)
              }
            })
            .catch(() => null)
            // Push hanya untuk pesan live; batch saat reconnect tidak spam notifikasi
            .finally(() => { if (isLive) pushNewMessage(payload).catch(() => {}) })
        }

        // Download + upload media di background, lalu broadcast update URL-nya
        if (mediaInfo) {
          ;(async () => {
            const tm0 = Date.now()
            try {
              const buffer = await downloadMediaMessage(
                msg, 'buffer', {},
                { logger: console, reuploadRequest: sock.updateMediaMessage }
              )
              const mediaUrl = await uploadToStorage(buffer, storageFilename, mediaMimetype)
              if (!mediaUrl) return
              const { data: updated } = await supabase
                .from('messages')
                .update({ media_url: mediaUrl })
                .eq('id', savedMessage.id)
                .select()
                .single()
              const upPayload = { message: updated || { ...savedMessage, media_url: mediaUrl }, conversationId, contactId }
              const pub2 = await publish('message_updated', upPayload)
              if (!pub2) ioInstance?.emit('message_updated', upPayload)
              console.log(`[Recv] media ready conv=${conversationId} ${mediaInfo.type} in ${Date.now() - tm0}ms`)
            } catch (err) {
              console.warn('[Media] Background download/upload failed:', err.message)
            }
          })()
        }

      } catch (err) {
        console.error('Error processing message:', err)
      }
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
