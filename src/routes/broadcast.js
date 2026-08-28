// Broadcasting — kirim pesan promo ke calon customer (chat resolved, bukan
// Non-Client) yang dipilih manual admin, dengan proteksi anti-blokir.
import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

const NON_CLIENT_RE = /non[\s_-]*client/i;

// GET /candidates?cooldown_days=14
// Daftar chat resolved (bukan Non-Client) + status cooldown tiap nomor.
router.get('/candidates', requireAdmin, async (req, res) => {
  try {
    const cooldownDays = Math.max(1, parseInt(req.query.cooldown_days, 10) || 14);

    const { data: convs, error } = await supabase
      .from('conversations')
      .select('id, wa_jid, status, updated_at, last_message_at, contact:contacts (id, phone, name, manual_wa_number)')
      .eq('status', 'resolved')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1000);
    if (error) throw error;

    const ids = (convs || []).map((c) => c.id);
    // Tag per percakapan (batch agar URL tidak kepanjangan)
    const tagsByConv = {};
    for (let i = 0; i < ids.length; i += 150) {
      const slice = ids.slice(i, i + 150);
      const { data: cts } = await supabase
        .from('conversation_tags')
        .select('conversation_id, tags (name)')
        .in('conversation_id', slice);
      for (const ct of cts || []) {
        if (!tagsByConv[ct.conversation_id]) tagsByConv[ct.conversation_id] = [];
        if (ct.tags?.name) tagsByConv[ct.conversation_id].push(ct.tags.name);
      }
    }

    // Nomor yang masih cooldown -> ambil log sejak batas cooldown
    const since = new Date(Date.now() - cooldownDays * 86400_000).toISOString();
    const cooldownUntil = {};
    {
      const { data: logs } = await supabase
        .from('broadcast_log')
        .select('wa_jid, sent_at')
        .gte('sent_at', since);
      for (const l of logs || []) {
        const until = new Date(new Date(l.sent_at).getTime() + cooldownDays * 86400_000).toISOString();
        if (!cooldownUntil[l.wa_jid] || until > cooldownUntil[l.wa_jid]) cooldownUntil[l.wa_jid] = until;
      }
    }

    const candidates = [];
    for (const c of convs || []) {
      const names = tagsByConv[c.id] || [];
      if (names.some((n) => NON_CLIENT_RE.test(n))) continue; // exclude Non-Client
      const phone = c.contact?.manual_wa_number || c.contact?.phone || null;
      const waJid = c.wa_jid || (phone ? `${String(phone).split('@')[0]}@s.whatsapp.net` : null);
      if (!waJid) continue;
      const until = cooldownUntil[waJid] || null;
      const onCooldown = !!until && until > new Date().toISOString();
      candidates.push({
        conversation_id: c.id,
        contact_id: c.contact?.id || null,
        name: c.contact?.name || null,
        phone,
        wa_jid: waJid,
        last_message_at: c.last_message_at || c.updated_at || null,
        on_cooldown: onCooldown,
        cooldown_until: onCooldown ? until : null,
      });
    }

    res.json({ candidates, cooldown_days: cooldownDays });
  } catch (err) {
    console.error('GET /broadcast/candidates error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /campaigns — daftar campaign
router.get('/campaigns', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('broadcast_campaigns')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('GET /broadcast/campaigns error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /campaigns/:id — detail + penerima
router.get('/campaigns/:id', requireAdmin, async (req, res) => {
  try {
    const { data: campaign, error } = await supabase
      .from('broadcast_campaigns').select('*').eq('id', req.params.id).single();
    if (error || !campaign) return res.status(404).json({ error: 'Campaign tidak ditemukan' });
    const { data: recipients } = await supabase
      .from('broadcast_recipients')
      .select('id, name, phone, status, skip_reason, error, sent_at')
      .eq('campaign_id', campaign.id)
      .order('created_at', { ascending: true });
    res.json({ campaign, recipients: recipients || [] });
  } catch (err) {
    console.error('GET /broadcast/campaigns/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /campaigns — buat campaign + penerima (dipilih manual)
// body: { name, message_type, message_body, quick_media_id, daily_limit,
//         cooldown_days, start_at, recipients: [{conversation_id, contact_id, wa_jid, name, phone}] }
router.post('/campaigns', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Nama campaign wajib diisi' });
    const messageType = ['text', 'template', 'quick_media'].includes(b.message_type) ? b.message_type : 'text';
    const messageBody = typeof b.message_body === 'string' ? b.message_body : '';
    if (messageType === 'quick_media' && !b.quick_media_id)
      return res.status(400).json({ error: 'quick_media_id wajib untuk campaign media' });
    if (messageType !== 'quick_media' && !messageBody.trim())
      return res.status(400).json({ error: 'Isi pesan wajib diisi' });

    const recipients = Array.isArray(b.recipients) ? b.recipients : [];
    if (recipients.length === 0) return res.status(400).json({ error: 'Pilih minimal satu penerima' });

    const dailyLimit = Math.max(1, Math.min(500, parseInt(b.daily_limit, 10) || 40));
    const cooldownDays = Math.max(1, Math.min(365, parseInt(b.cooldown_days, 10) || 14));

    // Jadwal mulai: 'scheduled' bila start_at valid & di masa depan, else 'draft'
    let status = 'draft';
    let startAt = null;
    if (b.start_at) {
      const t = new Date(b.start_at);
      if (!Number.isNaN(t.getTime())) {
        startAt = t.toISOString();
        if (t.getTime() > Date.now()) status = 'scheduled';
      }
    }

    // Dedup wa_jid dalam campaign
    const seen = new Set();
    const rows = [];
    for (const r of recipients) {
      const waJid = r.wa_jid || (r.phone ? `${String(r.phone).split('@')[0]}@s.whatsapp.net` : null);
      if (!waJid || seen.has(waJid)) continue;
      seen.add(waJid);
      rows.push({
        conversation_id: r.conversation_id || null,
        contact_id: r.contact_id || null,
        wa_jid: waJid,
        name: r.name || null,
        phone: r.phone || null,
        status: 'pending',
      });
    }
    if (rows.length === 0) return res.status(400).json({ error: 'Tidak ada penerima valid' });

    const { data: campaign, error } = await supabase
      .from('broadcast_campaigns')
      .insert({
        name,
        message_type: messageType,
        message_body: messageBody,
        quick_media_id: b.quick_media_id || null,
        status,
        daily_limit: dailyLimit,
        cooldown_days: cooldownDays,
        total_targets: rows.length,
        start_at: startAt,
        created_by: req.user?.id || null,
      })
      .select().single();
    if (error) throw error;

    const withCampaign = rows.map((r) => ({ ...r, campaign_id: campaign.id }));
    // Sisipkan bertahap agar aman terhadap batas payload
    for (let i = 0; i < withCampaign.length; i += 200) {
      const { error: rErr } = await supabase
        .from('broadcast_recipients').insert(withCampaign.slice(i, i + 200));
      if (rErr) throw rErr;
    }

    res.json({ campaign });
  } catch (err) {
    console.error('POST /broadcast/campaigns error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /campaigns/:id/start — mulai sekarang (dari draft/paused/scheduled)
router.post('/campaigns/:id/start', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('broadcast_campaigns')
      .update({ status: 'running', started_at: new Date().toISOString(), start_at: null })
      .eq('id', req.params.id)
      .in('status', ['draft', 'paused', 'scheduled'])
      .select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'Campaign tidak dapat dimulai dari status saat ini' });
    res.json(data);
  } catch (err) {
    console.error('POST /broadcast/campaigns/:id/start error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /campaigns/:id/pause
router.post('/campaigns/:id/pause', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('broadcast_campaigns')
      .update({ status: 'paused' })
      .eq('id', req.params.id)
      .in('status', ['running', 'scheduled'])
      .select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'Campaign tidak sedang berjalan' });
    res.json(data);
  } catch (err) {
    console.error('POST /broadcast/campaigns/:id/pause error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /campaigns/:id/cancel
router.post('/campaigns/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('broadcast_campaigns')
      .update({ status: 'canceled', completed_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .in('status', ['draft', 'scheduled', 'running', 'paused'])
      .select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'Campaign tidak dapat dibatalkan' });
    res.json(data);
  } catch (err) {
    console.error('POST /broadcast/campaigns/:id/cancel error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
