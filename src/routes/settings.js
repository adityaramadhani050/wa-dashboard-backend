import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { requireAdmin } from '../middleware/auth.js';
import { invalidateAutoAssignCache, distributeUnassigned } from '../services/autoAssign.js';

const router = Router();

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

export default router;
