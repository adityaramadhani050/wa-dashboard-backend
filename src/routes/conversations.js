import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { getSock, broadcast, bumpConvOutgoing } from '../baileys/connection.js';

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
    // Ambil tag per-batch (mencegah URL kepanjangan / limit baris saat percakapan
    // banyak, mis. filter "Semua Agent" -> tanpa ini semua tag bisa hilang).
    for (let i = 0; i < conversationIds.length; i += 150) {
      const batch = conversationIds.slice(i, i + 150);
      const { data: convTags } = await supabase
        .from('conversation_tags')
        .select('conversation_id, tags (id, name, color)')
        .in('conversation_id', batch);

      (convTags || []).forEach((ct) => {
        if (!tagsByConversation[ct.conversation_id]) tagsByConversation[ct.conversation_id] = [];
        if (ct.tags) tagsByConversation[ct.conversation_id].push(ct.tags);
      });
    }

    // Ringkasan sudah didenormalisasi di baris conversations -> tanpa query per-chat.
    const enriched = data.map((conv) => {
      const lastFromMe = conv.last_from_me ?? null;
      // Unread (boolean): pesan terakhir dari customer & lebih baru dari last_read_at
      const unread = lastFromMe === false && !!conv.last_message_at &&
        (!conv.last_read_at || new Date(conv.last_message_at) > new Date(conv.last_read_at));
      return {
        ...conv,
        lastMessage: conv.last_message || null,
        lastMessageAt: conv.last_message_at || conv.updated_at,
        lastFromMe,
        awaitingSince: conv.awaiting_since || null,
        tags: tagsByConversation[conv.id] || [],
        unread,
      };
    });

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
    const limit = Math.min(parseInt(req.query.limit, 10) || 0, 200);
    const before = req.query.before; // timestamp ISO -> muat pesan LEBIH LAMA dari ini

    let data, error;
    if (limit > 0) {
      // Ambil `limit` pesan terbaru (atau sebelum `before`), lalu balik jadi urut naik.
      let q = supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', id)
        .order('timestamp', { ascending: false })
        .limit(limit);
      if (before) q = q.lt('timestamp', before);
      ({ data, error } = await q);
      if (!error && data) data = data.reverse();
    } else {
      // Tanpa limit -> perilaku lama (semua pesan, urut naik)
      ({ data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', id)
        .order('timestamp', { ascending: true }));
    }

    if (error) throw error;

    // Tandai sudah dibaca hanya saat memuat halaman terbaru (bukan saat load older).
    if (!before) {
      supabase
        .from('conversations')
        .update({ last_read_at: new Date().toISOString() })
        .eq('id', id)
        .then(({ error: e }) => { if (e) console.warn('last_read_at update warn:', e.message); });
    }

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

    // Di-assign ke agent -> chat jadi "Aktif" (kecuali sudah resolved tetap dihormati?
    // tetap set in_progress karena agent kini menangani).
    const { data, error } = await supabase
      .from('conversations')
      .update({ assigned_to: agent_id, status: 'in_progress', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(`*, contact:contacts (id, phone, name), agents:assigned_to (id, name, email, role)`)
      .single();

    if (error) throw error;

    // Broadcast assignment supaya list chat semua dashboard update realtime
    if (data?.agents) {
      broadcast('conversation_assigned', {
        conversationId: id,
        agent: { id: data.agents.id, name: data.agents.name },
      }).catch(() => {});
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hapus assign agent dari percakapan -> kembali "Open" (kecuali yang sudah Resolved)
router.post('/:id/unassign', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('conversations')
      .update({ assigned_to: null, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*, contact:contacts (id, phone, name)')
      .single();
    if (error) throw error;

    // Status kembali ke "Open" bila masih aktif (bukan resolved)
    await supabase.from('conversations')
      .update({ status: 'open' })
      .eq('id', id)
      .eq('status', 'in_progress');

    // Broadcast unassign (agent: null) supaya badge hilang realtime di semua dashboard
    broadcast('conversation_assigned', { conversationId: id, agent: null }).catch(() => {});

    res.json(data);
  } catch (err) {
    console.error(`POST /conversations/${req.params.id}/unassign error:`, err);
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
    const { message, reply_to } = req.body;
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

    const tStart = Date.now();

    // Reply/quote: bangun objek quoted minimal dari data pesan yang dibalas.
    // generateHighQualityLinkPreview: buat kartu preview otomatis bila pesan
    // mengandung URL (butuh dependency link-preview-js — terpasang saat deploy).
    const sendOpts = { generateHighQualityLinkPreview: true };
    if (reply_to?.wa_message_id) {
      sendOpts.quoted = {
        key: { remoteJid: jid, fromMe: !!reply_to.from_me, id: reply_to.wa_message_id },
        message: { conversation: reply_to.body || '' },
      };
    }

    const sentResult = await sock.sendMessage(jid, { text: message }, sendOpts);
    const waMessageId = sentResult?.key?.id || null;
    const tWa = Date.now();

    const { data: saved, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: id,
        from_me: true,
        body: message,
        timestamp: new Date().toISOString(),
        status: 'sent',
        wa_message_id: waMessageId,
        reply_to_wa_id: reply_to?.wa_message_id || null,
        reply_to_body: reply_to?.body || null,
        reply_to_from_me: reply_to?.from_me ?? null,
      })
      .select()
      .single();

    if (msgError) throw msgError;

    // Agent membalas -> chat jadi "Aktif" (in_progress) + perbarui ringkasan.
    bumpConvOutgoing(id, message).catch(() => {});

    // Broadcast balasan agar list chat & tab lain langsung update (lastFromMe=true)
    broadcast('new_message', { message: saved, conversationId: id }).catch(() => {});

    console.log(`[Send] conv=${id} wa=${tWa - tStart}ms total=${Date.now() - tStart}ms`);
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

    // Tag "Non-Client" / "Deal" -> chat dianggap selesai, langsung Resolved
    // (tidak boleh berstatus Aktif).
    const { data: tag } = await supabase.from('tags').select('name').eq('id', tag_id).maybeSingle();
    const tagName = (tag?.name || '').toLowerCase();
    if (/non[\s_-]*client/.test(tagName) || tagName === 'deal' || /\bdeal\b/.test(tagName)) {
      await supabase.from('conversations')
        .update({ status: 'resolved', updated_at: new Date().toISOString() })
        .eq('id', id);
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
