// Pengaman koneksi WhatsApp saat deploy/restart:
// 1. Kunci giliran: hanya SATU server yang tersambung ke WhatsApp. Server baru
//    menunggu server lama melepas kunci (atau kunci basi > 20 dtk) sebelum
//    tersambung — dua server dengan akun sama membuat kunci enkripsi bentrok
//    sehingga penerima melihat "Menunggu pesan ini".
// 2. Mati tertib: kiriman baru ditolak, kiriman berjalan ditunggu, kunci
//    enkripsi disimpan, koneksi ditutup rapi, lalu kunci giliran dilepas.
// 3. Simpanan pesan keluar (7 hari) untuk kirim-ulang otomatis bila HP penerima
//    gagal membuka enkripsi (permintaan retry dari WhatsApp).
// Tabel opsional: wa_msg_store (SQL migrasi). Kunci giliran memakai app_settings.
import { randomUUID } from 'crypto'
import { proto } from '@whiskeysockets/baileys'
import { supabase } from '../db/supabase.js'

export const INSTANCE = randomUUID()
const LOCK_KEY = 'wa_lock'
const STALE_MS = 20000
const HEARTBEAT_MS = 5000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1. Kunci giliran ──────────────────────────────────────────────────────
async function readLock() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', LOCK_KEY).maybeSingle()
  try { return data?.value ? JSON.parse(data.value) : null } catch { return null }
}
async function writeLock(value) {
  await supabase.from('app_settings').upsert({ key: LOCK_KEY, value: JSON.stringify(value), updated_at: new Date().toISOString() }, { onConflict: 'key' })
}

let heartbeat = null
export async function acquireWaLock() {
  const started = Date.now()
  for (let i = 0; ; i++) {
    try {
      const cur = await readLock()
      const free = !cur || !cur.owner || cur.released || cur.owner === INSTANCE || Date.now() - (cur.at || 0) > STALE_MS
      if (free) {
        await writeLock({ owner: INSTANCE, at: Date.now() })
        await sleep(400)
        const check = await readLock()
        if (check?.owner === INSTANCE) break // menang (bila dua server berebut bersamaan)
      } else if (i === 0) {
        console.log('[WA] menunggu server lama melepas koneksi WhatsApp…')
      }
    } catch (e) {
      // Database bermasalah: jangan menahan WhatsApp selamanya
      console.warn('[WA] kunci giliran gagal dibaca:', e?.message || e)
      if (Date.now() - started > STALE_MS) break
    }
    if (Date.now() - started > 90000) { console.warn('[WA] kunci giliran tak kunjung lepas, ambil alih'); break }
    await sleep(2000)
  }
  console.log(`[WA] kunci giliran didapat (menunggu ${Math.round((Date.now() - started) / 1000)} dtk)`)
  clearInterval(heartbeat)
  heartbeat = setInterval(() => {
    if (shuttingDown) return
    writeLock({ owner: INSTANCE, at: Date.now() }).catch(() => {})
  }, HEARTBEAT_MS)
}

export async function releaseWaLock() {
  clearInterval(heartbeat)
  try {
    const cur = await readLock()
    if (!cur || cur.owner === INSTANCE) await writeLock({ owner: null, released: true, at: Date.now() })
  } catch { /* abaikan */ }
}

// ── 2. Mati tertib ────────────────────────────────────────────────────────
export let shuttingDown = false
let inflight = 0
export function beginShutdown() { shuttingDown = true }
export class ServerUpdatingError extends Error {
  constructor() { super('Server sedang update, coba kirim lagi beberapa detik.'); this.status = 503 }
}

// Bungkus sock.sendMessage: tolak saat mati, hitung kiriman berjalan, simpan pesan.
export function guardSocket(sock) {
  if (!sock || sock.__guarded) return sock
  const original = sock.sendMessage.bind(sock)
  sock.sendMessage = async (jid, content, opts) => {
    if (shuttingDown) throw new ServerUpdatingError()
    inflight++
    try {
      const sent = await original(jid, content, opts)
      if (sent?.key?.id && sent.message) rememberMessage(sent.key.id, sent.message)
      return sent
    } finally { inflight-- }
  }
  sock.__guarded = true
  return sock
}

export async function waitInflight(maxMs = 8000) {
  const until = Date.now() + maxMs
  while (inflight > 0 && Date.now() < until) await sleep(200)
  return inflight
}

// ── 3. Simpanan pesan keluar untuk kirim-ulang ────────────────────────────
const memory = new Map() // id -> base64 proto (terbaru di akhir)
const MEM_MAX = 3000
let storeOk = null
const encode = (message) => Buffer.from(proto.Message.encode(message).finish()).toString('base64')
const decode = (b64) => proto.Message.decode(Buffer.from(b64, 'base64'))

function rememberMessage(id, message) {
  let b64
  try { b64 = encode(message) } catch { return }
  memory.set(id, b64)
  if (memory.size > MEM_MAX) memory.delete(memory.keys().next().value)
  if (storeOk === false) return
  supabase.from('wa_msg_store').upsert({ id, message: b64 }, { onConflict: 'id' }).then(({ error }) => {
    if (error) { if (/wa_msg_store/.test(error.message || '')) storeOk = false } else storeOk = true
  }, () => {})
}

// Dipakai getMessage Baileys saat penerima meminta kirim-ulang.
export async function loadMessage(id) {
  if (!id) return undefined
  const m = memory.get(id)
  if (m) { try { return decode(m) } catch { /* lanjut */ } }
  if (storeOk !== false) {
    const { data, error } = await supabase.from('wa_msg_store').select('message').eq('id', id).maybeSingle()
    if (error && /wa_msg_store/.test(error.message || '')) storeOk = false
    if (data?.message) { try { return decode(data.message) } catch { /* lanjut */ } }
  }
  return undefined
}

export async function pruneMessageStore(days = 7) {
  if (storeOk === false) return
  const before = new Date(Date.now() - days * 86400000).toISOString()
  await supabase.from('wa_msg_store').delete().lt('created_at', before).then(() => {}, () => {})
}

// Cache hitungan retry (antarmuka CacheStore Baileys) agar retry tidak berulang tanpa batas.
export function makeRetryCache(ttlMs = 10 * 60 * 1000) {
  const m = new Map()
  const live = (k) => { const v = m.get(k); if (!v) return undefined; if (Date.now() > v.exp) { m.delete(k); return undefined } return v.val }
  return {
    get: (k) => live(k),
    set: (k, val) => { m.set(k, { val, exp: Date.now() + ttlMs }); if (m.size > 5000) m.delete(m.keys().next().value) },
    del: (k) => { m.delete(k) },
    flushAll: () => m.clear(),
  }
}
