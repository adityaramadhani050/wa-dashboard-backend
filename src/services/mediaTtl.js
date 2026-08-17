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

// Hapus SATU batch (maks 500) file media lebih lama dari TTL. Return { fetched, deleted }.
// Baris pesan tetap ada; media_url di-null-kan & media_expired=true supaya frontend tahu.
async function runMediaTtlBatch(ttlDays) {
  const cutoff = new Date(Date.now() - ttlDays * DAY_MS).toISOString();
  const { data, error } = await supabase
    .from('messages')
    .select('id, media_url')
    .not('media_url', 'is', null)
    .lt('timestamp', cutoff)
    .limit(500);
  if (error) throw error;
  const fetched = data?.length || 0;
  if (!fetched) return { fetched: 0, deleted: 0 };

  const paths = [];
  const ids = [];
  for (const m of data) {
    const p = storagePathFromUrl(m.media_url);
    // Sertakan thumbnail bila ada (thumb_<path>)
    if (p) { paths.push(p, `thumb_${p}`); ids.push(m.id); }
  }
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths).catch(() => {});

  if (ids.length) {
    let res = await supabase.from('messages')
      .update({ media_url: null, media_thumb_url: null, media_expired: true }).in('id', ids);
    if (res.error) {
      await supabase.from('messages').update({ media_url: null }).in('id', ids);
    }
  }
  return { fetched, deleted: ids.length };
}

// Kompatibilitas job berkala: proses satu batch, kembalikan jumlah dihapus.
export async function runMediaTtl(ttlDays) {
  try {
    const { deleted } = await runMediaTtlBatch(ttlDays);
    if (deleted) console.log(`[MediaTTL] ${deleted} media dihapus (>${ttlDays} hari)`);
    return deleted;
  } catch (e) {
    console.warn('[MediaTTL] gagal:', e.message);
    return 0;
  }
}

// Backfill: hapus SEMUA media lebih lama dari TTL sekaligus (batch berulang).
export async function runMediaTtlAll(ttlDays, { maxBatches = 400 } = {}) {
  let total = 0;
  try {
    for (let i = 0; i < maxBatches; i++) {
      const { fetched, deleted } = await runMediaTtlBatch(ttlDays);
      total += deleted;
      if (fetched < 500) break; // batch terakhir
    }
    console.log(`[MediaTTL] backfill selesai: ${total} media dihapus (>${ttlDays} hari)`);
  } catch (e) {
    console.warn('[MediaTTL] backfill gagal:', e.message);
  }
  return total;
}

// Aktif hanya bila env MEDIA_TTL_DAYS di-set (>0). Cek berkala + sekali saat start.
export function startMediaTtlJob(intervalMs = 6 * 60 * 60 * 1000) {
  const ttlDays = parseInt(process.env.MEDIA_TTL_DAYS, 10) || 0;
  if (ttlDays <= 0) return; // dinonaktifkan secara default
  setTimeout(() => runMediaTtl(ttlDays), 2 * 60 * 1000);
  setInterval(() => runMediaTtl(ttlDays), intervalMs);
  console.log(`[MediaTTL] job aktif (hapus media >${ttlDays} hari, cek tiap ${Math.round(intervalMs / 3600000)} jam)`);
}
