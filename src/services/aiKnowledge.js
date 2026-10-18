// Pengetahuan AI Sales yang terus bertambah:
//  - Skill / Playbook (.md): dokumen pengetahuan buatan admin. Yang relevan
//    dengan isi chat dipilih otomatis (kata kunci + judul + "kapan dipakai").
//  - Pelajaran (koreksi admin): balasan AI yang dikoreksi -> contoh "jangan / sebaiknya".
//  - Memori customer: ringkasan fakta tiap customer, diperbarui otomatis setelah
//    percakapan dengan AI berhenti sejenak, dipakai saat customer kembali.
// Tabel (SQL migrasi): ai_skills, ai_lessons, ai_customer_memory. Bila belum ada,
// AI tetap jalan tanpa pengetahuan tambahan.
import { supabase } from '../db/supabase.js';
import { generate, aiEnabled } from './llm.js';

const MAX_SKILLS = 3;
const MAX_SKILL_CHARS = 10000;  // total isi skill per balasan (hemat token)
const MAX_LESSONS = 5;

// ── Pencocokan teks sederhana (Bahasa Indonesia) ──────────────────────────
const STOP = new Set(('yang dan di ke dari ini itu untuk dengan ada tidak saya kami kita kak kakak bisa mau apa ' +
  'ya ga gak nggak juga sudah udah aja saja atau jadi kalau kalo karena pada dalam akan masih lagi dong deh sih nih ' +
  'oke ok iya halo hai min admin terima kasih makasih tolong mohon bagaimana gimana berapa kapan dimana mana boleh ' +
  'buat yg utk dgn tp tapi juga lebih sangat sama the and').split(' '));

export function tokens(text) {
  const out = new Set();
  for (let w of String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w);
    // bentuk dasar sederhana: hargaNYA -> harga, garansiNYA, tagihanKU
    for (const suf of ['nya', 'kah', 'lah', 'ku', 'mu']) {
      if (w.endsWith(suf) && w.length - suf.length >= 4) out.add(w.slice(0, -suf.length));
    }
  }
  return out;
}

function overlap(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

// Skor relevansi skill terhadap teks chat. Kata kunci (frasa) paling kuat.
export function scoreSkill(skill, text, textTokens) {
  const lower = String(text || '').toLowerCase();
  const hits = [];
  let score = 0;
  for (const kw of String(skill.keywords || '').split(/[,\n]/).map((k) => k.trim().toLowerCase()).filter(Boolean)) {
    const kt = tokens(kw);
    const matched = kw.length >= 3 && (lower.includes(kw) || (kt.size && [...kt].every((t) => textTokens.has(t))));
    if (matched) { score += 3; hits.push(kw); }
  }
  const titleHits = overlap(tokens(skill.title), textTokens);
  const whenHits = overlap(tokens(skill.when_to_use), textTokens);
  score += titleHits * 1.5 + whenHits;
  return { score, hits };
}

// ── Cache tabel ───────────────────────────────────────────────────────────
const cache = { skills: null, lessons: null, at: 0 };
export function invalidateKnowledgeCache() { cache.at = 0; }

async function loadAll() {
  if (cache.skills && Date.now() - cache.at < 30000) return cache;
  const [s, l] = await Promise.all([
    supabase.from('ai_skills').select('id, title, when_to_use, keywords, content, always').eq('active', true),
    supabase.from('ai_lessons').select('id, customer_message, ai_reply, better_reply, note, created_at').eq('active', true)
      .order('created_at', { ascending: false }).limit(200),
  ]);
  cache.skills = s.error ? [] : (s.data || []);
  cache.lessons = l.error ? [] : (l.data || []);
  cache.at = Date.now();
  return cache;
}

// Skill yang dipakai untuk teks chat ini: semua skill "selalu dipakai" + maks 3
// skill paling relevan (skor >= 2).
export function pickSkills(skills, text) {
  const tt = tokens(text);
  const always = skills.filter((s) => s.always);
  const ranked = skills.filter((s) => !s.always)
    .map((s) => ({ s, ...scoreSkill(s, text, tt) }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SKILLS);
  const chosen = [...always.map((s) => ({ s, score: null, hits: [] })), ...ranked];
  let used = 0;
  return chosen.filter((x) => {
    const len = (x.s.content || '').length;
    if (used && used + len > MAX_SKILL_CHARS) return false;
    used += len;
    return true;
  });
}

export function pickLessons(lessons, text) {
  const tt = tokens(text);
  const scored = lessons.map((l, i) => ({ l, i, score: overlap(tokens(`${l.customer_message} ${l.note}`), tt) }));
  const relevant = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = relevant.slice(0, MAX_LESSONS);
  // sisa slot: pelajaran terbaru (aturan umum tetap berlaku)
  for (const x of scored) {
    if (picked.length >= MAX_LESSONS) break;
    if (!picked.includes(x)) picked.push(x);
  }
  return picked.map((x) => x.l);
}

const clip = (s, n) => { s = String(s || '').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };

// Bagian prompt pengetahuan untuk satu chat. `chatText` = pesan customer terbaru.
export async function buildKnowledge({ contactId, chatText }) {
  const { skills, lessons } = await loadAll();
  const chosen = pickSkills(skills, chatText);
  const lessonList = pickLessons(lessons, chatText);
  const memory = contactId ? await getMemory(contactId) : null;

  const parts = [];
  if (memory?.summary) {
    parts.push(`INGATAN TENTANG CUSTOMER INI (dari percakapan sebelumnya; pakai, jangan tanya ulang yang sudah diketahui):\n${memory.summary}`);
  }
  if (chosen.length) {
    parts.push(`SKILL / PLAYBOOK TIM (pedoman resmi — ikuti bila relevan dengan pesan customer):\n${
      chosen.map((x) => `### ${x.s.title}\n${x.s.content}`).join('\n\n')}`);
  }
  if (lessonList.length) {
    parts.push(`PELAJARAN DARI KOREKSI ADMIN (sangat penting — jangan ulangi kesalahan yang sama):\n${
      lessonList.map((l, i) => `${i + 1}. Situasi: customer bilang "${clip(l.customer_message, 160)}"\n   Jangan seperti: "${clip(l.ai_reply, 200)}"\n   Sebaiknya: "${clip(l.better_reply, 300)}"${l.note ? `\n   Alasan/aturan: ${clip(l.note, 200)}` : ''}`).join('\n')}`);
  }
  return {
    text: parts.join('\n\n'),
    used: { skills: chosen.map((x) => ({ id: x.s.id, title: x.s.title, hits: x.hits })), lessons: lessonList.length, memory: !!memory?.summary },
  };
}

// ── Memori customer ───────────────────────────────────────────────────────
export async function getMemory(contactId) {
  const { data, error } = await supabase.from('ai_customer_memory')
    .select('contact_id, summary, updated_at, last_message_at').eq('contact_id', contactId).maybeSingle();
  return error ? null : data;
}

export async function saveMemory(contactId, summary, lastMessageAt = null) {
  const row = { contact_id: contactId, summary: clip(summary, 2000), updated_at: new Date().toISOString() };
  if (lastMessageAt) row.last_message_at = lastMessageAt;
  const { error } = await supabase.from('ai_customer_memory').upsert(row, { onConflict: 'contact_id' });
  if (error) throw error;
}

// Panggilan customer (mis. "pak budi" / "bu sari") disimpan sebagai baris
// "- Panggilan: ..." di memori customer.
const SAL_RE = /^\s*-?\s*panggilan\s*:\s*(.+)$/im;
export function normalizeSalutation(v) {
  let s = String(v || '').toLowerCase().replace(/[^a-z\s.'-]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^bapak\b/, 'pak').replace(/^ibu\b/, 'bu');
  if (!/^(pak|bu)(\s|$)/.test(s)) return null;
  return s.split(' ').slice(0, 3).join(' ').slice(0, 30);
}
export async function getSalutation(contactId) {
  if (!contactId) return null;
  const mem = await getMemory(contactId).catch(() => null);
  const m = mem?.summary?.match(SAL_RE);
  return m ? normalizeSalutation(m[1]) : null;
}
export async function saveSalutation(contactId, salutation) {
  const sal = normalizeSalutation(salutation);
  if (!contactId || !sal) return;
  const mem = await getMemory(contactId).catch(() => null);
  const rest = String(mem?.summary || '').split('\n').filter((l) => l.trim() && !SAL_RE.test(l));
  await saveMemory(contactId, [`- Panggilan: ${sal}`, ...rest].join('\n'));
}

const IDLE_MS = 30 * 60 * 1000; // ringkas setelah chat sepi 30 menit
const MIN_NEW_MESSAGES = 4;     // dan minimal 4 pesan baru sejak ringkasan terakhir

async function summarize(previous, transcript) {
  const result = await generate('memory_summary', {
    prompt: `Ringkasan sebelumnya:\n${previous || '(belum ada)'}\n\nPercakapan baru:\n${transcript}`,
    system: 'Kamu mencatat fakta penting tentang seorang calon customer PLTS untuk tim sales. Gabungkan ringkasan sebelumnya dengan percakapan baru menjadi catatan ringkas berbentuk poin (maks 8 poin, tiap poin singkat). Baris pertama WAJIB "- Panggilan: pak/bu <nama>" bila sudah diketahui (pertahankan dari ringkasan sebelumnya). Fokus: nama, lokasi, jenis bangunan, tagihan listrik/kebutuhan daya, tujuan, produk/paket yang dibahas & harga yang sudah disebut, keberatan, status (tertarik/ragu/survei diminta/tidak lanjut), janji atau hal yang harus ditindaklanjuti. Jangan mengarang. Tulis dalam Bahasa Indonesia, tanpa pembuka/penutup.',
    maxTokens: 500,
    temperature: 0.2,
  });
  return String(result.text || '').trim();
}

// Perbarui memori untuk chat yang dipegang AI & sudah sepi >= 30 menit sejak
// pesan terakhir yang belum diringkas.
export async function refreshMemories(agentId, { limit = 8 } = {}) {
  if (!agentId || !aiEnabled()) return 0;
  const probe = await supabase.from('ai_customer_memory').select('contact_id').limit(1);
  if (probe.error) return 0; // tabel belum dimigrasi
  const cutoff = new Date(Date.now() - IDLE_MS).toISOString();
  const { data: convs, error } = await supabase.from('conversations')
    .select('id, contact_id, last_message_at').eq('assigned_to', agentId)
    .lt('last_message_at', cutoff).order('last_message_at', { ascending: false }).limit(50);
  if (error) return 0;
  let done = 0;
  for (const c of convs || []) {
    if (done >= limit || !c.contact_id || !c.last_message_at) continue;
    const mem = await getMemory(c.contact_id);
    if (mem?.last_message_at && new Date(mem.last_message_at) >= new Date(c.last_message_at)) continue;
    let q = supabase.from('messages').select('body, from_me, timestamp').eq('conversation_id', c.id)
      .not('body', 'is', null).order('timestamp', { ascending: true }).limit(60);
    if (mem?.last_message_at) q = q.gt('timestamp', mem.last_message_at);
    const { data: msgs } = await q;
    if (!msgs?.length) { await saveMemory(c.contact_id, mem?.summary || '', c.last_message_at); continue; }
    if (msgs.length < MIN_NEW_MESSAGES) continue; // belum cukup bahan; tunggu pesan berikutnya
    const transcript = msgs.map((m) => `${m.from_me ? 'Sales' : 'Customer'}: ${m.body}`).join('\n');
    try {
      const summary = await summarize(mem?.summary, transcript);
      if (summary) await saveMemory(c.contact_id, summary, c.last_message_at);
      done++;
    } catch (e) {
      console.warn(`[AIMemory] contact=${c.contact_id} gagal:`, e?.message || e);
      break; // kemungkinan kuota -> coba lagi di putaran berikutnya
    }
  }
  if (done) console.log(`[AIMemory] ${done} memori customer diperbarui`);
  return done;
}

// Saran kata kunci untuk skill (dipakai saat admin menyimpan skill tanpa kata kunci).
export async function suggestKeywords({ title, when_to_use, content }) {
  if (!aiEnabled()) return '';
  const result = await generate('skill_keywords', {
    prompt: `Judul: ${title}\nKapan dipakai: ${when_to_use || '-'}\nIsi:\n${clip(content, 4000)}`,
    system: 'Buat daftar 8-15 kata kunci/frasa pendek (Bahasa Indonesia sehari-hari, termasuk sinonim & singkatan yang biasa dipakai customer di WhatsApp) yang menandakan pesan customer membutuhkan pedoman ini. Balas HANYA daftar dipisah koma, huruf kecil.',
    maxTokens: 200,
    temperature: 0.3,
  });
  return String(result.text || '').replace(/\n/g, ', ').replace(/\s*,\s*/g, ', ').replace(/^[,\s]+|[,\s]+$/g, '').slice(0, 600);
}
