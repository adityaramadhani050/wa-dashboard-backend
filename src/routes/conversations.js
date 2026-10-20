import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { getSock, broadcast, bumpConvOutgoing } from '../baileys/connection.js';
import { requireAdmin, requireAdminStrict } from '../middleware/auth.js';
import { setRegionManually } from '../services/regionalBot.js';
import { onTagsChanged as onFollowupTagsChanged } from '../services/followup.js';
import { waitSessions, workMinutes, getWorkHours, KPI_MINUTES } from './stats.js';
import { getAiSalesConfig, scheduleAiReply, resumeAi } from '../services/aiSales.js';
import { sendOwned } from '../utils/waSend.js';
import { storagePathFromUrl } from '../services/mediaTtl.js';
import { guardConversation } from '../services/access.js';

const router = Router();

// Kolom lokasi kontak (city/province/region) ditambahkan oleh migrasi regional.
// Fallback ke kolom dasar agar daftar chat tetap jalan sebelum migrasi dijalankan.
const CONTACT_COLS = 'id, phone, name, first_seen, created_at, manual_wa_number, city, province, region';
const CONTACT_COLS_BASE = 'id, phone, name, first_seen, created_at, manual_wa_number';
const convSelect = (contactCols) => `
  *,
  contact:contacts (${contactCols}),
  agents:assigned_to (id, name, email, role)
`;

// Lampirkan tag & ringkasan (lastMessage, unread, ...) ke baris percakapan.
async function enrichConversations(data) {
  const conversationIds = data.map((conv) => conv.id);
  const tagsByConversation = {};
  // Ambil tag per-batch (mencegah URL kepanjangan / limit baris)
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
  return data.map((conv) => {
    const lastFromMe = conv.last_from_me ?? null;
    // Unread (boolean): pesan terakhir dari customer & lebih baru dari last_read_at
    const unread = lastFromMe === false && !!conv.last_message_at &&
      (!conv.last_read_at || new Date(conv.last_message_at) > new Date(conv.last_read_at));
    const { conversation_tags: _ct, ...rest } = conv;
    return {
      ...rest,
      lastMessage: conv.last_message || null,
      lastMessageAt: conv.last_message_at || conv.updated_at,
      lastFromMe,
      awaitingSince: conv.awaiting_since || null,
      tags: tagsByConversation[conv.id] || [],
      unread,
    };
  });
}

const KPI_MS = 5 * 60 * 1000;
const cleanQ = (q) => String(q || '').trim().slice(0, 60).replace(/[,()*%\\]/g, ' ').trim();
const chatRegionOf = (c) => c.region || c.contact?.region || null;

// Daftar chat.
// - Mode halaman (dipakai daftar Chats): ?limit=100&cursor=<updated_at>&q=&tag=&reply=&status=&region=&agent_id=
//   -> { items, nextCursor, hasMore, total, pinned }. pinned = chat menunggu balasan
//   > 5 menit (disematkan di atas daftar) pada halaman pertama.
// - ?ids=a,b -> chat tertentu (untuk chat baru yang belum termuat di daftar).
// - Tanpa limit (ekspor, forward lama): seluruh chat, diambil per 1000 baris.
// Agent selalu dibatasi ke chat miliknya sendiri.
router.get('/', async (req, res) => {
  try {
    const agentId = req.user?.role === 'agent' ? req.user.id : (req.query.agent_id || null);
    const limit = req.query.limit ? Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 100)) : null;
    const ids = req.query.ids ? String(req.query.ids).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50) : null;
    const q = cleanQ(req.query.q);
    const tag = req.query.tag || null;
    const reply = req.query.reply || null;      // unread | unreplied | replied
    const status = req.query.status || null;    // open | in_progress | resolved
    const region = req.query.region || null;    // barat | timur | unknown | bot

    // Pencarian: nama/nomor kontak atau isi pesan terakhir
    let contactIds = null;
    if (q) {
      const { data: cs } = await supabase.from('contacts').select('id')
        .or(`name.ilike.*${q}*,phone.ilike.*${q}*`).limit(300);
      contactIds = (cs || []).map((c) => c.id);
    }

    const build = (contactCols, { head = false, pinnedOnly = false } = {}) => {
      let sel = convSelect(contactCols);
      if (tag) sel += ', conversation_tags!inner(tag_id)';
      let qb = head
        ? supabase.from('conversations').select(tag ? 'id, conversation_tags!inner(tag_id)' : 'id', { count: 'exact', head: true })
        : supabase.from('conversations').select(sel);
      if (agentId) qb = qb.eq('assigned_to', agentId);
      if (ids) qb = qb.in('id', ids);
      if (tag) qb = qb.eq('conversation_tags.tag_id', tag);
      if (status) qb = qb.eq('status', status);
      if (reply === 'unreplied' || reply === 'unread') qb = qb.eq('last_from_me', false);
      else if (reply === 'replied') qb = qb.eq('last_from_me', true);
      if (region === 'bot') qb = qb.eq('bot_state', 'awaiting_location');
      else if (region === 'unknown') qb = qb.is('region', null);
      if (q) {
        const parts = [`last_message.ilike.*${q}*`];
        if (contactIds?.length) parts.push(`contact_id.in.(${contactIds.join(',')})`);
        qb = qb.or(parts.join(','));
      }
      if (pinnedOnly) {
        qb = qb.eq('last_from_me', false).not('awaiting_since', 'is', null)
          .lt('awaiting_since', new Date(Date.now() - KPI_MS).toISOString());
      }
      return qb;
    };
    // Filter yang tidak bisa dilakukan di database (regional dari kontak, belum dibaca)
    const post = (rows) => rows.filter((c) => {
      if (region === 'barat' || region === 'timur') { if (chatRegionOf(c) !== region) return false; }
      if (region === 'unknown' && chatRegionOf(c)) return false;
      if (reply === 'unread' && !c.unread) return false;
      return true;
    });
    const run = async (fn) => {
      let r = await fn(CONTACT_COLS);
      if (r.error) r = await fn(CONTACT_COLS_BASE);
      if (r.error) throw r.error;
      return r;
    };

    // Mode lama: seluruh chat (per 1000 baris agar tidak terpotong)
    if (!limit && !ids) {
      const all = [];
      for (let from = 0; ; from += 1000) {
        const { data } = await run((cols) => build(cols).order('updated_at', { ascending: false }).range(from, from + 999));
        all.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      return res.json(post(await enrichConversations(all)));
    }

    if (ids) {
      const { data } = await run((cols) => build(cols));
      return res.json({ items: await enrichConversations(data || []) });
    }

    // Kursor: updated_at baris terakhir + id baris yang waktunya sama persis
    // (skip) agar tidak ada chat yang terlewat/terulang di batas halaman.
    const cursor = req.query.cursor || null;
    const skip = req.query.skip ? String(req.query.skip).split(',').filter(Boolean).slice(0, 200) : [];
    const { data } = await run((cols) => {
      let qb = build(cols).order('updated_at', { ascending: false }).limit(limit);
      if (cursor) qb = qb.lte('updated_at', cursor);
      if (skip.length) qb = qb.not('id', 'in', `(${skip.join(',')})`);
      return qb;
    });
    const rows = data || [];
    const nextCursor = rows.length ? rows[rows.length - 1].updated_at : null;
    const nextSkip = nextCursor ? rows.filter((r) => r.updated_at === nextCursor).map((r) => r.id) : [];
    const items = post(await enrichConversations(rows));

    let pinned = [];
    let total = null;
    if (!cursor) {
      const [p, c] = await Promise.all([
        run((cols) => build(cols, { pinnedOnly: true }).order('awaiting_since', { ascending: true }).limit(200)),
        build(null, { head: true }),
      ]);
      pinned = post(await enrichConversations(p.data || []));
      total = c.error ? null : c.count;
    }
    res.json({ items, pinned, nextCursor, nextSkip: cursor === nextCursor ? [...skip, ...nextSkip] : nextSkip, hasMore: rows.length === limit, total });
  } catch (err) {
    console.error('GET /conversations error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!(await guardConversation(req, res, req.params.id))) return;
    const { id } = req.params;

    const build = (contactCols) => supabase
      .from('conversations')
      .select(convSelect(contactCols))
      .eq('id', id)
      .maybeSingle();

    let { data: conv, error } = await build(CONTACT_COLS);
    if (error) ({ data: conv, error } = await build(CONTACT_COLS_BASE));
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
    if (!(await guardConversation(req, res, req.params.id))) return;
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

// Hapus chat (admin): seluruh pesan + file media di storage + data turunan chat
// (tag, follow-up, Tanya Tim). Kontak, catatan kontak & Ingatan AI tetap ada.
// Chat di WhatsApp (HP & customer) tidak terhapus.
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: conv } = await supabase.from('conversations').select('id, assigned_to').eq('id', id).maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Chat tidak ditemukan' });

    // File media pesan (best-effort; kegagalan storage tidak membatalkan hapus chat).
    // File yang juga dipakai Galeri Produk atau pesan di chat lain (forward,
    // broadcast) TIDAK dihapus.
    const urls = new Set();
    for (const cols of ['media_url, media_thumb_url', 'media_url']) {
      let ok = true;
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from('messages').select(cols)
          .eq('conversation_id', id).not('media_url', 'is', null).range(from, from + 999);
        if (error) { ok = false; break; } // kolom media_thumb_url mungkin belum ada
        for (const m of data || []) { if (m.media_url) urls.add(m.media_url); if (m.media_thumb_url) urls.add(m.media_thumb_url); }
        if (!data || data.length < 1000) break;
      }
      if (ok) break;
    }
    const shared = new Set();
    const list = [...urls];
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const [qm, other] = await Promise.all([
        supabase.from('quick_media').select('media_url').in('media_url', chunk),
        supabase.from('messages').select('media_url').in('media_url', chunk).neq('conversation_id', id).limit(1000),
      ]);
      for (const r of [...(qm.data || []), ...(other.data || [])]) shared.add(r.media_url);
      if ((qm.error && !/quick_media/.test(qm.error.message || '')) || other.error) chunk.forEach((u) => shared.add(u)); // ragu -> jangan hapus
    }
    const paths = list.filter((u) => !shared.has(u)).map(storagePathFromUrl).filter(Boolean);
    const { count: messageCount } = await supabase.from('messages').select('id', { count: 'exact', head: true }).eq('conversation_id', id);
    const { error: msgErr } = await supabase.from('messages').delete().eq('conversation_id', id);
    if (msgErr) throw msgErr;
    // Data turunan chat (tabel opsional: abaikan bila belum ada)
    for (const t of ['conversation_tags', 'conversation_tag_events', 'followup_tasks', 'followup_sequences', 'ai_team_requests']) {
      await supabase.from(t).delete().eq('conversation_id', id).then(() => {}, () => {});
    }
    const { error } = await supabase.from('conversations').delete().eq('id', id);
    if (error) throw error;

    // File media dihapus SETELAH data terhapus (bila gagal, hanya sisa file di storage)
    let mediaDeleted = 0;
    for (let i = 0; i < paths.length; i += 500) {
      const batch = paths.slice(i, i + 500);
      const { error } = await supabase.storage.from('wa-media').remove(batch);
      if (error) console.warn('[DeleteChat] hapus media gagal:', error.message);
      else mediaDeleted += batch.length;
    }

    broadcast('conversation_updated', { conversationId: id, deleted: true, assignedTo: conv.assigned_to || null }).catch(() => {});
    console.log(`[DeleteChat] conv=${id} dihapus oleh ${req.user?.name || req.user?.id}: ${messageCount ?? '?'} pesan, ${mediaDeleted} file media`);
    res.json({ success: true, messages: messageCount ?? null, media: mediaDeleted });
  } catch (err) {
    console.error('DELETE /conversations/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Tombol "Lanjutkan AI": AI Sales kembali membalas chat ini sekarang juga,
// mengabaikan jeda 30 menit akibat balasan manual sebelumnya.
router.post('/:id/ai-resume', async (req, res) => {
  try {
    if (!(await guardConversation(req, res, req.params.id))) return;
    const cfg = await getAiSalesConfig();
    if (!cfg.enabled || !cfg.agent_id) return res.status(400).json({ error: 'AI Sales belum aktif.' });
    const { data: conv } = await supabase.from('conversations').select('assigned_to').eq('id', req.params.id).maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Chat tidak ditemukan' });
    if (String(conv.assigned_to) !== String(cfg.agent_id)) return res.status(400).json({ error: 'Chat ini tidak di-assign ke AI Sales.' });
    await resumeAi(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /conversations/:id/ai-resume error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/assign', async (req, res) => {
  try {
    const { id } = req.params;
    const { agent_id } = req.body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
    const { data: before } = await supabase.from('conversations').select('assigned_to').eq('id', id).maybeSingle();

    // Di-assign ke agent -> chat jadi "Aktif" (kecuali sudah resolved tetap dihormati?
    // tetap set in_progress karena agent kini menangani).
    const now = new Date().toISOString();
    const run = (patch) => supabase
      .from('conversations')
      .update(patch)
      .eq('id', id)
      .select(`*, contact:contacts (id, phone, name), agents:assigned_to (id, name, email, role)`)
      .single();
    const base = { assigned_to: agent_id, status: 'in_progress', updated_at: now };
    let { data, error } = await run({ ...base, assigned_at: now });
    if (error && /assigned_at/.test(error.message || '')) ({ data, error } = await run(base)); // kolom belum ada

    if (error) throw error;

    // Di-assign ke AI Sales -> langsung balas pesan customer yang menunggu
    getAiSalesConfig().then((cfg) => {
      if (cfg.enabled && String(cfg.agent_id) === String(agent_id)) scheduleAiReply(id, 3000, { force: true });
    }).catch(() => {});

    // Broadcast assignment supaya list chat semua dashboard update realtime
    if (data?.agents) {
      broadcast('conversation_assigned', {
        conversationId: id,
        agent: { id: data.agents.id, name: data.agents.name },
        prevAgentId: before?.assigned_to || null, // agent lama: chat hilang dari daftarnya
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
    const { data: before } = await supabase.from('conversations').select('assigned_to').eq('id', id).maybeSingle();
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
    broadcast('conversation_assigned', { conversationId: id, agent: null, prevAgentId: before?.assigned_to || null }).catch(() => {});

    res.json(data);
  } catch (err) {
    console.error(`POST /conversations/${req.params.id}/unassign error:`, err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    if (!(await guardConversation(req, res, req.params.id))) return;
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

// Admin menentukan/mengganti regional chat. Bila chat belum punya agent,
// langsung diarahkan ke agent regional tsb (selama auto-assign aktif).
router.patch('/:id/region', requireAdmin, async (req, res) => {
  try {
    const region = req.body?.region;
    if (!['barat', 'timur'].includes(region))
      return res.status(400).json({ error: "region harus 'barat' atau 'timur'" });
    const result = await setRegionManually(req.params.id, region);
    if (!result) return res.status(404).json({ error: 'Percakapan tidak ditemukan' });
    res.json({ success: true, region: result.region, agent: result.agent || null });
  } catch (err) {
    console.error('PATCH /conversations/:id/region error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/messages', async (req, res) => {
  try {
    if (!(await guardConversation(req, res, req.params.id))) return;
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

    const sentResult = await sendOwned(sock, jid, { text: message }, sendOpts);
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

// Pasang/lepas label percakapan: khusus admin (agent hanya melihat)
router.post('/:id/tags', requireAdminStrict, async (req, res) => {
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

    // Follow-up: tag pemicu/penghenti mungkin berubah
    onFollowupTagsChanged(id).catch(() => {});

    res.status(201).json(data);
  } catch (err) {
    console.error(`POST /conversations/${req.params.id}/tags error:`, err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/tags/:tagId', requireAdminStrict, async (req, res) => {
  try {
    const { id, tagId } = req.params;
    const { error } = await supabase
      .from('conversation_tags')
      .delete()
      .eq('conversation_id', id)
      .eq('tag_id', tagId);

    if (error) throw error;
    onFollowupTagsChanged(id).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error(`DELETE /conversations/${req.params.id}/tags/${req.params.tagId} error:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Rata-rata waktu respons agent di satu chat (semua balasan, jam kerja bila aktif).
router.get('/:id/response-stats', async (req, res) => {
  try {
    if (!(await guardConversation(req, res, req.params.id))) return;
    const run = (cols) => {
      const all = [];
      const page = async (from) => {
        const { data, error } = await supabase.from('messages').select(cols)
          .eq('conversation_id', req.params.id)
          .order('timestamp', { ascending: true }).order('id', { ascending: true })
          .range(from, from + 999);
        if (error) return { error };
        all.push(...(data || []));
        return data && data.length === 1000 ? page(from + 1000) : { data: all };
      };
      return page(0);
    };
    let r = await run('from_me, timestamp, sent_by_bot');
    if (r.error) r = await run('from_me, timestamp');
    if (r.error) throw r.error;
    const wh = await getWorkHours();
    const sessions = waitSessions(r.data);
    const times = sessions.filter((s) => s.end != null).map((s) => workMinutes(s.from, s.end, wh));
    const last = sessions[sessions.length - 1];
    res.json({
      avg: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      replies: times.length,
      met: times.filter((t) => t <= KPI_MINUTES).length,
      kpiMinutes: KPI_MINUTES,
      workHours: !!wh,
      waiting: !!(last && last.end == null),
    });
  } catch (err) {
    console.error(`GET /conversations/${req.params.id}/response-stats error:`, err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
