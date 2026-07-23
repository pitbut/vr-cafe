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

// Процедурная анимация скелета: сами крутим кости (руки/ноги/голова) под
// разные состояния — не зависим от того, есть ли готовые клипы в GLB.
const BONE_NAMES = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm',
  'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg',
];

AFRAME.registerComponent('bone-anim', {
  schema: { state: { type: 'string', default: 'idle' } },
  init: function () {
    this.bones = {};
    this.clock = 0;
    this.el.addEventListener('model-loaded', (e) => {
      const model = e.detail.model;
      BONE_NAMES.forEach((n) => {
        const bone = model.getObjectByName(n);
        if (bone) {
          this.bones[n] = bone;
          bone.userData.restRotation = bone.rotation.clone();
        }
      });
    });
  },
  setState: function (state) {
    this.data.state = state;
  },
  tick: function (t, dt) {
    const b = this.bones;
    if (!b.Hips && !b.Spine) return; // модель ещё не загрузилась
    this.clock += dt / 1000;
    const c = this.clock;

    // Сбрасываем к исходной позе перед тем, как применить новую — иначе накопится дрейф
    Object.keys(b).forEach((name) => {
      if (b[name].userData.restRotation) b[name].rotation.copy(b[name].userData.restRotation);
    });

    const st = this.data.state;
    if (st === 'walk' || st === 'run') {
      const speed = st === 'run' ? 6.2 : 3.2;
      const amp = st === 'run' ? 0.85 : 0.5;
      const phase = c * speed;
      if (b.LeftUpLeg) b.LeftUpLeg.rotation.x += Math.sin(phase) * amp;
      if (b.RightUpLeg) b.RightUpLeg.rotation.x += Math.sin(phase + Math.PI) * amp;
      if (b.LeftLeg) b.LeftLeg.rotation.x += Math.max(0, -Math.sin(phase)) * amp * 1.3;
      if (b.RightLeg) b.RightLeg.rotation.x += Math.max(0, -Math.sin(phase + Math.PI)) * amp * 1.3;
      if (b.LeftArm) b.LeftArm.rotation.x += Math.sin(phase + Math.PI) * amp * 0.6;
      if (b.RightArm) b.RightArm.rotation.x += Math.sin(phase) * amp * 0.6;
      if (b.Spine) b.Spine.rotation.x += st === 'run' ? 0.18 : 0.04;
    } else if (st === 'sit') {
      if (b.LeftUpLeg) b.LeftUpLeg.rotation.x += -1.4;
      if (b.RightUpLeg) b.RightUpLeg.rotation.x += -1.4;
      if (b.LeftLeg) b.LeftLeg.rotation.x += 1.3;
      if (b.RightLeg) b.RightLeg.rotation.x += 1.3;
      if (b.Spine) b.Spine.rotation.x += 0.05;
    } else if (st === 'talk') {
      if (b.Head) {
        b.Head.rotation.x += Math.sin(c * 3) * 0.04;
        b.Head.rotation.y += Math.sin(c * 1.3) * 0.09;
      }
      if (b.RightForeArm) b.RightForeArm.rotation.z += Math.sin(c * 2.4) * 0.18;
      if (b.RightArm) b.RightArm.rotation.x += -0.15 + Math.sin(c * 2.4) * 0.05;
    } else if (st === 'eat') {
      const cyc = (Math.sin(c * 1.8) + 1) / 2; // 0..1
      if (b.RightForeArm) b.RightForeArm.rotation.x += -cyc * 1.6;
      if (b.RightArm) b.RightArm.rotation.z += -cyc * 0.25;
      if (b.Head) b.Head.rotation.x += cyc * 0.15;
    } else {
      // idle — лёгкое дыхание и покачивание
      if (b.Spine) b.Spine.rotation.x += Math.sin(c * 1.2) * 0.02;
      if (b.Head) b.Head.rotation.y += Math.sin(c * 0.5) * 0.05;
    }
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
  document.getElementById('emotesBar').classList.remove('hidden');
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
  registerBuildSocketHandlers();
  registerMusicSocketHandlers();
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

  socket.on('user-moved', ({ id, x, y, z, ry, state }) => {
    const p = peers[id];
    if (!p) return;
    p.x = x; p.z = z;
    if (p.entity) {
      p.entity.setAttribute('position', `${x} 0 ${z}`);
      if (typeof ry === 'number') p.entity.setAttribute('rotation', `0 ${ry} 0`);
    }
    if (p.modelEl && p.modelEl.components['bone-anim'] && state) {
      p.modelEl.components['bone-anim'].setState(state);
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
    modelEl.setAttribute('bone-anim', '');
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
let manualState = null; // 'sit' | 'talk' | 'eat' | null (авто idle/walk/run)
let shiftHeld = false;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') shiftHeld = true;
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') shiftHeld = false;
});

function setEmote(state) {
  manualState = state; // null снимает ручной режим
}

document.querySelectorAll('#emotesBar button').forEach((btn) => {
  btn.addEventListener('click', () => setEmote(btn.dataset.emote || null));
});

function startMovementSync() {
  const rig = document.getElementById('rig');
  let last = { x: null, z: null };
  let lastState = null;
  setInterval(() => {
    const pos = rig.object3D.position;
    const rot = rig.object3D.rotation;
    const ry = (rot.y * 180) / Math.PI;
    updateVoiceVolumes(pos);
    updateStageMusicVolume(pos);

    const posMoved = last.x === null || Math.abs(pos.x - last.x) > 0.005 || Math.abs(pos.z - last.z) > 0.005;
    const state = manualState || (posMoved ? (shiftHeld ? 'run' : 'walk') : 'idle');
    const stateChanged = state !== lastState;

    if (!posMoved && !stateChanged) return;
    last = { x: pos.x, z: pos.z };
    lastState = state;
    if (socket) socket.emit('move', { x: pos.x, y: pos.y, z: pos.z, ry, state });
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
      btn.textContent = 'Включить для всех';
      btn.className = 'secondary';
      btn.addEventListener('click', () => {
        if (socket) socket.emit('music-play', { file });
      });
      row.appendChild(btn);
      list.appendChild(row);
    });
  } catch (e) {
    list.innerHTML = '<p class="menu-hint">Не удалось получить список треков.</p>';
  }
}

let musicOptOut = false;
let lastMusicState = null; // последнее состояние музыки в комнате (для галочки-переключателя)

// Применяем то, что реально играет в комнате (пришло с сервера — общее для всех)
function applyMusicPlay(data, syncOffset) {
  lastMusicState = data;
  document.getElementById('musicStatus').textContent = `▶️ Играет: ${data.file}`;
  document.getElementById('musicStatus').className = 'status ok';
  document.getElementById('musicBtn').classList.add('active');
  if (musicOptOut) return; // сам себе выключил — не проигрываем
  bgAudio.src = `/music/${encodeURIComponent(data.file)}`;
  bgAudio.currentTime = 0;
  bgAudio.play().then(() => {
    if (syncOffset) {
      const offset = (Date.now() - data.startedAt) / 1000;
      if (offset > 0 && bgAudio.duration && offset < bgAudio.duration) bgAudio.currentTime = offset;
    }
  }).catch(() => {});
}

function applyMusicStop() {
  lastMusicState = null;
  bgAudio.pause();
  document.getElementById('musicBtn').classList.remove('active');
  document.getElementById('musicStatus').textContent = 'Остановлено';
  document.getElementById('musicStatus').className = 'status';
}

document.getElementById('musicOptOut').addEventListener('change', (e) => {
  musicOptOut = e.target.checked;
  if (musicOptOut) {
    bgAudio.pause();
  } else if (lastMusicState) {
    applyMusicPlay(lastMusicState, true);
  }
});

document.getElementById('musicBtn').addEventListener('click', openMusicPanel);
document.getElementById('stopMusicBtn').addEventListener('click', () => {
  if (socket) socket.emit('music-stop');
});
document.getElementById('musicCancelBtn').addEventListener('click', () => {
  document.getElementById('musicPanel').classList.add('hidden');
});

function registerMusicSocketHandlers() {
  socket.on('music-play', (data) => applyMusicPlay(data, true));
  socket.on('music-stop', () => applyMusicStop());
}

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

// ============================================================
// СТРОИТЕЛЬСТВО ИНТЕРЬЕРА (стены/пол/перегородки/мебель)
// ============================================================
const CATEGORY_DEFS = {
  wall: {
    label: 'Стена',
    variants: {
      brown: { label: 'Тёмная', color: '#5a4132' },
      cream: { label: 'Светлая', color: '#cfc9c2' },
    },
    grid: 1,
    build: (variant) => {
      const el = document.createElement('a-box');
      el.setAttribute('width', 2);
      el.setAttribute('height', 2.5);
      el.setAttribute('depth', 0.15);
      el.setAttribute('color', CATEGORY_DEFS.wall.variants[variant].color);
      el.setAttribute('position', '0 1.25 0');
      return el;
    },
  },
  floor: {
    label: 'Пол',
    variants: {
      light: { label: 'Светлый', color: '#8a6b4d' },
      dark: { label: 'Тёмный', color: '#4a3527' },
    },
    grid: 1,
    build: (variant) => {
      const el = document.createElement('a-plane');
      el.setAttribute('width', 1);
      el.setAttribute('height', 1);
      el.setAttribute('rotation', '-90 0 0');
      el.setAttribute('color', CATEGORY_DEFS.floor.variants[variant].color);
      el.setAttribute('position', '0 0.02 0');
      return el;
    },
  },
  partition: {
    label: 'Перегородка',
    variants: { wood: { label: 'Дерево', color: '#6b4f3d' } },
    grid: 1,
    build: () => {
      const el = document.createElement('a-box');
      el.setAttribute('width', 1.2);
      el.setAttribute('height', 1.3);
      el.setAttribute('depth', 0.1);
      el.setAttribute('color', '#6b4f3d');
      el.setAttribute('position', '0 0.65 0');
      return el;
    },
  },
  table: {
    label: 'Стол',
    variants: { round: { label: 'Круглый' } },
    grid: 0.5,
    build: () => {
      const wrap = document.createElement('a-entity');
      const top = document.createElement('a-cylinder');
      top.setAttribute('radius', '0.55');
      top.setAttribute('height', '0.06');
      top.setAttribute('color', '#7a5a3d');
      top.setAttribute('position', '0 0.45 0');
      const leg = document.createElement('a-cylinder');
      leg.setAttribute('radius', '0.06');
      leg.setAttribute('height', '0.45');
      leg.setAttribute('color', '#3a2b22');
      leg.setAttribute('position', '0 0.22 0');
      wrap.appendChild(top);
      wrap.appendChild(leg);
      return wrap;
    },
  },
  chair: {
    label: 'Стул',
    variants: { basic: { label: 'Обычный', color: '#8a4b32' } },
    grid: 0.5,
    build: (variant) => {
      const el = document.createElement('a-box');
      el.setAttribute('width', '0.4');
      el.setAttribute('height', '0.4');
      el.setAttribute('depth', '0.4');
      el.setAttribute('color', CATEGORY_DEFS.chair.variants[variant].color);
      el.setAttribute('position', '0 0.2 0');
      return el;
    },
  },
  bar: {
    label: 'Барная стойка',
    variants: { basic: { label: 'Секция' } },
    grid: 1,
    build: () => {
      const wrap = document.createElement('a-entity');
      const base = document.createElement('a-box');
      base.setAttribute('width', '1');
      base.setAttribute('height', '1.2');
      base.setAttribute('depth', '0.6');
      base.setAttribute('color', '#5c3d2e');
      base.setAttribute('position', '0 0.6 0');
      const top = document.createElement('a-box');
      top.setAttribute('width', '1.05');
      top.setAttribute('height', '0.08');
      top.setAttribute('depth', '0.65');
      top.setAttribute('color', '#caa06a');
      top.setAttribute('position', '0 1.24 0');
      wrap.appendChild(base);
      wrap.appendChild(top);
      return wrap;
    },
  },
};

const builtEntities = {}; // id -> a-entity (wrapper)
let currentBuildItem = null; // { category, variant }
let buildRotation = 0;
let isPlacementMode = false;
let isRemoveMode = false;
let ghostEntity = null;

function renderBuiltObject(obj) {
  if (builtEntities[obj.id]) return;
  const def = CATEGORY_DEFS[obj.category];
  if (!def) return;
  const wrapper = document.createElement('a-entity');
  wrapper.setAttribute('position', `${obj.x} 0 ${obj.z}`);
  wrapper.setAttribute('rotation', `0 ${obj.ry || 0} 0`);
  const built = def.build(obj.variant);
  wrapper.appendChild(built);
  document.getElementById('builtObjects').appendChild(wrapper);
  wrapper.object3D.userData.buildId = obj.id;
  builtEntities[obj.id] = wrapper;
}

function removeBuiltObject(id) {
  const el = builtEntities[id];
  if (el && el.parentNode) el.parentNode.removeChild(el);
  delete builtEntities[id];
}

// ---------- UI каталога ----------
function buildCatalogUI() {
  const tabsWrap = document.getElementById('buildTabs');
  const variantsWrap = document.getElementById('buildVariants');

  function renderVariants(catKey) {
    variantsWrap.innerHTML = '';
    const def = CATEGORY_DEFS[catKey];
    Object.entries(def.variants).forEach(([varKey, v]) => {
      const row = document.createElement('div');
      row.className = 'menu-item';
      row.innerHTML = `<span>${v.label || varKey}</span>`;
      const btn = document.createElement('button');
      btn.textContent = 'Выбрать';
      btn.className = 'secondary';
      btn.addEventListener('click', () => {
        currentBuildItem = { category: catKey, variant: varKey };
        isPlacementMode = true;
        isRemoveMode = false;
        document.getElementById('buildPanel').classList.add('hidden');
        showBuildHint();
      });
      row.appendChild(btn);
      variantsWrap.appendChild(row);
    });
  }

  Object.entries(CATEGORY_DEFS).forEach(([key, def], i) => {
    const tab = document.createElement('button');
    tab.textContent = def.label;
    if (i === 0) tab.classList.add('active');
    tab.addEventListener('click', () => {
      tabsWrap.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      tab.classList.add('active');
      renderVariants(key);
    });
    tabsWrap.appendChild(tab);
  });
  renderVariants(Object.keys(CATEGORY_DEFS)[0]);
}
buildCatalogUI();

document.getElementById('buildBtn').addEventListener('click', () => {
  document.getElementById('buildPanel').classList.remove('hidden');
});
document.getElementById('buildCancelBtn').addEventListener('click', () => {
  document.getElementById('buildPanel').classList.add('hidden');
});
document.getElementById('buildRemoveModeBtn').addEventListener('click', () => {
  isRemoveMode = true;
  isPlacementMode = false;
  currentBuildItem = null;
  document.getElementById('buildPanel').classList.add('hidden');
  showBuildHint();
});

function showBuildHint() {
  const hint = document.getElementById('buildHint');
  hint.classList.remove('hidden');
  hint.textContent = isRemoveMode
    ? '🗑 Режим удаления — клик по объекту убирает его. Esc — выйти'
    : '🔨 Клик — поставить, R — повернуть, Esc — выйти';
}
function hideBuildHint() {
  document.getElementById('buildHint').classList.add('hidden');
}

function exitBuildMode() {
  isPlacementMode = false;
  isRemoveMode = false;
  currentBuildItem = null;
  if (ghostEntity && ghostEntity.parentNode) ghostEntity.parentNode.removeChild(ghostEntity);
  ghostEntity = null;
  hideBuildHint();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') exitBuildMode();
  if (e.key.toLowerCase() === 'r' && isPlacementMode) {
    buildRotation = (buildRotation + 90) % 360;
  }
});

// ---------- Определение точки на полу по направлению камеры ----------
function getGroundPointFromCamera(maxDist = 15) {
  const camEl = document.getElementById('camera');
  if (!camEl || !camEl.object3D) return null;
  const camera = camEl.getObject3D('camera') || camEl.object3D;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const origin = new THREE.Vector3();
  camera.getWorldPosition(origin);
  if (dir.y >= -0.001) return null;
  const t = -origin.y / dir.y;
  if (t < 0 || t > maxDist) return null;
  return { x: origin.x + dir.x * t, z: origin.z + dir.z * t };
}

function snap(val, grid) {
  return Math.round(val / grid) * grid;
}

// ---------- Тик: обновляем призрак-превью ----------
AFRAME.registerComponent('build-ticker', {
  tick: function () {
    if (!isPlacementMode || !currentBuildItem) {
      if (ghostEntity && ghostEntity.parentNode) {
        ghostEntity.parentNode.removeChild(ghostEntity);
        ghostEntity = null;
      }
      return;
    }
    const point = getGroundPointFromCamera();
    if (!point) return;
    const def = CATEGORY_DEFS[currentBuildItem.category];
    const gx = snap(point.x, def.grid);
    const gz = snap(point.z, def.grid);

    if (!ghostEntity) {
      ghostEntity = document.createElement('a-entity');
      ghostEntity.setAttribute('material', 'opacity: 0.5; transparent: true');
      const built = def.build(currentBuildItem.variant);
      built.setAttribute('material', 'opacity: 0.5; transparent: true');
      ghostEntity.appendChild(built);
      document.getElementById('builtObjects').appendChild(ghostEntity);
    }
    ghostEntity.setAttribute('position', `${gx} 0 ${gz}`);
    ghostEntity.setAttribute('rotation', `0 ${buildRotation} 0`);
  },
});
document.querySelector('a-scene').setAttribute('build-ticker', '');

// ---------- Клик: поставить / удалить ----------
document.addEventListener('click', (e) => {
  if (e.target.tagName !== 'CANVAS') return; // клики по UI-панелям не считаем

  if (isPlacementMode && currentBuildItem) {
    const point = getGroundPointFromCamera();
    if (!point) return;
    const def = CATEGORY_DEFS[currentBuildItem.category];
    const gx = snap(point.x, def.grid);
    const gz = snap(point.z, def.grid);
    if (socket) {
      socket.emit('build-place', {
        category: currentBuildItem.category,
        variant: currentBuildItem.variant,
        x: gx, z: gz, ry: buildRotation,
      });
    }
  } else if (isRemoveMode) {
    const camEl = document.getElementById('camera');
    const camera = camEl.getObject3D('camera');
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    const container = document.getElementById('builtObjects').object3D;
    const hits = raycaster.intersectObject(container, true);
    if (hits.length) {
      let obj = hits[0].object;
      while (obj && !obj.userData.buildId) obj = obj.parent;
      if (obj && obj.userData.buildId && socket) {
        socket.emit('build-remove', { id: obj.userData.buildId });
      }
    }
  }
});

// ---------- Синхронизация с сервером ----------
function registerBuildSocketHandlers() {
  socket.on('room-layout', (layout) => {
    (layout || []).forEach(renderBuiltObject);
  });
  socket.on('build-place', (item) => renderBuiltObject(item));
  socket.on('build-remove', ({ id }) => removeBuiltObject(id));
}
