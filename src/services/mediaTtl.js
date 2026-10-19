import { supabase } from '../db/supabase.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET = 'wa-media';

// Ambil path file di storage dari public URL (.../object/public/wa-media/<path>)
export function storagePathFromUrl(url) {
  if (!url) return null;
  const marker = `/${BUCKET}/`;
  const i = url.indexOf(marker);
  if (i === -1) return null;
  return decodeURIComponent(url.slice(i + marker.length).split('?')[0]);
}

// URL yang masih dipakai di tempat lain -> filenya TIDAK boleh dihapus:
// Galeri Produk (quick_media) atau pesan yang lebih baru dari batas TTL
// (mis. foto galeri / hasil forward yang dikirim lagi baru-baru ini).
async function sharedUrls(urls, cutoff) {
  const shared = new Set();
  for (let i = 0; i < urls.length; i += 100) {
    const chunk = urls.slice(i, i + 100);
    const [qm, recent] = await Promise.all([
      supabase.from('quick_media').select('media_url').in('media_url', chunk),
      supabase.from('messages').select('media_url').in('media_url', chunk).gte('timestamp', cutoff).limit(1000),
    ]);
    if ((qm.error && !/quick_media/.test(qm.error.message || '')) || recent.error) { chunk.forEach((u) => shared.add(u)); continue; } // ragu -> simpan
    for (const r of [...(qm.data || []), ...(recent.data || [])]) shared.add(r.media_url);
  }
  return shared;
}

// Hapus SATU batch (maks 500) file media lebih lama dari TTL. Return { fetched, deleted }.
// Baris pesan tetap ada; media_url di-null-kan & media_expired=true supaya frontend tahu.
// state.after = kursor timestamp agar pesan yang filenya dipertahankan (galeri)
// tidak terbaca berulang-ulang.
async function runMediaTtlBatch(ttlDays, state = {}) {
  const cutoff = new Date(Date.now() - ttlDays * DAY_MS).toISOString();
  let q = supabase
    .from('messages')
    .select('id, media_url, timestamp')
    .not('media_url', 'is', null)
    .lt('timestamp', cutoff)
    .order('timestamp', { ascending: true })
    .limit(500);
  if (state.after) q = q.gt('timestamp', state.after);
  const { data, error } = await q;
  if (error) throw error;
  const fetched = data?.length || 0;
  state.after = fetched === 500 ? data[fetched - 1].timestamp : null;
  if (!fetched) return { fetched: 0, deleted: 0 };

  const shared = await sharedUrls([...new Set(data.map((m) => m.media_url))], cutoff);
  const paths = [];
  const ids = [];
  for (const m of data) {
    if (shared.has(m.media_url)) continue; // file dipakai galeri / pesan lain yang masih baru
    const p = storagePathFromUrl(m.media_url);
    // Sertakan thumbnail bila ada (thumb_<path>)
    if (p) { paths.push(p, `thumb_${p}`); ids.push(m.id); }
  }
  // Hapus file fisik di storage. Jangan telan error diam-diam: kalau gagal
  // (mis. izin DELETE kurang saat pakai anon key), file tidak terhapus padahal
  // DB dikosongkan -> storage tak berkurang. Log agar ketahuan.
  let storageError = null;
  if (paths.length) {
    const { error: remErr } = await supabase.storage.from(BUCKET).remove([...new Set(paths)]);
    if (remErr) {
      storageError = remErr.message;
      console.error('[MediaTTL] GAGAL hapus file storage:', remErr.message,
        '-> pastikan SUPABASE_SERVICE_ROLE_KEY di-set atau ada policy DELETE untuk bucket.');
    }
  }

  // Hanya kosongkan referensi DB bila file benar-benar sudah dihapus dari
  // storage; jika gagal, biarkan media_url agar bisa dicoba ulang nanti.
  if (ids.length && !storageError) {
    let res = await supabase.from('messages')
      .update({ media_url: null, media_thumb_url: null, media_expired: true }).in('id', ids);
    if (res.error) {
      await supabase.from('messages').update({ media_url: null }).in('id', ids);
    }
  }
  return { fetched, deleted: storageError ? 0 : ids.length, storageError };
}

// Kompatibilitas job berkala: proses satu batch, kembalikan jumlah dihapus.
const jobState = {};
export async function runMediaTtl(ttlDays) {
  try {
    const { deleted } = await runMediaTtlBatch(ttlDays, jobState);
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
  let storageError = null;
  const state = {};
  try {
    for (let i = 0; i < maxBatches; i++) {
      const r = await runMediaTtlBatch(ttlDays, state);
      total += r.deleted;
      if (r.storageError) { storageError = r.storageError; break; } // stop, jangan hammer
      if (r.fetched < 500 || !state.after) break; // batch terakhir
    }
    console.log(`[MediaTTL] backfill selesai: ${total} media dihapus (>${ttlDays} hari)`);
  } catch (e) {
    console.warn('[MediaTTL] backfill gagal:', e.message);
    storageError = storageError || e.message;
  }
  return { total, storageError };
}

// Aktif hanya bila env MEDIA_TTL_DAYS di-set (>0). Cek berkala + sekali saat start.
export function startMediaTtlJob(intervalMs = 6 * 60 * 60 * 1000) {
  const ttlDays = parseInt(process.env.MEDIA_TTL_DAYS, 10) || 0;
  if (ttlDays <= 0) return; // dinonaktifkan secara default
  setTimeout(() => runMediaTtl(ttlDays), 2 * 60 * 1000);
  setInterval(() => runMediaTtl(ttlDays), intervalMs);
  console.log(`[MediaTTL] job aktif (hapus media >${ttlDays} hari, cek tiap ${Math.round(intervalMs / 3600000)} jam)`);
}
