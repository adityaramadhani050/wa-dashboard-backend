// AI Sales Agent: akun agent yang sepenuhnya dikendalikan AI.
//
// - Akun agent biasa (dibuat di Manajemen Agent) ditunjuk sebagai AI Sales di
//   pengaturan (app_settings 'ai_sales'). Ia ikut auto-assign seperti agent lain.
// - Pesan customer di chat milik AI dibalas otomatis (beberapa pesan beruntun
//   ditunggu dulu lalu dibalas sekaligus) dengan gaya sales manusia.
// - Wewenang sampai mengumpulkan data & usulan jadwal survei; konfirmasi jadwal
//   dan Deal oleh admin. Tidak menyerahkan chat sendiri: admin mengambil alih
//   dengan meng-assign ulang (AI hanya membalas chat yang di-assign ke akunnya).
// - Hal di luar kemampuan (komplain, harga di luar katalog, dll.) -> AI membalas
//   sopan "dicek dulu" & mengirim notifikasi ke admin.
import { randomBytes } from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '../db/supabase.js';
import { getSock, broadcast, bumpConvOutgoing } from '../baileys/connection.js';
import { markBotMessageId } from './regionalBot.js';
import { buildSalesContext } from './salesKnowledge.js';
import { sendToAgents } from '../push/fcm.js';
import { sendWebPushToAgents } from '../push/webpush.js';

const KEY = 'ai_sales';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const HUMAN_ACTIVE_MS = 30 * 60 * 1000; // ada balasan manusia <30 mnt -> AI diam
const MAX_REPLIES_PER_DAY = 40;          // pengaman per chat

export const DEFAULT_AI_SALES = {
  enabled: false,
  agent_id: null,
  persona_name: '',          // kosong = nama akun agent
  style: 'santai',           // santai | sopan
  instructions: '',          // aturan/info tambahan dari admin
  reply_delay_sec: 10,       // tunggu pesan beruntun sebelum membalas
};

export function parseAiSales(raw) {
  let v = {};
  try { v = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { v = {}; }
  const delay = parseInt(v.reply_delay_sec, 10);
  return {
    enabled: !!v.enabled,
    agent_id: v.agent_id || null,
    persona_name: String(v.persona_name || '').slice(0, 40),
    style: v.style === 'sopan' ? 'sopan' : 'santai',
    instructions: String(v.instructions || '').slice(0, 3000),
    reply_delay_sec: Number.isNaN(delay) ? DEFAULT_AI_SALES.reply_delay_sec : Math.min(120, Math.max(3, delay)),
  };
}

let cache = { val: null, at: 0 };
export async function getAiSalesConfig() {
  if (cache.val && Date.now() - cache.at < 15000) return cache.val;
  let val = { ...DEFAULT_AI_SALES };
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
    if (data?.value) val = parseAiSales(data.value);
  } catch { /* pakai default */ }
  cache = { val, at: Date.now() };
  return val;
}
export function invalidateAiSalesCache() { cache.at = 0; }

export async function saveAiSalesConfig(input) {
  const val = parseAiSales({ ...(await getAiSalesConfig()), ...input });
  const { error } = await supabase.from('app_settings')
    .upsert({ key: KEY, value: JSON.stringify(val), updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
  invalidateAiSalesCache();
  return val;
}

// ── Penjadwalan (debounce per chat) ───────────────────────────────────────
const timers = new Map();      // conversationId -> timeout
const processing = new Set();  // conversationId sedang diproses
const dailyCount = new Map();  // `${convId}|${tanggal}` -> jumlah balasan

// Dipanggil untuk tiap pesan masuk (setelah routing): jadwalkan balasan bila
// chat dipegang AI Sales.
export async function onIncomingForAi(conversationId) {
  const cfg = await getAiSalesConfig();
  if (!cfg.enabled || !cfg.agent_id) return;
  const { data: conv } = await supabase.from('conversations').select('assigned_to').eq('id', conversationId).maybeSingle();
  if (conv && String(conv.assigned_to) === String(cfg.agent_id)) scheduleAiReply(conversationId);
}

// opts.force: admin sengaja meng-assign chat ke AI -> abaikan cek "manusia aktif"
export async function scheduleAiReply(conversationId, delayMs, opts = {}) {
  const cfg = await getAiSalesConfig();
  if (!cfg.enabled || !cfg.agent_id || !process.env.GEMINI_API_KEY) return;
  const wait = delayMs ?? cfg.reply_delay_sec * 1000;
  clearTimeout(timers.get(conversationId));
  timers.set(conversationId, setTimeout(() => {
    timers.delete(conversationId);
    processConversation(conversationId, opts).catch((e) => console.warn(`[AISales] conv=${conversationId} gagal:`, e?.message || e));
  }, wait));
}

const wibDate = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRecentMessages(conversationId) {
  const run = (cols) => supabase.from('messages').select(cols)
    .eq('conversation_id', conversationId)
    .order('timestamp', { ascending: false }).limit(40);
  let r = await run('body, from_me, timestamp, media_type, sent_by_bot, sent_by_ai');
  if (r.error) r = await run('body, from_me, timestamp, media_type, sent_by_bot');
  if (r.error) r = await run('body, from_me, timestamp, media_type');
  return (r.data || []).reverse();
}

async function processConversation(conversationId, { force = false } = {}) {
  if (processing.has(conversationId)) return;
  processing.add(conversationId);
  try {
    const cfg = await getAiSalesConfig();
    if (!cfg.enabled || !cfg.agent_id) return;

    const { data: conv } = await supabase.from('conversations')
      .select('id, assigned_to, status, wa_jid, contact:contacts (id, name, phone)')
      .eq('id', conversationId).maybeSingle();
    if (!conv || String(conv.assigned_to) !== String(cfg.agent_id)) return; // sudah diambil alih
    if ((conv.wa_jid || '').endsWith('@g.us')) return;

    const { data: tagRows } = await supabase.from('conversation_tags').select('tags (name)').eq('conversation_id', conversationId);
    const tagNames = (tagRows || []).map((r) => r.tags?.name || '');
    // Deal / Non-Client ditangani admin
    if (tagNames.some((n) => /\bdeal\b/i.test(n) || /non[\s_-]*client/i.test(n))) return;

    const msgs = await fetchRecentMessages(conversationId);
    const last = msgs[msgs.length - 1];
    if (!last || last.from_me) return; // tidak ada pesan customer yang menunggu

    // Ada manusia (admin/agent) yang membalas setelah balasan AI terakhir & masih
    // baru -> admin sedang menangani, AI tidak ikut campur. (Butuh kolom sent_by_ai.)
    if (!force) {
      let lastAi = -1;
      msgs.forEach((m, i) => { if (m.sent_by_ai) lastAi = i; });
      const humanRecent = msgs.slice(lastAi + 1).some((m) => m.from_me && !m.sent_by_bot && m.sent_by_ai === false
        && Date.now() - new Date(m.timestamp).getTime() < HUMAN_ACTIVE_MS);
      if (humanRecent) return;
    }

    const dayKey = `${conversationId}|${wibDate()}`;
    if ((dailyCount.get(dayKey) || 0) >= MAX_REPLIES_PER_DAY) {
      console.warn(`[AISales] conv=${conversationId} mencapai batas ${MAX_REPLIES_PER_DAY} balasan/hari`);
      return;
    }

    const { data: agent } = await supabase.from('agents').select('name').eq('id', cfg.agent_id).maybeSingle();
    const persona = cfg.persona_name || agent?.name || 'Sales';
    const plan = await generateReply({ conversationId, msgs, cfg, persona });
    if (!plan?.reply) return;

    // Pesan baru masuk selagi AI berpikir -> jadwalkan ulang agar ikut terjawab
    const latest = await fetchRecentMessages(conversationId);
    const newest = latest[latest.length - 1];
    if (newest && newest.timestamp !== last.timestamp) {
      if (!newest.from_me) scheduleAiReply(conversationId, 2000);
      return;
    }
    const { data: still } = await supabase.from('conversations').select('assigned_to').eq('id', conversationId).maybeSingle();
    if (String(still?.assigned_to) !== String(cfg.agent_id)) return;

    const jid = conv.wa_jid || (conv.contact?.phone ? `${String(conv.contact.phone).split('@')[0]}@s.whatsapp.net` : null);
    if (!jid) return;
    await sendAiText(conversationId, jid, plan.reply);
    dailyCount.set(dayKey, (dailyCount.get(dayKey) || 0) + 1);
    await applyActions(conv, plan, persona);
  } finally {
    processing.delete(conversationId);
  }
}

// ── Otak AI ───────────────────────────────────────────────────────────────
let genai = null;
function client() {
  if (!genai) genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return genai;
}

const MEDIA_LABEL = { image: 'gambar', video: 'video', audio: 'pesan suara', document: 'dokumen', sticker: 'stiker', location: 'lokasi', contact: 'kontak' };

function historyText(msgs, persona) {
  return msgs.map((m) => {
    const who = m.from_me ? persona : 'Customer';
    let body = (m.body || '').trim();
    if (m.media_type && (!body || /^\[.*\]$/.test(body))) body = `[mengirim ${MEDIA_LABEL[m.media_type] || 'media'}]`;
    return `${who}: ${body || '[pesan kosong]'}`;
  }).join('\n');
}

export function buildSystemPrompt({ persona, style, instructions, ctx }) {
  const tone = style === 'sopan'
    ? 'sopan & profesional tapi tetap hangat (boleh "Kak", hindari singkatan alay)'
    : 'santai, ramah, khas chat WA sales Indonesia (boleh "Kak", singkatan WA wajar seperti "yg", "utk", "kalo")';
  return `Kamu adalah ${persona}, sales PLTS (panel surya) RenusPro yang sedang membalas chat WhatsApp customer secara langsung. Kamu sales manusia sungguhan dari sudut pandang customer: tulis seperti orang yang mengetik di HP.

TUJUAN: bawa customer bertahap dari kenal -> paham kebutuhan & solusi -> SETUJU SURVEI LOKASI GRATIS. Batas wewenangmu: mengumpulkan data & usulan jadwal survei. Konfirmasi jadwal survei & Deal dilakukan admin — jangan pernah menjanjikan jadwal pasti atau menyatakan deal.

PENGETAHUAN PRODUK:
- Jenis sistem: On-grid (hemat tagihan PLN), Off-grid (tanpa PLN), Hybrid (dengan baterai cadangan).
- Nilai jual: hemat tagihan s/d puluhan persen, balik modal jangka menengah, tahan 25+ tahun, bergaransi, ramah lingkungan.
- Harga ditentukan kapasitas (kWp), jenis sistem, tagihan listrik bulanan, lokasi & kondisi atap.

KATALOG & HARGA RESMI (satu-satunya sumber angka harga/spek):
${ctx.productRef || '(katalog belum diisi)'}
ATURAN HARGA: sebut harga/spek HANYA dari katalog. Jangan mengarang angka. Jangan beri diskon/promo/cicilan yang tidak tertulis di instruksi admin. Bila butuh hitungan khusus, gali kebutuhan atau tawarkan survei untuk hitungan akurat.

ALUR (baca posisi percakapan, pilih yang sesuai):
1. Awal: sapa singkat, beri 1 nilai/manfaat relevan, tanya 1 hal untuk menggali kebutuhan (tujuan pasang, tagihan listrik/bulan, rumah/usaha, kota).
2. Diskusi: gali lebih dalam (1 pertanyaan per balasan), beri rekomendasi & edukasi singkat. Bila customer minta harga, beri dari katalog yang paling sesuai.
3. Survei: bila kebutuhan sudah jelas & customer tertarik, tawarkan survei lokasi gratis. Kumpulkan: nama, alamat lengkap (minimal kota/kecamatan), dan hari/jam yang diinginkan. Setelah lengkap, sampaikan bahwa tim akan mengonfirmasi jadwalnya.

TAG CHAT INI: ${ctx.convTagsText}
- "Prospek": penawaran sudah dikirim -> tindak lanjuti keputusan & keberatan customer.
- "Fail": customer tidak lanjut -> balas sopan & ringan, jangan memaksa.

DI LUAR KEMAMPUAN (komplain, garansi/servis unit terpasang, minta ditelepon, permintaan khusus yang tidak bisa kamu jawab): balas sopan bahwa kamu cek/teruskan dulu ke tim, dan isi "notify_admin" dengan ringkasannya.
Bila customer bertanya apakah kamu bot/AI: jangan berbohong — jawab santai bahwa kamu dibantu sistem tim RenusPro, lalu lanjutkan membantu.
Media yang tidak bisa kamu lihat (gambar/dokumen/pesan suara): minta customer menjelaskan singkat lewat teks.

GAYA: ${tone}. Pakai "Kak" untuk customer, "kami" untuk tim. Maksimal 2-3 kalimat pendek, tanpa bullet/list, emoji 0-1. Jangan mulai dengan "Tentu", "Baik", "Terima kasih atas pertanyaan Anda". Jangan ulangi salam bila percakapan sudah berjalan. Jangan sebut dirimu AI/asisten virtual.

CONTOH GAYA SALES ASLI KAMI (${ctx.learnSourceNote}) — tiru rasa bahasanya, jangan salin mentah:
${ctx.salesStyleRef || '(belum ada contoh)'}
${instructions ? `\nINSTRUKSI TAMBAHAN DARI ADMIN (wajib dipatuhi):\n${instructions}\n` : ''}
KELUARAN: JSON saja, tanpa teks lain:
{"reply": "balasan WA siap kirim",
 "prospek": true/false  (true bila balasan ini/sebelumnya sudah memberi penawaran harga/paket, atau customer jelas tertarik membeli),
 "survey": {"ready": true/false (true HANYA bila customer setuju survei & sudah memberi alamat + usulan waktu), "nama": "", "alamat": "", "jadwal": "", "catatan": ""},
 "notify_admin": "" (isi ringkasan singkat bila ada hal yang perlu ditangani admin, selain itu kosong)}`;
}

async function generateReply({ conversationId, msgs, cfg, persona }) {
  const ctx = await buildSalesContext(conversationId);
  const result = await client().models.generateContent({
    model: MODEL,
    contents: `Riwayat chat (terbaru di bawah):\n${historyText(msgs.slice(-30), persona)}\n\nBalas pesan customer yang terakhir.`,
    config: {
      systemInstruction: buildSystemPrompt({ persona, style: cfg.style, instructions: cfg.instructions, ctx }),
      responseMimeType: 'application/json',
      maxOutputTokens: 600,
      temperature: 0.8,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  return parsePlan(result.text);
}

export function parsePlan(text) {
  let raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  let obj;
  try { obj = JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    try { obj = m ? JSON.parse(m[0]) : null; } catch { obj = null; }
  }
  if (!obj || typeof obj.reply !== 'string') return null;
  const reply = obj.reply.trim().slice(0, 1500);
  if (!reply) return null;
  const s = obj.survey || {};
  return {
    reply,
    prospek: !!obj.prospek,
    survey: s.ready ? {
      nama: String(s.nama || '').slice(0, 120), alamat: String(s.alamat || '').slice(0, 300),
      jadwal: String(s.jadwal || '').slice(0, 120), catatan: String(s.catatan || '').slice(0, 300),
    } : null,
    notify_admin: String(obj.notify_admin || '').trim().slice(0, 500),
  };
}

// ── Kirim & aksi ──────────────────────────────────────────────────────────
async function sendAiText(conversationId, jid, text) {
  const sock = getSock();
  if (!sock) throw new Error('WhatsApp belum tersambung');
  // Terlihat "sedang mengetik" sebentar, sebanding panjang pesan
  try {
    await sock.presenceSubscribe?.(jid);
    await sock.sendPresenceUpdate?.('composing', jid);
    await sleep(Math.min(7000, 1200 + text.length * 35));
    await sock.sendPresenceUpdate?.('paused', jid);
  } catch { /* opsional */ }

  const id = '3EB0' + randomBytes(9).toString('hex').toUpperCase();
  markBotMessageId(id);
  await sock.sendMessage(jid, { text }, { messageId: id });

  const nowIso = new Date().toISOString();
  // Balasan AI dihitung sebagai balasan agent (bukan bot) di Analytics
  const row = { conversation_id: conversationId, from_me: true, body: text, timestamp: nowIso, status: 'sent', wa_message_id: id, sent_by_ai: true };
  let res = await supabase.from('messages').insert(row).select().single();
  if (res.error) {
    delete row.sent_by_ai; // kolom belum dimigrasi
    res = await supabase.from('messages').insert(row).select().single();
  }
  await bumpConvOutgoing(conversationId, text);
  if (res.data) broadcast('new_message', { message: res.data, conversationId }).catch(() => {});
  return res.data;
}

async function notifyAdmins(title, body, conversationId) {
  const { data: admins } = await supabase.from('agents').select('id').eq('role', 'admin');
  const ids = (admins || []).map((a) => a.id);
  if (!ids.length) return;
  const data = { url: `/chat/${conversationId}`, tag: `ai-sales-${conversationId}` };
  await Promise.allSettled([
    sendToAgents(ids, { title, body, data }),
    sendWebPushToAgents(ids, { title, body, data }),
  ]);
}

async function addNote(contactId, agentId, body) {
  if (!contactId) return;
  await supabase.from('contact_notes').insert({ contact_id: contactId, agent_id: agentId || null, body });
}

async function applyActions(conv, plan, persona) {
  const cfg = await getAiSalesConfig();
  const who = conv.contact?.name || conv.contact?.phone || 'customer';
  try {
    if (plan.prospek) {
      const { data: tags } = await supabase.from('tags').select('id, name');
      const tag = (tags || []).find((t) => /prospek/i.test(t.name || ''));
      if (tag) {
        const { error } = await supabase.from('conversation_tags').insert({ conversation_id: conv.id, tag_id: tag.id });
        if (!error) broadcast('conversation_updated', { conversationId: conv.id, tagsChanged: true }).catch(() => {});
      }
    }
    if (plan.survey) {
      const s = plan.survey;
      const note = `[${persona} · AI] Permintaan survei\nNama: ${s.nama || '-'}\nAlamat: ${s.alamat || '-'}\nUsulan jadwal: ${s.jadwal || '-'}${s.catatan ? `\nCatatan: ${s.catatan}` : ''}`;
      await addNote(conv.contact?.id, cfg.agent_id, note);
      await notifyAdmins('Permintaan survei dari AI Sales', `${who}: ${s.alamat || 'alamat -'} · ${s.jadwal || 'jadwal -'}`, conv.id);
      console.log(`[AISales] conv=${conv.id} permintaan survei dicatat`);
    }
    if (plan.notify_admin) {
      await addNote(conv.contact?.id, cfg.agent_id, `[${persona} · AI] Perlu dibantu admin: ${plan.notify_admin}`);
      await notifyAdmins('AI Sales butuh bantuan', `${who}: ${plan.notify_admin}`, conv.id);
    }
  } catch (e) {
    console.warn(`[AISales] aksi conv=${conv.id} gagal:`, e?.message || e);
  }
}

// ── Penyapu berkala: chat AI yang masih menunggu balasan (mis. baru di-assign
// manual ke AI, server restart, atau pesan yang terlewat). ────────────────
async function sweep() {
  const cfg = await getAiSalesConfig();
  if (!cfg.enabled || !cfg.agent_id || !process.env.GEMINI_API_KEY) return;
  const cutoff = new Date(Date.now() - cfg.reply_delay_sec * 1000).toISOString();
  const { data, error } = await supabase.from('conversations')
    .select('id').eq('assigned_to', cfg.agent_id)
    .in('status', ['open', 'in_progress'])
    .eq('last_from_me', false)
    .lt('awaiting_since', cutoff)
    .limit(20);
  if (error) return;
  for (const c of data || []) {
    if (!timers.has(c.id) && !processing.has(c.id)) scheduleAiReply(c.id, 500);
  }
}

export function startAiSalesJob(intervalMs = 60 * 1000) {
  setTimeout(() => sweep().catch(() => {}), 30 * 1000);
  setInterval(() => sweep().catch(() => {}), intervalMs);
  console.log('[AISales] job aktif');
}
