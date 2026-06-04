import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
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

export function resolveJidForSend(storedPhone) {
  const realPhone = lidToPhone.get(storedPhone);
  if (realPhone) {
    console.log(`[JID] Resolved LID ${storedPhone} → ${realPhone}`);
    return `${realPhone}@s.whatsapp.net`;
  }
  if (/^\d{10,13}$/.test(storedPhone)) {
    return `${storedPhone}@s.whatsapp.net`;
  }
  console.log(`[JID] Unresolved phone ${storedPhone}, trying @lid`);
  return `${storedPhone}@lid`;
}

function resolvePhone(jid) {
  const raw = jid.split('@')[0];
  if (!jid.endsWith('@lid')) return raw;
  return lidToPhone.get(raw) || raw;
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

async function saveMessage({ conversationId, fromMe, body, timestamp, waMessageId }) {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      from_me: fromMe,
      body,
      timestamp: new Date(timestamp * 1000).toISOString(),
      status: fromMe ? 'sent' : null,
      wa_message_id: waMessageId || null,
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
        const lid = phone;
        const realPhone = contact.notify.replace(/\D/g, '');
        if (realPhone) lidToPhone.set(lid, realPhone);
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

        const fromMe = msg.key.fromMe;
        const jid = msg.key.remoteJid;
        if (jid.endsWith('@g.us')) continue;

        const phone = resolvePhone(jid);
        const contactName = fromMe ? null : (msg.pushName || null);

        const body =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '[media]';

        const timestamp = msg.messageTimestamp;
        const waMessageId = msg.key.id;

        const contactId = await upsertContact(phone, contactName);
        const conversationId = await upsertConversation(contactId);

        const savedMessage = await saveMessage({
          conversationId,
          fromMe,
          body,
          timestamp,
          waMessageId,
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

  // Track delivery receipts for sent messages
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

        console.log(`[Receipt] msg=${key.id} status=${status}`);
      } catch (err) {
        console.warn('[Receipt] Update error:', err.message);
      }
    }
  });

  return sock;
}
