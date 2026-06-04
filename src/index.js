import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

import { connectToWhatsApp, setIO, getSock } from "./baileys/connection.js";
import conversationsRouter from "./routes/conversations.js";
import statsRouter from "./routes/stats.js";
import messagesRouter from "./routes/messages.js";
import agentsRouter from "./routes/agents.js";

const PORT = process.env.PORT || 3000;
const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  },
  transports: ["websocket", "polling"],
});

setIO(io);

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    wa_connected: false,
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/conversations", conversationsRouter);
app.use("/api/stats", statsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/agents", agentsRouter);

io.on("connection", (socket) => {
  console.log("Dashboard client connected:", socket.id);

  const sock = getSock();
  socket.emit("wa_status", { connected: !!sock });

  socket.on("disconnect", () => {
    console.log("Dashboard client disconnected:", socket.id);
  });
});

httpServer.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on ${PORT}`)
  setIO(io)
  await connectToWhatsApp()
})
