import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { getSock } from '../baileys/connection.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const { agent_id } = req.query;

    let query = supabase
      .from('conversations')
      .select(`
        *,
        contact:contacts (id, phone, name, first_seen, created_at),
        agents:assigned_to (id, name, email, role)
      `)
      .order('updated_at', { ascending: false });

    if (agent_id) query = query.eq('assigned_to', agent_id);

    const { data, error } = await query;
    if (error) throw error;

    const enriched = await Promise.all(
      data.map(async (conv) => {
        const { data: lastMsg } = await supabase
          .from('messages')
          .select('body, timestamp')
          .eq('conversation_id', conv.id)
          .order('timestamp', { ascending: false })
          .limit(1)
          .maybeSingle();

        return {
          ...conv,
          lastMessage: lastMsg?.body || null,
          lastMessageAt: lastMsg?.timestamp || conv.updated_at,
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    console.error('GET /conversations error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', id)
      .order('timestamp', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/assign', async (req, res) => {
  try {
    const { id } = req.params;
    const { agent_id } = req.body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });

    const { data, error } = await supabase
      .from('conversations')
      .update({ assigned_to: agent_id, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(`*, contact:contacts (id, phone, name), agents:assigned_to (id, name, email, role)`)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ['open', 'in_progress', 'resolved'];
    if (!status || !validStatuses.includes(status))
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });

    const { data, error } = await supabase
      .from('conversations')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const sock = getSock();
    if (!sock) return res.status(503).json({ error: 'WhatsApp is not connected yet' });

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, wa_jid, contact:contacts (phone)')
      .eq('id', id)
      .single();

    if (convError || !conversation)
      return res.status(404).json({ error: 'Conversation not found' });

    // Use stored wa_jid (original WhatsApp JID) — works for @lid contacts too
    let jid = conversation.wa_jid;

    // Fallback: build from phone number if wa_jid not stored yet
    if (!jid) {
      const rawPhone = conversation.contact?.phone;
      if (!rawPhone)
        return res.status(422).json({ error: 'No phone number linked to this conversation' });
      const phone = rawPhone.split('@')[0];
      jid = `${phone}@s.whatsapp.net`;
    }

    console.log(`[Send] conversation=${id} jid=${jid}`);

    const sentResult = await sock.sendMessage(jid, { text: message });
    const waMessageId = sentResult?.key?.id || null;

    const { data: saved, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: id,
        from_me: true,
        body: message,
        timestamp: new Date().toISOString(),
        status: 'sent',
        wa_message_id: waMessageId,
      })
      .select()
      .single();

    if (msgError) throw msgError;

    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id);

    res.json({ success: true, message: saved });
  } catch (err) {
    console.error(`POST /conversations/${req.params.id}/messages error:`, err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
