import { Router } from 'express';
import { getSock } from '../baileys/connection.js';
import { supabase } from '../db/supabase.js';

const router = Router();

router.post('/send', async (req, res) => {
  try {
    const { phone, message, conversation_id } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: 'phone and message are required' });
    }

    const sock = getSock();
    if (!sock) {
      return res.status(503).json({ error: 'WhatsApp is not connected yet' });
    }

    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

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
