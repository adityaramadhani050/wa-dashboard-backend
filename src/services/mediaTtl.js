import { supabase } from '../db/supabase.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET = 'wa-media';

// Ambil path file di storage dari public URL (.../object/public/wa-media/<path>)
function storagePathFromUrl(url) {
  if (!url) return null;
  const marker = `/${BUCKET}/`;
  const i = url.indexOf(marker);
  if (i === -1) return null;
  return decodeURIComponent(url.slice(i + marker.length).split('?')[0]);
}

// Hapus file media lebih lama dari TTL untuk hemat storage. Baris pesan tetap
// ada; media_url di-null-kan & media_expired=true supaya frontend tahu.
export async function runMediaTtl(ttlDays) {
  try {
    const cutoff = new Date(Date.now() - ttlDays * DAY_MS).toISOString();
    const { data, error } = await supabase
      .from('messages')
      .select('id, media_url')
      .not('media_url', 'is', null)
      .lt('timestamp', cutoff)
      .limit(500);
    if (error) throw error;
    if (!data?.length) return 0;

    const paths = [];
    const ids = [];
    for (const m of data) {
      const p = storagePathFromUrl(m.media_url);
      if (p) { paths.push(p); ids.push(m.id); }
    }
    if (!paths.length) return 0;

    await supabase.storage.from(BUCKET).remove(paths).catch(() => {});
    // Tandai kadaluarsa; fallback tanpa kolom media_expired bila belum ada.
    let res = await supabase.from('messages')
      .update({ media_url: null, media_expired: true }).in('id', ids);
    if (res.error) {
      await supabase.from('messages').update({ media_url: null }).in('id', ids);
    }
    console.log(`[MediaTTL] ${ids.length} media dihapus (lebih lama dari ${ttlDays} hari)`);
    return ids.length;
  } catch (e) {
    console.warn('[MediaTTL] gagal:', e.message);
    return 0;
  }
}

// Aktif hanya bila env MEDIA_TTL_DAYS di-set (>0). Cek berkala + sekali saat start.
export function startMediaTtlJob(intervalMs = 6 * 60 * 60 * 1000) {
  const ttlDays = parseInt(process.env.MEDIA_TTL_DAYS, 10) || 0;
  if (ttlDays <= 0) return; // dinonaktifkan secara default
  setTimeout(() => runMediaTtl(ttlDays), 2 * 60 * 1000);
  setInterval(() => runMediaTtl(ttlDays), intervalMs);
  console.log(`[MediaTTL] job aktif (hapus media >${ttlDays} hari, cek tiap ${Math.round(intervalMs / 3600000)} jam)`);
}
