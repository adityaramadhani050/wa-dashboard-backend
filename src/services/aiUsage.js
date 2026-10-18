// Pemantauan pemakaian token AI per fitur. Setiap panggilan Gemini dicatat ke
// tabel ai_usage_log (SQL migrasi). Bila tabel belum ada, pencatatan dilewati.
import { supabase } from '../db/supabase.js';

export const AI_FEATURES = {
  ai_sales_reply: 'AI Sales — balas customer',
  ai_followup: 'AI Sales — follow-up otomatis',
  suggest_reply: 'Saran balasan (agent)',
  followup_draft: 'Draf follow-up (agent)',
  memory_summary: 'Ringkasan Ingatan AI',
  skill_keywords: 'Saran kata kunci skill',
  regional_city: 'Deteksi kota (bot regional)',
};

let disabled = false;

// `result` = respons generateContent (punya usageMetadata).
export function logAiUsage(feature, model, result) {
  if (disabled) return;
  const u = result?.usageMetadata || {};
  const row = {
    feature,
    model: String(model || '').slice(0, 60),
    input_tokens: u.promptTokenCount || 0,
    output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
    cached_tokens: u.cachedContentTokenCount || 0,
  };
  supabase.from('ai_usage_log').insert(row).then(({ error }) => {
    if (error && /ai_usage_log/.test(error.message || '')) disabled = true; // tabel belum ada
  }, () => {});
}

// Ringkasan per fitur & per hari (WIB) untuk `days` hari terakhir.
export async function usageSummary(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('ai_usage_log')
      .select('created_at, feature, input_tokens, output_tokens, cached_tokens')
      .gte('created_at', since).order('created_at', { ascending: true }).range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const blank = () => ({ calls: 0, input: 0, output: 0, cached: 0 });
  const add = (o, r) => { o.calls++; o.input += r.input_tokens || 0; o.output += r.output_tokens || 0; o.cached += r.cached_tokens || 0; };
  const total = blank();
  const byFeature = {};
  const byDay = {};
  const todayKey = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const today = blank();
  for (const r of rows) {
    const day = new Date(new Date(r.created_at).getTime() + 7 * 3600000).toISOString().slice(0, 10);
    add(total, r);
    add((byFeature[r.feature] = byFeature[r.feature] || blank()), r);
    add((byDay[day] = byDay[day] || blank()), r);
    if (day === todayKey) add(today, r);
  }
  return {
    days, total, today,
    features: Object.entries(byFeature)
      .map(([key, v]) => ({ key, label: AI_FEATURES[key] || key, ...v }))
      .sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    daily: Object.entries(byDay).map(([date, v]) => ({ date, ...v })),
  };
}
