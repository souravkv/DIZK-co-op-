const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, '../client/public')));

// ─── Constants ────────────────────────────────────────────────────────────────
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;
const ARENA_RADIUS = 280;
const PLAYER_RADIUS = 20;
const BULLET_RADIUS = 5;
const BULLET_SPEED = 9;
const BULLET_LIFE = 90;
const PLAYER_SPEED = 3.5;
const DODGE_SPEED = 13;
const DODGE_FRAMES = 10;
const DODGE_COOLDOWN = 45;
const SHOOT_COOLDOWN = 18;
const MAX_AMMO = 5;
const AMMO_REGEN_RATE = 0.004;
const BULLET_DAMAGE = 22;
const MAX_PLAYERS = 4;
const PICKUP_INTERVAL_TICKS = 300;
const MAX_PICKUPS = 5;
const INVINCIBLE_FRAMES = 12;

const SPAWN_ANGLES = [Math.PI * 1.5, Math.PI * 0.5, 0, Math.PI];

// ─── Room manager ─────────────────────────────────────────────────────────────
const rooms = new Map();

function createRoom() {
  const id = uuidv4().slice(0, 6).toUpperCase();
  const room = {
    id,
    players: new Map(),      // playerId -> playerState
    bullets: [],
    pickups: [],
    clients: new Map(),      // playerId -> ws
    phase: 'lobby',          // lobby | playing | ended
    tickCount: 0,
    pickupTimer: 0,
    interval: null,
    hostId: null,
  };
  rooms.set(id, room);
  return room;
}

function findOpenRoom() {
  for (const room of rooms.values()) {
    if (room.phase === 'lobby' && room.players.size < MAX_PLAYERS) return room;
  }
  return createRoom();
}

// ─── Player factory ───────────────────────────────────────────────────────────
function createPlayer(id, slotIndex) {
  const angle = SPAWN_ANGLES[slotIndex];
  return {
    id,
    slot: slotIndex,
    x: Math.cos(angle) * ARENA_RADIUS * 0.6,
    y: Math.sin(angle) * ARENA_RADIUS * 0.6,
    vx: 0, vy: 0,
    angle: angle + Math.PI,
    hp: 100,
    alive: true,
    ammo: MAX_AMMO,
    shootCd: 0,
    dodgeCd: 0,
    dodgeTime: 0,
    dodgeVx: 0, dodgeVy: 0,
    invincible: 0,
    shield: 0,
    kills: 0,
    // Input state received from client
    input: { up: false, down: false, left: false, right: false, shoot: false, dodgeL: false, dodgeR: false },
    inputSeq: 0,
  };
}

// ─── Pickup factory ───────────────────────────────────────────────────────────
let pickupIdCounter = 0;
function createPickup() {
  const a = Math.random() * Math.PI * 2;
  const r = Math.random() * ARENA_RADIUS * 0.75;
  return {
    id: ++pickupIdCounter,
    x: Math.cos(a) * r,
    y: Math.sin(a) * r,
    type: Math.random() < 0.6 ? 'ammo' : 'shield',
  };
}

// ─── Physics helpers ──────────────────────────────────────────────────────────
function circleArena(x, y, r, vx, vy) {
  const dist = Math.sqrt(x * x + y * y);
  const maxR = ARENA_RADIUS - r;
  if (dist > maxR) {
    const nx = x / dist, ny = y / dist;
    x = nx * maxR; y = ny * maxR;
    const dot = vx * nx + vy * ny;
    vx -= 2 * dot * nx; vy -= 2 * dot * ny;
    vx *= 0.8; vy *= 0.8;
  }
  return { x, y, vx, vy, bounced: dist > maxR };
}

// ─── Game tick ────────────────────────────────────────────────────────────────
function tick(room) {
  if (room.phase !== 'playing') return;
  room.tickCount++;

  // ── Update players ──
  for (const [, p] of room.players) {
    if (!p.alive) continue;
    const inp = p.input;

    // Movement
    let ax = 0, ay = 0;
    if (inp.up) ay -= 1;
    if (inp.down) ay += 1;
    if (inp.left) ax -= 1;
    if (inp.right) ax += 1;
    const len = Math.sqrt(ax * ax + ay * ay);
    if (len > 0) { ax /= len; ay /= len; }
    if (ax || ay) p.angle = Math.atan2(ay, ax);

    if (p.dodgeTime > 0) {
      p.vx = p.dodgeVx; p.vy = p.dodgeVy;
      p.dodgeTime--;
    } else {
      p.vx = ax * PLAYER_SPEED; p.vy = ay * PLAYER_SPEED;
    }

    p.x += p.vx; p.y += p.vy;

    // Arena wall
    const col = circleArena(p.x, p.y, PLAYER_RADIUS, p.vx, p.vy);
    p.x = col.x; p.y = col.y; p.vx = col.vx; p.vy = col.vy;

    // Cooldowns
    if (p.shootCd > 0) p.shootCd--;
    if (p.dodgeCd > 0) p.dodgeCd--;
    if (p.invincible > 0) p.invincible--;
    if (p.shield > 0) p.shield--;

    // Ammo regen
    if (p.ammo < MAX_AMMO) p.ammo = Math.min(MAX_AMMO, p.ammo + AMMO_REGEN_RATE);

    // Shoot
    if (inp.shoot && p.shootCd <= 0 && p.ammo >= 1) {
      p.ammo = Math.floor(p.ammo) - 1;
      if (p.ammo < 0) p.ammo = 0;
      p.shootCd = SHOOT_COOLDOWN;
      room.bullets.push({
        id: uuidv4().slice(0, 8),
        x: p.x + Math.cos(p.angle) * (PLAYER_RADIUS + BULLET_RADIUS + 2),
        y: p.y + Math.sin(p.angle) * (PLAYER_RADIUS + BULLET_RADIUS + 2),
        vx: Math.cos(p.angle) * BULLET_SPEED,
        vy: Math.sin(p.angle) * BULLET_SPEED,
        owner: p.id,
        ownerSlot: p.slot,
        life: BULLET_LIFE,
      });
    }

    // Dodge left
    if (inp.dodgeL && p.dodgeCd <= 0) {
      const da = -Math.PI / 2;
      const da2 = p.angle + da;
      p.dodgeVx = Math.cos(da2) * DODGE_SPEED;
      p.dodgeVy = Math.sin(da2) * DODGE_SPEED;
      p.dodgeTime = DODGE_FRAMES;
      p.dodgeCd = DODGE_COOLDOWN;
      p.invincible = DODGE_FRAMES;
    }

    // Dodge right
    if (inp.dodgeR && p.dodgeCd <= 0) {
      const da = Math.PI / 2;
      const da2 = p.angle + da;
      p.dodgeVx = Math.cos(da2) * DODGE_SPEED;
      p.dodgeVy = Math.sin(da2) * DODGE_SPEED;
      p.dodgeTime = DODGE_FRAMES;
      p.dodgeCd = DODGE_COOLDOWN;
      p.invincible = DODGE_FRAMES;
    }

    // Player-player collision (soft push)
    for (const [, other] of room.players) {
      if (other.id === p.id || !other.alive) continue;
      const dx = p.x - other.x, dy = p.y - other.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const minD = PLAYER_RADIUS * 2;
      if (d < minD && d > 0) {
        const overlap = (minD - d) / 2;
        p.x += (dx / d) * overlap;
        p.y += (dy / d) * overlap;
        other.x -= (dx / d) * overlap;
        other.y -= (dy / d) * overlap;
      }
    }
  }

  // ── Update bullets ──
  room.bullets = room.bullets.filter(b => b.life > 0);
  for (const b of room.bullets) {
    b.x += b.vx; b.y += b.vy;
    b.life--;

    // Wall bounce
    const col = circleArena(b.x, b.y, BULLET_RADIUS, b.vx, b.vy);
    if (col.bounced) {
      b.x = col.x; b.y = col.y;
      b.vx = col.vx; b.vy = col.vy;
      b.life -= 20;
    }

    // Hit players
    for (const [, p] of room.players) {
      if (!p.alive || p.id === b.owner || p.invincible > 0) continue;
      const dx = p.x - b.x, dy = p.y - b.y;
      if (Math.sqrt(dx * dx + dy * dy) < PLAYER_RADIUS + BULLET_RADIUS) {
        b.life = 0;
        if (p.shield > 0) {
          p.shield = 0;
        } else {
          p.hp -= BULLET_DAMAGE;
          p.invincible = INVINCIBLE_FRAMES;
          if (p.hp <= 0) {
            p.hp = 0;
            p.alive = false;
            const killer = room.players.get(b.owner);
            if (killer && killer.id !== p.id) killer.kills++;
            checkWin(room);
          }
        }
        break;
      }
    }
  }

  // ── Pickups ──
  room.pickupTimer++;
  if (room.pickupTimer >= PICKUP_INTERVAL_TICKS && room.pickups.length < MAX_PICKUPS) {
    room.pickups.push(createPickup());
    room.pickupTimer = 0;
  }
  for (const pk of room.pickups) {
    for (const [, p] of room.players) {
      if (!p.alive) continue;
      const dx = p.x - pk.x, dy = p.y - pk.y;
      if (Math.sqrt(dx * dx + dy * dy) < PLAYER_RADIUS + 10) {
        if (pk.type === 'ammo') p.ammo = Math.min(MAX_AMMO, Math.floor(p.ammo) + 3);
        else p.shield = 180;
        room.pickups = room.pickups.filter(x => x.id !== pk.id);
        break;
      }
    }
  }

  // ── Broadcast state ──
  broadcastState(room);
}

function checkWin(room) {
  const alive = [...room.players.values()].filter(p => p.alive);
  if (alive.length <= 1) {
    room.phase = 'ended';
    const winner = alive[0] || null;
    broadcast(room, { type: 'gameOver', winner: winner ? { id: winner.id, slot: winner.slot, kills: winner.kills } : null });
    clearInterval(room.interval);
    setTimeout(() => rooms.delete(room.id), 30000);
  }
}

function broadcastState(room) {
  const state = {
    type: 'state',
    tick: room.tickCount,
    players: [...room.players.values()].map(p => ({
      id: p.id, slot: p.slot, x: p.x, y: p.y,
      angle: p.angle, hp: p.hp, alive: p.alive,
      ammo: Math.floor(p.ammo), shootCd: p.shootCd,
      dodgeCd: p.dodgeCd, dodgeTime: p.dodgeTime,
      invincible: p.invincible, shield: p.shield > 0,
      kills: p.kills,
    })),
    bullets: room.bullets.map(b => ({ id: b.id, x: b.x, y: b.y, ownerSlot: b.ownerSlot })),
    pickups: room.pickups.map(pk => ({ id: pk.id, x: pk.x, y: pk.y, type: pk.type })),
  };
  broadcast(room, state);
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const [, ws] of room.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ─── WebSocket connection handler ─────────────────────────────────────────────
wss.on('connection', (ws) => {
  let playerId = null;
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Join or create room ──
    if (msg.type === 'join') {
      let room;
      if (msg.roomCode) {
        room = rooms.get(msg.roomCode.toUpperCase());
        if (!room || room.phase !== 'lobby' || room.players.size >= MAX_PLAYERS) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found or full' }));
          return;
        }
      } else {
        room = findOpenRoom();
      }

      playerId = uuidv4();
      roomId = room.id;
      const slot = room.players.size;
      const player = createPlayer(playerId, slot);
      room.players.set(playerId, player);
      room.clients.set(playerId, ws);
      if (!room.hostId) room.hostId = playerId;

      ws.send(JSON.stringify({
        type: 'joined',
        playerId,
        roomCode: room.id,
        slot,
        playerCount: room.players.size,
      }));

      // Tell everyone a new player joined
      broadcast(room, {
        type: 'lobby',
        players: [...room.players.values()].map(p => ({ id: p.id, slot: p.slot })),
        roomCode: room.id,
      });

      return;
    }

    if (!playerId || !roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    // ── Start game (host only) ──
    if (msg.type === 'start') {
      if (room.hostId !== playerId) return;
      if (room.players.size < 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Need at least 2 players' }));
        return;
      }
      room.phase = 'playing';
      room.tickCount = 0;
      room.pickupTimer = 0;
      room.bullets = [];
      room.pickups = [];
      broadcast(room, { type: 'start', playerCount: room.players.size });
      room.interval = setInterval(() => tick(room), TICK_MS);
      return;
    }

    // ── Input from client ──
    if (msg.type === 'input') {
      const player = room.players.get(playerId);
      if (!player || !player.alive) return;
      player.input = msg.input;
      player.inputSeq = msg.seq || 0;
      return;
    }
  });

  ws.on('close', () => {
    if (!playerId || !roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(playerId);
    if (player) {
      player.alive = false;
      checkWin(room);
    }
    room.players.delete(playerId);
    room.clients.delete(playerId);
    broadcast(room, {
      type: 'lobby',
      players: [...room.players.values()].map(p => ({ id: p.id, slot: p.slot })),
      roomCode: room.id,
    });
    if (room.players.size === 0) {
      clearInterval(room.interval);
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Disc Duel server running on http://localhost:${PORT}`));
