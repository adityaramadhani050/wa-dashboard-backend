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

export default router;
