import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  getContentType,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { supabase } from '../db/supabase.js';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FOLDER = path.join(__dirname, '../../.wa_auth');

let sock = null;
let ioInstance = null;

// In-memory store to resolve LID → real phone mappings
const store = makeInMemoryStore({});

export function setIO(io) {
  ioInstance = io;
}

export function getSock() {
  return sock;
}

// Resolve the best phone number from a JID
// @lid JIDs are WhatsApp internal IDs, try to resolve to real phone via store
function resolvePhone(jid, storeContacts = {}) {
  const raw = jid.split('@')[0];
  if (!jid.endsWith('@lid')) return raw;

  // Try to find real number from store contacts
  const contact = storeContacts[jid];
  if (contact?.notify) return contact.notify.replace(/\D/g, '');
  if (contact?.verifiedName) return contact.verifiedName;
  if (contact?.id) return contact.id.split('@')[0];

  // Fallback: use LID number as-is (not ideal but better than crashing)
  return raw;
}

async function upsertContact(phone, pushName) {
  const { data: existing } = await supabase
    .from('contacts')
    .select('id, name, phone')
    .eq('phone', phone)
    .single();

  if (existing) {
    // Update name if we now have a real name and previously only had phone as name
    if (pushName && pushName !== phone && existing.name === existing.phone) {
      await supabase
        .from('contacts')
        .update({ name: pushName })
        .eq('id', existing.id);
    }
    return existing.id;
  }

  const { data, error } = await supabase
    .from('contacts')
    .insert({
      phone,
      name: pushName || phone,
      first_seen: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

async function upsertConversation(contactId) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('conversations')
    .insert({
      contact_id: contactId,
      status: 'open',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

async function saveMessage({ conversationId, fromMe, body, timestamp }) {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      from_me: fromMe,
      body,
      timestamp: new Date(timestamp * 1000).toISOString(),
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
  });

  // Bind store to socket events for LID resolution
  store.bind(sock.ev);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      try {
        const qrDataURL = await QRCode.toDataURL(qr);
        console.log('New QR code generated, emitting to frontend...');
        ioInstance?.emit('qr', qrDataURL);
      } catch (err) {
        console.error('QR generation error:', err);
      }
    }

    if (connection === 'open') {
      console.log('WhatsApp connected!');
      ioInstance?.emit('wa_status', { connected: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom &&
        lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;

      console.log('Connection closed. Reconnect:', shouldReconnect);
      ioInstance?.emit('wa_status', { connected: false });

      if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp(), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;

        const fromMe = msg.key.fromMe;
        const jid = msg.key.remoteJid;

        if (jid.endsWith('@g.us')) continue;

        // Resolve real phone number (handles both @s.whatsapp.net and @lid)
        const phone = resolvePhone(jid, store.contacts || {});

        // Only use pushName from received messages — for sent messages,
        // pushName is your own account name, not the contact's name
        const contactName = fromMe ? null : (msg.pushName || null);

        const body =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '[media]';

        const timestamp = msg.messageTimestamp;

        const contactId = await upsertContact(phone, contactName);
        const conversationId = await upsertConversation(contactId);

        const savedMessage = await saveMessage({
          conversationId,
          fromMe,
          body,
          timestamp,
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

  return sock;
}
