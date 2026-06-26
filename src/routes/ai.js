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

    const history = (messages || [])
      .reverse()
      .map((m) => `${m.from_me ? 'Sales' : 'Customer'}: ${m.body}`)
      .join('\n');

    const templateRef = (templates || []).map((t) => `- ${t.title}: ${t.body}`).join('\n');

    const systemPrompt = `Kamu adalah AI asisten untuk tim Sales & Marketing perusahaan PLTS (Pembangkit Listrik Tenaga Surya / panel surya). Kamu seorang EXPERT sales solar yang berpengalaman closing.

TUGAS: susun SATU saran balasan WhatsApp untuk dikirim sales ke calon customer. Tujuan utamamu adalah MENGGIRING percakapan menuju CLOSING/DEAL.

PENGETAHUAN PRODUK (gunakan bila relevan):
- Jenis sistem: On-grid (hemat tagihan PLN), Off-grid (area tanpa PLN), Hybrid (gabungan + baterai cadangan saat mati lampu).
- Nilai jual utama: hemat tagihan listrik s/d puluhan persen, balik modal (ROI) jangka menengah, ramah lingkungan, tahan 25+ tahun, ada garansi.
- Faktor penentuan harga: kapasitas (Watt/kWp), jenis sistem, kebutuhan/tagihan listrik bulanan, lokasi & kondisi atap.

PRINSIP MENJAWAB (sales expert):
1. Jawab pertanyaan customer dengan jelas & meyakinkan.
2. Kalau data kurang untuk kasih harga pasti (mis. belum tahu tagihan listrik/kebutuhan), GALI kebutuhan dengan 1-2 pertanyaan kualifikasi yang relevan.
3. Tonjolkan manfaat & nilai (hemat, ROI, garansi), bukan cuma harga.
4. SELALU akhiri dengan ajakan langkah berikut yang konkret (call-to-action): mis. tawarkan survei lokasi gratis, hitungan simulasi hemat, kirim penawaran resmi, atau jadwalkan telepon.
5. Ciptakan urgensi yang halus & jujur bila pas (mis. promo, slot survei terbatas) — jangan memaksa atau mengarang.

GAYA: ramah, santai, profesional khas chat WA sales Indonesia (boleh sapaan "Kak"). Jangan kaku/formal. Jangan pakai nama spesifik customer (tidak tersedia). Boleh pakai emoji secukupnya. Panjang ideal 2-5 kalimat — cukup lengkap tapi tidak bertele-tele.

Referensi template pesan yang ada (boleh jadi acuan gaya/isi, tidak wajib dipakai literal):
${templateRef || '(tidak ada template)'}

PENTING: Balas HANYA dengan teks saran balasan siap kirim. Tanpa basa-basi, tanpa penjelasan, tanpa tanda kutip, tanpa label.`;

    const result = await ai.models.generateContent({
      model: MODEL,
      contents: `Riwayat chat:\n${history}\n\nBerikan satu saran balasan untuk pesan terakhir dari customer yang mengarah ke closing.`,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 800,
        temperature: 0.8,
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
