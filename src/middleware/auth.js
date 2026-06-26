import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
// Enforcement opt-in: selama 'false', token tetap diverifikasi & req.user diisi,
// tapi request TIDAK diblokir (supaya rollout FE+BE tidak memutus aplikasi live).
// Setelah kedua sisi terdeploy & terverifikasi, set AUTH_ENFORCED=true di Railway.
const ENFORCED = String(process.env.AUTH_ENFORCED || '').toLowerCase() === 'true';

export function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function readToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    return jwt.verify(m[1], JWT_SECRET);
  } catch {
    return null;
  }
}

// Verifikasi token & isi req.user. Memblokir hanya bila AUTH_ENFORCED=true.
export function requireAuth(req, res, next) {
  const payload = readToken(req);
  if (payload) req.user = payload;
  if (!ENFORCED) return next();
  if (!payload) return res.status(401).json({ error: 'Tidak terautentikasi. Silakan login ulang.' });
  next();
}

// Hanya admin. Memblokir hanya bila AUTH_ENFORCED=true.
export function requireAdmin(req, res, next) {
  if (!req.user) {
    const payload = readToken(req);
    if (payload) req.user = payload;
  }
  if (!ENFORCED) return next();
  if (!req.user) return res.status(401).json({ error: 'Tidak terautentikasi.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses khusus admin.' });
  next();
}
