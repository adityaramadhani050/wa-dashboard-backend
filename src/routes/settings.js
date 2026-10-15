import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { requireAdmin } from '../middleware/auth.js';
import { invalidateAutoAssignCache, distributeUnassigned } from '../services/autoAssign.js';
import { runMediaTtlAll } from '../services/mediaTtl.js';
import { parseRegionalSettings, invalidateRegionalSettingsCache } from '../services/regionalBot.js';

const router = Router();

// Backfill hapus media lama (admin) — bebaskan storage sekaligus.
router.post('/cleanup-media', requireAdmin, async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.body?.days, 10) || 60);
    const { total, storageError } = await runMediaTtlAll(days);
    if (storageError) {
      return res.status(500).json({
        error: `Gagal menghapus file dari storage: ${storageError}. Set SUPABASE_SERVICE_ROLE_KEY di server atau tambah policy DELETE untuk bucket wa-media.`,
        deleted: total, days,
      });
    }
    res.json({ success: true, deleted: total, days });
  } catch (err) {
    console.error('POST /settings/cleanup-media error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Status auto-assign (semua user boleh baca)
router.get('/auto-assign', async (req, res) => {
  try {
    const { data } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'auto_assign')
      .maybeSingle();
    res.json({ enabled: data?.value === 'true' });
  } catch (err) {
    console.error('GET /settings/auto-assign error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Aktif/non-aktifkan auto-assign (admin). Saat diaktifkan, langsung bagikan
// percakapan unassigned yang aktif secara seimbang ke para agent.
router.put('/auto-assign', requireAdmin, async (req, res) => {
  try {
    const enabled = !!req.body.enabled;
    const { error } = await supabase
      .from('app_settings')
      .upsert({ key: 'auto_assign', value: enabled ? 'true' : 'false', updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    invalidateAutoAssignCache();

    let distributed = 0;
    if (enabled) {
      const r = await distributeUnassigned();
      distributed = r.assigned;
    }
    res.json({ enabled, distributed });
  } catch (err) {
    console.error('PUT /settings/auto-assign error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Jam & hari kerja (untuk pengecualian overdue di luar jam kerja) ──────────
const DEFAULT_WORK_HOURS = { enabled: false, days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' };

function parseWorkHours(raw) {
  if (!raw) return { ...DEFAULT_WORK_HOURS };
  try {
    const v = JSON.parse(raw);
    return {
      enabled: !!v.enabled,
      days: Array.isArray(v.days) ? v.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : DEFAULT_WORK_HOURS.days,
      start: typeof v.start === 'string' ? v.start : DEFAULT_WORK_HOURS.start,
      end: typeof v.end === 'string' ? v.end : DEFAULT_WORK_HOURS.end,
    };
  } catch { return { ...DEFAULT_WORK_HOURS }; }
}

// Baca jam kerja (semua user boleh baca — dipakai frontend untuk overdue)
router.get('/work-hours', async (req, res) => {
  try {
    const { data } = await supabase
      .from('app_settings').select('value').eq('key', 'work_hours').maybeSingle();
    res.json(parseWorkHours(data?.value));
  } catch (err) {
    console.error('GET /settings/work-hours error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Simpan jam kerja (admin)
router.put('/work-hours', requireAdmin, async (req, res) => {
  try {
    const payload = parseWorkHours(JSON.stringify(req.body || {}));
    const { error } = await supabase
      .from('app_settings')
      .upsert({ key: 'work_hours', value: JSON.stringify(payload), updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    res.json(payload);
  } catch (err) {
    console.error('PUT /settings/work-hours error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Routing Regional (bot tanya lokasi -> agent Barat/Timur) ────────────────
async function regionalStatus() {
  // Info pendukung untuk UI: agent yang belum diberi regional tidak menerima lead baru.
  const res = await supabase.from('agents').select('id, name, region, available').eq('role', 'agent');
  if (res.error) return { migrated: false, agents_without_region: [], per_region: {} };
  const agents = res.data || [];
  const per_region = { barat: 0, timur: 0 };
  agents.forEach((a) => { if (per_region[a.region] != null && a.available !== false) per_region[a.region]++; });
  return {
    migrated: true,
    agents_without_region: agents.filter((a) => !a.region).map((a) => a.name),
    per_region, // jumlah agent TERSEDIA per regional
  };
}

router.get('/regional-routing', requireAdmin, async (req, res) => {
  try {
    const { data } = await supabase
      .from('app_settings').select('value').eq('key', 'regional_routing').maybeSingle();
    res.json({ ...parseRegionalSettings(data?.value), status: await regionalStatus() });
  } catch (err) {
    console.error('GET /settings/regional-routing error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/regional-routing', requireAdmin, async (req, res) => {
  try {
    const payload = parseRegionalSettings(req.body || {});
    const { error } = await supabase
      .from('app_settings')
      .upsert({ key: 'regional_routing', value: JSON.stringify(payload), updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    invalidateRegionalSettingsCache();
    res.json({ ...payload, status: await regionalStatus() });
  } catch (err) {
    console.error('PUT /settings/regional-routing error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
