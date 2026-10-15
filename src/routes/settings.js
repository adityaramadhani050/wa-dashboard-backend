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

// Ambil semua baris tabel secara bertahap (Supabase membatasi 1000 baris/query)
async function fetchAllRows(table, cols) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(cols).order('id', { ascending: true }).range(from, from + 999);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

// Backfill sekali jalan: isi regional kontak lama & percakapannya.
//  - kontak sudah punya regional -> salin ke percakapan yang belum punya
//  - kontak belum punya regional -> ambil dari regional agent yang menanganinya
// Hanya mengisi yang masih kosong (tidak menimpa pilihan admin).
router.post('/regional-backfill', requireAdmin, async (req, res) => {
  try {
    const [agents, contacts, convs] = await Promise.all([
      fetchAllRows('agents', 'id, region'),
      fetchAllRows('contacts', 'id, region'),
      fetchAllRows('conversations', 'id, contact_id, assigned_to, region'),
    ]);
    const agentRegion = {};
    agents.forEach((a) => { if (a.region) agentRegion[a.id] = a.region; });
    const contactRegion = {};
    contacts.forEach((c) => { if (c.region) contactRegion[c.id] = c.region; });

    const setContacts = { barat: new Set(), timur: new Set() };
    const setConvs = { barat: new Set(), timur: new Set() };
    let noSource = 0;
    for (const cv of convs) {
      // Prioritas: regional kontak -> regional chat (mis. diset admin) -> regional agent
      const region = contactRegion[cv.contact_id] || cv.region || agentRegion[cv.assigned_to] || null;
      if (!region) { if (!cv.region) noSource++; continue; }
      if (!contactRegion[cv.contact_id] && cv.contact_id) {
        setContacts[region].add(cv.contact_id);
        contactRegion[cv.contact_id] = region; // kontak dgn >1 percakapan: pakai yang pertama
      }
      if (!cv.region) setConvs[region].add(cv.id);
    }

    const applyBatched = async (table, region, ids) => {
      const list = [...ids];
      let n = 0;
      for (let i = 0; i < list.length; i += 150) {
        const { data, error } = await supabase.from(table).update({ region })
          .in('id', list.slice(i, i + 150)).is('region', null).select('id');
        if (error) throw error;
        n += (data || []).length;
      }
      return n;
    };
    let contactsUpdated = 0, convsUpdated = 0;
    for (const region of ['barat', 'timur']) {
      contactsUpdated += await applyBatched('contacts', region, setContacts[region]);
      convsUpdated += await applyBatched('conversations', region, setConvs[region]);
    }
    res.json({
      success: true,
      contacts_updated: contactsUpdated,
      conversations_updated: convsUpdated,
      without_source: noSource, // belum pernah ditangani agent ber-regional
    });
  } catch (err) {
    console.error('POST /settings/regional-backfill error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
