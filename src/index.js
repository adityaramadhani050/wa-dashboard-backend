import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

import { connectToWhatsApp, setIO } from './baileys/connection.js';
import conversationsRouter from './routes/conversations.js';
import statsRouter from './routes/stats.js';

const PORT = process.env.PORT || 3000;
const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH'],
  },
});

setIO(io);

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/conversations', conversationsRouter);
app.use('/api/stats', statsRouter);

io.on('connection', (socket) => {
  console.log('Dashboard client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Dashboard client disconnected:', socket.id);
  });
});

httpServer.listen(PORT, 'localhost', async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    await connectToWhatsApp();
  } catch (err) {
    console.error('Failed to start WhatsApp connection:', err);
  }
});
