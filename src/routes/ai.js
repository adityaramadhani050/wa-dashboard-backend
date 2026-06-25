import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../db/supabase.js';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.post('/suggest', async (req, res) => {
  try {
    const { conversation_id } = req.body;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id is required' });

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

    const systemPrompt = `Kamu membantu sales WhatsApp menyusun SATU saran balasan untuk customer.
Gaya bahasa: ramah, santai, khas chat WA sales Indonesia (boleh pakai sapaan umum seperti "Kak"). Jangan formal/kaku.
Jangan pakai nama spesifik customer (tidak tersedia) — gunakan sapaan umum saja.
Gunakan daftar template pesan berikut sebagai referensi gaya/isi jika relevan, tapi tidak wajib dipakai literal:
${templateRef || '(tidak ada template)'}
Balas HANYA dengan teks saran balasan, tanpa basa-basi/penjelasan, tanpa tanda kutip pembuka.`;

    const result = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 300,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `Riwayat chat:\n${history}\n\nBerikan satu saran balasan untuk pesan terakhir dari customer.` },
      ],
    });

    const suggestion = result.content?.[0]?.text?.trim() || '';
    res.json({ suggestion });
  } catch (err) {
    console.error('POST /ai/suggest error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
