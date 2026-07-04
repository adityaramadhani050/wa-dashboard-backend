import sharp from 'sharp';

const MAX_DIM = 1600;   // sisi terpanjang maksimum untuk gambar penuh
const THUMB_DIM = 320;  // sisi terpanjang thumbnail

// Kompres/resize gambar. Return { buffer, mimetype, ext } atau null bila bukan
// gambar / gagal / tidak lebih kecil.
export async function compressImage(buffer, mimetype) {
  if (!buffer || !mimetype?.startsWith('image/')) return null;
  if (mimetype === 'image/gif') return null; // biarkan animasi apa adanya
  try {
    const out = await sharp(buffer, { failOn: 'none' })
      .rotate() // hormati orientasi EXIF
      .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    if (out.length < buffer.length) return { buffer: out, mimetype: 'image/jpeg', ext: 'jpg' };
    return null;
  } catch {
    return null;
  }
}

// Buat thumbnail kecil untuk preview di daftar/percakapan.
export async function makeThumbnail(buffer, mimetype) {
  if (!buffer || !mimetype?.startsWith('image/')) return null;
  if (mimetype === 'image/gif') return null;
  try {
    const out = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: THUMB_DIM, height: THUMB_DIM, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 55, mozjpeg: true })
      .toBuffer();
    return { buffer: out, mimetype: 'image/jpeg', ext: 'jpg' };
  } catch {
    return null;
  }
}
