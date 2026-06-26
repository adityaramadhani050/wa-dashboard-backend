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

    // KNOWLEDGE BASE PRODUK: katalog asli supaya AI tidak mengarang harga/spek
    const { data: products } = await supabase
      .from('products')
      .select('name, category, capacity, price, specs')
      .eq('active', true)
      .order('created_at', { ascending: false });
    const productRef = (products || [])
      .map((p) => {
        const head = [p.name, p.capacity, p.category].filter(Boolean).join(' · ');
        const price = p.price ? ` — Harga: ${p.price}` : '';
        const specs = p.specs ? ` — ${p.specs}` : '';
        return `- ${head}${price}${specs}`;
      })
      .join('\n');

    // PEMBELAJARAN (in-context learning) — ambil contoh balasan asli sales (from_me=true)
    // dengan PRIORITAS:
    //   1) percakapan yang BERHASIL/closing (status resolved atau bertag deal/closing)
    //   3) ditangani AGENT yang sama dengan chat ini
    // Urutan tier: A=closing+agent sama, B=closing siapa saja, C=agent sama, D=terbaru global.

    // agent yang menangani percakapan saat ini
    const { data: convRow } = await supabase
      .from('conversations')
      .select('assigned_to')
      .eq('id', conversation_id)
      .maybeSingle();
    const currentAgentId = convRow?.assigned_to || null;

    // tag yang menempel pada percakapan ini — agar AI menyesuaikan saran
    const { data: convTagRows } = await supabase
      .from('conversation_tags')
      .select('tags (name)')
      .eq('conversation_id', conversation_id);
    const convTags = (convTagRows || []).map((r) => r.tags?.name).filter(Boolean);
    const convTagsText = convTags.length ? convTags.join(', ') : '(belum ada tag)';

    // kumpulkan id percakapan "berhasil/closing": status resolved + bertag deal/closing/closed
    const successfulIds = new Set();
    const { data: resolvedConvs } = await supabase
      .from('conversations')
      .select('id')
      .eq('status', 'resolved')
      .order('updated_at', { ascending: false })
      .limit(200);
    (resolvedConvs || []).forEach((c) => successfulIds.add(c.id));

    const { data: allTags } = await supabase.from('tags').select('id, name');
    const dealTagIds = (allTags || [])
      .filter((t) => /deal|clos|menang|berhasil|jadi|won/i.test(t.name || ''))
      .map((t) => t.id);
    if (dealTagIds.length) {
      const { data: ct } = await supabase
        .from('conversation_tags')
        .select('conversation_id')
        .in('tag_id', dealTagIds);
      (ct || []).forEach((c) => successfulIds.add(c.conversation_id));
    }

    // map assigned_to untuk percakapan berhasil (untuk tahu mana yang agent-nya sama)
    const successfulByAgent = new Set();
    if (successfulIds.size) {
      const { data: succRows } = await supabase
        .from('conversations')
        .select('id, assigned_to')
        .in('id', [...successfulIds]);
      (succRows || []).forEach((r) => {
        if (currentAgentId && r.assigned_to === currentAgentId) successfulByAgent.add(r.id);
      });
    }

    // percakapan milik agent yang sama (status apapun) untuk tier C
    let agentConvIds = [];
    if (currentAgentId) {
      const { data: agentConvs } = await supabase
        .from('conversations')
        .select('id')
        .eq('assigned_to', currentAgentId)
        .order('updated_at', { ascending: false })
        .limit(200);
      agentConvIds = (agentConvs || []).map((c) => c.id);
    }

    const fetchSalesBodies = async (convIds, limit) => {
      if (!convIds || !convIds.length) return [];
      const { data } = await supabase
        .from('messages')
        .select('body')
        .eq('from_me', true)
        .not('body', 'is', null)
        .in('conversation_id', convIds.slice(0, 100)) // batasi agar URL query tidak terlalu panjang
        .order('timestamp', { ascending: false })
        .limit(limit);
      return data || [];
    };

    const tierA = await fetchSalesBodies([...successfulByAgent], 40);
    const tierB = await fetchSalesBodies([...successfulIds], 60);
    const tierC = await fetchSalesBodies(agentConvIds, 40);
    const { data: tierD } = await supabase
      .from('messages')
      .select('body')
      .eq('from_me', true)
      .not('body', 'is', null)
      .order('timestamp', { ascending: false })
      .limit(80);

    const seenExample = new Set();
    const salesExamples = [];
    for (const m of [...tierA, ...tierB, ...tierC, ...(tierD || [])]) {
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
    const learnSourceNote = successfulByAgent.size
      ? 'diutamakan dari percakapan yang BERHASIL closing & agent yang sama'
      : successfulIds.size
        ? 'diutamakan dari percakapan yang BERHASIL closing'
        : 'dari balasan sales terbaru';

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
- "Survey": survei lokasi SUDAH ditawarkan/dijadwalkan. JANGAN menawarkan survei lagi — lanjutkan dengan konfirmasi jadwal atau tindak lanjut hasil survei.
- "Penawaran": penawaran/harga SUDAH dikirim. Tindak lanjuti keputusan customer, jawab keberatan, bantu mereka memutuskan.
- "Follow-Up": customer perlu di-follow up. Beri dorongan halus & relevan sesuai konteks terakhir.
Kalau ada tag lain yang tak tercantum di sini, pakai penilaianmu sendiri.

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
