// Pemantauan pemakaian token AI per fitur. Setiap panggilan AI (OpenRouter)
// dicatat ke tabel ai_usage_log (SQL migrasi). Bila tabel belum ada, pencatatan
// dilewati; bila kolom cost_usd belum ada, biaya tidak dicatat.
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
let noCost = false;

// `usage` = objek usage dari OpenRouter (prompt_tokens, completion_tokens, cost, ...).
export function logAiUsage(feature, model, usage) {
  if (disabled) return;
  const u = usage || {};
  const row = {
    feature,
    model: String(model || '').slice(0, 80),
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    cached_tokens: u.prompt_tokens_details?.cached_tokens || 0,
  };
  if (!noCost) row.cost_usd = Number(u.cost || 0);
  supabase.from('ai_usage_log').insert(row).then(({ error }) => {
    if (!error) return;
    if (/cost_usd/.test(error.message || '')) { noCost = true; delete row.cost_usd; supabase.from('ai_usage_log').insert(row).then(() => {}, () => {}); }
    else if (/ai_usage_log/.test(error.message || '')) disabled = true; // tabel belum ada
  }, () => {});
}

// Ringkasan per fitur & per hari (WIB) untuk `days` hari terakhir.
export async function usageSummary(days = 30) {
  // Minimal sejak awal hari ini (WIB) agar hitungan request gratis hari ini lengkap
  const todayKey = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const todayStart = new Date(`${todayKey}T00:00:00+07:00`).toISOString();
  const since = new Date(Math.min(Date.now() - days * 86400000, new Date(todayStart).getTime())).toISOString();
  const rows = [];
  let cols = 'created_at, feature, model, input_tokens, output_tokens, cached_tokens, cost_usd';
  for (let from = 0; ; from += 1000) {
    let { data, error } = await supabase.from('ai_usage_log')
      .select(cols).gte('created_at', since).order('created_at', { ascending: true }).range(from, from + 999);
    if (error && /cost_usd/.test(error.message || '')) {
      cols = 'created_at, feature, model, input_tokens, output_tokens, cached_tokens';
      ({ data, error } = await supabase.from('ai_usage_log')
        .select(cols).gte('created_at', since).order('created_at', { ascending: true }).range(from, from + 999));
    }
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const periodStart = Date.now() - days * 86400000;
  const blank = () => ({ calls: 0, input: 0, output: 0, cached: 0, cost: 0 });
  const add = (o, r) => { o.calls++; o.input += r.input_tokens || 0; o.output += r.output_tokens || 0; o.cached += r.cached_tokens || 0; o.cost += Number(r.cost_usd || 0); };
  const total = blank();
  const byFeature = {};
  const byDay = {};
  const today = blank();
  let freeToday = 0;
  for (const r of rows) {
    const day = new Date(new Date(r.created_at).getTime() + 7 * 3600000).toISOString().slice(0, 10);
    if (day === todayKey) {
      add(today, r);
      if (String(r.model || '').endsWith(':free')) freeToday++;
    }
    if (new Date(r.created_at).getTime() < periodStart && day !== todayKey) continue;
    add(total, r);
    const f = (byFeature[r.feature] = byFeature[r.feature] || { ...blank(), models: {} });
    add(f, r);
    if (r.model) f.models[r.model] = (f.models[r.model] || 0) + 1;
    add((byDay[day] = byDay[day] || blank()), r);
  }
  return {
    days, total, today, free_today: freeToday,
    features: Object.entries(byFeature)
      .map(([key, v]) => ({
        key, label: AI_FEATURES[key] || key, ...v,
        models: Object.entries(v.models).sort((a, b) => b[1] - a[1]).map(([model, calls]) => ({ model, calls })),
      }))
      .sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    daily: Object.entries(byDay).map(([date, v]) => ({ date, ...v })),
  };
}
