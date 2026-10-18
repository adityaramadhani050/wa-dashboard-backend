// Penghubung ke model AI lewat OpenRouter (https://openrouter.ai) — satu API
// key untuk banyak model. Model dipilih PER FITUR di pengaturan (app_settings
// 'ai_models'): model utama + cadangan. Bila model utama error / kena limit /
// jawabannya kosong, model cadangan dicoba berurutan.
// Env: OPENROUTER_API_KEY (wajib).
import { supabase } from '../db/supabase.js';
import { logAiUsage } from './aiUsage.js';

const API = 'https://openrouter.ai/api/v1';
const KEY = 'ai_models';
const TIMEOUT_MS = 45000;

export const aiEnabled = () => !!process.env.OPENROUTER_API_KEY;

// Model gratis berganti cukup sering di OpenRouter; ID bisa diubah admin di
// Manajemen Agent → AI Sales → Model AI.
const CHAT_MODELS = { model: 'google/gemma-4-31b-it:free', fallbacks: ['deepseek/deepseek-v4-flash:free', 'google/gemini-2.5-flash'] };
const LIGHT_MODELS = { model: 'google/gemma-4-26b-a4b-it:free', fallbacks: ['nvidia/nemotron-3-super-120b-a12b:free', 'google/gemini-2.5-flash'] };

export const DEFAULT_AI_MODELS = {
  features: {
    ai_sales_reply: CHAT_MODELS,
    ai_followup: CHAT_MODELS,
    suggest_reply: CHAT_MODELS,
    followup_draft: CHAT_MODELS,
    memory_summary: LIGHT_MODELS,
    skill_keywords: LIGHT_MODELS,
    regional_city: LIGHT_MODELS,
  },
  privacy: false, // true = hanya penyedia yang tidak menyimpan/melatih data prompt
};

const cleanId = (v) => String(v || '').trim().replace(/\s+/g, '').slice(0, 120);

export function parseAiModels(raw) {
  let v = {};
  try { v = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { v = {}; }
  const features = {};
  for (const [f, def] of Object.entries(DEFAULT_AI_MODELS.features)) {
    const cur = v.features?.[f] || {};
    const model = cleanId(cur.model) || def.model;
    const fallbacks = (Array.isArray(cur.fallbacks) ? cur.fallbacks : def.fallbacks)
      .map(cleanId).filter((m) => m && m !== model).filter((m, i, a) => a.indexOf(m) === i).slice(0, 3);
    features[f] = { model, fallbacks };
  }
  return { features, privacy: !!v.privacy };
}

let cache = { val: null, at: 0 };
export async function getAiModels() {
  if (cache.val && Date.now() - cache.at < 15000) return cache.val;
  let val = parseAiModels({});
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
    if (data?.value) val = parseAiModels(data.value);
  } catch { /* pakai default */ }
  cache = { val, at: Date.now() };
  return val;
}

export async function saveAiModels(input) {
  const cur = await getAiModels();
  const val = parseAiModels({ ...cur, ...input, features: { ...cur.features, ...(input?.features || {}) } });
  const { error } = await supabase.from('app_settings')
    .upsert({ key: KEY, value: JSON.stringify(val), updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
  cache.at = 0;
  return val;
}

class AiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Ambil JSON dari jawaban model (toleran terhadap ```json ...``` atau teks tambahan).
export function parseJsonLoose(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(raw); } catch { /* lanjut */ }
  const m = raw.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

async function callOnce(model, { system, prompt, json, maxTokens, temperature, topP, privacy }) {
  const body = {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ],
    // Ruang ekstra untuk model yang tetap "berpikir"; panjang jawaban dijaga lewat prompt
    max_tokens: Math.max(256, maxTokens * 3),
    temperature,
    ...(topP ? { top_p: topP } : {}),
    reasoning: { enabled: false, exclude: true },
    ...(json ? { response_format: { type: 'json_object' } } : {}),
    ...(privacy ? { provider: { data_collection: 'deny' } } : {}),
    usage: { include: true },
  };
  const post = () => fetch(`${API}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'WA Dashboard',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let res = await post();
  let data = await res.json().catch(() => ({}));
  // Model yang wajib "berpikir" / tidak mendukung format JSON -> ulangi tanpa parameter itu
  if (res.status === 400 && /reason|response_format|json/i.test(data.error?.message || '')) {
    body.reasoning = { exclude: true };
    delete body.response_format;
    res = await post();
    data = await res.json().catch(() => ({}));
  }
  if (!res.ok || data.error) {
    const status = data.error?.code || res.status;
    throw new AiError(`${model}: ${data.error?.message || res.statusText || 'gagal'}`, Number(status) || res.status);
  }
  const text = String(data.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new AiError(`${model}: jawaban kosong`, 502);
  if (json && !parseJsonLoose(text)) throw new AiError(`${model}: jawaban bukan JSON`, 502);
  return { text, model: data.model || model, usage: data.usage || {} };
}

// Panggil AI untuk satu fitur. Mengembalikan { text, model }.
// opts: system, prompt, json (keluaran JSON), maxTokens, temperature, topP,
//       models (paksa daftar model, mis. untuk tombol Tes).
export async function generate(feature, { system = '', prompt, json = false, maxTokens = 400, temperature = 0.7, topP, models } = {}) {
  if (!aiEnabled()) throw new AiError('OPENROUTER_API_KEY belum diset di server', 500);
  const cfg = await getAiModels();
  const f = cfg.features[feature] || DEFAULT_AI_MODELS.features.ai_sales_reply;
  const list = (models?.length ? models : [f.model, ...f.fallbacks]).filter(Boolean);
  let lastErr = null;
  let limited = false;
  for (const model of list) {
    try {
      const out = await callOnce(model, { system, prompt, json, maxTokens, temperature, topP, privacy: cfg.privacy });
      logAiUsage(feature, out.model, out.usage);
      return out;
    } catch (e) {
      lastErr = e;
      if (e.status === 429) limited = true;
      console.warn(`[AI] ${feature} model ${model} gagal (${e.status || e.name}): ${e.message}`);
    }
  }
  throw new AiError(lastErr?.message || 'Semua model AI gagal', limited ? 429 : (lastErr?.status || 500));
}

export const isQuotaError = (err) => err?.status === 429 || /rate limit|quota|429/i.test(String(err?.message || ''));

// ── Info OpenRouter untuk halaman pengaturan ─────────────────────────────
async function orGet(path) {
  const res = await fetch(`${API}${path}`, {
    headers: process.env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {},
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AiError(data.error?.message || res.statusText, res.status);
  return data;
}

let modelsCache = { list: null, at: 0 };
// Daftar model teks dari OpenRouter (cache 1 jam): gratis dulu, lalu termurah.
export async function listModels() {
  if (modelsCache.list && Date.now() - modelsCache.at < 3600000) return modelsCache.list;
  const data = await orGet('/models');
  const list = (data.data || [])
    .filter((m) => (m.architecture?.output_modalities || ['text']).includes('text'))
    .map((m) => {
      const pin = Number(m.pricing?.prompt || 0) * 1e6;
      const pout = Number(m.pricing?.completion || 0) * 1e6;
      const sp = m.supported_parameters || [];
      return {
        id: m.id,
        name: m.name || m.id,
        free: m.id.endsWith(':free') || (pin === 0 && pout === 0),
        context: m.context_length || 0,
        price_in: pin,   // USD per 1 juta token
        price_out: pout,
        json: sp.includes('response_format') || sp.includes('structured_outputs'),
      };
    })
    .sort((a, b) => (b.free - a.free) || (a.price_in + a.price_out) - (b.price_in + b.price_out) || a.id.localeCompare(b.id));
  modelsCache = { list, at: Date.now() };
  return list;
}

// Status API key: sudah pernah beli kredit? (menentukan batas model gratis
// 50 vs 1.000 request/hari) + sisa saldo.
export async function keyStatus() {
  if (!aiEnabled()) return { configured: false };
  const [key, credits] = await Promise.allSettled([orGet('/key'), orGet('/credits')]);
  const k = key.status === 'fulfilled' ? key.value.data || {} : {};
  const c = credits.status === 'fulfilled' ? credits.value.data || {} : null;
  const freeTier = k.is_free_tier !== undefined ? !!k.is_free_tier : null;
  return {
    configured: true,
    valid: key.status === 'fulfilled',
    error: key.status === 'rejected' ? key.reason?.message : undefined,
    free_tier: freeTier,
    free_daily_limit: freeTier === false ? 1000 : 50,
    credits: c ? { total: Number(c.total_credits || 0), used: Number(c.total_usage || 0), remaining: Number(c.total_credits || 0) - Number(c.total_usage || 0) } : null,
  };
}
