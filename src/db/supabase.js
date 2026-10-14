import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ws = require('ws');

const supabaseUrl = process.env.SUPABASE_URL;
// Backend tepercaya (server-side): utamakan SERVICE ROLE KEY agar operasi
// storage (hapus file) & tabel tidak terhalang RLS. Jika belum di-set, fallback
// ke ANON KEY supaya layanan tetap jalan (tetapi hapus storage butuh policy).
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const supabaseKey = serviceKey || anonKey;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY environment variables');
}

if (serviceKey) {
  console.log('[Supabase] memakai SERVICE ROLE key (bypass RLS)');
} else {
  console.warn('[Supabase] PERINGATAN: memakai ANON key — hapus file storage butuh policy DELETE. Set SUPABASE_SERVICE_ROLE_KEY untuk lebih andal.');
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws },
});
