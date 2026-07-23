require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- PeerJS сигнальный сервер (для голосовых WebRTC-соединений) ---
const peerServer = ExpressPeerServer(server, { path: '/', allow_discovery: false });
app.use('/peerjs', peerServer);

// --- Состояние комнат в памяти: { roomCode: { socketId: {name, color, peerId, x, y, z, ry} } } ---
const rooms = {};

function roomUserCount(roomCode) {
  return rooms[roomCode] ? Object.keys(rooms[roomCode]).length : 0;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomCode, name, color, peerId }) => {
    if (!roomCode || !peerId) return;
    currentRoom = roomCode;
    socket.join(roomCode);

    if (!rooms[roomCode]) rooms[roomCode] = {};
    rooms[roomCode][socket.id] = {
      name: (name || 'Гость').slice(0, 24),
      color: color || '#4FC3F7',
      peerId,
      x: 0, y: 0, z: 0, ry: 0,
    };

    // Отправляем новичку список уже сидящих в кафе
    socket.emit('room-users', rooms[roomCode]);

    // Сообщаем остальным о новом госте
    socket.to(roomCode).emit('user-joined', { id: socket.id, ...rooms[roomCode][socket.id] });
  });

  socket.on('move', (pos) => {
    if (currentRoom && rooms[currentRoom] && rooms[currentRoom][socket.id]) {
      Object.assign(rooms[currentRoom][socket.id], pos);
      socket.to(currentRoom).emit('user-moved', { id: socket.id, ...pos });
    }
  });

  socket.on('chat', (msg) => {
    if (currentRoom) {
      io.to(currentRoom).emit('chat', {
        id: socket.id,
        name: rooms[currentRoom]?.[socket.id]?.name || '???',
        text: String(msg?.text || '').slice(0, 500),
      });
    }
  });

  socket.on('order', (data) => {
    if (currentRoom) {
      io.to(currentRoom).emit('order', {
        id: socket.id,
        name: rooms[currentRoom]?.[socket.id]?.name || 'Гость',
        item: String(data?.item || '').slice(0, 40),
        emoji: String(data?.emoji || '☕').slice(0, 4),
      });
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom] && rooms[currentRoom][socket.id]) {
      delete rooms[currentRoom][socket.id];
      socket.to(currentRoom).emit('user-left', { id: socket.id });
      if (roomUserCount(currentRoom) === 0) delete rooms[currentRoom];
    }
  });
});

// --- Приглашение через Telegram-бота ---
app.post('/api/invite', async (req, res) => {
  const { roomCode, hostName, chatId: chatIdOverride } = req.body || {};
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = chatIdOverride || process.env.TELEGRAM_CHAT_ID;

  if (!roomCode) {
    return res.status(400).json({ error: 'Не указан код комнаты' });
  }
  if (!token) {
    return res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN не настроен на сервере (см. .env.example)' });
  }
  if (!chatId) {
    return res.status(400).json({ error: 'Не указан chat_id получателя' });
  }

  const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const link = `${baseUrl}/?room=${encodeURIComponent(roomCode)}`;
  const text =
    `☕ ${hostName || 'Друг'} приглашает вас в виртуальное кафе!\n\n` +
    `Код комнаты: ${roomCode}\n` +
    `Ссылка: ${link}`;

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = await tgRes.json();
    if (!data.ok) {
      return res.status(502).json({ error: data.description || 'Telegram API вернул ошибку' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

app.get('/api/tracks', (req, res) => {
  const musicDir = path.join(__dirname, 'public', 'music');
  try {
    if (!fs.existsSync(musicDir)) return res.json({ tracks: [] });
    const files = fs
      .readdirSync(musicDir)
      .filter((f) => /\.(mp3|ogg|wav|m4a)$/i.test(f));
    res.json({ tracks: files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 VR Кафе запущено на порту ${PORT}`));
