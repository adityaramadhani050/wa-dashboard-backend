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
        contact:contacts (id, phone, name, first_seen, created_at, manual_wa_number),
        agents:assigned_to (id, name, email, role)
      `)
      .order('updated_at', { ascending: false });

    if (agent_id) query = query.eq('assigned_to', agent_id);

    const { data, error } = await query;
    if (error) throw error;

    const conversationIds = data.map((conv) => conv.id);
    const tagsByConversation = {};
    if (conversationIds.length > 0) {
      const { data: convTags } = await supabase
        .from('conversation_tags')
        .select('conversation_id, tags (id, name, color)')
        .in('conversation_id', conversationIds);

      (convTags || []).forEach((ct) => {
        if (!tagsByConversation[ct.conversation_id]) tagsByConversation[ct.conversation_id] = [];
        if (ct.tags) tagsByConversation[ct.conversation_id].push(ct.tags);
      });
    }

    const enriched = await Promise.all(
      data.map(async (conv) => {
        const { data: lastMsg } = await supabase
          .from('messages')
          .select('body, timestamp, from_me')
          .eq('conversation_id', conv.id)
          .order('timestamp', { ascending: false })
          .limit(1)
          .maybeSingle();

        let unreadQuery = supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', conv.id)
          .eq('from_me', false);
        if (conv.last_read_at) unreadQuery = unreadQuery.gt('timestamp', conv.last_read_at);
        const { count: unreadCount } = await unreadQuery;

        // Hitung sejak kapan customer menunggu dibalas (untuk KPI response time <5 menit).
        // awaitingSince = waktu pesan masuk pertama yang belum dibalas agent.
        const lastFromMe = lastMsg ? !!lastMsg.from_me : null;
        let awaitingSince = null;
        if (lastMsg && lastMsg.from_me === false) {
          const { data: lastReply } = await supabase
            .from('messages')
            .select('timestamp')
            .eq('conversation_id', conv.id)
            .eq('from_me', true)
            .order('timestamp', { ascending: false })
            .limit(1)
            .maybeSingle();

          let firstUnansweredQuery = supabase
            .from('messages')
            .select('timestamp')
            .eq('conversation_id', conv.id)
            .eq('from_me', false)
            .order('timestamp', { ascending: true })
            .limit(1);
          if (lastReply?.timestamp) firstUnansweredQuery = firstUnansweredQuery.gt('timestamp', lastReply.timestamp);
          const { data: firstUnanswered } = await firstUnansweredQuery.maybeSingle();
          awaitingSince = firstUnanswered?.timestamp || lastMsg.timestamp;
        }

        return {
          ...conv,
          lastMessage: lastMsg?.body || null,
          lastMessageAt: lastMsg?.timestamp || conv.updated_at,
          lastFromMe,
          awaitingSince,
          tags: tagsByConversation[conv.id] || [],
          unread: (unreadCount || 0) > 0,
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    console.error('GET /conversations error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: conv, error } = await supabase
      .from('conversations')
      .select(`
        *,
        contact:contacts (id, phone, name, first_seen, created_at, manual_wa_number),
        agents:assigned_to (id, name, email, role)
      `)
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!conv) return res.status(404).json({ error: 'Percakapan tidak ditemukan' });

    const { data: convTags } = await supabase
      .from('conversation_tags')
      .select('tags (id, name, color)')
      .eq('conversation_id', id);

    res.json({
      ...conv,
      tags: (convTags || []).map((ct) => ct.tags).filter(Boolean),
    });
  } catch (err) {
    console.error('GET /conversations/:id error:', err);
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

    // Mark conversation as read — fire-and-forget, don't block the response
    supabase
      .from('conversations')
      .update({ last_read_at: new Date().toISOString() })
      .eq('id', id)
      .then(({ error: e }) => { if (e) console.warn('last_read_at update warn:', e.message); });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await supabase.from('messages').delete().eq('conversation_id', id);
    const { error } = await supabase.from('conversations').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /conversations/:id error:', err);
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

    let jid = conversation.wa_jid;

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

router.post('/:id/tags', async (req, res) => {
  try {
    const { id } = req.params;
    const { tag_id } = req.body;
    if (!tag_id) return res.status(400).json({ error: 'tag_id wajib diisi' });

    const { data, error } = await supabase
      .from('conversation_tags')
      .insert({ conversation_id: id, tag_id })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(200).json({ success: true, message: 'Tag sudah ditambahkan sebelumnya' });
      }
      throw error;
    }
    res.status(201).json(data);
  } catch (err) {
    console.error(`POST /conversations/${req.params.id}/tags error:`, err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/tags/:tagId', async (req, res) => {
  try {
    const { id, tagId } = req.params;
    const { error } = await supabase
      .from('conversation_tags')
      .delete()
      .eq('conversation_id', id)
      .eq('tag_id', tagId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error(`DELETE /conversations/${req.params.id}/tags/${req.params.tagId} error:`, err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
