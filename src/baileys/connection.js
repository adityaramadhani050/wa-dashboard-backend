import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { supabase } from '../db/supabase.js';
import QRCode from 'qrcode';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FOLDER = path.join(__dirname, '../../.wa_auth');

let sock = null;
let ioInstance = null;
let isConnected = false;

const lidToPhone = new Map();

export function setIO(io) { ioInstance = io; }
export function getSock() { return sock; }
export function getIsConnected() { return isConnected; }

async function clearAuthFolder() {
  try {
    await fs.rm(AUTH_FOLDER, { recursive: true, force: true });
    console.log('[Auth] Auth folder cleared');
  } catch (err) {
    console.warn('[Auth] Could not clear auth folder:', err.message);
  }
}

export async function resetSession() {
  if (sock) {
    try { sock.ev.removeAllListeners(); sock.end(); } catch (e) {}
    sock = null;
  }
  isConnected = false;
  ioInstance?.emit('wa_status', { connected: false });
  await clearAuthFolder();
  setTimeout(() => connectToWhatsApp(), 500);
}

function resolvePhone(jid) {
  const raw = jid.split('@')[0];
  if (!jid.endsWith('@lid')) return raw;
  return lidToPhone.get(raw) || raw;
}

function extractBody(message) {
  if (!message) return null;
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
  );
}

function getMediaInfo(message) {
  if (message.imageMessage) {
    return { type: 'image', msgObj: message.imageMessage, ext: 'jpg', filename: null };
  }
  if (message.videoMessage) {
    return { type: 'video', msgObj: message.videoMessage, ext: 'mp4', filename: null };
  }
  if (message.audioMessage) {
    return {
      type: 'audio',
      msgObj: message.audioMessage,
      ext: message.audioMessage.ptt ? 'ogg' : 'mp3',
      filename: null,
    };
  }
  if (message.documentMessage) {
    const doc = message.documentMessage;
    const ext = doc.fileName?.split('.').pop() || 'bin';
    return { type: 'document', msgObj: doc, ext, filename: doc.fileName };
  }
  if (message.documentWithCaptionMessage?.message?.documentMessage) {
    const doc = message.documentWithCaptionMessage.message.documentMessage;
    const ext = doc.fileName?.split('.').pop() || 'bin';
    return { type: 'document', msgObj: doc, ext, filename: doc.fileName };
  }
  return null;
}

async function uploadToStorage(buffer, filename, mimetype) {
  try {
    const { error } = await supabase.storage
      .from('wa-media')
      .upload(filename, buffer, { contentType: mimetype, upsert: true });
    if (error) throw error;
    const { data: { publicUrl } } = supabase.storage.from('wa-media').getPublicUrl(filename);
    return publicUrl;
  } catch (err) {
    console.warn('[Storage] Upload error:', err.message);
    return null;
  }
}

async function upsertContact(phone, pushName) {
  const { data: existing } = await supabase
    .from('contacts')
    .select('id, name, phone')
    .eq('phone', phone)
    .single();

  if (existing) {
    if (pushName && pushName !== phone && existing.name === existing.phone) {
      await supabase.from('contacts').update({ name: pushName }).eq('id', existing.id);
    }
    return existing.id;
  }

  const { data, error } = await supabase
    .from('contacts')
    .insert({ phone, name: pushName || phone, first_seen: new Date().toISOString() })
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

async function upsertConversation(contactId, waJid) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id, wa_jid')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (existing) {
    if (waJid && existing.wa_jid !== waJid) {
      await supabase.from('conversations').update({ wa_jid: waJid }).eq('id', existing.id);
    }
    return existing.id;
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
    .single();

  if (error) throw error;
  return data.id;
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
    .single();

  if (error) throw error;
  return data;
}

async function incrementDailyStats() {
  try {
    const today = new Date().toISOString().split('T')[0];
    await supabase.rpc('increment_daily_stats', { stat_date: today });
  } catch (err) {
    console.warn('increment_daily_stats RPC error:', err.message);
  }
}

export async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

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
        if (!key.id) return undefined;
        const { data } = await supabase
          .from('messages')
          .select('body')
          .eq('wa_message_id', key.id)
          .maybeSingle();
        if (data?.body) return { conversation: data.body };
      } catch {}
      return { conversation: 'message unavailable' };
    },
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      if (!contact.id) continue;
      const phone = contact.id.split('@')[0];
      if (contact.lid) {
        const lid = contact.lid.split('@')[0];
        lidToPhone.set(lid, phone);
      }
      if (contact.id.endsWith('@lid') && contact.notify) {
        const realPhone = contact.notify.replace(/\D/g, '');
        if (realPhone) lidToPhone.set(phone, realPhone);
      }
    }
    console.log(`[Contacts] LID map updated, ${lidToPhone.size} entries`);
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const update of updates) {
      if (!update.id || !update.lid) continue;
      const phone = update.id.split('@')[0];
      const lid = update.lid.split('@')[0];
      lidToPhone.set(lid, phone);
    }
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      try {
        const qrDataURL = await QRCode.toDataURL(qr);
        ioInstance?.emit('qr', qrDataURL);
      } catch (err) {
        console.error('QR generation error:', err);
      }
    }

    if (connection === 'open') {
      console.log('WhatsApp connected!');
      isConnected = true;
      ioInstance?.emit('wa_status', { connected: true });
    }

    if (connection === 'close') {
      isConnected = false;
      ioInstance?.emit('wa_status', { connected: false });
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(`[WA] Closed. statusCode=${statusCode} loggedOut=${loggedOut}`);
      if (loggedOut) {
        await clearAuthFolder();
        setTimeout(() => connectToWhatsApp(), 1000);
      } else {
        setTimeout(() => connectToWhatsApp(), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;

        const msgKeys = Object.keys(msg.message);
        const isProtocol = msgKeys.every(k =>
          ['messageContextInfo', 'protocolMessage', 'senderKeyDistributionMessage', 'reactionMessage'].includes(k)
        );
        if (isProtocol) continue;

        const fromMe = msg.key.fromMe;
        const jid = msg.key.remoteJid;
        if (jid.endsWith('@g.us')) continue;

        const waMessageId = msg.key.id;

        // Deduplication: skip if this wa_message_id already exists
        if (waMessageId) {
          const { data: dup } = await supabase
            .from('messages')
            .select('id')
            .eq('wa_message_id', waMessageId)
            .maybeSingle();
          if (dup) {
            console.log(`[Dedup] Skipping duplicate message: ${waMessageId}`);
            continue;
          }
        }

        const phone = resolvePhone(jid);
        const contactName = fromMe ? null : (msg.pushName || null);
        const body = extractBody(msg.message);
        const timestamp = msg.messageTimestamp;

        // Detect and download media
        const mediaInfo = getMediaInfo(msg.message);
        let mediaUrl = null, mediaFilename = null, mediaMimetype = null;

        if (mediaInfo) {
          try {
            const buffer = await downloadMediaMessage(
              msg, 'buffer', {},
              { logger: console, reuploadRequest: sock.updateMediaMessage }
            );
            const storageFilename = `${Date.now()}-${waMessageId}.${mediaInfo.ext}`;
            mediaMimetype = mediaInfo.msgObj.mimetype || 'application/octet-stream';
            mediaFilename = mediaInfo.filename || storageFilename;
            mediaUrl = await uploadToStorage(buffer, storageFilename, mediaMimetype);
            console.log(`[Media] ${mediaInfo.type} uploaded: ${storageFilename}`);
          } catch (err) {
            console.warn('[Media] Download/upload failed:', err.message);
          }
        }

        const contactId = await upsertContact(phone, contactName);
        const conversationId = await upsertConversation(contactId, jid);

        const savedMessage = await saveMessage({
          conversationId,
          fromMe,
          body: body || (mediaInfo ? `[${mediaInfo.type}]` : '[media]'),
          timestamp,
          waMessageId,
          mediaType: mediaInfo?.type || null,
          mediaUrl,
          mediaFilename,
          mediaMimetype,
        });

        await supabase
          .from('conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', conversationId);

        await incrementDailyStats();

        ioInstance?.emit('new_message', {
          message: savedMessage,
          conversationId,
          contactId,
        });
      } catch (err) {
        console.error('Error processing message:', err);
      }
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (!key.fromMe || !update.status) continue;
      try {
        let status = 'sent';
        if (update.status >= 4) status = 'read';
        else if (update.status >= 3) status = 'delivered';

        await supabase
          .from('messages')
          .update({ status })
          .eq('wa_message_id', key.id);

        console.log(`[Receipt] msg=${key.id} status=${status}(${update.status})`);
      } catch (err) {
        console.warn('[Receipt] Update error:', err.message);
      }
    }
  });

  return sock;
}
