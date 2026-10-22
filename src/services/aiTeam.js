// Tanya Tim: AI Sales menanyakan hal yang jawabannya harus dari tim internal
// (stok -> Gudang, lalu Procurement bila kosong; teknis -> Teknis) lewat WA ke
// nomor pribadi PIC divisi, dengan gaya chat antar rekan kerja. PIC menjawab
// dengan reply/quote; AI membaca jawabannya lalu meneruskan ke customer.
//
// - Pengaturan: app_settings 'ai_team' (divisi, topik, PIC utama + cadangan,
//   batas waktu). Chat dengan nomor PIC tetap tersimpan (nomor ini juga dipakai
//   notifikasi ERP) tapi tidak di-auto-assign & tidak dibalas AI.
// - Data: tabel ai_team_requests (SQL migrasi). Bila belum ada, fitur nonaktif.
// - Ke customer: tidak pernah menyebut supplier/procurement/gudang kosong;
//   barang inden dibingkai sebagai pesanan langsung dari pabrik.
import { randomBytes } from 'crypto';
import { supabase } from '../db/supabase.js';
import { getSock } from '../baileys/connection.js';
import { generate, parseJsonLoose } from './llm.js';
import { getSalutation } from './aiKnowledge.js';
import { getWorkHours, workMinutes } from '../routes/stats.js';
import {
  getAiSalesConfig, humanizeText, runAiTask, notifyAgents, notifyAdmins, addContactNote,
} from './aiSales.js';

const KEY = 'ai_team';
const TABLE = 'ai_team_requests';
const DEBOUNCE_MS = 12000;           // tunggu bubble beruntun dari PIC
const DEFAULT_HOURS = { start: 8 * 60, end: 20 * 60, days: null };

export const TEAM_DIVISIONS = {
  gudang: { label: 'Gudang', who: 'tim gudang' },
  procurement: { label: 'Procurement', who: 'tim procurement' },
  teknis: { label: 'Teknis / Engineer', who: 'tim teknis' },
};

export const DEFAULT_AI_TEAM = {
  enabled: false,
  remind_min: 30,   // pengingat + pindah ke PIC cadangan + kabari customer
  admin_min: 60,    // notifikasi admin
  divisions: {
    gudang: {
      enabled: true,
      topics: [
        'Ketersediaan stok panel, inverter, baterai (merek/tipe/kapasitas tertentu)',
        'Stok komponen tambahan: baterai tambahan, panel tambahan, kabel, MCB, rangka',
        'Barang tersedia untuk tanggal pasang yang diminta customer?',
        'Unit pengganti untuk klaim garansi',
        'Kuantitas besar untuk proyek usaha/industri',
      ].join('\n'),
      pics: [],
    },
    procurement: {
      enabled: true,
      topics: [
        'Ketersediaan barang yang kosong/kurang di gudang',
        'Lama pemesanan (inden/proses) dan pengiriman sampai barang siap',
        'Datasheet/spesifikasi detail produk yang belum ada di playbook',
      ].join('\n'),
      pics: [],
    },
    teknis: {
      enabled: true,
      topics: [
        'Kondisi atap (asbes, genteng tanah, dak beton, spandek): kuat atau tidak, arah & bayangan',
        'Luas atap cukup untuk kapasitas yang diminta?',
        'Kelistrikan: 1 phase / 3 phase, perlu naik daya PLN, kondisi panel listrik lama',
        'Beban yang bisa ditanggung saat padam (AC, pompa, mesin) & berapa lama',
        'Kompatibilitas: tambah baterai/panel ke sistem lama atau merek lain, gabung genset',
        'Pelanggan lama: kode error inverter, produksi tidak sesuai, baterai tidak terisi',
        'Lama pemasangan & apakah listrik padam saat instalasi',
        'Penangkal petir/grounding, SLO, gambar SLD',
      ].join('\n'),
      pics: [],
    },
  },
};

// 0812-3456-789 / +62 812 / 812... -> 628123456789
export function normalizePhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = `62${d.slice(1)}`;
  else if (d.startsWith('8')) d = `62${d}`;
  return d.length >= 9 && d.length <= 15 ? d : '';
}

const int = (v, def, min, max) => { const n = parseInt(v, 10); return Number.isNaN(n) ? def : Math.min(max, Math.max(min, n)); };

export function parseAiTeam(raw) {
  let v = {};
  try { v = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { v = {}; }
  const remind = int(v.remind_min, DEFAULT_AI_TEAM.remind_min, 5, 240);
  const divisions = {};
  for (const [k, def] of Object.entries(DEFAULT_AI_TEAM.divisions)) {
    const d = v.divisions?.[k] || {};
    const pics = (Array.isArray(d.pics) ? d.pics : [])
      .map((p) => ({ call: String(p?.call || '').trim().slice(0, 40), phone: normalizePhone(p?.phone) }))
      .filter((p) => p.phone)
      .filter((p, i, a) => a.findIndex((x) => x.phone === p.phone) === i)
      .slice(0, 5);
    divisions[k] = {
      enabled: d.enabled === undefined ? def.enabled : !!d.enabled,
      topics: String(d.topics ?? def.topics).slice(0, 2000),
      pics,
    };
  }
  return {
    enabled: !!v.enabled,
    remind_min: remind,
    admin_min: Math.max(remind + 5, int(v.admin_min, DEFAULT_AI_TEAM.admin_min, 10, 480)),
    divisions,
  };
}

// ── Konfigurasi + indeks nomor PIC (dipakai sinkron oleh connection.js) ───
let cache = { val: null, at: 0 };
let phoneIndex = new Map(); // phone -> { division, index, call }
function rebuildIndex(cfg) {
  const m = new Map();
  for (const [division, d] of Object.entries(cfg.divisions)) {
    d.pics.forEach((p, index) => { if (!m.has(p.phone)) m.set(p.phone, { division, index, call: p.call }); });
  }
  phoneIndex = m;
}

export async function getAiTeamConfig() {
  if (cache.val && Date.now() - cache.at < 15000) return cache.val;
  let val = parseAiTeam({});
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
    if (data?.value) val = parseAiTeam(data.value);
  } catch { /* pakai default */ }
  cache = { val, at: Date.now() };
  rebuildIndex(val);
  return val;
}

export async function saveAiTeamConfig(input) {
  const cur = await getAiTeamConfig();
  const val = parseAiTeam({ ...cur, ...input, divisions: { ...cur.divisions, ...(input?.divisions || {}) } });
  const { error } = await supabase.from('app_settings')
    .upsert({ key: KEY, value: JSON.stringify(val), updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
  cache = { val, at: Date.now() };
  rebuildIndex(val);
  return val;
}

// Nomor milik PIC (internal)? Dipanggil sinkron untuk setiap pesan WA.
export function teamPhoneInfo(phone) { return phoneIndex.get(String(phone || '').split('@')[0]) || null; }
export const isTeamPhone = (phone) => !!teamPhoneInfo(phone);

// ID pesan yang kita kirim ke PIC -> mengenali reply PIC walau jid-nya @lid.
const teamWaIds = new Set();
export const isTeamWaId = (id) => !!id && teamWaIds.has(id);

// ── Util ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clip = (s, n) => { s = String(s || '').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const nowIso = () => new Date().toISOString();
const labelOf = (d) => TEAM_DIVISIONS[d]?.label || d;

async function teamHours() { return (await getWorkHours().catch(() => null)) || DEFAULT_HOURS; }
export function inHours(wh, ms = Date.now()) {
  const wib = new Date(ms + 7 * 3600 * 1000);
  const mins = wib.getUTCHours() * 60 + wib.getUTCMinutes();
  if (wh.days && !wh.days.includes(wib.getUTCDay())) return false;
  return mins >= wh.start && mins < wh.end;
}

let tableOk = null;
async function tableReady() {
  if (tableOk) return true;
  const { error } = await supabase.from(TABLE).select('id').limit(1);
  tableOk = !error;
  if (error) console.warn('[AITeam] tabel ai_team_requests belum ada — jalankan SQL migrasi');
  return tableOk;
}

async function updateReq(id, patch) {
  const { data, error } = await supabase.from(TABLE).update({ ...patch, updated_at: nowIso() }).eq('id', id).select().maybeSingle();
  if (error) throw error;
  return data;
}

const withThread = (req, entry) => [...(Array.isArray(req.thread) ? req.thread : []), { at: nowIso(), ...entry }].slice(-40);

// Isi {panggilan} + gaya (huruf kecil, tanpa ciri AI) untuk pesan ke PIC.
async function styleForTeam(text, call) {
  const cfg = await getAiSalesConfig().catch(() => ({ lowercase: true }));
  let t = String(text || '').replace(/\{\s*panggilan\s*\}/gi, call || '').replace(/^\s*,\s*/, '');
  t = humanizeText(t, { lowercase: cfg.lowercase !== false });
  return t;
}

// Kirim 1-3 bubble ke PIC seperti orang mengetik. quote = { id, jid, text } pesan PIC yang dibalas.
async function sendToPic(phone, text, { quote = null } = {}) {
  const sock = getSock();
  if (!sock) throw new Error('WhatsApp belum tersambung');
  const jid = `${phone}@s.whatsapp.net`;
  const bubbles = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const ids = [];
  for (let i = 0; i < bubbles.length; i++) {
    try {
      await sock.sendPresenceUpdate?.('composing', jid);
      await sleep(Math.min(6000, (700 + bubbles[i].length * 35) * rand(0.8, 1.2)));
      await sock.sendPresenceUpdate?.('paused', jid);
    } catch { /* opsional */ }
    const id = '3EB0' + randomBytes(9).toString('hex').toUpperCase();
    teamWaIds.add(id); // pesan ini tersimpan di chat PIC lewat event WA biasa
    const opts = { messageId: id };
    if (quote?.id && i === 0) {
      opts.quoted = { key: { remoteJid: quote.jid || jid, id: quote.id, fromMe: !!quote.fromMe }, message: { conversation: quote.text || '' } };
    }
    await sock.sendMessage(jid, { text: bubbles[i] }, opts);
    ids.push(id);
    if (i < bubbles.length - 1) await sleep(rand(500, 1200));
  }
  return { ids, text: bubbles.join('\n') };
}

function picOf(cfg, division, index) { return cfg.divisions[division]?.pics?.[index] || null; }

// ── Membuat pertanyaan ke tim ─────────────────────────────────────────────
// Dipanggil AI Sales (plan.ask_team) atau berantai Gudang -> Procurement.
export async function createTeamRequest({ conv, division, topic, question, teamMessage, parentId = null }) {
  const cfg = await getAiTeamConfig();
  const who = conv.contact?.name || conv.contact?.phone || 'customer';
  const d = cfg.divisions[division];
  if (!cfg.enabled || !d?.enabled || !d.pics.length || !(await tableReady())) {
    // Tidak bisa ditanyakan otomatis -> admin yang menindaklanjuti
    await addContactNote(conv.contact?.id, `[Tanya Tim] Perlu dijawab ${labelOf(division)}: ${question || topic}`).catch(() => {});
    await notifyAdmins(`Pertanyaan untuk ${labelOf(division)}`, `${who}: ${clip(question || topic, 140)}`, conv.id).catch(() => {});
    return null;
  }
  // Sudah ada pertanyaan yang sama & masih menunggu -> jangan tanya ulang
  const { data: open } = await supabase.from(TABLE).select('id, topic, division')
    .eq('conversation_id', conv.id).in('status', ['open', 'waiting_customer']);
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if ((open || []).some((r) => r.division === division && norm(r.topic) === norm(topic))) return null;

  const pic = d.pics[0];
  const template = String(teamMessage || '').trim() || `{panggilan}, mau tanya soal ${topic || question} dong`;
  const { data: req, error } = await supabase.from(TABLE).insert({
    conversation_id: conv.id, contact_id: conv.contact?.id || null, division,
    topic: clip(topic, 120) || null, customer_question: clip(question, 500) || null,
    team_message: clip(template, 1000), status: 'open', pic_index: 0, pic_phone: pic.phone,
    parent_id: parentId, thread: [], wa_ids: [],
  }).select().single();
  if (error) throw error;
  try {
    const text = await styleForTeam(template, pic.call);
    const sent = await sendToPic(pic.phone, text);
    await updateReq(req.id, {
      sent_at: nowIso(), wa_ids: sent.ids,
      thread: withThread(req, { from: 'ai', pic: pic.call || pic.phone, text: sent.text, wa_ids: sent.ids }),
    });
    console.log(`[AITeam] ${division} ditanya conv=${conv.id} topik="${topic}"`);
  } catch (e) {
    console.warn(`[AITeam] gagal kirim ke PIC ${division}:`, e?.message || e);
    await updateReq(req.id, { status: 'failed' }).catch(() => {});
    await notifyAdmins(`Gagal menghubungi ${labelOf(division)}`, `${who}: ${clip(question || topic, 140)}`, conv.id).catch(() => {});
  }
  return req;
}

// Customer menjawab pertanyaan balik dari tim -> kirim ke PIC (reply ke pertanyaannya).
export async function submitCustomerAnswer({ id, team_message: teamMessage }, conv) {
  if (!id || !teamMessage || !(await tableReady())) return;
  const { data: req } = await supabase.from(TABLE).select('*').eq('id', id).eq('conversation_id', conv.id).maybeSingle();
  if (!req || req.status !== 'waiting_customer') return;
  const cfg = await getAiTeamConfig();
  const pic = picOf(cfg, req.division, req.pic_index) || { phone: req.pic_phone, call: '' };
  const lastTeam = [...(req.thread || [])].reverse().find((t) => t.from === 'team' && t.wa_id);
  const text = await styleForTeam(teamMessage, pic.call);
  const sent = await sendToPic(req.pic_phone || pic.phone, text, { quote: lastTeam ? { id: lastTeam.wa_id, jid: lastTeam.jid, text: lastTeam.text } : null });
  for (const i of sent.ids) teamWaIds.add(i);
  await updateReq(req.id, {
    status: 'open', sent_at: nowIso(), reminded_at: null, acked: false,
    wa_ids: [...(req.wa_ids || []), ...sent.ids],
    thread: withThread(req, { from: 'customer', text: sent.text, wa_ids: sent.ids }),
  });
}

// ── Konteks untuk prompt AI Sales ─────────────────────────────────────────
// Aturan TETAP (bagian prompt sistem) — hanya divisi yang aktif & punya PIC.
export function teamPromptRules(cfg) {
  if (!cfg?.enabled) return '';
  const lines = [];
  for (const k of ['gudang', 'teknis']) {
    const d = cfg.divisions[k];
    if (!d?.enabled || !d.pics.length) continue;
    const topics = d.topics.split('\n').map((s) => s.trim()).filter(Boolean).join('; ');
    lines.push(`- "${k}": ${k === 'gudang' ? 'SEMUA pertanyaan stok/ketersediaan barang' : 'pertanyaan teknis'} — ${topics}`);
  }
  if (!lines.length) return '';
  return `TANYA TIM INTERNAL (kamu bertanya lewat WA ke rekan kerja):
Bila customer menanyakan hal yang jawabannya harus dari tim berikut, JANGAN menebak/mengarang. Isi "ask_team" dan di "messages" kabari customer singkat bahwa kamu cek dulu (mis. "sebentar ya pak, saya cek dulu ketersediaannya" / "saya pastikan dulu ke tim teknis ya pak"). Tetap tanggapi bagian lain dari pesan customer yang bisa kamu jawab.
${lines.join('\n')}
- Ke customer JANGAN PERNAH menyebut supplier, procurement, atau stok gudang kosong. Barang yang perlu dipesan = "dipesan langsung dari pabrik".
- "team_message": pesan WA ke rekan kerja divisi itu, gaya santai seperti chat antar rekan kerja sales (BUKAN gaya bot: tanpa salam formal, tanpa label/emoji pembuka, tanpa kode/nomor tiket). Awali dengan "{panggilan}," lalu inti pertanyaan + konteks yang dibutuhkan tim (barang/tipe/kapasitas/jumlah, kota customer, rencana waktu pasang; untuk teknis: kondisi atap/listrik yang sudah diketahui). 1-3 kalimat pendek, boleh dipisah baris. Contoh: "{panggilan}, mau tanya stok dong\\ninverter hybrid 5kw sama baterai 10kwh ada ga ya? buat customer di surabaya, rencana pasang bulan depan".
- Jangan bertanya ulang hal yang masih menunggu jawaban (lihat STATUS TANYA TIM); bila customer menanyakannya lagi, bilang masih dicek.
- Bila STATUS TANYA TIM berisi "TIM MENUNGGU JAWABAN CUSTOMER" dan customer sudah menjawabnya, isi "team_answer" dengan id-nya dan "team_message" berisi jawaban customer untuk rekan kerja (gaya santai, mis. "atapnya genteng metal mas, rumah 2 lantai").
- Bila sekarang di luar jam kerja, kabari customer bahwa infonya dikabari di jam kerja berikutnya.`;
}

// Status per chat (bagian dinamis prompt).
export async function teamContextFor(conversationId, cfg) {
  if (!cfg?.enabled || !(await tableReady())) return '';
  const { data } = await supabase.from(TABLE)
    .select('id, division, topic, status, sent_at, created_at, thread')
    .eq('conversation_id', conversationId).in('status', ['open', 'waiting_customer'])
    .order('created_at', { ascending: true }).limit(10);
  const wh = await teamHours();
  const lines = [`STATUS TANYA TIM: sekarang ${inHours(wh) ? 'jam kerja' : 'DI LUAR jam kerja'}.`];
  const waiting = (data || []).filter((r) => r.status === 'open');
  const asked = (data || []).filter((r) => r.status === 'waiting_customer');
  if (waiting.length) {
    lines.push('Masih menunggu jawaban tim (jangan ditanyakan ulang, jangan dijawab sendiri):');
    for (const r of waiting) {
      const mins = Math.round((Date.now() - new Date(r.sent_at || r.created_at).getTime()) / 60000);
      lines.push(`- ${r.division === 'teknis' ? 'teknis' : 'stok'}: ${r.topic || '-'} (ditanyakan ${mins} menit lalu)`);
    }
  }
  for (const r of asked) {
    const q = [...(r.thread || [])].reverse().find((t) => t.from === 'team');
    lines.push(`TIM MENUNGGU JAWABAN CUSTOMER [id=${r.id}] soal ${r.topic || '-'}: tim bertanya "${clip(q?.text, 200)}"`);
  }
  return lines.length > 1 ? lines.join('\n') : lines[0];
}

// ── Jawaban dari PIC ──────────────────────────────────────────────────────
const seen = new Set();
const batches = new Map(); // phone -> { timer, msgs }

// Dipanggil connection.js untuk pesan masuk dari nomor PIC (atau reply ke pesan kita).
export function handleTeamMessage(m) {
  if (!m?.waMessageId || seen.has(m.waMessageId)) return;
  seen.add(m.waMessageId);
  if (seen.size > 5000) seen.clear();
  const tsMs = Number(m.timestamp || 0) * 1000;
  if (tsMs && Date.now() - tsMs > 24 * 3600 * 1000) return; // pesan lama dari sinkronisasi
  const phone = String(m.phone || '').split('@')[0];
  const b = batches.get(phone) || { msgs: [] };
  clearTimeout(b.timer);
  b.msgs.push(m);
  b.timer = setTimeout(() => {
    batches.delete(phone);
    processTeamBatch(phone, b.msgs).catch((e) => console.warn('[AITeam] proses jawaban gagal:', e?.message || e));
  }, DEBOUNCE_MS);
  batches.set(phone, b);
}

async function candidateRequests(phone, quotedIds) {
  const since = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const { data } = await supabase.from(TABLE).select('*')
    .or(`status.in.(open,waiting_customer),answered_at.gte."${since}"`)
    .order('created_at', { ascending: true }).limit(100);
  const rows = (data || []).filter((r) => !['closed', 'cancelled', 'failed', 'expired'].includes(r.status));
  const byQuote = rows.find((r) => (r.wa_ids || []).some((id) => quotedIds.includes(id)));
  const info = teamPhoneInfo(phone);
  const cfg = await getAiTeamConfig();
  const mine = rows.filter((r) => r.pic_phone === phone
    || (info && r.division === info.division && cfg.divisions[r.division]?.pics.some((p) => p.phone === phone))
    || (byQuote && r.id === byQuote.id));
  // Prioritas: yang masih menunggu, lalu yang baru dijawab (mis. ralat)
  mine.sort((a, b) => (a.status === 'answered') - (b.status === 'answered'));
  return { byQuote, list: mine };
}

export async function parseTeamReply(text, list, quotedIdx) {
  const items = list.map((r, i) => {
    const ours = [...(r.thread || [])].reverse().find((t) => t.from === 'ai' || t.from === 'customer');
    return `${i + 1}. [${r.division}] ${r.topic || '-'} — pesan kita: "${clip(ours?.text || r.team_message, 220)}"${r.status === 'answered' ? ` (sudah dijawab: "${clip(r.answer, 120)}")` : ''}`;
  }).join('\n');
  const out = await generate('team_parse', {
    system: `Kamu membantu sales membaca balasan WhatsApp dari rekan kerja internal (tim gudang / procurement / teknis) atas pertanyaan sales. Balas HANYA JSON:
{"match": nomor pertanyaan yang dijawab (1..n) atau null bila tidak bisa dipastikan,
 "kind": "answer" (jawaban/informasi, termasuk "tidak ada"/"kosong"/"harus pesan") | "question" (tim balik bertanya / butuh info tambahan dari customer) | "ack" (hanya konfirmasi sedang dicek, mis. "ok bentar", "siap dicek") | "other" (TIDAK berkaitan dengan pertanyaan di daftar, mis. menanggapi notifikasi sistem/ERP, PO, pengiriman barang lain, obrolan lain — bila ragu pilih "other" dan match null),
 "stock": khusus pertanyaan [gudang] dengan kind "answer": "available" (semua tersedia) | "partial" (sebagian) | "empty" (kosong); selain itu null,
 "answer": ringkasan jawaban atau pertanyaan tim yang akurat & lengkap (angka, tipe, jumlah, waktu), jangan menambah info,
 "missing": bila partial/empty: barang yang kosong/kurang, selain itu "",
 "clarify": bila match null dan ada lebih dari 1 pertanyaan: pesan WA santai ke rekan kerja untuk memastikan ini jawaban yang mana (mis. "yang ini buat baterai 10kwh ya mas?"), selain itu "",
 "procurement_message": bila pertanyaan [gudang] dan stock partial/empty: pesan WA santai ke rekan tim procurement, diawali "{panggilan},", menanyakan ketersediaan barang yang kosong + berapa lama pemesanan sampai barang siap & pengirimannya, sertakan konteks dari pesan kita (kota, rencana pasang) bila ada. Gaya chat antar rekan kerja, bukan bot, 1-3 kalimat pendek boleh dipisah baris. Selain itu ""}`,
    prompt: `Pertanyaan yang sedang ditunggu jawabannya:\n${items}\n\n${quotedIdx ? `Balasan ini me-reply pesan pertanyaan nomor ${quotedIdx}.\n\n` : ''}Balasan rekan kerja:\n"""${clip(text, 1500)}"""`,
    json: true,
    maxTokens: 500,
    temperature: 0.1,
  });
  return parseJsonLoose(out.text) || {};
}

async function processTeamBatch(phone, msgs) {
  if (!(await tableReady())) return;
  const text = msgs.map((m) => String(m.body || '').trim()).filter(Boolean).join('\n');
  if (!text) return;
  const quotedIds = msgs.map((m) => m.quotedId).filter(Boolean);
  const { byQuote, list } = await candidateRequests(phone, quotedIds);
  if (!list.length) { console.log(`[AITeam] pesan dari PIC ${phone} tanpa pertanyaan terbuka, diabaikan`); return; }
  const lastMsg = msgs[msgs.length - 1];
  const teamEntry = { from: 'team', pic: teamPhoneInfo(phone)?.call || phone, text: clip(text, 1500), wa_id: lastMsg.waMessageId, jid: lastMsg.jid };

  let parsed = {};
  try { parsed = await parseTeamReply(text, list, byQuote ? list.indexOf(byQuote) + 1 : null); }
  catch (e) { console.warn('[AITeam] AI gagal membaca jawaban tim:', e?.message || e); }

  // Tidak berkaitan (mis. menanggapi notifikasi ERP) & bukan reply ke pertanyaan kita -> abaikan
  if (parsed.kind === 'other' && !byQuote) return;
  let req = byQuote || (parsed.match && list[parsed.match - 1]) || null;
  const waiting = list.filter((r) => r.status !== 'answered');
  if (!req && waiting.length === 1) req = waiting[0];
  if (!req) {
    if (parsed.clarify) {
      const t = await styleForTeam(parsed.clarify, '');
      await sendToPic(phone, t, { quote: { id: lastMsg.waMessageId, jid: lastMsg.jid, text } }).catch(() => {});
    }
    return;
  }

  const kind = parsed.kind || 'answer';
  const thread = withThread(req, teamEntry);
  if (kind === 'ack' || kind === 'other') {
    await updateReq(req.id, { thread, acked: kind === 'ack' ? true : req.acked });
    return;
  }

  const { data: conv } = await supabase.from('conversations')
    .select('id, assigned_to, contact:contacts (id, name, phone)').eq('id', req.conversation_id).maybeSingle();
  if (!conv) { await updateReq(req.id, { thread, status: 'closed' }); return; }
  const answer = String(parsed.answer || text).trim();

  if (kind === 'question') {
    await updateReq(req.id, { thread, status: 'waiting_customer', acked: true });
    const task = `TUGAS SEKARANG: untuk menjawab pertanyaan customer soal "${req.topic || req.customer_question}", ${req.division === 'teknis' ? 'tim teknis' : 'kamu'} butuh info tambahan: "${answer}". Tanyakan hal itu ke customer secara natural & singkat${req.division === 'teknis' ? ' (boleh bilang biar tim teknis bisa cek)' : ''}. JANGAN menyebut supplier/procurement/gudang.`;
    await forwardOrFallback(conv, req, task, `Tim ${labelOf(req.division)} bertanya: ${answer}`);
    return;
  }

  // kind === 'answer'
  const cfg = await getAiTeamConfig();
  const proc = cfg.divisions.procurement;
  const needOrder = req.division === 'gudang' && (parsed.stock === 'partial' || parsed.stock === 'empty');
  if (needOrder && proc?.enabled && proc.pics.length) {
    await updateReq(req.id, { thread, status: 'answered', answer, stock: parsed.stock, answered_at: nowIso() });
    const child = await createTeamRequest({
      conv, division: 'procurement',
      topic: parsed.missing || req.topic,
      question: `${req.customer_question || req.topic} (gudang: ${answer})`,
      teamMessage: parsed.procurement_message || `{panggilan}, ${parsed.missing || req.topic} di gudang lagi kosong nih\nkalo pesen sekarang kira2 berapa lama sampe barangnya siap ya? sama pengirimannya berapa hari`,
      parentId: req.id,
    });
    if (child) {
      const task = `TUGAS SEKARANG: info ketersediaan "${req.topic}" sudah ada: ${parsed.stock === 'partial' ? `sebagian ready (${answer}); yang belum ada: ${parsed.missing || '-'}` : 'barangnya perlu dipesan dulu'}. Kabari customer singkat ${parsed.stock === 'partial' ? 'bahwa yang ready sudah ready, dan untuk sisanya ' : 'bahwa '}kamu sedang cek jadwal/estimasinya dari PABRIK supaya estimasinya pas. JANGAN bilang stok gudang kosong/habis, JANGAN sebut supplier/procurement, JANGAN beri estimasi waktu dulu.`;
      await forwardOrFallback(conv, req, task, `Gudang: ${answer} — sedang dicek ke procurement`);
      return;
    }
  }

  await updateReq(req.id, { thread, status: 'answered', answer, stock: parsed.stock || null, answered_at: nowIso() });
  const fromFactory = req.division === 'procurement' || needOrder;
  const task = `TUGAS SEKARANG: ${req.status === 'answered' ? 'ada RALAT/tambahan info dari tim' : 'tim sudah menjawab'} pertanyaan customer soal "${req.topic || req.customer_question}". Jawaban internal tim (jangan disalin mentah, jangan tambah info yang tidak ada): "${answer}".
Sampaikan ke customer secara natural sesuai gaya biasa. Sebut cukup "tim kami" bila perlu, jangan sebut nama divisi internal.${fromFactory ? '\nBarang ini DIPESAN LANGSUNG DARI PABRIK: sampaikan sebagai pemesanan dari pabrik dengan SATU estimasi total waktu sampai barang siap (gabungkan lama pesan/proses + pengiriman). JANGAN menyebut supplier, procurement, atau stok gudang kosong. Bila pabrik juga tidak tersedia, sampaikan jujur dengan halus dan tawarkan alternatif tipe/kapasitas lain.' : ''}
Jangan sebut harga kecuali tertulis di jawaban tim atau di SKILL / PLAYBOOK. Bila relevan, arahkan ke langkah berikutnya.`;
  await forwardOrFallback(conv, req, task, `${labelOf(req.division)}: ${answer}`);
}

// AI meneruskan ke customer; bila chat bukan milik AI / admin sedang aktif ->
// catat & beri tahu agent yang memegang chat (atau admin).
async function forwardOrFallback(conv, req, task, noteText) {
  let res = { sent: false };
  try { res = await runAiTask(conv.id, task); } catch (e) { console.warn('[AITeam] gagal meneruskan ke customer:', e?.message || e); }
  if (res.sent) return;
  await addContactNote(conv.contact?.id, `[Tanya Tim] ${noteText}`).catch(() => {});
  const who = conv.contact?.name || conv.contact?.phone || 'customer';
  const title = `Jawaban ${labelOf(req.division)} untuk ${who}`;
  if (conv.assigned_to) await notifyAgents([conv.assigned_to], title, clip(noteText, 160), conv.id).catch(() => {});
  else await notifyAdmins(title, clip(noteText, 160), conv.id).catch(() => {});
}

// ── Batas waktu (dihitung dalam jam kerja) ───────────────────────────────
const REMINDERS = [
  '{panggilan}, yang {topik} tadi gimana ya? customernya nanyain lagi soalnya 🙏',
  '{panggilan} maaf ganggu, soal {topik} tadi udah ada infonya belum ya?',
  '{panggilan}, {topik} yang tadi aku tanyain udah sempet dicek belum? 🙏',
];
const HOLD_CUSTOMER = [
  'maaf ya {sapaan}, masih saya cek, nanti langsung saya kabari 🙏',
  '{sapaan}, ini masih saya pastikan dulu ya, sebentar lagi saya kabari',
  'masih saya cek ya {sapaan}, ditunggu sebentar 🙏',
];

export async function runTeamTimers() {
  const cfg = await getAiTeamConfig();
  if (!cfg.enabled || !(await tableReady())) return 0;
  const { data: rows } = await supabase.from(TABLE).select('*').eq('status', 'open').not('sent_at', 'is', null).limit(100);
  const wh = await teamHours();
  let acted = 0;
  for (const req of rows || []) {
    const mins = workMinutes(new Date(req.sent_at).getTime(), Date.now(), wh);
    try {
      if (mins >= cfg.remind_min && !req.reminded_at) { await remindAndEscalate(req, cfg); acted++; }
      if (mins >= cfg.admin_min && !req.admin_notified_at) {
        const { data: conv } = await supabase.from('conversations').select('id, contact:contacts (id, name, phone)').eq('id', req.conversation_id).maybeSingle();
        const who = conv?.contact?.name || conv?.contact?.phone || 'customer';
        await notifyAdmins(`${labelOf(req.division)} belum menjawab`, `${who}: ${clip(req.topic || req.customer_question, 120)} (${Math.round(mins)} menit)`, req.conversation_id).catch(() => {});
        await updateReq(req.id, { admin_notified_at: nowIso(), thread: withThread(req, { from: 'system', text: 'Admin dinotifikasi (belum dijawab)' }) });
        acted++;
      }
      // Tidak terjawab berhari-hari -> kedaluwarsa
      if (Date.now() - new Date(req.sent_at).getTime() > 7 * 86400000) await updateReq(req.id, { status: 'expired' });
    } catch (e) { console.warn(`[AITeam] timer req=${req.id} gagal:`, e?.message || e); }
  }
  return acted;
}

async function remindAndEscalate(req, cfg) {
  const d = cfg.divisions[req.division];
  const cur = picOf(cfg, req.division, req.pic_index) || { phone: req.pic_phone, call: '' };
  const topik = req.topic || 'yang tadi';
  const patch = { reminded_at: nowIso() };
  let thread = req.thread || [];
  // Pengingat santai ke PIC sekarang
  const rem = await styleForTeam(pick(REMINDERS).replace('{topik}', topik), cur.call);
  const lastOurs = [...thread].reverse().find((t) => (t.from === 'ai' || t.from === 'customer') && t.wa_ids?.length);
  const s1 = await sendToPic(req.pic_phone || cur.phone, rem, { quote: lastOurs ? { id: lastOurs.wa_ids[0], jid: `${req.pic_phone}@s.whatsapp.net`, text: lastOurs.text, fromMe: true } : null }).catch(() => null);
  let waIds = [...(req.wa_ids || []), ...(s1?.ids || [])];
  if (s1) thread = [...thread, { at: nowIso(), from: 'ai', pic: cur.call || cur.phone, text: s1.text, wa_ids: s1.ids, reminder: true }];
  // Pindah ke PIC cadangan (kecuali PIC sekarang sudah bilang sedang dicek)
  const next = d?.pics?.[req.pic_index + 1];
  if (next && !req.acked) {
    const text = await styleForTeam(req.team_message, next.call);
    const s2 = await sendToPic(next.phone, text).catch(() => null);
    if (s2) {
      waIds = [...waIds, ...s2.ids];
      thread = [...thread, { at: nowIso(), from: 'ai', pic: next.call || next.phone, text: s2.text, wa_ids: s2.ids }];
      Object.assign(patch, { pic_index: req.pic_index + 1, pic_phone: next.phone });
    }
  }
  await updateReq(req.id, { ...patch, wa_ids: waIds, thread: thread.slice(-40) });
  // Kabari customer "masih dicek" (tanpa AI, hemat token)
  await holdCustomer(req).catch(() => {});
}

async function holdCustomer(req) {
  const { data: conv } = await supabase.from('conversations')
    .select('id, assigned_to, wa_jid, contact:contacts (id, phone)').eq('id', req.conversation_id).maybeSingle();
  const ai = await getAiSalesConfig();
  if (!conv || !ai.enabled || String(conv.assigned_to) !== String(ai.agent_id)) return;
  const sal = await getSalutation(conv.contact?.id).catch(() => null);
  const text = humanizeText(pick(HOLD_CUSTOMER).replace('{sapaan}', sal || 'bapak/ibu'), { salutation: sal, lowercase: ai.lowercase });
  await runAiTask(conv.id, null, { fixedMessages: [text] });
}

// ── Daftar untuk dashboard ────────────────────────────────────────────────
export async function listTeamRequests({ conversationId = null, limit = 30 } = {}) {
  if (!(await tableReady())) return { ready: false, requests: [] };
  let q = supabase.from(TABLE)
    .select('id, conversation_id, division, topic, customer_question, status, stock, answer, pic_phone, pic_index, parent_id, thread, created_at, sent_at, answered_at, reminded_at, admin_notified_at, conversation:conversations (id, contact:contacts (name, phone))')
    .order('created_at', { ascending: false }).limit(limit);
  if (conversationId) q = q.eq('conversation_id', conversationId);
  const { data, error } = await q;
  if (error) throw error;
  return { ready: true, requests: data || [] };
}

export async function closeTeamRequest(id) {
  return updateReq(id, { status: 'closed' });
}

// Cek nomor PIC terdaftar di WhatsApp.
export async function checkPicNumbers(cfg) {
  const sock = getSock();
  if (!sock) throw new Error('WhatsApp belum tersambung');
  const out = {};
  for (const d of Object.values(cfg.divisions)) {
    for (const p of d.pics) {
      if (out[p.phone] !== undefined) continue;
      try { const [r] = await sock.onWhatsApp(`${p.phone}@s.whatsapp.net`); out[p.phone] = !!r?.exists; }
      catch { out[p.phone] = null; }
    }
  }
  return out;
}

export async function startAiTeamJob(intervalMs = 60 * 1000) {
  await getAiTeamConfig().catch(() => {});
  // ID pesan kita ke PIC (7 hari) -> mengenali reply walau jid PIC berupa @lid
  try {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data } = await supabase.from(TABLE).select('wa_ids').gte('created_at', since).limit(1000);
    for (const r of data || []) for (const id of r.wa_ids || []) teamWaIds.add(id);
  } catch { /* tabel belum ada */ }
  setInterval(() => {
    getAiTeamConfig().catch(() => {});
    runTeamTimers().catch((e) => console.warn('[AITeam] timer gagal:', e?.message || e));
  }, intervalMs);
  console.log('[AITeam] job aktif');
}

