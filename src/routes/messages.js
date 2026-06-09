import { Router } from 'express';
import multer from 'multer';
import { getSock } from '../baileys/connection.js';
import { supabase } from '../db/supabase.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
});

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
      await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversation_id);
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

    const sentResult = await sock.sendMessage(jid, baileysMsg);
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
      })
      .select().single();

    if (error) throw error;

    await supabase.from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversation_id);

    res.json({ success: true, message: saved });
  } catch (err) {
    console.error('POST /messages/send-media error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
