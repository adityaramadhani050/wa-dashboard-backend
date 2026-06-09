import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import { connectToWhatsApp, setIO, getSock, getIsConnected, resetSession } from './baileys/connection.js'
import conversationsRouter from './routes/conversations.js'
import statsRouter from './routes/stats.js'
import messagesRouter from './routes/messages.js'
import agentsRouter from './routes/agents.js'
import authRouter from './routes/auth.js'
import { subscriber, redisAvailable } from './db/redis.js'

const PORT = process.env.PORT || 3000
const app = express()
const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 20000,
  pingInterval: 10000,
})

setIO(io)

const REDIS_CHANNELS = ['new_message', 'message_status', 'message_deleted', 'message_edited']

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

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
app.use(express.json())

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    wa_connected: getIsConnected(),
    redis: redisAvailable,
    timestamp: new Date().toISOString(),
  })
})

app.use('/api/auth', authRouter)
app.use('/api/conversations', conversationsRouter)
app.use('/api/stats', statsRouter)
app.use('/api/messages', messagesRouter)
app.use('/api/agents', agentsRouter)

app.post('/api/wa/reset', async (req, res) => {
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
  socket.on('disconnect', () => {
    console.log('Dashboard client disconnected:', socket.id)
  })
})

httpServer.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on ${PORT}`)
  setIO(io)
  await connectToWhatsApp()
})
