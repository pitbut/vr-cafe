// ============================================================
// ВИРТУАЛЬНОЕ КАФЕ — клиентская логика
// ============================================================

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#1abc9c', '#e67e22', '#ecf0f1'];
const MAX_VOICE_DISTANCE = 9; // метров, после которых голос не слышен

const MENU_ITEMS = [
  { name: 'Капучино', emoji: '☕' },
  { name: 'Латте', emoji: '🥛' },
  { name: 'Эспрессо', emoji: '☕' },
  { name: 'Чай', emoji: '🍵' },
  { name: 'Круассан', emoji: '🥐' },
  { name: 'Чизкейк', emoji: '🍰' },
  { name: 'Лимонад', emoji: '🍋' },
  { name: 'Коктейль', emoji: '🍹' },
];

// ---------- Коллизии: не даём проходить сквозь стены и барную стойку ----------
const ROOM_BOUNDS = { minX: -12.3, maxX: 12.3, minZ: -9.3, maxZ: 9.3 };
const BAR_BOX = { minX: -4.3, maxX: 4.3, minZ: -9.0, maxZ: -7.9 };

AFRAME.registerComponent('boundary-check', {
  tick: function () {
    const pos = this.el.object3D.position;
    if (pos.x < ROOM_BOUNDS.minX) pos.x = ROOM_BOUNDS.minX;
    if (pos.x > ROOM_BOUNDS.maxX) pos.x = ROOM_BOUNDS.maxX;
    if (pos.z < ROOM_BOUNDS.minZ) pos.z = ROOM_BOUNDS.minZ;
    if (pos.z > ROOM_BOUNDS.maxZ) pos.z = ROOM_BOUNDS.maxZ;
    // барная стойка — не даём зайти "за стойку"
    if (pos.x > BAR_BOX.minX && pos.x < BAR_BOX.maxX && pos.z > BAR_BOX.minZ && pos.z < BAR_BOX.maxZ) {
      pos.z = BAR_BOX.minZ - 0.05;
    }
  },
});

let myName = '';
let myColor = COLORS[0];
let roomCode = null;
let socket = null;
let peer = null;
let myPeerId = null;
let localStream = null;
let muted = false;

// remoteId(socket.id) -> { entity, audioEl, gainNode, x,y,z }
const peers = {};

// ---------- Генерация UI: выбор цвета ----------
function buildColorPicker() {
  const wrap = document.getElementById('colorPicker');
  COLORS.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'color-swatch' + (i === 0 ? ' selected' : '');
    el.style.background = c;
    el.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
      el.classList.add('selected');
      myColor = c;
    });
    wrap.appendChild(el);
  });
}
buildColorPicker();

let myAvatarFile = '';

async function loadAvatarList() {
  try {
    const res = await fetch('/api/avatars');
    const data = await res.json();
    const select = document.getElementById('avatarSelect');
    (data.avatars || []).forEach((file) => {
      const opt = document.createElement('option');
      opt.value = file;
      opt.textContent = file.replace(/\.[^.]+$/, '');
      select.appendChild(opt);
    });
  } catch (e) {
    console.warn('Не удалось загрузить список аватаров:', e.message);
  }
}
loadAvatarList();

document.getElementById('avatarSelect').addEventListener('change', (e) => {
  myAvatarFile = e.target.value;
});

// Проигрывает анимации из GLB-модели и плавно переключается idle <-> walk
AFRAME.registerComponent('simple-gltf-anim', {
  init: function () {
    this.mixer = null;
    this.idleAction = null;
    this.walkAction = null;
    this.current = null;
    this.el.addEventListener('model-loaded', (e) => {
      const model = e.detail.model;
      const clips = model.animations || [];
      if (!clips.length) return;
      this.mixer = new THREE.AnimationMixer(model);
      const idleClip = clips.find((c) => /idle|stand|breath/i.test(c.name));
      const walkClip = clips.find((c) => /walk|run|move/i.test(c.name));
      this.idleAction = this.mixer.clipAction(idleClip || clips[0]);
      this.walkAction = walkClip ? this.mixer.clipAction(walkClip) : this.idleAction;
      this.idleAction.play();
      this.current = this.idleAction;
    });
  },
  setMoving: function (moving) {
    const target = moving ? this.walkAction : this.idleAction;
    if (!target || this.current === target) return;
    target.reset().fadeIn(0.25).play();
    if (this.current) this.current.fadeOut(0.25);
    this.current = target;
  },
  tick: function (t, dt) {
    if (this.mixer) this.mixer.update(dt / 1000);
  },
});

// ---------- Табы Создать / Войти ----------
const tabCreate = document.getElementById('tabCreate');
const tabJoin = document.getElementById('tabJoin');
const paneCreate = document.getElementById('paneCreate');
const paneJoin = document.getElementById('paneJoin');

tabCreate.addEventListener('click', () => {
  tabCreate.classList.add('active');
  tabJoin.classList.remove('active');
  paneCreate.classList.remove('hidden');
  paneJoin.classList.add('hidden');
});
tabJoin.addEventListener('click', () => {
  tabJoin.classList.add('active');
  tabCreate.classList.remove('active');
  paneJoin.classList.remove('hidden');
  paneCreate.classList.add('hidden');
});

function showError(msg) {
  const el = document.getElementById('landingError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function generateRoomCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Если в ссылке есть ?room=CODE — сразу подставляем в поле "войти"
const urlParams = new URLSearchParams(window.location.search);
const prefilledRoom = urlParams.get('room');
if (prefilledRoom) {
  tabJoin.click();
  document.getElementById('joinCodeInput').value = prefilledRoom.toUpperCase();
}

document.getElementById('createBtn').addEventListener('click', () => {
  ensureAudioCtx();
  myName = document.getElementById('nameInput').value.trim() || 'Гость';
  enterCafe(generateRoomCode());
});

document.getElementById('joinBtn').addEventListener('click', () => {
  ensureAudioCtx();
  myName = document.getElementById('nameInput').value.trim() || 'Гость';
  const code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
  if (!code) return showError('Введите код комнаты');
  enterCafe(code);
});

// ============================================================
// ВХОД В КАФЕ
// ============================================================
async function enterCafe(code) {
  roomCode = code;

  // Микрофон
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    console.warn('Микрофон недоступен, продолжаем без голоса:', e.message);
    localStream = null;
  }

  document.getElementById('landing').classList.add('hidden');
  document.getElementById('scene').classList.remove('hidden');
  document.getElementById('roomPanel').classList.remove('hidden');
  document.getElementById('userList').classList.remove('hidden');
  document.getElementById('chatBox').classList.remove('hidden');
  document.getElementById('voiceControls').classList.remove('hidden');
  document.getElementById('controlsHint').classList.remove('hidden');
  document.getElementById('roomCodeLabel').textContent = roomCode;

  buildTables();
  buildVipRooms();
  buildWaiters();
  document.getElementById('rig').setAttribute('boundary-check', '');
  setupStageMusic();

  socket = io();
  peer = new Peer(undefined, {
    host: window.location.hostname,
    port: window.location.port || (window.location.protocol === 'https:' ? 443 : 80),
    path: '/peerjs',
    secure: window.location.protocol === 'https:',
  });

  peer.on('open', (id) => {
    myPeerId = id;
    socket.emit('join-room', { roomCode, name: myName, color: myColor, peerId: myPeerId, avatarFile: myAvatarFile });
  });

  peer.on('call', (call) => {
    call.answer(localStream || undefined);
    call.on('stream', (remoteStream) => attachRemoteAudio(call.peer, remoteStream));
  });

  registerSocketHandlers();
  startMovementSync();
}

// ============================================================
// SOCKET.IO — синхронизация игроков, чат
// ============================================================
function registerSocketHandlers() {
  socket.on('room-users', (users) => {
    Object.entries(users).forEach(([id, u]) => {
      if (id !== socket.id) addRemotePlayer(id, u);
    });
    refreshUserList();
  });

  socket.on('user-joined', (u) => {
    addRemotePlayer(u.id, u);
    refreshUserList();
    // звоним новому гостю голосом
    if (peer && u.peerId && localStream) {
      const call = peer.call(u.peerId, localStream);
      call.on('stream', (remoteStream) => attachRemoteAudio(u.id, remoteStream));
    }
    addChatLine('Система', `${u.name} зашёл(шла) в кафе`);
  });

  socket.on('user-moved', ({ id, x, y, z, ry }) => {
    const p = peers[id];
    if (!p) return;
    const dx = x - p.x, dz = z - p.z;
    const moved = Math.sqrt(dx * dx + dz * dz) > 0.01;
    p.x = x; p.z = z;
    if (p.entity) {
      p.entity.setAttribute('position', `${x} 0 ${z}`);
      if (typeof ry === 'number') p.entity.setAttribute('rotation', `0 ${ry} 0`);
    }
    if (p.modelEl && p.modelEl.components['simple-gltf-anim']) {
      const anim = p.modelEl.components['simple-gltf-anim'];
      if (moved) {
        anim.setMoving(true);
        clearTimeout(p.idleTimer);
        p.idleTimer = setTimeout(() => anim.setMoving(false), 400);
      }
    }
  });

  socket.on('user-left', ({ id }) => {
    removeRemotePlayer(id);
    refreshUserList();
  });

  socket.on('chat', (msg) => addChatLine(msg.name, msg.text));

  socket.on('order', (data) => {
    addChatLine('☕ Бар', `${data.name} заказал(а) ${data.emoji} ${data.item} — уже готовим!`);
    spawnOrderNotice(data.name, data.emoji, data.item);
  });
}

// ============================================================
// АВАТАРЫ ДРУГИХ ИГРОКОВ
// ============================================================
function addRemotePlayer(id, u) {
  if (peers[id]) return;
  const container = document.getElementById('otherPlayers');
  const entity = document.createElement('a-entity');
  // Позиция игрока всегда на уровне пола — высота глаз (u.y) сюда не идёт,
  // иначе аватар "парит" в воздухе.
  entity.setAttribute('position', `${u.x || 0} 0 ${u.z || 0}`);

  let modelEl = null;
  if (u.avatarFile) {
    modelEl = document.createElement('a-entity');
    modelEl.setAttribute('gltf-model', `/models/${encodeURIComponent(u.avatarFile)}`);
    modelEl.setAttribute('simple-gltf-anim', '');
    modelEl.setAttribute('position', '0 0 0');
    entity.appendChild(modelEl);
  } else {
    const body = document.createElement('a-cylinder');
    body.setAttribute('radius', '0.28');
    body.setAttribute('height', '1.3');
    body.setAttribute('position', '0 0.9 0');
    body.setAttribute('color', u.color || '#4FC3F7');

    const head = document.createElement('a-sphere');
    head.setAttribute('radius', '0.22');
    head.setAttribute('position', '0 1.75 0');
    head.setAttribute('color', u.color || '#4FC3F7');

    entity.appendChild(body);
    entity.appendChild(head);
  }

  const label = document.createElement('a-text');
  label.setAttribute('value', u.name || 'Гость');
  label.setAttribute('align', 'center');
  label.setAttribute('position', '0 2.15 0');
  label.setAttribute('color', '#fff');
  label.setAttribute('scale', '0.6 0.6 0.6');
  label.setAttribute('side', 'double');
  entity.appendChild(label);

  container.appendChild(entity);

  peers[id] = {
    entity,
    modelEl,
    audioEl: null,
    gainNode: null,
    x: u.x || 0,
    y: 0,
    z: u.z || 0,
    name: u.name,
    color: u.color,
    idleTimer: null,
  };
}

function removeRemotePlayer(id) {
  const p = peers[id];
  if (!p) return;
  if (p.entity && p.entity.parentNode) p.entity.parentNode.removeChild(p.entity);
  if (p.audioEl) p.audioEl.remove();
  clearTimeout(p.idleTimer);
  delete peers[id];
}

function refreshUserList() {
  const el = document.getElementById('userList');
  el.innerHTML = `<div class="u"><span class="dot" style="background:${myColor}"></span><b>${myName} (вы)</b></div>`;
  Object.values(peers).forEach((p) => {
    el.innerHTML += `<div class="u"><span class="dot" style="background:${p.color}"></span>${p.name}</div>`;
  });
}

// ============================================================
// ГОЛОС: приём потока + затухание по расстоянию (proximity voice)
// ============================================================
let audioCtx = null;
function attachRemoteAudio(id, stream) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.srcObject = stream;
  audioEl.style.display = 'none';
  document.body.appendChild(audioEl);

  const source = audioCtx.createMediaStreamSource(stream);
  const gainNode = audioCtx.createGain();
  source.connect(gainNode).connect(audioCtx.destination);
  audioEl.volume = 0; // звук идёт через WebAudio graph, не через тег напрямую

  if (peers[id]) {
    peers[id].audioEl = audioEl;
    peers[id].gainNode = gainNode;
  }
}

function updateVoiceVolumes(myPos) {
  Object.values(peers).forEach((p) => {
    if (!p.gainNode) return;
    const dx = p.x - myPos.x, dz = p.z - myPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const vol = Math.max(0, 1 - dist / MAX_VOICE_DISTANCE);
    p.gainNode.gain.setTargetAtTime(vol, audioCtx.currentTime, 0.05);
  });
}

document.getElementById('muteBtn').addEventListener('click', (e) => {
  muted = !muted;
  if (localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  e.target.classList.toggle('muted', muted);
  document.getElementById('micStatus').textContent = muted ? 'Микрофон выключен' : 'Микрофон включён';
});

// ============================================================
// ДВИЖЕНИЕ: периодически шлём свою позицию на сервер
// ============================================================
function startMovementSync() {
  const rig = document.getElementById('rig');
  let last = { x: null, z: null };
  setInterval(() => {
    const pos = rig.object3D.position;
    const rot = rig.object3D.rotation;
    const ry = (rot.y * 180) / Math.PI;
    updateVoiceVolumes(pos);
    updateStageMusicVolume(pos);
    if (last.x === pos.x && last.z === pos.z) return;
    last = { x: pos.x, z: pos.z };
    if (socket) socket.emit('move', { x: pos.x, y: pos.y, z: pos.z, ry });
  }, 120);
}

// ============================================================
// ЧАТ
// ============================================================
function addChatLine(name, text) {
  const box = document.getElementById('chatMessages');
  const line = document.createElement('div');
  line.innerHTML = `<b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

const chatInput = document.getElementById('chatInput');
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && chatInput.value.trim()) {
    socket.emit('chat', { text: chatInput.value.trim() });
    chatInput.value = '';
    document.getElementById('camera').blur?.();
  }
});
// Не даём WASD двигать камеру, пока печатаем в чат
chatInput.addEventListener('focus', () => {
  document.getElementById('rig').setAttribute('wasd-controls', 'enabled', false);
});
chatInput.addEventListener('blur', () => {
  document.getElementById('rig').setAttribute('wasd-controls', 'enabled', true);
});

// ============================================================
// ПРИГЛАШЕНИЕ В TELEGRAM
// ============================================================
document.getElementById('copyLinkBtn').addEventListener('click', () => {
  const link = `${window.location.origin}/?room=${roomCode}`;
  navigator.clipboard.writeText(link);
  const btn = document.getElementById('copyLinkBtn');
  btn.textContent = '✅';
  setTimeout(() => (btn.textContent = '🔗'), 1500);
});

const invitePanel = document.getElementById('invitePanel');
document.getElementById('inviteBtn').addEventListener('click', () => {
  invitePanel.classList.remove('hidden');
  document.getElementById('inviteStatus').textContent = '';
});
document.getElementById('inviteCancelBtn').addEventListener('click', () => {
  invitePanel.classList.add('hidden');
});
document.getElementById('inviteSendBtn').addEventListener('click', async () => {
  const status = document.getElementById('inviteStatus');
  const chatId = document.getElementById('inviteChatId').value.trim();
  status.textContent = 'Отправка…';
  status.className = 'status';
  try {
    const res = await fetch('/api/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode, hostName: myName, chatId: chatId || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка отправки');
    status.textContent = '✅ Приглашение отправлено!';
    status.className = 'status ok';
    setTimeout(() => invitePanel.classList.add('hidden'), 1200);
  } catch (e) {
    status.textContent = '❌ ' + e.message;
    status.className = 'status err';
  }
});

// ============================================================
// РАССТАНОВКА МЕБЕЛИ (столики + VIP-комнаты)
// ============================================================
function buildTables() {
  const container = document.getElementById('tables');
  const positions = [
    [-8, 0, -2], [-8, 0, 2], [-4, 0, 2], [4, 0, 2], [8, 0, -2], [8, 0, 2],
  ];
  positions.forEach(([x, y, z]) => {
    const table = document.createElement('a-cylinder');
    table.setAttribute('position', `${x} ${0.45 + y} ${z}`);
    table.setAttribute('radius', '0.55');
    table.setAttribute('height', '0.06');
    table.setAttribute('color', '#7a5a3d');
    container.appendChild(table);

    const leg = document.createElement('a-cylinder');
    leg.setAttribute('position', `${x} ${0.22 + y} ${z}`);
    leg.setAttribute('radius', '0.06');
    leg.setAttribute('height', '0.45');
    leg.setAttribute('color', '#3a2b22');
    container.appendChild(leg);

    [[-0.8, 0], [0.8, 0], [0, -0.8], [0, 0.8]].forEach(([dx, dz]) => {
      const chair = document.createElement('a-box');
      chair.setAttribute('position', `${x + dx} ${0.35 + y} ${z + dz}`);
      chair.setAttribute('width', '0.4');
      chair.setAttribute('height', '0.4');
      chair.setAttribute('depth', '0.4');
      chair.setAttribute('color', '#8a4b32');
      container.appendChild(chair);
    });
  });
}

function buildVipRooms() {
  const container = document.getElementById('vipRooms');
  const roomXs = [10, 10, 10];
  const roomZs = [-6, -1, 4];
  roomXs.forEach((x, i) => {
    const z = roomZs[i];
    const wallColor = '#241a15';

    const back = document.createElement('a-box');
    back.setAttribute('position', `${x + 1.5} 1.5 ${z}`);
    back.setAttribute('width', '0.15');
    back.setAttribute('height', '3');
    back.setAttribute('depth', '3.6');
    back.setAttribute('color', wallColor);
    container.appendChild(back);

    const side1 = document.createElement('a-box');
    side1.setAttribute('position', `${x} 1.5 ${z - 1.8}`);
    side1.setAttribute('width', '3');
    side1.setAttribute('height', '3');
    side1.setAttribute('depth', '0.15');
    side1.setAttribute('color', wallColor);
    container.appendChild(side1);

    const side2 = document.createElement('a-box');
    side2.setAttribute('position', `${x} 1.5 ${z + 1.8}`);
    side2.setAttribute('width', '3');
    side2.setAttribute('height', '3');
    side2.setAttribute('depth', '0.15');
    side2.setAttribute('color', wallColor);
    container.appendChild(side2);

    const sign = document.createElement('a-text');
    sign.setAttribute('value', `VIP ${i + 1}`);
    sign.setAttribute('position', `${x + 1.4} 2.3 ${z}`);
    sign.setAttribute('rotation', '0 -90 0');
    sign.setAttribute('color', '#d98c3d');
    sign.setAttribute('align', 'center');
    container.appendChild(sign);

    const sofa = document.createElement('a-box');
    sofa.setAttribute('position', `${x + 0.9} 0.35 ${z}`);
    sofa.setAttribute('width', '0.6');
    sofa.setAttribute('height', '0.7');
    sofa.setAttribute('depth', '2.4');
    sofa.setAttribute('color', '#6b3f2a');
    container.appendChild(sofa);

    const table = document.createElement('a-cylinder');
    table.setAttribute('position', `${x - 0.3} 0.4 ${z}`);
    table.setAttribute('radius', '0.4');
    table.setAttribute('height', '0.06');
    table.setAttribute('color', '#7a5a3d');
    container.appendChild(table);
  });
}

// ============================================================
// ОФИЦИАНТЫ (ходят между столиками)
// ============================================================
function buildWaiter(name, startPos, endPos, duration, color) {
  const container = document.getElementById('npcWaiters');
  const entity = document.createElement('a-entity');
  entity.setAttribute('position', startPos);

  const body = document.createElement('a-cylinder');
  body.setAttribute('radius', '0.26');
  body.setAttribute('height', '1.3');
  body.setAttribute('position', '0 0.9 0');
  body.setAttribute('color', color);

  const head = document.createElement('a-sphere');
  head.setAttribute('radius', '0.2');
  head.setAttribute('position', '0 1.75 0');
  head.setAttribute('color', '#e0a893');

  const label = document.createElement('a-text');
  label.setAttribute('value', name);
  label.setAttribute('align', 'center');
  label.setAttribute('position', '0 2.1 0');
  label.setAttribute('color', '#fff');
  label.setAttribute('scale', '0.55 0.55 0.55');

  entity.appendChild(body);
  entity.appendChild(head);
  entity.appendChild(label);
  container.appendChild(entity);

  entity.setAttribute('animation__go', {
    property: 'position',
    to: endPos,
    dur: duration,
    dir: 'alternate',
    loop: true,
    easing: 'easeInOutSine',
  });
}

function buildWaiters() {
  buildWaiter('Официант', '-6 0 -4', '6 0 -4', 9000, '#1abc9c');
  buildWaiter('Официантка', '6 0 3', '-6 0 3', 11000, '#e67e22');
}

// ============================================================
// МУЗЫКА: реальные треки (из public/music) + «живая» на сцене караоке
// ============================================================
const STAGE_POS = { x: -10, z: 8 };
const STAGE_MAX_DISTANCE = 10;

let stageMusicGain = null;
let stageOscillators = [];

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function setupStageMusic() {
  const ctx = ensureAudioCtx();
  stageMusicGain = ctx.createGain();
  stageMusicGain.gain.value = 0;
  stageMusicGain.connect(ctx.destination);
  const notes = [196, 246.94, 293.66, 392]; // G-B-D-G — «живой» мотив на сцене
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = i % 2 === 0 ? 'triangle' : 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = 0.4;
    osc.connect(g).connect(stageMusicGain);
    osc.start();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.15 + i * 0.05;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.25;
    lfo.connect(lfoGain).connect(g.gain);
    lfo.start();
    stageOscillators.push(osc, lfo, g);
  });
}

function updateStageMusicVolume(myPos) {
  if (!stageMusicGain) return;
  const dx = myPos.x - STAGE_POS.x, dz = myPos.z - STAGE_POS.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const vol = Math.max(0, 1 - dist / STAGE_MAX_DISTANCE) * 0.25;
  stageMusicGain.gain.setTargetAtTime(vol, audioCtx.currentTime, 0.2);
}

// ---------- Плеер реальных треков ----------
const bgAudio = document.getElementById('bgAudio');
bgAudio.volume = 0.5;

async function openMusicPanel() {
  ensureAudioCtx();
  const panel = document.getElementById('musicPanel');
  const list = document.getElementById('trackList');
  const status = document.getElementById('musicStatus');
  list.innerHTML = 'Загрузка списка треков…';
  panel.classList.remove('hidden');
  status.textContent = '';

  try {
    const res = await fetch('/api/tracks');
    const data = await res.json();
    list.innerHTML = '';
    if (!data.tracks || data.tracks.length === 0) {
      list.innerHTML = '<p class="menu-hint">Треков пока нет — положи .mp3 файлы в папку <code>public/music</code> на сервере (см. public/music/README.md).</p>';
      return;
    }
    data.tracks.forEach((file) => {
      const row = document.createElement('div');
      row.className = 'menu-item';
      row.innerHTML = `<span>🎵 ${file.replace(/\.[^.]+$/, '')}</span>`;
      const btn = document.createElement('button');
      btn.textContent = 'Включить';
      btn.className = 'secondary';
      btn.addEventListener('click', () => playTrack(file));
      row.appendChild(btn);
      list.appendChild(row);
    });
  } catch (e) {
    list.innerHTML = '<p class="menu-hint">Не удалось получить список треков.</p>';
  }
}

function playTrack(file) {
  bgAudio.src = `/music/${encodeURIComponent(file)}`;
  bgAudio.play().catch(() => {});
  document.getElementById('musicStatus').textContent = `▶️ Играет: ${file}`;
  document.getElementById('musicStatus').className = 'status ok';
  document.getElementById('musicBtn').classList.add('active');
}

function stopTrack() {
  bgAudio.pause();
  bgAudio.removeAttribute('src');
  document.getElementById('musicBtn').classList.remove('active');
  document.getElementById('musicStatus').textContent = 'Остановлено';
  document.getElementById('musicStatus').className = 'status';
}

document.getElementById('musicBtn').addEventListener('click', openMusicPanel);
document.getElementById('stopMusicBtn').addEventListener('click', stopTrack);
document.getElementById('musicCancelBtn').addEventListener('click', () => {
  document.getElementById('musicPanel').classList.add('hidden');
});

// ============================================================
// МЕНЮ ЗАКАЗА (+ всплывающее уведомление над баром для всех)
// ============================================================
function buildOrderMenu() {
  const wrap = document.getElementById('menuItems');
  MENU_ITEMS.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'menu-item';
    row.innerHTML = `<span>${item.emoji} ${item.name}</span>`;
    const btn = document.createElement('button');
    btn.textContent = 'Заказать';
    btn.className = 'secondary';
    btn.addEventListener('click', () => {
      if (socket) socket.emit('order', { item: item.name, emoji: item.emoji });
      const status = document.getElementById('orderStatus');
      status.textContent = `✅ Заказ «${item.name}» отправлен бармену`;
      status.className = 'status ok';
    });
    row.appendChild(btn);
    wrap.appendChild(row);
  });
}
buildOrderMenu();

document.getElementById('menuBtn').addEventListener('click', () => {
  document.getElementById('orderPanel').classList.remove('hidden');
  document.getElementById('orderStatus').textContent = '';
});
document.getElementById('orderCancelBtn').addEventListener('click', () => {
  document.getElementById('orderPanel').classList.add('hidden');
});

// Всплывающая надпись над барной стойкой — видно всем в комнате
function spawnOrderNotice(name, emoji, item) {
  const container = document.getElementById('orderNotices');
  const text = document.createElement('a-text');
  const offsetX = (Math.random() - 0.5) * 2;
  text.setAttribute('value', `${emoji} ${item}\n— ${name}`);
  text.setAttribute('align', 'center');
  text.setAttribute('color', '#ffd9a0');
  text.setAttribute('scale', '0.8 0.8 0.8');
  text.setAttribute('position', `${offsetX} 0 0`);
  container.appendChild(text);

  text.setAttribute('animation__rise', {
    property: 'position',
    to: `${offsetX} 1.2 0`,
    dur: 3500,
    easing: 'easeOutQuad',
  });
  text.setAttribute('animation__fade', {
    property: 'text.opacity',
    from: 1,
    to: 0,
    dur: 3500,
    easing: 'easeInQuad',
  });
  setTimeout(() => { if (text.parentNode) text.parentNode.removeChild(text); }, 3600);
}
