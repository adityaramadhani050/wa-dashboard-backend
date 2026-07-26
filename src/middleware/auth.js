import jwt from 'jsonwebtoken';
import { supabase } from '../db/supabase.js';

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

// Token mesin/service (mis. bot notif WA) — TANPA kedaluwarsa.
// Perlakukan seperti password; dicabut dengan merotasi JWT_SECRET.
export function signServiceToken({ id = 'bot-notif-wa', name = 'Bot Notif WA', role = 'admin' } = {}) {
  return jwt.sign(
    { id, username: id, name, role, type: 'service' },
    JWT_SECRET
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

// Cache waktu ganti password per user (epoch detik) untuk kurangi query per request.
const pwdCache = new Map(); // id -> { changedAtSec, at }
export function invalidatePwdCache(userId) { if (userId != null) pwdCache.delete(userId); }

async function passwordChangedAtSec(userId) {
  const now = Date.now();
  const c = pwdCache.get(userId);
  if (c && now - c.at < 30000) return c.changedAtSec;
  let changedAtSec = 0;
  try {
    const { data } = await supabase
      .from('agents').select('password_changed_at').eq('id', userId).maybeSingle();
    if (data?.password_changed_at) changedAtSec = Math.floor(new Date(data.password_changed_at).getTime() / 1000);
  } catch { /* kolom mungkin belum ada -> 0 (tak ada invalidasi) */ }
  pwdCache.set(userId, { changedAtSec, at: now });
  return changedAtSec;
}

// Token dianggap TIDAK valid bila diterbitkan sebelum password terakhir diganti.
// Token service (bot) & token tanpa iat dilewati.
async function tokenNotRevoked(payload) {
  if (!payload || payload.type === 'service' || !payload.id || !payload.iat) return true;
  const changed = await passwordChangedAtSec(payload.id);
  if (!changed) return true;
  return payload.iat >= changed - 5; // toleransi 5 dtk clock skew
}

// Verifikasi token & isi req.user. Memblokir hanya bila AUTH_ENFORCED=true.
export async function requireAuth(req, res, next) {
  const payload = readToken(req);
  const ok = payload && (await tokenNotRevoked(payload));
  if (ok) req.user = payload;
  if (!ENFORCED) return next();
  if (!payload) return res.status(401).json({ error: 'Tidak terautentikasi. Silakan login ulang.' });
  if (!ok) return res.status(401).json({ error: 'Sesi berakhir karena password diubah. Silakan login ulang.' });
  next();
}

// Hanya admin. Memblokir hanya bila AUTH_ENFORCED=true.
export async function requireAdmin(req, res, next) {
  if (!req.user) {
    const payload = readToken(req);
    if (payload && (await tokenNotRevoked(payload))) req.user = payload;
  }
  if (!ENFORCED) return next();
  if (!req.user) return res.status(401).json({ error: 'Tidak terautentikasi.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses khusus admin.' });
  next();
}
