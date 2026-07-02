import { Router } from 'express';
import multer from 'multer';
import { getSock, broadcast } from '../baileys/connection.js';
import { supabase } from '../db/supabase.js';

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
      await supabase.from('conversations').update({ status: 'in_progress', updated_at: new Date().toISOString() }).eq('id', conversation_id);
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
    const buffer = file.buffer;
    const caption_ = caption || undefined;

    let baileysMsg;
    if (mediaType === 'image') {
      baileysMsg = { image: buffer, caption: caption_, mimetype: file.mimetype };
    } else if (mediaType === 'video') {
      baileysMsg = { video: buffer, caption: caption_, mimetype: file.mimetype };
    } else if (mediaType === 'audio') {
      baileysMsg = { audio: buffer, mimetype: file.mimetype, ptt: false };
    } else {
      baileysMsg = { document: buffer, fileName: file.originalname, mimetype: file.mimetype, caption: caption_ };
    }

    const sentResult = await sock.sendMessage(jid, baileysMsg, buildQuotedOpts(jid, replyTo));
    const waMessageId = sentResult?.key?.id || null;

    let mediaUrl = null;
    try {
      const storageFilename = `${Date.now()}-${file.originalname}`;
      const { error: uploadErr } = await supabase.storage
        .from('wa-media')
        .upload(storageFilename, buffer, { contentType: file.mimetype, upsert: true });
      if (!uploadErr) {
        const { data: { publicUrl } } = supabase.storage.from('wa-media').getPublicUrl(storageFilename);
        mediaUrl = publicUrl;
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
        media_filename: file.originalname,
        media_mimetype: file.mimetype,
        reply_to_wa_id: replyTo?.wa_message_id || null,
        reply_to_body: replyTo?.body || null,
        reply_to_from_me: replyTo?.from_me ?? null,
      })
      .select().single();

    if (error) throw error;

    await supabase.from('conversations')
      .update({ status: 'in_progress', updated_at: new Date().toISOString() })
      .eq('id', conversation_id);

    broadcast('new_message', { message: saved, conversationId: conversation_id }).catch(() => {});
    res.json({ success: true, message: saved });
  } catch (err) {
    console.error('POST /messages/send-media error:', err);
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

    await supabase.from('conversations')
      .update({ status: 'in_progress', updated_at: new Date().toISOString() })
      .eq('id', target_conversation_id);

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

    await supabase.from('conversations')
      .update({ status: 'in_progress', updated_at: new Date().toISOString() })
      .eq('id', conversation_id);

    broadcast('new_message', { message: saved, conversationId: conversation_id }).catch(() => {});
    res.json({ success: true, message: saved });
  } catch (err) {
    console.error('POST /messages/send-quick-media error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
