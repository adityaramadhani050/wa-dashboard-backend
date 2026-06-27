import { supabase } from '../db/supabase.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Tandai percakapan sebagai "resolved" bila tidak ada aktivitas selama 24 jam
// (customer tidak membalas sejak chat terakhir). Memakai updated_at sebagai
// penanda aktivitas terakhir (di-bump tiap pesan masuk/keluar).
export async function runAutoResolve() {
  try {
    const cutoff = new Date(Date.now() - DAY_MS).toISOString();
    const { data, error } = await supabase
      .from('conversations')
      .update({ status: 'resolved', updated_at: new Date().toISOString() })
      .neq('status', 'resolved')
      .lt('updated_at', cutoff)
      .select('id');
    if (error) throw error;
    if (data?.length) console.log(`[AutoResolve] ${data.length} percakapan ditandai resolved (tidak aktif >24 jam)`);
    return data?.length || 0;
  } catch (e) {
    console.warn('[AutoResolve] gagal:', e.message);
    return 0;
  }
}

// Jalankan berkala (default tiap 30 menit) + sekali saat start (delay singkat)
export function startAutoResolveJob(intervalMs = 30 * 60 * 1000) {
  setTimeout(() => runAutoResolve(), 60 * 1000);
  setInterval(() => runAutoResolve(), intervalMs);
  console.log('[AutoResolve] job aktif (cek tiap', Math.round(intervalMs / 60000), 'menit)');
}
