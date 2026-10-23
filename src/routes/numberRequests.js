// Permintaan nomor WhatsApp customer: WhatsApp kadang menyembunyikan nomor asli
// (ID samaran @lid). Agent meminta admin mencarikan nomornya; admin mengisi
// nomor (tersimpan sebagai Nomor WA Manual kontak) atau menolak dengan alasan.
// Admin mendapat lonceng + push, agent mendapat notifikasi hasilnya.
// Tabel: number_requests (SQL migrasi).
import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { guardConversation } from '../services/access.js';
import { notifyAgents, notifyAdmins } from '../services/aiSales.js';
import { publish } from '../db/redis.js';
import { emitLocal } from '../realtime.js';

const router = Router();
const isAdmin = (req) => req.user?.role === 'admin';
const SELECT = 'id, conversation_id, contact_id, agent_id, note, status, number, reason, handled_by, created_at, handled_at';

// Nomor tersembunyi = chat @lid yang nomornya belum terbaca & belum ada nomor manual
export function phoneHidden(conv) {
  const jid = conv?.wa_jid || '';
  if (!jid.endsWith('@lid')) return false;
  const c = conv.contact || {};
  return !c.manual_wa_number && (!c.phone || c.phone === jid.split('@')[0]);
}

// 08xx / +62 8xx / 62-8xx -> 628xx; null bila tidak valid
export function normalizeNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = `62${d.slice(1)}`;
  else if (d.startsWith('8')) d = `62${d}`;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

async function notifyRealtime(row) {
  const data = { request: row, agentId: row.agent_id };
  await publish('number_request', data);
  await emitLocal('number_request', data);
}

// Lengkapi nama kontak, agent & chat untuk daftar
async function enrich(rows) {
  if (!rows.length) return rows;
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))];
  const agentIds = [...new Set(rows.flatMap((r) => [r.agent_id, r.handled_by]).filter(Boolean))];
  const [{ data: contacts }, { data: agents }] = await Promise.all([
    contactIds.length ? supabase.from('contacts').select('id, name, phone, manual_wa_number').in('id', contactIds) : { data: [] },
    agentIds.length ? supabase.from('agents').select('id, name').in('id', agentIds) : { data: [] },
  ]);
  const cMap = new Map((contacts || []).map((c) => [String(c.id), c]));
  const aMap = new Map((agents || []).map((a) => [String(a.id), a]));
  return rows.map((r) => ({
    ...r,
    contact: cMap.get(String(r.contact_id)) || null,
    agent: aMap.get(String(r.agent_id)) || null,
    handler: r.handled_by ? aMap.get(String(r.handled_by)) || null : null,
  }));
}

function tableMissing(err) {
  return /number_requests/.test(err?.message || '') && /(does not exist|schema cache|relation)/i.test(err?.message || '');
}
function fail(res, err, where) {
  if (tableMissing(err)) return res.status(500).json({ error: 'Tabel number_requests belum dibuat. Jalankan SQL migrasi di Supabase.' });
  console.error(`${where} error:`, err?.message || err);
  res.status(500).json({ error: err?.message || 'Terjadi kesalahan' });
}

// Daftar: admin -> semua (default yang menunggu); agent -> miliknya
router.get('/', async (req, res) => {
  try {
    const status = req.query.status || (isAdmin(req) ? 'pending' : null);
    let q = supabase.from('number_requests').select(SELECT).order('created_at', { ascending: false }).limit(100);
    if (status && status !== 'all') q = q.eq('status', status);
    if (!isAdmin(req)) q = q.eq('agent_id', req.user?.id);
    const { data, error } = await q;
    if (error) throw error;
    res.json(await enrich(data || []));
  } catch (err) { fail(res, err, 'GET /number-requests'); }
});

// Status permintaan terbaru untuk sebuah chat (ditampilkan di Detail Chat)
router.get('/conversation/:id', async (req, res) => {
  try {
    if (!(await guardConversation(req, res, req.params.id))) return;
    const { data, error } = await supabase.from('number_requests').select(SELECT)
      .eq('conversation_id', req.params.id).order('created_at', { ascending: false }).limit(1);
    if (error) throw error;
    const [row] = await enrich(data || []);
    res.json(row || null);
  } catch (err) {
    if (tableMissing(err)) return res.json(null);
    fail(res, err, 'GET /number-requests/conversation');
  }
});

// Agent meminta admin mencarikan nomor customer
router.post('/', async (req, res) => {
  try {
    const conversationId = req.body?.conversation_id;
    if (!conversationId) return res.status(400).json({ error: 'conversation_id wajib diisi' });
    if (!(await guardConversation(req, res, conversationId))) return;
    const { data: conv } = await supabase.from('conversations')
      .select('id, wa_jid, contact_id, contact:contacts (id, name, phone, manual_wa_number)').eq('id', conversationId).maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Chat tidak ditemukan' });
    if (!phoneHidden(conv)) return res.status(400).json({ error: 'Nomor customer ini sudah tersedia.' });

    const { data: pending } = await supabase.from('number_requests').select(SELECT)
      .eq('contact_id', conv.contact_id).eq('status', 'pending').limit(1);
    if (pending?.length) return res.json((await enrich(pending))[0]);

    const note = String(req.body?.note || '').trim().slice(0, 300) || null;
    const { data: row, error } = await supabase.from('number_requests').insert({
      conversation_id: conv.id, contact_id: conv.contact_id, agent_id: req.user?.id || null, note, status: 'pending',
    }).select(SELECT).single();
    if (error) throw error;

    const [full] = await enrich([row]);
    const who = full.contact?.name || 'customer';
    notifyAdmins('Permintaan nomor customer', `${full.agent?.name || 'Agent'} meminta nomor WA ${who}${note ? ` — ${note}` : ''}`, conv.id).catch(() => {});
    await notifyRealtime(full);
    res.json(full);
  } catch (err) { fail(res, err, 'POST /number-requests'); }
});

async function handle(req, res, kind) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Hanya admin yang dapat memproses permintaan.' });
  const { data: reqRow, error: e1 } = await supabase.from('number_requests').select(SELECT).eq('id', req.params.id).maybeSingle();
  if (e1) throw e1;
  if (!reqRow) return res.status(404).json({ error: 'Permintaan tidak ditemukan' });
  if (reqRow.status !== 'pending') return res.status(409).json({ error: 'Permintaan ini sudah diproses.' });

  const update = { status: kind, handled_by: req.user?.id || null, handled_at: new Date().toISOString() };
  if (kind === 'done') {
    const number = normalizeNumber(req.body?.number);
    if (!number) return res.status(400).json({ error: 'Nomor tidak valid. Contoh: 081234567890 atau 6281234567890.' });
    const { error: e2 } = await supabase.from('contacts').update({ manual_wa_number: number }).eq('id', reqRow.contact_id);
    if (e2) throw e2;
    update.number = number;
  } else {
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (!reason) return res.status(400).json({ error: 'Isi alasan penolakan.' });
    update.reason = reason;
  }
  const { data: row, error: e3 } = await supabase.from('number_requests').update(update).eq('id', reqRow.id).select(SELECT).single();
  if (e3) throw e3;

  const [full] = await enrich([row]);
  const who = full.contact?.name || 'customer';
  if (full.agent_id) {
    const body = kind === 'done' ? `Nomor ${who}: ${full.number}` : `Nomor ${who} tidak bisa dicarikan — ${full.reason}`;
    notifyAgents([full.agent_id], kind === 'done' ? 'Nomor customer sudah diisi admin' : 'Permintaan nomor ditolak', body, full.conversation_id).catch(() => {});
  }
  await notifyRealtime(full);
  res.json(full);
}

router.post('/:id/fulfill', async (req, res) => { try { await handle(req, res, 'done'); } catch (err) { fail(res, err, 'POST /number-requests/fulfill'); } });
router.post('/:id/reject', async (req, res) => { try { await handle(req, res, 'rejected'); } catch (err) { fail(res, err, 'POST /number-requests/reject'); } });

export default router;
