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
import { supabase } from '../db/supabase.js';
import { getSock, broadcast, bumpConvOutgoing } from '../baileys/connection.js';
import { markBotMessageId } from './regionalBot.js';
import { buildSalesContext } from './salesKnowledge.js';
import { buildKnowledge, refreshMemories, getSalutation, saveSalutation, normalizeSalutation } from './aiKnowledge.js';
import { STEP_META, getFollowupConfig, completeTask, applyAiOutcome } from './followup.js';
import { getWorkHours } from '../routes/stats.js';
import { generate, aiEnabled } from './llm.js';
import { sendToAgents } from '../push/fcm.js';
import { sendWebPushToAgents } from '../push/webpush.js';

const KEY = 'ai_sales';
const HUMAN_ACTIVE_MS = 30 * 60 * 1000; // ada balasan manusia <30 mnt -> AI diam
const MAX_REPLIES_PER_DAY = 40;          // pengaman per chat
const HISTORY_LIMIT = 15;                // pesan terakhir yang dibacakan ke AI (hemat token)

export const DEFAULT_AI_SALES = {
  enabled: false,
  agent_id: null,
  persona_name: '',          // kosong = nama akun agent
  company: 'Renus',          // nama perusahaan yang disebut AI
  style: 'santai',           // santai | sopan
  instructions: '',          // aturan/info tambahan dari admin
  reply_delay_sec: 10,       // tunggu pesan beruntun sebelum membalas
  followup_enabled: false,   // AI mengirim tugas follow-up chat miliknya otomatis
  lowercase: true,           // semua huruf kecil agar terlihat natural
};

export function parseAiSales(raw) {
  let v = {};
  try { v = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { v = {}; }
  const delay = parseInt(v.reply_delay_sec, 10);
  return {
    enabled: !!v.enabled,
    agent_id: v.agent_id || null,
    persona_name: String(v.persona_name || '').slice(0, 40),
    company: String(v.company ?? DEFAULT_AI_SALES.company).trim().slice(0, 60) || DEFAULT_AI_SALES.company,
    style: v.style === 'sopan' ? 'sopan' : 'santai',
    instructions: String(v.instructions || '').slice(0, 3000),
    reply_delay_sec: Number.isNaN(delay) ? DEFAULT_AI_SALES.reply_delay_sec : Math.min(120, Math.max(3, delay)),
    followup_enabled: !!v.followup_enabled,
    lowercase: v.lowercase === undefined ? true : !!v.lowercase,
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
  if (!cfg.enabled || !cfg.agent_id || !aiEnabled()) return;
  const wait = delayMs ?? cfg.reply_delay_sec * 1000;
  clearTimeout(timers.get(conversationId));
  timers.set(conversationId, setTimeout(() => {
    timers.delete(conversationId);
    processConversation(conversationId, opts).catch((e) => console.warn(`[AISales] conv=${conversationId} gagal:`, e?.message || e));
  }, wait));
}

const wibDate = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const skipped = new Map(); // conversationId -> timestamp pesan customer yang sengaja tidak dibalas

// Pesan penutup/basa-basi yang tidak perlu dibalas (tanpa memanggil AI = hemat token).
const TRIVIAL_WORDS = new Set(('ok oke okey okay okeh okee sip sipp siap baik iya ya yaa yap y mantap mantab ' +
  'makasih makasi mksh makasii trims terima kasih thanks thank you thx tq ty noted sama sama2 pak bu kak min ' +
  'nggih injih ok2 oc').split(' '));
export function isTrivialMessage(m) {
  if (m.media_type === 'sticker') return true;
  const raw = String(m.body || '').trim();
  if (!raw || /^\[.*\]$/.test(raw)) return !!m.media_type && m.media_type === 'sticker';
  const words = raw.toLowerCase().replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, ' ').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.every((w) => TRIVIAL_WORDS.has(w)) && raw.length <= 40;
}
// Semua pesan customer yang menunggu sepele & pesan kita sebelumnya bukan pertanyaan.
export function shouldSkipWithoutAi(msgs) {
  let i = msgs.length - 1;
  const pending = [];
  while (i >= 0 && !msgs[i].from_me) { pending.unshift(msgs[i]); i--; }
  const lastOut = i >= 0 ? msgs[i] : null;
  if (!pending.length || !lastOut) return false;          // chat baru: tetap dibalas
  if (/\?\s*\S{0,3}\s*$/.test(String(lastOut.body || ''))) return false; // kita bertanya -> "ok" adalah jawaban
  return pending.every(isTrivialMessage);
}

async function fetchRecentMessages(conversationId) {
  const run = (cols) => supabase.from('messages').select(cols)
    .eq('conversation_id', conversationId)
    .order('timestamp', { ascending: false }).limit(40);
  let r = await run('body, from_me, timestamp, media_type, wa_message_id, sent_by_bot, sent_by_ai');
  if (r.error) r = await run('body, from_me, timestamp, media_type, wa_message_id, sent_by_bot');
  if (r.error) r = await run('body, from_me, timestamp, media_type, wa_message_id');
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
    if (skipped.get(conversationId) === last.timestamp) return; // sudah diputuskan tidak dibalas

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
    if (shouldSkipWithoutAi(msgs)) {
      skipped.set(conversationId, last.timestamp);
      await supabase.from('conversations').update({ awaiting_since: null }).eq('id', conversationId);
      console.log(`[AISales] conv=${conversationId} pesan penutup (tanpa AI), tidak dibalas`);
      return;
    }

    // Follow-up AI terakhir yang kini dibalas customer -> AI ikut menilai hasilnya
    const fuTask = await pendingAiFollowupOutcome(conversationId, cfg.agent_id, last.timestamp);
    const plan = await generateReply({ conversationId, contactId: conv.contact?.id, waName: conv.contact?.name, msgs, cfg, persona, fuTask });
    if (!plan) return;
    if (plan.followup_outcome && fuTask) {
      await applyAiOutcome(fuTask.id, plan.followup_outcome, plan.objection_category).catch(() => {});
    }
    if (plan.skip || !plan.messages.length) {
      // Pesan penutup (ok/makasih/stiker) -> tidak perlu dibalas, seperti sales manusia
      skipped.set(conversationId, last.timestamp);
      await supabase.from('conversations').update({ awaiting_since: null }).eq('id', conversationId);
      console.log(`[AISales] conv=${conversationId} pesan penutup, tidak dibalas`);
      return;
    }

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
    // Tandai dibaca (centang biru) pesan customer yang dibalas
    const unread = [];
    for (let i = msgs.length - 1; i >= 0 && !msgs[i].from_me; i--) if (msgs[i].wa_message_id) unread.push(msgs[i].wa_message_id);
    await sendAiBubbles(conversationId, jid, plan.messages, { readIds: unread, readLen: msgs.filter((m) => !m.from_me).slice(-3).map((m) => m.body || '').join(' ').length });
    dailyCount.set(dayKey, (dailyCount.get(dayKey) || 0) + 1);
    await applyActions(conv, plan, persona);
  } finally {
    processing.delete(conversationId);
  }
}

// ── Otak AI ───────────────────────────────────────────────────────────────

const MEDIA_LABEL = { image: 'gambar', video: 'video', audio: 'pesan suara', document: 'dokumen', sticker: 'stiker', location: 'lokasi', contact: 'kontak' };

function historyText(msgs, persona) {
  return msgs.map((m) => {
    const who = m.from_me ? persona : 'Customer';
    let body = (m.body || '').trim();
    if (m.media_type && (!body || /^\[.*\]$/.test(body))) body = `[mengirim ${MEDIA_LABEL[m.media_type] || 'media'}]`;
    return `${who}: ${body || '[pesan kosong]'}`;
  }).join('\n');
}

// Prompt TETAP (sama untuk semua chat selama pengaturan tidak berubah) -> diletakkan
// di depan agar penyedia model bisa memakai prompt cache (lebih murah). Data yang
// berubah per chat ada di buildChatContext() dan dikirim di bagian akhir.
export function buildSystemPrompt({ persona, style, instructions, ctx, lowercase = true, company = 'Renus' }) {
  const tone = style === 'sopan'
    ? 'sopan & profesional tapi tetap hangat, hindari singkatan alay'
    : 'santai, ramah, khas chat WA sales Indonesia (singkatan WA wajar seperti "yg", "utk", "kalo")';
  return `Kamu adalah ${persona}, sales PLTS (panel surya) ${company} yang sedang membalas chat WhatsApp customer secara langsung. Kamu sales manusia sungguhan dari sudut pandang customer: tulis seperti orang yang mengetik di HP.

TUJUAN: bawa customer bertahap dari kenal -> paham kebutuhan & solusi -> SETUJU SURVEI LOKASI GRATIS. Batas wewenangmu: mengumpulkan data & usulan jadwal survei. Konfirmasi jadwal survei & Deal dilakukan admin — jangan pernah menjanjikan jadwal pasti atau menyatakan deal.

PENGETAHUAN PRODUK:
- Jenis sistem: On-grid (hemat tagihan PLN), Off-grid (tanpa PLN), Hybrid (dengan baterai cadangan).
- Nilai jual: hemat tagihan s/d puluhan persen, balik modal jangka menengah, tahan 25+ tahun, bergaransi, ramah lingkungan.
- Harga ditentukan kapasitas (kWp), jenis sistem, tagihan listrik bulanan, lokasi & kondisi atap.

KATALOG & HARGA RESMI: ada di bagian KATALOG pada pesan (satu-satunya sumber angka harga/spek).
ATURAN HARGA: sebut harga/spek HANYA dari katalog. Jangan mengarang angka. Jangan beri diskon/promo/cicilan yang tidak tertulis di instruksi admin. Bila butuh hitungan khusus, gali kebutuhan atau tawarkan survei untuk hitungan akurat.

ALUR (baca posisi percakapan, pilih yang sesuai):
1. Awal: sapa singkat, beri 1 nilai/manfaat relevan, tanya 1 hal untuk menggali kebutuhan (tujuan pasang, tagihan listrik/bulan, rumah/usaha, kota).
2. Diskusi: gali lebih dalam (1 pertanyaan per balasan), beri rekomendasi & edukasi singkat. Bila customer minta harga, beri dari katalog yang paling sesuai.
3. Survei: bila kebutuhan sudah jelas & customer tertarik, tawarkan survei lokasi gratis. Kumpulkan: nama, alamat lengkap (minimal kota/kecamatan), dan hari/jam yang diinginkan. Setelah lengkap, sampaikan bahwa tim akan mengonfirmasi jadwalnya.

ARTI TAG CHAT (lihat TAG CHAT pada pesan):
- "Prospek": penawaran sudah dikirim -> tindak lanjuti keputusan & keberatan customer.
- "Fail": customer tidak lanjut -> balas sopan & ringan, jangan memaksa.

DI LUAR KEMAMPUAN (komplain, garansi/servis unit terpasang, minta ditelepon, permintaan khusus yang tidak bisa kamu jawab): balas sopan bahwa kamu cek/teruskan dulu ke tim, dan isi "notify_admin" dengan ringkasannya.
Bila customer bertanya apakah kamu bot/AI: jangan berbohong — jawab santai bahwa kamu dibantu sistem tim ${company}, lalu lanjutkan membantu.
Media yang tidak bisa kamu lihat (gambar/dokumen/pesan suara): minta customer menjelaskan singkat lewat teks.

SAPAAN CUSTOMER (lihat DATA CUSTOMER pada pesan; nama WhatsApp belum tentu nama asli, jangan dipakai menebak):
- Pakai "pak"/"bu" + nama (mis. "pak budi", "bu sari") bila panggilan sudah diketahui. Sebelum tahu, pakai "bapak/ibu" atau tanpa sapaan. JANGAN PERNAH memakai "kak", "kakak", atau "Anda".
- Bila panggilan belum diketahui, tanyakan nama secara natural di awal percakapan (balasan pertama atau kedua), mis. "maaf dengan bapak/ibu siapa ya?", sambil tetap menjawab pertanyaannya. Cukup sekali, jangan diulang bila tidak dijawab. Tentukan pak/bu dari jawaban customer (nama, cara menyebut diri, konteks); bila ragu tetap "bapak/ibu".

GAYA: ${tone}. Pakai "kami" untuk tim. Jangan sebut dirimu AI/asisten virtual.${lowercase ? ' Tulis SEMUA dengan huruf kecil (termasuk awal kalimat & nama), seperti orang chat santai.' : ''}
TULIS SEPERTI MANUSIA NGETIK WA (penting, customer tidak boleh merasa ini bot):
- Pecah jadi 1-3 bubble pendek seperti orang chat beruntun (mis. jawaban di bubble 1, pertanyaan di bubble 2). Sering cukup 1 bubble. Tiap bubble 1-2 kalimat.
- Jangan selalu diakhiri pertanyaan; kadang cukup menjawab/menanggapi.
- Jangan pakai tanda "—" atau ";" atau bullet/list/bold. Tanda seru maksimal satu. Emoji 0-1 per balasan, tidak di setiap balasan.
- Jangan buka dengan "Tentu", "Baik", "Halo!" berulang, "Terima kasih atas pertanyaannya", "Dengan senang hati". Jangan tutup dengan "Semoga membantu", "Jangan ragu untuk…", "Ada lagi yang bisa dibantu?".
- Jangan mengulang/merangkum ucapan customer. Variasikan kata, jangan berpola sama di tiap balasan. Boleh huruf kecil di awal & singkatan wajar.
- Pesan penutup/basa-basi dari customer ("ok", "sip", "makasih", "siap", jempol, stiker) setelah obrolan selesai: balas sangat singkat (mis. "sama2 pak 🙏") atau tidak usah dibalas (skip=true).

CONTOH GAYA SALES ASLI KAMI (${ctx.learnSourceNote}) — tiru rasa bahasanya, jangan salin mentah:
${ctx.salesStyleRef || '(belum ada contoh)'}
${instructions ? `\nINSTRUKSI TAMBAHAN DARI ADMIN (wajib dipatuhi):\n${instructions}\n` : ''}
Bagian INGATAN, SKILL/PLAYBOOK, dan PELAJARAN pada pesan (bila ada) wajib diikuti.
KELUARAN: JSON saja, tanpa teks lain:
{"messages": ["bubble 1", "bubble 2 (opsional)"],
 "skip": false (true HANYA bila pesan customer tidak perlu dibalas, messages kosong),
 "prospek": true/false  (true bila balasan ini/sebelumnya sudah memberi penawaran harga/paket, atau customer jelas tertarik membeli),
 "survey": {"ready": true/false (true HANYA bila customer setuju survei & sudah memberi alamat + usulan waktu), "nama": "", "alamat": "", "jadwal": "", "catatan": ""},
 "notify_admin": "" (isi ringkasan singkat bila ada hal yang perlu ditangani admin, selain itu kosong),
 "panggilan": "" (isi "pak <nama>"/"bu <nama>" bila customer sudah menyebut namanya di percakapan, selain itu kosong),
 "followup_outcome": "", "objection_category": "" (isi HANYA bila ada CATATAN FOLLOW-UP pada pesan: "considering" masih pertimbangan, "objection" ada keberatan + kategori harga|spek|kebutuhan|timing|approval|kompetitor, "later" minta dihubungi nanti, "interested" tertarik lanjut/survei, "lost" tidak jadi)}`;
}

// Data per chat (dikirim setelah prompt tetap).
export function buildChatContext({ ctx, knowledge = '', fuTask = null, waName = '', salutation = null }) {
  return [
    `KATALOG:\n${ctx.productRef || '(katalog belum diisi)'}`,
    `TAG CHAT: ${ctx.convTagsText}`,
    `DATA CUSTOMER: nama di WhatsApp: ${waName || '-'} · panggilan tersimpan: ${salutation || '(belum diketahui)'}`,
    knowledge || '',
    fuTask ? `CATATAN FOLLOW-UP: pesan terakhir kita sebelum customer membalas adalah follow-up tahap ${fuTask.label} (${fuTask.goal}). Isi "followup_outcome".` : '',
  ].filter(Boolean).join('\n\n');
}

async function generateReply({ conversationId, contactId, waName = '', msgs, cfg, persona, fuTask = null, task = '' }) {
  const salutation = await getSalutation(contactId).catch(() => null);
  // Skill & produk relevan dipilih dari pesan customer terbaru
  const chatText = msgs.filter((m) => !m.from_me).slice(-4).map((m) => m.body || '').join('\n');
  const ctx = await buildSalesContext(conversationId, { chatText: `${chatText}\n${task}` });
  let knowledge = { text: '', used: null };
  try { knowledge = await buildKnowledge({ contactId, chatText: task ? `${chatText}\n${task}` : chatText }); } catch (e) { console.warn('[AISales] pengetahuan gagal dimuat:', e?.message || e); }
  if (knowledge.used?.skills?.length) console.log(`[AISales] conv=${conversationId} skill: ${knowledge.used.skills.map((s) => s.title).join(', ')}`);
  const result = await generate(task ? 'ai_followup' : 'ai_sales_reply', {
    system: buildSystemPrompt({ persona, style: cfg.style, instructions: cfg.instructions, ctx, lowercase: cfg.lowercase, company: cfg.company }),
    prompt: `${buildChatContext({ ctx, knowledge: knowledge.text, fuTask, waName, salutation })}\n\nRIWAYAT CHAT (15 pesan terakhir, terbaru di bawah; konteks lebih lama ada di INGATAN):\n${historyText(msgs.slice(-HISTORY_LIMIT), persona)}\n\n${task || 'Balas pesan customer yang terakhir.'}`,
    json: true,
    maxTokens: 600,
    temperature: 0.8,
  });
  const plan = parsePlan(result.text, { salutation, lowercase: cfg.lowercase });
  // Customer baru menyebut namanya -> simpan panggilannya untuk chat berikutnya
  if (plan?.panggilan && plan.panggilan !== salutation) {
    saveSalutation(contactId, plan.panggilan).catch(() => {});
  }
  return plan;
}

// Saringan ciri khas tulisan AI sebelum dikirim.
// opts.salutation: panggilan customer (mis. "pak budi"); opts.lowercase: huruf kecil semua.
export function humanizeText(text, { salutation = null, lowercase = false } = {}) {
  let t = String(text || '').trim();
  const short = salutation ? salutation.split(' ')[0] : '';
  t = t.replace(/^["'“”]+|["'“”]+$/g, '');                       // kutip pembungkus
  t = t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^\s*[-•*]\s+/gm, '').replace(/^#+\s*/gm, ''); // markdown
  t = t.replace(/\s*[—–]\s*/g, ', ');                               // em/en dash
  t = t.replace(/\s*;\s*/g, ', ');
  t = t.replace(/^(tentu( saja)?|baik(lah)?|dengan senang hati)(,? (ya )?(kak|kakak|pak|bu|bapak|ibu)( \w+)?)?\s*[,!.]\s*/i, '');
  t = t.replace(/\b(anda)\b/gi, short === 'pak' ? 'bapak' : short === 'bu' ? 'ibu' : 'bapak/ibu');
  // Tidak memakai "kak": ganti dengan pak/bu bila diketahui, selain itu dihapus
  t = t.replace(/\b(kakak|kak|kk)\b/gi, short);
  t = t.replace(/(^|[.!?]\s+)(semoga (informasi(nya)? ini )?membantu|jangan ragu (untuk|buat) [^.!?]*|ada lagi yang bisa (saya|kami|aku) bantu[^.!?]*|terima kasih atas pertanyaan(nya)?[^.!?]*)[.!?]?/gi, '$1');
  t = t.replace(/!{2,}/g, '!');
  let ex = 0;
  t = t.replace(/!/g, () => (++ex > 1 ? '.' : '!'));             // tanda seru maks 1
  t = t.replace(/\s*,\s*([.!?])/g, '$1').replace(/,\s*,/g, ',').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  t = t.replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').replace(/^[,.\s]+/, '').trim();
  if (lowercase) t = t.toLowerCase();
  return t;
}

export function parsePlan(text, { salutation = null, lowercase = false } = {}) {
  let raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  let obj;
  try { obj = JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    try { obj = m ? JSON.parse(m[0]) : null; } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  let list = Array.isArray(obj.messages) ? obj.messages : (typeof obj.reply === 'string' ? [obj.reply] : []);
  const panggilan = normalizeSalutation(obj.panggilan);
  const opts = { salutation: panggilan || salutation, lowercase };
  const messages = list.map((m) => humanizeText(String(m || '').slice(0, 1000), opts)).filter(Boolean).slice(0, 3);
  const skip = !!obj.skip && !messages.length;
  if (!messages.length && !skip) return null;
  const s = obj.survey || {};
  const fo = String(obj.followup_outcome || '').trim();
  return {
    messages,
    reply: messages.join('\n'),
    skip,
    prospek: !!obj.prospek,
    survey: s.ready ? {
      nama: String(s.nama || '').slice(0, 120), alamat: String(s.alamat || '').slice(0, 300),
      jadwal: String(s.jadwal || '').slice(0, 120), catatan: String(s.catatan || '').slice(0, 300),
    } : null,
    notify_admin: String(obj.notify_admin || '').trim().slice(0, 500),
    panggilan,
    followup_outcome: ['considering', 'objection', 'later', 'interested', 'lost'].includes(fo) ? fo : null,
    objection_category: String(obj.objection_category || '').trim() || null,
  };
}

// ── Kirim & aksi ──────────────────────────────────────────────────────────
// Kirim beberapa bubble seperti manusia: baca dulu (centang biru), jeda membaca,
// "sedang mengetik" sesuai panjang tiap bubble, jeda antar bubble.
async function sendAiBubbles(conversationId, jid, messages, { readIds = [], readLen = 0 } = {}) {
  const sock = getSock();
  if (!sock) throw new Error('WhatsApp belum tersambung');
  if (readIds.length) {
    try { await sock.readMessages?.(readIds.map((id) => ({ remoteJid: jid, id, fromMe: false }))); } catch { /* opsional */ }
    await sleep(Math.min(6000, rand(1200, 2500) + readLen * 25));
  }
  try { await sock.presenceSubscribe?.(jid); } catch { /* opsional */ }
  for (let i = 0; i < messages.length; i++) {
    const text = messages[i];
    try {
      await sock.sendPresenceUpdate?.('composing', jid);
      await sleep(Math.min(9000, (900 + text.length * 45) * rand(0.8, 1.25)));
      await sock.sendPresenceUpdate?.('paused', jid);
    } catch { /* opsional */ }
    await sendAiText(conversationId, jid, text);
    if (i < messages.length - 1) await sleep(rand(500, 1400));
  }
}

async function sendAiText(conversationId, jid, text) {
  const sock = getSock();
  if (!sock) throw new Error('WhatsApp belum tersambung');

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

// ── Follow-up otomatis oleh AI ────────────────────────────────────────────
// Tugas follow-up jatuh tempo pada chat milik AI dikirim AI sendiri (jam kerja),
// lalu ditandai selesai dengan hasil sementara "Tidak dibalas". Bila customer
// kemudian membalas, AI menilai hasilnya (pertimbangan/keberatan/tertarik/...).
const AI_FU_NOTE = '[AI] Follow-up dikirim otomatis';
const fuProcessing = new Set();

// Jam kirim follow-up: mengikuti Jam Kerja bila aktif, selain itu 08.00–20.00 WIB.
async function withinSendHours(nowMs = Date.now()) {
  const wh = await getWorkHours().catch(() => null);
  const wib = new Date(nowMs + 7 * 3600 * 1000);
  const mins = wib.getUTCHours() * 60 + wib.getUTCMinutes();
  if (!wh) return mins >= 8 * 60 && mins < 20 * 60;
  if (wh.days && !wh.days.includes(wib.getUTCDay())) return false;
  return mins >= wh.start && mins < wh.end - 15;
}

// Follow-up AI terakhir (<= 7 hari) yang dibalas customer setelahnya & belum dinilai.
async function pendingAiFollowupOutcome(conversationId, agentId, customerTs) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data, error } = await supabase.from('followup_tasks')
    .select('id, step, done_at').eq('conversation_id', conversationId).eq('status', 'done')
    .eq('outcome', 'no_reply').eq('note', AI_FU_NOTE).gte('done_at', since)
    .order('done_at', { ascending: false }).limit(1);
  const t = !error && data?.[0];
  if (!t || new Date(customerTs) <= new Date(t.done_at)) return null;
  const meta = STEP_META[t.step] || {};
  return { id: t.id, label: meta.label || t.step, goal: meta.goal || '' };
}

async function processFollowupTask(task, cfg, persona) {
  if (fuProcessing.has(task.id)) return false;
  fuProcessing.add(task.id);
  try {
    const conv = task.conversation;
    if (!conv || String(conv.assigned_to) !== String(cfg.agent_id) || (conv.wa_jid || '').endsWith('@g.us')) return false;
    const msgs = await fetchRecentMessages(task.conversation_id);
    const last = msgs[msgs.length - 1];
    // Customer sedang menunggu balasan / baru saja chat -> biar alur balasan biasa yang menangani
    if (last && !last.from_me) return false;
    if (last && Date.now() - new Date(last.timestamp).getTime() < 2 * 3600 * 1000) return false;
    const { data: tagRows } = await supabase.from('conversation_tags').select('tags (name)').eq('conversation_id', task.conversation_id);
    if ((tagRows || []).some((r) => /\bdeal\b|non[\s_-]*client/i.test(r.tags?.name || ''))) return false;

    const meta = STEP_META[task.step] || {};
    const fuCfg = await getFollowupConfig().catch(() => ({ templates: {} }));
    const sal = await getSalutation(conv.contact?.id).catch(() => null);
    const tpl = String(fuCfg.templates?.[task.step] || '')
      .replace(/\bkak(ak)?\s*\{\{\s*nama\s*\}\}/gi, sal || 'bapak/ibu').replace(/\{\{\s*nama\s*\}\}/gi, sal || 'bapak/ibu');
    const instruction = `TUGAS SEKARANG: customer belum membalas sejak pesan terakhir. Kirim pesan FOLLOW-UP tahap ${meta.label || task.step}: ${meta.goal || 'sapa & tindak lanjuti diskusi terakhir'}.
Rujuk diskusi terakhir secara personal (produk/kebutuhan yang dibahas), singkat, tidak memaksa, jangan menyebut kata "follow up". Jangan mengulang salam pembuka panjang.
${tpl ? `Acuan isi dari tim (sesuaikan dengan konteks, jangan disalin mentah): ${tpl}` : ''}
Pada keluaran ini "skip" harus false dan "prospek"/"survey" false.`;
    const plan = await generateReply({ conversationId: task.conversation_id, contactId: conv.contact?.id, waName: conv.contact?.name, msgs, cfg, persona, task: instruction });
    if (!plan?.messages?.length) return false;

    const jid = conv.wa_jid || (conv.contact?.phone ? `${String(conv.contact.phone).split('@')[0]}@s.whatsapp.net` : null);
    if (!jid) return false;
    await sendAiBubbles(task.conversation_id, jid, plan.messages);
    await completeTask(task.id, { outcome: 'no_reply', note: AI_FU_NOTE }, cfg.agent_id);
    console.log(`[AISales] follow-up ${meta.label || task.step} dikirim conv=${task.conversation_id}`);
    return true;
  } catch (e) {
    console.warn(`[AISales] follow-up task=${task.id} gagal:`, e?.message || e);
    return false;
  } finally {
    fuProcessing.delete(task.id);
  }
}

export async function runAiFollowups({ maxPerRun = 5 } = {}) {
  const cfg = await getAiSalesConfig();
  if (!cfg.enabled || !cfg.followup_enabled || !cfg.agent_id || !aiEnabled()) return 0;
  if (!(await withinSendHours())) return 0;
  const { data: tasks, error } = await supabase.from('followup_tasks')
    .select('id, conversation_id, step, due_at, conversation:conversations (assigned_to, wa_jid, contact:contacts (id, name, phone))')
    .eq('status', 'pending').lte('due_at', new Date().toISOString())
    .order('due_at', { ascending: true }).limit(100);
  if (error) return 0;
  const mine = (tasks || []).filter((t) => String(t.conversation?.assigned_to) === String(cfg.agent_id));
  if (!mine.length) return 0;
  const { data: agent } = await supabase.from('agents').select('name').eq('id', cfg.agent_id).maybeSingle();
  const persona = cfg.persona_name || agent?.name || 'Sales';
  let sent = 0;
  for (const t of mine) {
    if (sent >= maxPerRun) break;
    if (await processFollowupTask(t, cfg, persona)) {
      sent++;
      await sleep(rand(20000, 60000)); // jangan kirim beruntun ke banyak orang sekaligus
    }
  }
  return sent;
}

// ── Penyapu berkala: chat AI yang masih menunggu balasan (mis. baru di-assign
// manual ke AI, server restart, atau pesan yang terlewat). ────────────────
async function sweep() {
  const cfg = await getAiSalesConfig();
  if (!cfg.enabled || !cfg.agent_id || !aiEnabled()) return;
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
  // Memori customer (chat AI yang sepi) & follow-up otomatis AI, tiap 5 menit
  setInterval(async () => {
    const cfg = await getAiSalesConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.agent_id) return;
    await refreshMemories(cfg.agent_id).catch(() => {});
    if (cfg.followup_enabled) await runAiFollowups().catch((e) => console.warn('[AISales] follow-up job gagal:', e?.message || e));
  }, 5 * 60 * 1000);
  console.log('[AISales] job aktif');
}
