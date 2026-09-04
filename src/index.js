import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { connectToWhatsApp, setIO, getSock, getIsConnected, resetSession, triggerSync, getSyncing, getLatestQr } from './baileys/connection.js'

// Allowlist origin CORS. Set CORS_ORIGINS (dipisah koma) di Railway ke domain
// frontend (mis. https://app.vercel.app). Jika belum diset, izinkan semua agar
// tidak memutus layanan yang sudah jalan.
const ALLOWED_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
const corsOrigin = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '*'
import conversationsRouter from './routes/conversations.js'
import statsRouter from './routes/stats.js'
import messagesRouter from './routes/messages.js'
import agentsRouter from './routes/agents.js'
import authRouter from './routes/auth.js'
import contactsRouter from './routes/contacts.js'
import templatesRouter from './routes/templates.js'
import tagsRouter from './routes/tags.js'
import remindersRouter from './routes/reminders.js'
import aiRouter from './routes/ai.js'
import productsRouter from './routes/products.js'
import devicesRouter from './routes/devices.js'
import settingsRouter from './routes/settings.js'
import meRouter from './routes/me.js'
import broadcastRouter from './routes/broadcast.js'
import { requireAuth, requireAdmin } from './middleware/auth.js'
import { getVapidPublicKey, isWebPushEnabled } from './push/webpush.js'
import { isPushEnabled } from './push/fcm.js'
import { startAutoResolveJob } from './services/autoResolve.js'
import { startMediaTtlJob } from './services/mediaTtl.js'
import { startBroadcastWorker } from './services/broadcastWorker.js'
import { subscriber, redisAvailable } from './db/redis.js'

// Cegah proses mati karena error async internal Baileys yang tidak bisa kita
// tangkap (mis. "Connection Closed" saat Baileys mengirim retry-request untuk
// pesan yang gagal didekripsi tepat ketika koneksi sedang tertutup). Node 20
// meng-crash proses pada unhandledRejection secara default -> cukup di-log.
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || reason
  console.error('[unhandledRejection]', msg)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.message || err)
})

const PORT = process.env.PORT || 3000
const app = express()
const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 20000,
  pingInterval: 10000,
})

setIO(io)

const REDIS_CHANNELS = ['new_message', 'message_status', 'message_updated', 'conversation_assigned']

if (redisAvailable && subscriber) {
  subscriber.subscribe(...REDIS_CHANNELS, (err) => {
    if (err) console.error('[Redis] Subscribe error:', err.message)
    else console.log(`[Redis] Subscribed to: ${REDIS_CHANNELS.join(', ')}`)
  })
  subscriber.on('message', (channel, raw) => {
    try {
      const data = JSON.parse(raw)
      io.emit(channel, data)
    } catch {}
  })
  console.log('[Redis] Pub/sub enabled')
} else {
  console.log('[Redis] Not configured — using direct Socket.io emit')
}

app.use(helmet({
  crossOriginResourcePolicy: false, // API JSON lintas-origin (frontend beda domain)
  contentSecurityPolicy: false,     // tidak menyajikan HTML dari sini
}))
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
app.use(express.json())

// Rate limit login: cegah brute-force password (20 percobaan / 15 menit / IP)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan login. Coba lagi dalam beberapa menit.' },
})
app.use('/api/auth/login', loginLimiter)

// VAPID public key untuk web push (terbuka — bukan rahasia)
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: getVapidPublicKey() })
})

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    wa_connected: getIsConnected(),
    redis: redisAvailable,
    web_push: isWebPushEnabled(),   // true bila VAPID env terpasang
    fcm_push: isPushEnabled(),      // true bila FIREBASE_SERVICE_ACCOUNT terpasang
    timestamp: new Date().toISOString(),
  })
})

// /api/auth & /health terbuka. Sisanya butuh login (requireAuth).
// Endpoint khusus admin pakai requireAdmin. Enforcement diaktifkan via AUTH_ENFORCED=true.
app.use('/api/auth', authRouter)
app.use('/api/conversations', requireAuth, conversationsRouter)
app.use('/api/stats', requireAdmin, statsRouter)
app.use('/api/messages', requireAuth, messagesRouter)
app.use('/api/agents', requireAdmin, agentsRouter)
app.use('/api/contacts', requireAuth, contactsRouter)
app.use('/api/templates', requireAuth, templatesRouter)
app.use('/api/tags', requireAuth, tagsRouter)
app.use('/api/reminders', requireAuth, remindersRouter)
app.use('/api/ai', requireAuth, aiRouter)
app.use('/api/products', requireAuth, productsRouter)
app.use('/api/devices', requireAuth, devicesRouter)
app.use('/api/settings', requireAuth, settingsRouter)
app.use('/api/me', requireAuth, meRouter)
app.use('/api/broadcast', requireAdmin, broadcastRouter)

app.post('/api/wa/sync', requireAuth, async (req, res) => {
  try {
    const r = await triggerSync()
    res.json({ ...r, syncing: getSyncing() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/wa/reset', requireAdmin, async (req, res) => {
  try {
    await resetSession()
    res.json({ success: true, message: 'Session reset, scan QR to reconnect' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

io.on('connection', (socket) => {
  console.log('Dashboard client connected:', socket.id, '| transport:', socket.conn.transport.name)
  socket.emit('wa_status', { connected: getIsConnected() })
  socket.emit('wa_sync', { syncing: getSyncing() })
  // Kirim QR terbaru bila WA belum tersambung -> dashboard yang baru buka
  // halaman QR langsung dapat QR tanpa menunggu refresh berikutnya.
  const qr = getLatestQr()
  if (qr) socket.emit('qr', qr)
  // Dashboard membuka halaman QR -> minta QR terbaru
  socket.on('request_qr', () => {
    const cur = getLatestQr()
    socket.emit('wa_status', { connected: getIsConnected() })
    if (cur) socket.emit('qr', cur)
  })
  socket.on('disconnect', () => {
    console.log('Dashboard client disconnected:', socket.id)
  })
})

httpServer.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on ${PORT}`)
  setIO(io)
  startAutoResolveJob()
  startMediaTtlJob()
  startBroadcastWorker()
  await connectToWhatsApp()
})
