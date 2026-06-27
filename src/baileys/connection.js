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
import { sendToAgent, sendToAll, isPushEnabled } from '../push/fcm.js'
import { sendWebPushToAgent, sendWebPushToAll, isWebPushEnabled } from '../push/webpush.js'
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

// Kirim push FCM untuk pesan masuk baru. Target: agent yang menangani
// percakapan; kalau belum di-assign, kirim ke semua device terdaftar.
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
    console.log(`[Push] new message conv=${conversationId} assigned_to=${conv?.assigned_to || '(unassigned)'}`)
    if (conv?.assigned_to) {
      await Promise.all([
        sendToAgent(conv.assigned_to, { title, body, data }),       // FCM (Android)
        sendWebPushToAgent(conv.assigned_to, { title, body, data }), // Web Push (PWA)
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
    if (type !== 'notify') return

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

        const contactId = await upsertContact(phone, contactName)
        const conversationId = await upsertConversation(contactId, jid)
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

        // Push notification (FCM) ke HP agent — hanya pesan masuk dari customer
        if (!fromMe) pushNewMessage(payload).catch(() => {})

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
