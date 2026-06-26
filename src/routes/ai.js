import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '../db/supabase.js';

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

    const { data: templates } = await supabase
      .from('message_templates')
      .select('title, body');

    // PEMBELAJARAN: ambil contoh balasan asli yang ditulis sales (from_me=true)
    // dari berbagai percakapan, sebagai acuan gaya/pendekatan (in-context learning).
    const { data: salesMsgs } = await supabase
      .from('messages')
      .select('body')
      .eq('from_me', true)
      .not('body', 'is', null)
      .order('timestamp', { ascending: false })
      .limit(80);

    const seenExample = new Set();
    const salesExamples = [];
    for (const m of salesMsgs || []) {
      const b = (m.body || '').trim();
      if (b.length < 12 || b.length > 280) continue; // lewati yang terlalu pendek/panjang
      if (b.startsWith('[')) continue; // lewati placeholder media
      const key = b.toLowerCase();
      if (seenExample.has(key)) continue;
      seenExample.add(key);
      salesExamples.push(b);
      if (salesExamples.length >= 12) break;
    }
    const salesStyleRef = salesExamples.map((b) => `- ${b}`).join('\n');

    const history = (messages || [])
      .reverse()
      .map((m) => `${m.from_me ? 'Sales' : 'Customer'}: ${m.body}`)
      .join('\n');

    const templateRef = (templates || []).map((t) => `- ${t.title}: ${t.body}`).join('\n');

    const systemPrompt = `Kamu adalah AI asisten untuk tim Sales & Marketing perusahaan PLTS (Pembangkit Listrik Tenaga Surya / panel surya). Kamu seorang EXPERT sales solar yang berpengalaman closing.

TUGAS: susun SATU saran balasan WhatsApp untuk dikirim sales ke calon customer. Tujuan akhirnya memang closing/deal, TAPI dicapai BERTAHAP lewat diskusi yang membangun nilai & memahami kebutuhan dulu — bukan dengan langsung mengajak survei/meeting.

PENGETAHUAN PRODUK (gunakan bila relevan):
- Jenis sistem: On-grid (hemat tagihan PLN), Off-grid (area tanpa PLN), Hybrid (gabungan + baterai cadangan saat mati lampu).
- Nilai jual utama: hemat tagihan listrik s/d puluhan persen, balik modal (ROI) jangka menengah, ramah lingkungan, tahan 25+ tahun, ada garansi.
- Faktor penentuan harga: kapasitas (Watt/kWp), jenis sistem, kebutuhan/tagihan listrik bulanan, lokasi & kondisi atap.

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

GAYA: ramah, santai, profesional khas chat WA sales Indonesia (boleh sapaan "Kak"). Jangan kaku/formal. Jangan pakai nama spesifik customer (tidak tersedia).

PANJANG — WAJIB SINGKAT: maksimal 1-2 kalimat pendek (idealnya di bawah ~25 kata). Langsung ke inti, jangan bertele-tele. Lebih baik terlalu singkat daripada kepanjangan.

HUMANIZE — WAJIB, biar kedengaran seperti MANUSIA asli yang lagi ngetik WA, BUKAN bot/AI:
- Tulis seperti orang Indonesia ngobrol santai di WA sehari-hari. Bayangkan kamu sales beneran yang lagi pegang HP.
- Boleh pakai bahasa sehari-hari/informal yang wajar: "iya", "oke", "nanti", "soalnya", "sih", "ya", "dong", "kok", "nih", "aja", "gimana", "bener", "langsung". Jangan terlalu baku.
- Boleh singkatan WA yang umum & sopan seperlunya: "yg", "utk", "dgn", "kalo", "gak/ga", "udah", "tp", "bgt". Jangan berlebihan sampai norak.
- Variasikan kalimat — jangan kaku berpola. Sesekali kalimat pendek. Sapaan tidak harus selalu di awal.
- Emoji secukupnya saja (0-2), jangan tiap kalimat. Jangan pakai bullet/list/penomoran — ini chat WA, tulis mengalir natural.
- HINDARI gaya korporat/AI yang kaku: jangan buka dengan "Tentu," "Baik," "Dengan senang hati kami", "Terima kasih atas pertanyaan Anda", "Perlu kami informasikan bahwa", "Mohon maaf atas ketidaknyamanannya". Jangan terlalu sempurna/formal.
- Jangan kedengaran seperti brosur atau jawaban call center. Tulis seperti chat personal ke satu orang.
- Pakai "Kakak/Kak" untuk customer dan "kami/kita" untuk tim — konsisten, jangan campur "Anda".

BELAJAR DARI SALES ASLI — INI ACUAN PALING PENTING: berikut contoh balasan NYATA yang ditulis tim sales kami ke customer. Tirukan gaya bahasa, diksi, panjang kalimat, sapaan, dan cara mereka menawarkan/closing. Serap "rasa"-nya, JANGAN menyalin isinya mentah-mentah kalau tidak relevan dengan konteks:
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

    const suggestion = (result.text || '').trim();
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

export default router;
