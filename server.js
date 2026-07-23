require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const { MongoClient } = require('mongodb');

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
// --- Постройки (интерьер) по комнатам: { roomCode: [ {id, category, variant, x, z, ry} ] } ---
const roomLayouts = {};
// --- Общая музыка комнаты: { roomCode: { file, startedAt } | null } ---
const roomMusic = {};

function roomUserCount(roomCode) {
  return rooms[roomCode] ? Object.keys(rooms[roomCode]).length : 0;
}

// --- MongoDB: постоянное хранение построек (переживает перезапуск сервера) ---
let db = null;
async function initDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('MONGODB_URI не задан — постройки будут жить только в памяти (пропадут при перезапуске)');
    return;
  }
  try {
    const client = new MongoClient(uri);
    await client.connect();
    db = client.db('vrcafe');
    console.log('MongoDB подключена — постройки сохраняются навсегда');
  } catch (err) {
    console.error('Не удалось подключиться к MongoDB:', err.message);
  }
}
initDb();

async function loadLayoutFromDb(roomCode) {
  if (!db) return [];
  try {
    const doc = await db.collection('layouts').findOne({ _id: roomCode });
    return doc ? doc.objects || [] : [];
  } catch (err) {
    console.error('Ошибка чтения планировки из БД:', err.message);
    return [];
  }
}

async function ensureLayoutLoaded(roomCode) {
  if (!roomLayouts[roomCode]) {
    roomLayouts[roomCode] = await loadLayoutFromDb(roomCode);
  }
  return roomLayouts[roomCode];
}

async function persistAdd(roomCode, item) {
  if (!db) return;
  try {
    await db.collection('layouts').updateOne(
      { _id: roomCode },
      { $push: { objects: item } },
      { upsert: true }
    );
  } catch (err) {
    console.error('Ошибка сохранения объекта в БД:', err.message);
  }
}

async function persistRemove(roomCode, id) {
  if (!db) return;
  try {
    await db.collection('layouts').updateOne(
      { _id: roomCode },
      { $pull: { objects: { id } } }
    );
  } catch (err) {
    console.error('Ошибка удаления объекта из БД:', err.message);
  }
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', async ({ roomCode, name, color, peerId, avatarFile }) => {
    if (!roomCode || !peerId) return;
    currentRoom = roomCode;
    socket.join(roomCode);

    if (!rooms[roomCode]) rooms[roomCode] = {};
    rooms[roomCode][socket.id] = {
      name: (name || 'Гость').slice(0, 24),
      color: color || '#4FC3F7',
      avatarFile: avatarFile ? String(avatarFile).slice(0, 100) : null,
      peerId,
      x: 0, y: 0, z: 0, ry: 0,
    };

    // Отправляем новичку список уже сидящих в кафе
    socket.emit('room-users', rooms[roomCode]);

    // И то, что уже построено в этой комнате (постоянно хранится в БД)
    const layout = await ensureLayoutLoaded(roomCode);
    socket.emit('room-layout', layout);

    // Если в комнате сейчас что-то играет — синхронизируем новичка
    if (roomMusic[roomCode]) {
      socket.emit('music-play', roomMusic[roomCode]);
    }

    // Сообщаем остальным о новом госте
    socket.to(roomCode).emit('user-joined', { id: socket.id, ...rooms[roomCode][socket.id] });
  });

  socket.on('music-play', ({ file }) => {
    if (!currentRoom || !file) return;
    const state = { file: String(file).slice(0, 150), startedAt: Date.now() };
    roomMusic[currentRoom] = state;
    io.to(currentRoom).emit('music-play', state);
  });

  socket.on('music-stop', () => {
    if (!currentRoom) return;
    roomMusic[currentRoom] = null;
    io.to(currentRoom).emit('music-stop');
  });

  socket.on('build-place', async (obj) => {
    if (!currentRoom) return;
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category: String(obj?.category || '').slice(0, 20),
      variant: String(obj?.variant || '').slice(0, 20),
      x: Number(obj?.x) || 0,
      z: Number(obj?.z) || 0,
      ry: Number(obj?.ry) || 0,
    };
    const layout = await ensureLayoutLoaded(currentRoom);
    layout.push(item);
    io.to(currentRoom).emit('build-place', item);
    persistAdd(currentRoom, item);
  });

  socket.on('build-remove', async ({ id }) => {
    if (!currentRoom || !id) return;
    const layout = await ensureLayoutLoaded(currentRoom);
    const idx = layout.findIndex((o) => o.id === id);
    if (idx !== -1) layout.splice(idx, 1);
    io.to(currentRoom).emit('build-remove', { id });
    persistRemove(currentRoom, id);
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
      if (roomUserCount(currentRoom) === 0) {
        delete rooms[currentRoom];
        delete roomMusic[currentRoom];
      }
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

// TURN-сервер для голоса за строгими NAT/файрволами (Metered.ca, бесплатно до 20ГБ/мес)
app.get('/api/turn-credentials', async (req, res) => {
  const appName = process.env.METERED_APP_NAME;
  const apiKey = process.env.METERED_API_KEY;

  // Резервный набор — те же TURN-сервера, что по умолчанию использует сама библиотека
  // PeerJS (turn.peerjs.com), плюс публичные STUN. Используется, пока не настроен Metered.
  const fallback = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:eu-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' },
    { urls: 'turn:us-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' },
  ];

  if (!appName || !apiKey) {
    return res.json(fallback);
  }
  try {
    const r = await fetch(`https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`);
    const iceServers = await r.json();
    res.json(iceServers);
  } catch (err) {
    console.error('Ошибка получения TURN-данных:', err.message);
    res.json(fallback);
  }
});

app.get('/api/avatars', (req, res) => {
  const modelsDir = path.join(__dirname, 'public', 'models');
  try {
    if (!fs.existsSync(modelsDir)) return res.json({ avatars: [] });
    const files = fs
      .readdirSync(modelsDir)
      .filter((f) => /\.(glb|gltf)$/i.test(f));
    res.json({ avatars: files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
