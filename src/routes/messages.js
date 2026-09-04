import { Router } from 'express';
import multer from 'multer';
import { getSock, broadcast, bumpConvOutgoing } from '../baileys/connection.js';
import { supabase } from '../db/supabase.js';
import { compressImage, makeThumbnail } from '../utils/media.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
});

// Normalisasi reply_to (bisa string JSON dari multipart, atau objek)
function parseReplyTo(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}
// Bangun opsi quoted Baileys dari reply_to
function buildQuotedOpts(jid, replyTo) {
  if (!replyTo?.wa_message_id) return {};
  return {
    quoted: {
      key: { remoteJid: jid, fromMe: !!replyTo.from_me, id: replyTo.wa_message_id },
      message: { conversation: replyTo.body || '' },
    },
  };
}

function mediaTypeFromMime(mime) {
  if (!mime) return 'document';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

router.post('/send', async (req, res) => {
  try {
    const { phone, message, conversation_id } = req.body;

    if (!message) return res.status(400).json({ error: 'message is required' });
    if (!phone && !conversation_id) return res.status(400).json({ error: 'phone or conversation_id is required' });

    const sock = getSock();
    if (!sock) return res.status(503).json({ error: 'WhatsApp is not connected yet' });

    let jid;
    if (conversation_id) {
      const { data: conv } = await supabase.from('conversations').select('wa_jid').eq('id', conversation_id).single();
      if (conv?.wa_jid) jid = conv.wa_jid;
    }
    if (!jid && phone) {
      jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    }
    if (!jid) return res.status(400).json({ error: 'Could not resolve WhatsApp JID' });

    await sock.sendMessage(jid, { text: message });

    if (conversation_id) {
      const { data: saved, error } = await supabase
        .from('messages')
        .insert({ conversation_id, from_me: true, body: message, timestamp: new Date().toISOString() })
        .select().single();
      if (error) throw error;
      await bumpConvOutgoing(conversation_id, message);
      return res.json({ success: true, message: saved });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('POST /messages/send error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/send-media', upload.single('file'), async (req, res) => {
  try {
    const { conversation_id, caption } = req.body;
    const replyTo = parseReplyTo(req.body.reply_to);
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'file is required' });
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id is required' });

    const sock = getSock();
    if (!sock) return res.status(503).json({ error: 'WhatsApp is not connected yet' });

    const { data: conv } = await supabase
      .from('conversations').select('wa_jid').eq('id', conversation_id).single();
    if (!conv?.wa_jid) return res.status(404).json({ error: 'Conversation not found or no JID' });

    const jid = conv.wa_jid;
    const mediaType = mediaTypeFromMime(file.mimetype);
    let buffer = file.buffer;
    let fileMime = file.mimetype;
    let fileName = file.originalname;
    const caption_ = caption || undefined;

    // Kompres gambar sebelum kirim & simpan -> hemat storage & bandwidth
    if (mediaType === 'image') {
      const c = await compressImage(buffer, file.mimetype);
      if (c) {
        buffer = c.buffer;
        fileMime = c.mimetype;
        fileName = file.originalname.replace(/\.[^.]+$/, `.${c.ext}`);
      }
    }

    let baileysMsg;
    if (mediaType === 'image') {
      baileysMsg = { image: buffer, caption: caption_, mimetype: fileMime };
    } else if (mediaType === 'video') {
      baileysMsg = { video: buffer, caption: caption_, mimetype: fileMime };
    } else if (mediaType === 'audio') {
      baileysMsg = { audio: buffer, mimetype: fileMime, ptt: false };
    } else {
      baileysMsg = { document: buffer, fileName, mimetype: fileMime, caption: caption_ };
    }

    const sentResult = await sock.sendMessage(jid, baileysMsg, buildQuotedOpts(jid, replyTo));
    const waMessageId = sentResult?.key?.id || null;

    let mediaUrl = null;
    let thumbUrl = null;
    try {
      const storageFilename = `${Date.now()}-${fileName}`;
      const { error: uploadErr } = await supabase.storage
        .from('wa-media')
        .upload(storageFilename, buffer, { contentType: fileMime, upsert: true });
      if (!uploadErr) {
        const { data: { publicUrl } } = supabase.storage.from('wa-media').getPublicUrl(storageFilename);
        mediaUrl = publicUrl;
      }
      // Thumbnail untuk preview cepat (best-effort)
      if (mediaType === 'image') {
        const t = await makeThumbnail(buffer, fileMime);
        if (t) {
          const thumbName = `thumb_${storageFilename}`;
          const { error: te } = await supabase.storage.from('wa-media')
            .upload(thumbName, t.buffer, { contentType: t.mimetype, upsert: true });
          if (!te) thumbUrl = supabase.storage.from('wa-media').getPublicUrl(thumbName).data.publicUrl;
        }
      }
    } catch (e) {
      console.warn('[Media] Storage upload error:', e.message);
    }

    const { data: saved, error } = await supabase
      .from('messages')
      .insert({
        conversation_id,
        from_me: true,
        body: caption || `[${mediaType}]`,
        timestamp: new Date().toISOString(),
        status: 'sent',
        wa_message_id: waMessageId,
        media_type: mediaType,
        media_url: mediaUrl,
        media_filename: fileName,
        media_mimetype: fileMime,
        reply_to_wa_id: replyTo?.wa_message_id || null,
        reply_to_body: replyTo?.body || null,
        reply_to_from_me: replyTo?.from_me ?? null,
      })
      .select().single();

    if (error) throw error;

    // Simpan media_thumb_url (best-effort; kolom mungkin belum ada)
    if (thumbUrl) {
      await supabase.from('messages').update({ media_thumb_url: thumbUrl }).eq('id', saved.id)
        .then(({ error: e }) => { if (!e) saved.media_thumb_url = thumbUrl; }, () => {});
    }

    await bumpConvOutgoing(conversation_id, caption || `[${mediaType}]`);

    broadcast('new_message', { message: saved, conversationId: conversation_id }).catch(() => {});
    res.json({ success: true, message: saved });
  } catch (err) {
    console.error('POST /messages/send-media error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Edit pesan (hanya pesan keluar milik kita, teks, & <=15 menit sesuai aturan WA)
const EDIT_WINDOW_MS = 15 * 60 * 1000;
router.patch('/:id/edit', async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'message wajib diisi' });

    const { data: msg } = await supabase
      .from('messages')
      .select('id, conversation_id, from_me, wa_message_id, media_type, timestamp')
      .eq('id', id)
      .single();
    if (!msg) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
    if (!msg.from_me) return res.status(403).json({ error: 'Hanya pesan sendiri yang bisa diedit' });
    if (msg.media_type) return res.status(400).json({ error: 'Pesan media tidak bisa diedit' });
    if (!msg.wa_message_id) return res.status(400).json({ error: 'Pesan ini tidak bisa diedit' });
    const ageMs = Date.now() - new Date(msg.timestamp).getTime();
    if (ageMs > EDIT_WINDOW_MS) {
      return res.status(400).json({ error: 'Pesan sudah lewat 15 menit, tidak bisa diedit' });
    }

    const sock = getSock();
    if (!sock) return res.status(503).json({ error: 'WhatsApp is not connected yet' });

    const { data: conv } = await supabase
      .from('conversations').select('wa_jid').eq('id', msg.conversation_id).single();
    if (!conv?.wa_jid) return res.status(404).json({ error: 'Percakapan tidak ditemukan' });

    // Kirim edit asli ke WhatsApp -> customer melihat pesan berubah + "Diedit"
    await sock.sendMessage(conv.wa_jid, {
      text: message,
      edit: { remoteJid: conv.wa_jid, fromMe: true, id: msg.wa_message_id },
    });

    let res2 = await supabase.from('messages')
      .update({ body: message, edited: true })
      .eq('id', id)
      .select('id, conversation_id, body, edited').maybeSingle();
    if (res2.error) {
      res2 = await supabase.from('messages')
        .update({ body: message }).eq('id', id)
        .select('id, conversation_id, body').maybeSingle();
    }

    broadcast('message_updated', { message: res2.data, conversationId: msg.conversation_id }).catch(() => {});
    res.json({ success: true, message: res2.data });
  } catch (err) {
    console.error('PATCH /messages/:id/edit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Hapus pesan (untuk semua bila pesan milik kita & masih ada wa_message_id)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: msg } = await supabase
      .from('messages')
      .select('id, conversation_id, from_me, wa_message_id')
      .eq('id', id)
      .single();
    if (!msg) return res.status(404).json({ error: 'Pesan tidak ditemukan' });

    // Hapus di WhatsApp (delete for everyone) hanya untuk pesan keluar milik kita
    if (msg.from_me && msg.wa_message_id) {
      const sock = getSock();
      if (sock) {
        try {
          const { data: conv } = await supabase
            .from('conversations').select('wa_jid').eq('id', msg.conversation_id).single();
          if (conv?.wa_jid) {
            await sock.sendMessage(conv.wa_jid, {
              delete: { remoteJid: conv.wa_jid, fromMe: true, id: msg.wa_message_id },
            });
          }
        } catch (e) { console.warn('[Delete] WA delete gagal:', e.message); }
      }
    }

    const { error } = await supabase.from('messages').delete().eq('id', id);
    if (error) throw error;

    broadcast('message_deleted', { id, conversationId: msg.conversation_id }).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /messages/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Teruskan (forward) sebuah pesan ke percakapan lain
router.post('/forward', async (req, res) => {
  try {
    const { message_id, target_conversation_id } = req.body;
    if (!message_id || !target_conversation_id) {
      return res.status(400).json({ error: 'message_id dan target_conversation_id wajib diisi' });
    }

    const sock = getSock();
    if (!sock) return res.status(503).json({ error: 'WhatsApp is not connected yet' });

    const { data: msg, error: msgErr } = await supabase
      .from('messages')
      .select('body, media_type, media_url, media_filename, media_mimetype')
      .eq('id', message_id)
      .single();
    if (msgErr || !msg) return res.status(404).json({ error: 'Pesan tidak ditemukan' });

    const { data: conv } = await supabase
      .from('conversations').select('wa_jid').eq('id', target_conversation_id).single();
    if (!conv?.wa_jid) return res.status(404).json({ error: 'Percakapan tujuan tidak ditemukan' });

    const jid = conv.wa_jid;
    const caption = msg.body && !msg.body.startsWith('[') ? msg.body : undefined;

    let baileysMsg;
    if (msg.media_type && msg.media_url) {
      if (msg.media_type === 'image') baileysMsg = { image: { url: msg.media_url }, caption, mimetype: msg.media_mimetype || undefined };
      else if (msg.media_type === 'video') baileysMsg = { video: { url: msg.media_url }, caption, mimetype: msg.media_mimetype || undefined };
      else if (msg.media_type === 'audio') baileysMsg = { audio: { url: msg.media_url }, mimetype: msg.media_mimetype || undefined, ptt: false };
      else baileysMsg = { document: { url: msg.media_url }, fileName: msg.media_filename || 'file', mimetype: msg.media_mimetype || 'application/octet-stream', caption };
    } else {
      if (!msg.body) return res.status(400).json({ error: 'Pesan kosong, tidak bisa diteruskan' });
      baileysMsg = { text: msg.body };
    }

    const sentResult = await sock.sendMessage(jid, baileysMsg);
    const waMessageId = sentResult?.key?.id || null;

    const { data: saved, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: target_conversation_id,
        from_me: true,
        body: msg.body || `[${msg.media_type}]`,
        timestamp: new Date().toISOString(),
        status: 'sent',
        wa_message_id: waMessageId,
        media_type: msg.media_type || null,
        media_url: msg.media_url || null,
        media_filename: msg.media_filename || null,
        media_mimetype: msg.media_mimetype || null,
      })
      .select().single();
    if (error) throw error;

    await bumpConvOutgoing(target_conversation_id, msg.body || `[${msg.media_type}]`);

    broadcast('new_message', { message: saved, conversationId: target_conversation_id }).catch(() => {});
    res.json({ success: true, message: saved });
  } catch (err) {
    console.error('POST /messages/forward error:', err);
    res.status(500).json({ error: err.message });
  }
});

// List quick media gallery items
router.get('/quick-media', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('quick_media')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('GET /messages/quick-media error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Upload new quick media item
router.post('/quick-media', upload.single('file'), async (req, res) => {
  try {
    const { label, category } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'file is required' });
    if (!label) return res.status(400).json({ error: 'label is required' });

    const mediaType = mediaTypeFromMime(file.mimetype);
    const storageFilename = `${Date.now()}-${file.originalname}`;
    const { error: uploadErr } = await supabase.storage
      .from('wa-media')
      .upload(storageFilename, file.buffer, { contentType: file.mimetype, upsert: true });
    if (uploadErr) throw uploadErr;

    const { data: { publicUrl } } = supabase.storage.from('wa-media').getPublicUrl(storageFilename);

    const { data, error } = await supabase
      .from('quick_media')
      .insert({
        label,
        media_url: publicUrl,
        media_type: mediaType,
        mimetype: file.mimetype,
        category: category || null,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('POST /messages/quick-media error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete quick media item
router.delete('/quick-media/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('quick_media').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /messages/quick-media/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Send a quick-media gallery item to a conversation
router.post('/send-quick-media', async (req, res) => {
  try {
    const { conversation_id, quick_media_id, caption } = req.body;
    const replyTo = parseReplyTo(req.body.reply_to);
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id is required' });
    if (!quick_media_id) return res.status(400).json({ error: 'quick_media_id is required' });

    const sock = getSock();
    if (!sock) return res.status(503).json({ error: 'WhatsApp is not connected yet' });

    const { data: quickMedia, error: qmError } = await supabase
      .from('quick_media')
      .select('*')
      .eq('id', quick_media_id)
      .single();
    if (qmError || !quickMedia) return res.status(404).json({ error: 'Quick media not found' });

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, wa_jid, contact:contacts (phone)')
      .eq('id', conversation_id)
      .single();

    if (convError || !conversation)
      return res.status(404).json({ error: 'Conversation not found' });

    let jid = conversation.wa_jid;

    if (!jid) {
      const rawPhone = conversation.contact?.phone;
      if (!rawPhone)
        return res.status(422).json({ error: 'No phone number linked to this conversation' });
      const phone = rawPhone.split('@')[0];
      jid = `${phone}@s.whatsapp.net`;
    }

    console.log(`[Send] conversation=${conversation_id} jid=${jid} quick_media=${quick_media_id}`);

    const caption_ = caption || undefined;
    const mediaType = quickMedia.media_type;

    let baileysMsg;
    if (mediaType === 'image') {
      baileysMsg = { image: { url: quickMedia.media_url }, caption: caption_ };
    } else if (mediaType === 'video') {
      baileysMsg = { video: { url: quickMedia.media_url }, caption: caption_, mimetype: quickMedia.mimetype };
    } else {
      baileysMsg = {
        document: { url: quickMedia.media_url },
        mimetype: quickMedia.mimetype,
        fileName: quickMedia.label,
        caption: caption_,
      };
    }

    const sentResult = await sock.sendMessage(jid, baileysMsg, buildQuotedOpts(jid, replyTo));
    const waMessageId = sentResult?.key?.id || null;

    const { data: saved, error } = await supabase
      .from('messages')
      .insert({
        conversation_id,
        from_me: true,
        body: caption || `[${mediaType}] ${quickMedia.label}`,
        timestamp: new Date().toISOString(),
        status: 'sent',
        wa_message_id: waMessageId,
        reply_to_wa_id: replyTo?.wa_message_id || null,
        reply_to_body: replyTo?.body || null,
        reply_to_from_me: replyTo?.from_me ?? null,
        media_type: mediaType,
        media_url: quickMedia.media_url,
        media_filename: quickMedia.label,
        media_mimetype: quickMedia.mimetype,
      })
      .select().single();

    if (error) throw error;

    await bumpConvOutgoing(conversation_id, caption || `[${mediaType}] ${quickMedia.label}`);

    broadcast('new_message', { message: saved, conversationId: conversation_id }).catch(() => {});
    res.json({ success: true, message: saved });
  } catch (err) {
    console.error('POST /messages/send-quick-media error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Resolusi JID dari conversation_id (dipakai kirim lokasi/kontak)
async function resolveJid(conversationId) {
  const { data: conv } = await supabase
    .from('conversations').select('wa_jid, contact:contacts (phone)').eq('id', conversationId).single();
  if (conv?.wa_jid) return conv.wa_jid;
  const raw = conv?.contact?.phone;
  if (!raw) return null;
  return `${String(raw).split('@')[0]}@s.whatsapp.net`;
}

// Kirim LOKASI
router.post('/send-location', async (req, res) => {
  try {
    const { conversation_id, latitude, longitude, name, address } = req.body;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id wajib diisi' });
    const lat = Number(latitude), lng = Number(longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return res.status(400).json({ error: 'Koordinat tidak valid' });

    const sock = getSock();
    if (!sock) return res.status(503).json({ error: 'WhatsApp belum tersambung' });
    const jid = await resolveJid(conversation_id);
    if (!jid) return res.status(404).json({ error: 'Percakapan tidak ditemukan' });

    const sent = await sock.sendMessage(jid, {
      location: { degreesLatitude: lat, degreesLongitude: lng, name: name || undefined, address: address || undefined },
    });
    const place = name || address || 'Lokasi';
    const body = `📍 ${place}`;
    const mapUrl = `https://www.google.com/maps?q=${lat},${lng}`;

    const { data: saved, error } = await supabase.from('messages').insert({
      conversation_id, from_me: true, body,
      timestamp: new Date().toISOString(), status: 'sent',
      wa_message_id: sent?.key?.id || null,
      media_type: 'location', media_url: mapUrl, media_filename: address || name || `${lat},${lng}`,
    }).select().single();
    if (error) throw error;

    await bumpConvOutgoing(conversation_id, body);
    broadcast('new_message', { message: saved, conversationId: conversation_id }).catch(() => {});
    res.json({ success: true, message: saved });
  } catch (err) {
    console.error('POST /messages/send-location error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Kirim KONTAK
router.post('/send-contact', async (req, res) => {
  try {
    const { conversation_id, name, phone } = req.body;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id wajib diisi' });
    const displayName = String(name || '').trim();
    const digits = String(phone || '').replace(/\D/g, '');
    if (!displayName || !digits) return res.status(400).json({ error: 'Nama & nomor wajib diisi' });

    const sock = getSock();
    if (!sock) return res.status(503).json({ error: 'WhatsApp belum tersambung' });
    const jid = await resolveJid(conversation_id);
    if (!jid) return res.status(404).json({ error: 'Percakapan tidak ditemukan' });

    const vcard =
      'BEGIN:VCARD\n' +
      'VERSION:3.0\n' +
      `FN:${displayName}\n` +
      `TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}\n` +
      'END:VCARD';

    const sent = await sock.sendMessage(jid, { contacts: { displayName, contacts: [{ vcard }] } });
    const body = `📇 ${displayName} — +${digits}`;

    const { data: saved, error } = await supabase.from('messages').insert({
      conversation_id, from_me: true, body,
      timestamp: new Date().toISOString(), status: 'sent',
      wa_message_id: sent?.key?.id || null,
      media_type: 'contact', media_url: `https://wa.me/${digits}`, media_filename: digits,
    }).select().single();
    if (error) throw error;

    await bumpConvOutgoing(conversation_id, body);
    broadcast('new_message', { message: saved, conversationId: conversation_id }).catch(() => {});
    res.json({ success: true, message: saved });
  } catch (err) {
    console.error('POST /messages/send-contact error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
