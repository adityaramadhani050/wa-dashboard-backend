import { Router } from 'express';
import { getSock } from '../baileys/connection.js';
import { supabase } from '../db/supabase.js';

const router = Router();

router.post('/send', async (req, res) => {
  try {
    const { phone, message, conversation_id } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }
    if (!phone && !conversation_id) {
      return res.status(400).json({ error: 'phone or conversation_id is required' });
    }

    const sock = getSock();
    if (!sock) {
      return res.status(503).json({ error: 'WhatsApp is not connected yet' });
    }

    let jid;

    // Always prefer the stored wa_jid from the conversation — this handles
    // @lid contacts correctly without any phone number resolution.
    if (conversation_id) {
      const { data: conv } = await supabase
        .from('conversations')
        .select('wa_jid')
        .eq('id', conversation_id)
        .single();

      if (conv?.wa_jid) {
        jid = conv.wa_jid;
        console.log(`[Send] Using stored wa_jid: ${jid}`);
      }
    }

    // Fallback: build JID from phone number
    if (!jid && phone) {
      jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
      console.log(`[Send] Fallback JID from phone: ${jid}`);
    }

    if (!jid) {
      return res.status(400).json({ error: 'Could not resolve WhatsApp JID' });
    }

    await sock.sendMessage(jid, { text: message });

    if (conversation_id) {
      const { data: saved, error } = await supabase
        .from('messages')
        .insert({
          conversation_id,
          from_me: true,
          body: message,
          timestamp: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) throw error;

      await supabase
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversation_id);

      return res.json({ success: true, message: saved });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('POST /messages/send error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
