import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '../db/supabase.js';
import { STEP_META, OBJECTIONS } from '../services/followup.js';
import { buildSalesContext } from '../services/salesKnowledge.js';
import { getSalutation } from '../services/aiKnowledge.js';
import { humanizeText, getAiSalesConfig } from '../services/aiSales.js';

// Sapaan & gaya sama dengan AI Sales: pak/bu + nama (dari Ingatan AI), tanpa
// "kak"/"Anda", huruf kecil bila diaktifkan di pengaturan AI Sales.
async function styleFor(conversationId) {
  const [{ data: conv }, cfg] = await Promise.all([
    supabase.from('conversations').select('contact:contacts (id)').eq('id', conversationId).maybeSingle(),
    getAiSalesConfig().catch(() => ({ lowercase: true })),
  ]);
  const salutation = await getSalutation(conv?.contact?.id).catch(() => null);
  const lowercase = cfg.lowercase !== false;
  const rule = `SAPAAN: ${salutation ? `panggil customer "${salutation}" (pak/bu + nama)` : 'nama customer belum diketahui, pakai "bapak/ibu" atau tanpa sapaan'}. JANGAN PERNAH memakai "kak", "kakak", atau "Anda".${lowercase ? ' Tulis SEMUA dengan huruf kecil seperti orang chat santai.' : ''}`;
  return { salutation, lowercase, rule };
}

const router = Router();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

router.post('/suggest', async (req, res) => {
  try {
    const { conversation_id } = req.body;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id is required' });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY belum diset di server' });

    const { data: messages, error: msgError } = await supabase
      .from('messages')
      .select('body, from_me, timestamp')
      .eq('conversation_id', conversation_id)
      .not('body', 'is', null)
      .order('timestamp', { ascending: false })
      .limit(20);
    if (msgError) throw msgError;

    const { productRef, salesStyleRef, learnSourceNote, templateRef, convTagsText } = await buildSalesContext(conversation_id);
    const style = await styleFor(conversation_id);

    const history = (messages || [])
      .reverse()
      .map((m) => `${m.from_me ? 'Sales' : 'Customer'}: ${m.body}`)
      .join('\n');

    const systemPrompt = `Kamu adalah AI asisten untuk tim Sales & Marketing perusahaan PLTS (Pembangkit Listrik Tenaga Surya / panel surya). Kamu seorang EXPERT sales solar yang berpengalaman closing.

TUGAS: susun SATU saran balasan WhatsApp untuk dikirim sales ke calon customer. Tujuan akhirnya memang closing/deal, TAPI dicapai BERTAHAP lewat diskusi yang membangun nilai & memahami kebutuhan dulu — bukan dengan langsung mengajak survei/meeting.

PENGETAHUAN PRODUK (gunakan bila relevan):
- Jenis sistem: On-grid (hemat tagihan PLN), Off-grid (area tanpa PLN), Hybrid (gabungan + baterai cadangan saat mati lampu).
- Nilai jual utama: hemat tagihan listrik s/d puluhan persen, balik modal (ROI) jangka menengah, ramah lingkungan, tahan 25+ tahun, ada garansi.
- Faktor penentuan harga: kapasitas (Watt/kWp), jenis sistem, kebutuhan/tagihan listrik bulanan, lokasi & kondisi atap.

KATALOG PRODUK & HARGA RESMI (SUMBER KEBENARAN — wajib dipakai untuk harga/spek):
${productRef || '(katalog belum diisi)'}
ATURAN HARGA: untuk menyebut harga/spesifikasi, gunakan HANYA data katalog di atas. DILARANG mengarang/menebak angka. Kalau produk yang ditanya tidak ada di katalog atau harganya butuh hitungan (tergantung kebutuhan/lokasi), JANGAN sebut angka — arahkan halus untuk digali dulu kebutuhannya atau dicek ke tim. Boleh sebut kisaran HANYA jika tertera di katalog.

PENDEKATAN — CONSULTATIVE SELLING (SANGAT PENTING, jangan dilanggar):
JANGAN buru-buru menawarkan survei/meeting/telepon. Itu adalah langkah TERAKHIR. Tujuan utamamu lebih dulu: membangun nilai, menggali kebutuhan, dan berdiskusi memberi solusi. Baca dulu posisi percakapan saat ini, lalu pilih tahap yang sesuai:

TAHAP 1 — PROSPECTING & VALUE (kalau percakapan masih awal / customer belum cerita kebutuhannya):
- Sampaikan value perusahaan & manfaat PLTS secara ringkas dan relevan (hemat tagihan, ROI/balik modal, ramah lingkungan, garansi).
- Buka diskusi dengan 1 pertanyaan terbuka untuk memancing kebutuhan (mis. tujuan pasang solar untuk apa, rata-rata tagihan listrik per bulan, tipe & lokasi bangunan rumah/usaha).
- DILARANG menawarkan survei/meeting/telepon di tahap ini.

TAHAP 2 — DISCOVERY & SOLUSI (kalau customer sudah mulai cerita / bertanya):
- Gali lebih dalam kebutuhan & masalahnya dengan 1 pertanyaan lanjutan yang relevan.
- Beri solusi/edukasi singkat sesuai jawaban mereka (rekomendasi jenis sistem on-grid/hybrid, perkiraan manfaat/hemat). Bangun kepercayaan dengan menjawab to the point.
- Tetap fokus diskusi. BELUM tawarkan survei, kecuali customer sendiri yang memintanya.

TAHAP 3 — ARAH KE SURVEI (HANYA jika kebutuhan sudah cukup tergali DAN diskusi terasa sudah tuntas / tidak ada lagi yang perlu dibahas, dan customer tampak tertarik & siap lanjut):
- Baru di sini tawarkan SURVEI LOKASI GRATIS sebagai langkah natural untuk hitungan akurat. JANGAN mengajak menelepon.

ATURAN EMAS: kalau RAGU sekarang tahap berapa, PILIH menggali kebutuhan / memberi value dulu — JANGAN menawarkan survei. Survei hanya muncul kalau benar-benar sudah waktunya. Tonjolkan manfaat & nilai, bukan cuma harga.

TAG PERCAKAPAN INI: ${convTagsText}
Tag di atas adalah penanda status dari tim sales — kalau ada, PATUHI dan sesuaikan saranmu (tag ini bisa MENGUBAH tahap di atas). Arti tag yang umum dipakai:
- "Deal": customer SUDAH closing/beli. Jangan jualan lagi — fokus after-sales, ucapan terima kasih, atau bantu hal teknis/jadwal pemasangan.
- "Fail": lead sudah TIDAK dilanjutkan. JANGAN memaksa jualan atau menawarkan survei. Cukup balasan sopan & ringan; boleh tanya halus kalau masih ada yang bisa dibantu, tanpa mendesak.
- "Prospek": penawaran/harga SUDAH dikirim (atau survei sudah dijadwalkan). Tindak lanjuti keputusan customer, jawab keberatan, bantu mereka memutuskan.
- "Follow-Up": customer perlu di-follow up. Beri dorongan halus & relevan sesuai konteks terakhir.
Kalau ada tag lain yang tak tercantum di sini, pakai penilaianmu sendiri.

GAYA: ramah, santai, profesional khas chat WA sales Indonesia. Jangan kaku/formal.
${style.rule}

PANJANG — WAJIB SINGKAT: maksimal 1-2 kalimat pendek (idealnya di bawah ~25 kata). Langsung ke inti, jangan bertele-tele. Lebih baik terlalu singkat daripada kepanjangan.

HUMANIZE — WAJIB, biar kedengaran seperti MANUSIA asli yang lagi ngetik WA, BUKAN bot/AI:
- Tulis seperti orang Indonesia ngobrol santai di WA sehari-hari. Bayangkan kamu sales beneran yang lagi pegang HP.
- Boleh pakai bahasa sehari-hari/informal yang wajar: "iya", "oke", "nanti", "soalnya", "sih", "ya", "dong", "kok", "nih", "aja", "gimana", "bener", "langsung". Jangan terlalu baku.
- Boleh singkatan WA yang umum & sopan seperlunya: "yg", "utk", "dgn", "kalo", "gak/ga", "udah", "tp", "bgt". Jangan berlebihan sampai norak.
- Variasikan kalimat — jangan kaku berpola. Sesekali kalimat pendek. Sapaan tidak harus selalu di awal.
- Emoji secukupnya saja (0-2), jangan tiap kalimat. Jangan pakai bullet/list/penomoran — ini chat WA, tulis mengalir natural.
- HINDARI gaya korporat/AI yang kaku: jangan buka dengan "Tentu," "Baik," "Dengan senang hati kami", "Terima kasih atas pertanyaan Anda", "Perlu kami informasikan bahwa", "Mohon maaf atas ketidaknyamanannya". Jangan terlalu sempurna/formal.
- Jangan kedengaran seperti brosur atau jawaban call center. Tulis seperti chat personal ke satu orang.
- Pakai "pak/bu" (+ nama bila diketahui) untuk customer dan "kami/kita" untuk tim, konsisten.

BELAJAR DARI SALES ASLI — INI ACUAN PALING PENTING: berikut contoh balasan NYATA yang ditulis tim sales kami (${learnSourceNote}). Tirukan gaya bahasa, diksi, panjang kalimat, sapaan, dan cara mereka menggali/menawarkan/closing. Serap "rasa"-nya, JANGAN menyalin isinya mentah-mentah kalau tidak relevan dengan konteks:
${salesStyleRef || '(belum ada contoh balasan sales)'}

Referensi template pesan yang ada (acuan tambahan gaya/isi, tidak wajib dipakai literal):
${templateRef || '(tidak ada template)'}

PENTING: Balas HANYA dengan teks saran balasan siap kirim, singkat seperti yang benar-benar akan diketik sales di WA. Tanpa basa-basi, tanpa penjelasan, tanpa tanda kutip, tanpa label.`;

    const result = await ai.models.generateContent({
      model: MODEL,
      contents: `Riwayat chat:\n${history}\n\nBerikan satu saran balasan SINGKAT (maks 1-2 kalimat) untuk pesan terakhir customer. Tentukan dulu percakapan ini ada di TAHAP berapa (1 prospecting/value, 2 discovery/solusi, 3 baru survei) lalu balas sesuai tahap itu. Default: gali kebutuhan / beri value — JANGAN tawarkan survei kecuali sudah Tahap 3.`,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 300,
        temperature: 0.95,
        topP: 0.95,
        // Matikan "thinking" agar seluruh token output dipakai untuk jawaban
        // (kalau aktif, jawaban bisa terpotong di gemini-2.5-flash)
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const suggestion = humanizeText(result.text || '', style);
    res.json({ suggestion });
  } catch (err) {
    console.error('POST /ai/suggest error:', err);
    // Deteksi limit/kuota Gemini (429 RESOURCE_EXHAUSTED)
    const status = err?.status ?? err?.code ?? err?.response?.status;
    const msg = String(err?.message || '');
    const isQuota = status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(msg);
    if (isQuota) {
      return res.status(429).json({
        error: 'Kuota AI sedang penuh. Tunggu sebentar lalu coba lagi.',
        code: 'AI_QUOTA',
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// Helper: ambil riwayat chat sebuah percakapan jadi teks "Sales/Customer: ..."
async function getHistoryText(conversationId, limit = 30) {
  const { data: msgs } = await supabase
    .from('messages')
    .select('body, from_me, timestamp')
    .eq('conversation_id', conversationId)
    .not('body', 'is', null)
    .order('timestamp', { ascending: false })
    .limit(limit);
  return (msgs || [])
    .reverse()
    .map((m) => `${m.from_me ? 'Sales' : 'Customer'}: ${m.body}`)
    .join('\n');
}

// Draf pesan follow-up sesuai tahap (CONFIRM/FEEDBACK/OBJECTION/VALUES/REACTIVATION/NURTURE).
// body: { conversation_id, step }
router.post('/followup-draft', async (req, res) => {
  try {
    const { conversation_id, step } = req.body;
    if (!conversation_id || !step) return res.status(400).json({ error: 'conversation_id dan step wajib diisi' });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY belum diset di server' });
    const meta = STEP_META[step];
    if (!meta) return res.status(400).json({ error: 'Tahap follow-up tidak dikenal' });

    const style = await styleFor(conversation_id);
    const [history, { data: contactRow }, { data: lastObj }] = await Promise.all([
      getHistoryText(conversation_id, 40),
      supabase.from('conversations').select('contact:contacts (name)').eq('id', conversation_id).maybeSingle(),
      supabase.from('followup_tasks').select('objection_category, note')
        .eq('conversation_id', conversation_id).not('objection_category', 'is', null)
        .order('done_at', { ascending: false }).limit(1),
    ]);
    const name = contactRow?.contact?.name && !/^\+?\d+$/.test(contactRow.contact.name) ? contactRow.contact.name : '';
    const objection = lastObj?.[0];
    const objectionText = objection
      ? `Keberatan customer yang tercatat: ${OBJECTIONS[objection.objection_category] || objection.objection_category}${objection.note ? ` (catatan agent: ${objection.note})` : ''}.`
      : 'Belum ada keberatan yang tercatat.';

    const result = await ai.models.generateContent({
      model: MODEL,
      contents:
        `Tahap follow-up: ${meta.label} — tujuan: ${meta.goal}\n${objectionText}\n` +
        `Nama di WhatsApp: ${name || '(tidak diketahui)'} (belum tentu nama asli)\n\nRiwayat chat:\n${history || '(kosong)'}\n\n` +
        'Tulis SATU pesan WhatsApp follow-up untuk dikirim sales ke customer ini.',
      config: {
        systemInstruction:
          'Kamu sales PLTS (panel surya) yang ramah dan profesional. Tulis pesan follow-up WhatsApp berbahasa Indonesia yang ' +
          'singkat (2-4 kalimat), personal, merujuk penawaran/diskusi terakhir di riwayat chat, sesuai tujuan tahap. ' +
          `${style.rule} Jangan mengarang harga/spesifikasi yang tidak ada di riwayat. ` +
          'Untuk tahap VALUES, tawarkan informasi tambahan yang relevan dengan keberatan customer. ' +
          'Jangan memaksa. Jawab HANYA isi pesannya.',
        maxOutputTokens: 400,
        temperature: 0.7,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    res.json({ draft: humanizeText(result.text || '', style) });
  } catch (err) {
    handleAiError(err, res, 'POST /ai/followup-draft');
  }
});

function handleAiError(err, res, label) {
  console.error(`${label} error:`, err);
  const status = err?.status ?? err?.code ?? err?.response?.status;
  const msg = String(err?.message || '');
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(msg)) {
    return res.status(429).json({ error: 'Kuota AI sedang penuh. Tunggu sebentar lalu coba lagi.', code: 'AI_QUOTA' });
  }
  res.status(500).json({ error: err.message });
}

// SARAN TAG: AI usulkan tag (dari daftar tag yang ADA) untuk percakapan ini.
// Mengembalikan tag_ids yang cocok + alasan. Tidak membuat tag baru.
router.post('/suggest-tags', async (req, res) => {
  try {
    const { conversation_id } = req.body;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id is required' });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY belum diset di server' });

    const { data: tags } = await supabase.from('tags').select('id, name');
    if (!tags || tags.length === 0) return res.json({ tag_ids: [], reason: 'Belum ada tag yang tersedia.' });

    const history = await getHistoryText(conversation_id);
    const tagList = tags.map((t) => `- ${t.name}`).join('\n');

    const result = await ai.models.generateContent({
      model: MODEL,
      contents: `Daftar tag yang TERSEDIA (hanya boleh pilih dari ini, jangan buat baru):\n${tagList}\n\nRiwayat chat:\n${history}\n\nPilih tag yang paling sesuai dengan kondisi percakapan ini (boleh 0, 1, atau beberapa). Kembalikan nama tag PERSIS seperti di daftar.`,
      config: {
        systemInstruction: 'Kamu mengklasifikasikan status percakapan sales WhatsApp PLTS dengan memilih tag yang relevan dari daftar yang diberikan. Jawab ringkas & akurat.',
        maxOutputTokens: 300,
        temperature: 0.3,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            tags: { type: 'ARRAY', items: { type: 'STRING' } },
            reason: { type: 'STRING' },
          },
          required: ['tags'],
        },
      },
    });

    let parsed = {};
    try { parsed = JSON.parse(result.text || '{}'); } catch { parsed = {}; }
    const wanted = Array.isArray(parsed.tags) ? parsed.tags.map((s) => String(s).toLowerCase().trim()) : [];
    const matched = tags.filter((t) => wanted.includes((t.name || '').toLowerCase().trim()));

    res.json({ tag_ids: matched.map((t) => t.id), tags: matched, reason: parsed.reason || '' });
  } catch (err) {
    handleAiError(err, res, 'POST /ai/suggest-tags');
  }
});

// SARAN CATATAN: AI ringkas kebutuhan/poin penting customer jadi 1 catatan singkat.
router.post('/suggest-note', async (req, res) => {
  try {
    const { conversation_id } = req.body;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id is required' });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY belum diset di server' });

    const history = await getHistoryText(conversation_id);

    const result = await ai.models.generateContent({
      model: MODEL,
      contents: `Riwayat chat:\n${history}\n\nBuat ringkasan catatan internal singkat tentang customer ini untuk tim sales.`,
      config: {
        systemInstruction: `Kamu membuat CATATAN INTERNAL singkat (bukan untuk dikirim ke customer) yang merangkum poin penting dari percakapan sales PLTS: kebutuhan/tujuan, kapasitas/produk yang diminati, lokasi, perkiraan tagihan listrik, keberatan/kendala, dan status terakhir. Tulis padat dalam bentuk poin atau 2-4 kalimat. Bahasa Indonesia. Kalau info belum ada, jangan mengarang — cukup tulis yang diketahui. Jawab HANYA isi catatannya.`,
        maxOutputTokens: 400,
        temperature: 0.5,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    res.json({ note: (result.text || '').trim() });
  } catch (err) {
    handleAiError(err, res, 'POST /ai/suggest-note');
  }
});

export default router;
