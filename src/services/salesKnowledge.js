// Pengetahuan sales bersama untuk saran balasan AI & AI Sales Agent:
// katalog produk resmi, contoh balasan sales asli (diutamakan yang closing),
// template, dan tag percakapan.
import { supabase } from '../db/supabase.js';
import { tokens } from './aiKnowledge.js';

// Kapasitas dalam watt dari teks ("3 kWp", "3kwp", "3.000 Wp", "1500 watt").
function capacitiesIn(text) {
  const out = [];
  const re = /(\d+(?:[.,]\d+)?)\s*(kwp|kw|wp|watt)\b/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    let n = parseFloat(m[1].replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
    if (/^kw/i.test(m[2])) n *= 1000;
    if (n > 0) out.push(Math.round(n));
  }
  return out;
}

// Katalog hemat token: semua produk ditulis ringkas (nama · kapasitas · harga),
// spesifikasi lengkap hanya untuk maks. 3 produk yang relevan dengan chat.
export function catalogFor(products, chatText) {
  const list = products || [];
  if (chatText === undefined) {
    return list.map((p) => {
      const head = [p.name, p.capacity, p.category].filter(Boolean).join(' · ');
      return `- ${head}${p.price ? ` — Harga: ${p.price}` : ''}${p.specs ? ` — ${p.specs}` : ''}`;
    }).join('\n');
  }
  const tt = tokens(chatText);
  const caps = capacitiesIn(chatText);
  const scored = list.map((p, i) => {
    let score = 0;
    for (const w of tokens(`${p.name} ${p.category || ''}`)) if (tt.has(w)) score += 1;
    const pc = capacitiesIn(p.capacity || p.name);
    if (caps.length && pc.some((c) => caps.includes(c))) score += 3;
    return { p, i, score };
  });
  const detail = new Set(scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map((x) => x.i));
  return scored.map(({ p, i }) => {
    const head = [p.name, p.capacity, p.category].filter(Boolean).join(' · ');
    const price = p.price ? ` — Harga: ${p.price}` : '';
    return `- ${head}${price}${detail.has(i) && p.specs ? ` — ${p.specs}` : ''}`;
  }).join('\n');
}

// opts.chatText: bila diisi, katalog diringkas sesuai isi chat (hemat token).
export async function buildSalesContext(conversation_id, opts = {}) {
  const { data: templates } = await supabase
    .from('message_templates')
    .select('title, body');

  // KNOWLEDGE BASE PRODUK: katalog asli supaya AI tidak mengarang harga/spek
  const { data: products } = await supabase
    .from('products')
    .select('name, category, capacity, price, specs')
    .eq('active', true)
    .order('created_at', { ascending: false });
  const productRef = catalogFor(products, opts.chatText);

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
    if (salesExamples.length >= 6) break;
  }
  const salesStyleRef = salesExamples.map((b) => `- ${b}`).join('\n');
  const learnSourceNote = successfulByAgent.size
    ? 'diutamakan dari percakapan yang BERHASIL closing & agent yang sama'
    : successfulIds.size
      ? 'diutamakan dari percakapan yang BERHASIL closing'
      : 'dari balasan sales terbaru';


  const templateRef = (templates || []).map((t) => `- ${t.title}: ${t.body}`).join('\n');
  return { productRef, salesStyleRef, learnSourceNote, templateRef, convTags, convTagsText };
}
