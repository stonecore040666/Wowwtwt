import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

// ── Types ────────────────────────────────────────────────────────────────────

interface PlayerInfo {
  id: string;
  name: string;
  alive: boolean;
  badges: number;
  kos: number;
  survivalTime: number;
  score: number;
  lines: number;
  targetId: string | null;
  lastAttackerId: string | null;
}

interface Room {
  id: string;
  name: string;
  ownerId: string;
  maxPlayers: number;
  passkey: string | null;
  players: PlayerInfo[];
  status: 'waiting' | 'countdown' | 'playing';
  gameStartTime: number;
}

// ── Badge multiplier (T99 style) ─────────────────────────────────────────────

function badgeMultiplier(badges: number): number {
  if (badges >= 12) return 2.0;
  if (badges >= 6)  return 1.75;
  if (badges >= 3)  return 1.5;
  if (badges >= 1)  return 1.25;
  return 1.0;
}

// ── Garbage table ─────────────────────────────────────────────────────────────
// 1 line = 0, 2 lines = 1, 3 lines = 2, 4 lines = 4
const BASE_GARBAGE = [0, 0, 1, 2, 4];

// ── State ─────────────────────────────────────────────────────────────────────

const rooms = new Map<string, Room>();
let playerCounter = 0;
const playerNames = new Map<string, string>();

function mkId(): string {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function playerName(id: string): string {
  if (!playerNames.has(id)) {
    playerCounter += 1;
    playerNames.set(id, `P${playerCounter}`);
  }
  return playerNames.get(id)!;
}

function makePlayer(id: string): PlayerInfo {
  return {
    id,
    name: playerName(id),
    alive: true,
    badges: 0,
    kos: 0,
    survivalTime: 0,
    score: 0,
    lines: 0,
    targetId: null,
    lastAttackerId: null,
  };
}

function roomToClient(r: Room) {
  return {
    id: r.id,
    name: r.name,
    ownerId: r.ownerId,
    maxPlayers: r.maxPlayers,
    hasPasskey: r.passkey !== null,
    players: r.players.map(p => ({
      id: p.id, name: p.name, alive: p.alive,
      survivalTime: p.survivalTime, badges: p.badges, kos: p.kos,
    })),
    status: r.status,
  };
}

function getRoomList() {
  return Array.from(rooms.values()).map(r => ({
    id: r.id, name: r.name, hasPasskey: r.passkey !== null,
    playerCount: r.players.length, maxPlayers: r.maxPlayers, status: r.status,
  }));
}

function broadcastRoomList() { io.emit('room_list', getRoomList()); }

function findRoom(socketId: string): Room | undefined {
  return Array.from(rooms.values()).find(r => r.players.some(p => p.id === socketId));
}

// Broadcast current stats (badges, KOs, targets) to everyone in a room
function emitStatsUpdate(room: Room) {
  const stats = room.players.map(p => ({
    id: p.id, name: p.name, alive: p.alive,
    badges: p.badges, kos: p.kos,
  }));
  io.to(room.id).emit('stats_update', { players: stats });
}

function emitTargetsUpdate(room: Room) {
  const targets: Record<string, string> = {};
  for (const p of room.players) {
    if (p.targetId) targets[p.id] = p.targetId;
  }
  io.to(room.id).emit('targets_update', { targets });
}

// Pick a random alive target (excluding self)
function pickRandomTarget(room: Room, excludeId: string): string | null {
  const alive = room.players.filter(p => p.alive && p.id !== excludeId);
  if (alive.length === 0) return null;
  return alive[Math.floor(Math.random() * alive.length)].id;
}

// Check if game should end; resolve KO cascade
function checkGameEnd(room: Room) {
  const alive = room.players.filter(p => p.alive);
  if (alive.length <= 1 && room.status === 'playing') {
    const now = Date.now();
    alive.forEach(p => { p.survivalTime = now - room.gameStartTime; });
    const result = room.players
      .map(p => ({ id: p.id, name: p.name, time: p.survivalTime, score: p.score, lines: p.lines, badges: p.badges, kos: p.kos }))
      .sort((a, b) => b.time - a.time);
    io.to(room.id).emit('game_ended', { result });
    room.status = 'waiting';
    room.gameStartTime = 0;
    room.players.forEach(p => {
      p.alive = true; p.survivalTime = 0; p.score = 0; p.lines = 0;
      p.badges = 0; p.kos = 0; p.targetId = null; p.lastAttackerId = null;
    });
    broadcastRoomList();
  }
}

// ── Socket.io ─────────────────────────────────────────────────────────────────

io.on('connection', (socket: Socket) => {
  socket.emit('room_list', getRoomList());

  socket.on('set_name', ({ name }: { name: string }) => {
    const cleaned = String(name).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
    if (cleaned) playerNames.set(socket.id, cleaned);
  });

  socket.on('get_rooms', () => { socket.emit('room_list', getRoomList()); });

  socket.on('create_room', ({ name, maxPlayers, passkey }: { name: string; maxPlayers: number; passkey: string }) => {
    // If already in a room, leave it first
    const existing = findRoom(socket.id);
    if (existing) doLeave(socket);

    const id = mkId();
    const room: Room = {
      id, name: (name || '').trim() || `ROOM-${id}`,
      ownerId: socket.id,
      maxPlayers: Math.max(2, Math.min(100, Number(maxPlayers) || 10)),
      passkey: passkey ? passkey.trim() : null,
      players: [makePlayer(socket.id)],
      status: 'waiting', gameStartTime: 0,
    };
    rooms.set(id, room);
    socket.join(id);
    socket.emit('room_joined', { room: roomToClient(room), myId: socket.id });
    broadcastRoomList();
  });

  socket.on('join_room', ({ roomId, passkey }: { roomId: string; passkey?: string }) => {
    // If already in a room, reject (must leave first)
    const existing = findRoom(socket.id);
    if (existing) return socket.emit('join_error', 'Already in a room');

    const room = rooms.get(roomId);
    if (!room) return socket.emit('join_error', 'Room not found');
    if (room.status !== 'waiting') return socket.emit('join_error', 'Game already started');
    if (room.players.length >= room.maxPlayers) return socket.emit('join_error', 'Room is full');
    if (room.passkey && room.passkey !== (passkey || '')) return socket.emit('join_error', 'Wrong passkey');
    room.players.push(makePlayer(socket.id));
    socket.join(roomId);
    socket.emit('room_joined', { room: roomToClient(room), myId: socket.id });
    io.to(roomId).emit('room_updated', roomToClient(room));
    broadcastRoomList();
  });

  socket.on('leave_room', () => doLeave(socket));

  socket.on('start_game', () => {
    const room = findRoom(socket.id);
    if (!room || room.ownerId !== socket.id || room.status !== 'waiting') return;
    if (room.players.length < 1) return socket.emit('join_error', '2人以上のプレイヤーが必要です');
    // Reset all stats for new game
    room.players.forEach(p => {
      p.alive = true; p.badges = 0; p.kos = 0; p.score = 0; p.lines = 0;
      p.survivalTime = 0; p.targetId = null; p.lastAttackerId = null;
    });
    room.status = 'countdown';
    broadcastRoomList();
    io.to(room.id).emit('game_countdown');
    setTimeout(() => {
      if (rooms.has(room.id) && room.status === 'countdown') {
        room.status = 'playing';
        room.gameStartTime = Date.now();
        io.to(room.id).emit('game_start');
        emitStatsUpdate(room);
        emitTargetsUpdate(room);
      }
    }, 4000);
  });

  // ── T99: Set target ──────────────────────────────────────────────────────────
  socket.on('set_target', ({ targetId }: { targetId: string | null }) => {
    const room = findRoom(socket.id);
    if (!room || room.status !== 'playing') return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me) return;
    // Validate target is alive
    if (targetId) {
      const target = room.players.find(p => p.id === targetId && p.alive && p.id !== socket.id);
      me.targetId = target ? targetId : pickRandomTarget(room, socket.id);
    } else {
      me.targetId = pickRandomTarget(room, socket.id);
    }
    emitTargetsUpdate(room);
  });

  // ── T99: Send garbage ────────────────────────────────────────────────────────
  socket.on('send_garbage', ({ lines, targetId }: { lines: number; targetId?: string }) => {
    const room = findRoom(socket.id);
    if (!room || room.status !== 'playing') return;
    const sender = room.players.find(p => p.id === socket.id);
    if (!sender || !sender.alive) return;

    // Cap base lines
    const baseLines = Math.min(Math.max(0, Math.floor(lines)), 4);
    if (baseLines <= 0) return;

    // Apply badge multiplier
    const mult = badgeMultiplier(sender.badges);
    const finalLines = Math.max(1, Math.round(baseLines * mult));

    // Determine target
    let tid = targetId || sender.targetId;
    if (!tid) tid = pickRandomTarget(room, socket.id);
    if (!tid) return;

    const target = room.players.find(p => p.id === tid && p.alive && p.id !== socket.id);
    if (!target) {
      // Target is dead, pick random
      const newTarget = pickRandomTarget(room, socket.id);
      if (!newTarget) return;
      tid = newTarget;
    }

    // Track who attacked this target (for 'attacker' targeting mode)
    const finalTarget = room.players.find(p => p.id === tid);
    if (finalTarget) {
      finalTarget.lastAttackerId = socket.id;
      io.to(tid).emit('receive_garbage', {
        lines: finalLines,
        fromId: socket.id,
        fromName: sender.name,
        fromBadges: sender.badges,
      });
    }
  });

  // ── Board update ─────────────────────────────────────────────────────────────
  socket.on('board_update', ({ board }: { board: (string | 0)[][] }) => {
    const room = findRoom(socket.id);
    if (!room || room.status !== 'playing') return;
    socket.to(room.id).emit('player_board', { playerId: socket.id, board });
  });

  // ── T99: Player died ─────────────────────────────────────────────────────────
  socket.on('player_dead', ({ time, score, lines }: { time: number; score: number; lines: number }) => {
    const room = findRoom(socket.id);
    if (!room) return;
    const dead = room.players.find(p => p.id === socket.id);
    if (!dead || !dead.alive) return;

    dead.alive = false;
    dead.survivalTime = time;
    dead.score = score;
    dead.lines = lines;

    // Find killer (last person to send this player garbage)
    const killerId = dead.lastAttackerId;
    const killer = killerId ? room.players.find(p => p.id === killerId && p.alive) : null;

    // Transfer badges
    const badgesTransferred = dead.badges;
    if (killer) {
      killer.badges += dead.badges + 1;
      killer.kos += 1;
    }

    // Anyone targeting this dead player: reassign them to random
    for (const p of room.players) {
      if (p.targetId === socket.id) {
        p.targetId = pickRandomTarget(room, p.id);
      }
    }

    io.to(room.id).emit('player_died', {
      playerId: socket.id,
      deadName: dead.name,
      killerId: killer?.id ?? null,
      killerName: killer?.name ?? null,
      badgesTransferred,
    });

    emitStatsUpdate(room);
    emitTargetsUpdate(room);
    checkGameEnd(room);
  });

  socket.on('disconnect', () => doLeave(socket));

  function doLeave(s: typeof socket) {
    playerNames.delete(s.id);
    const room = findRoom(s.id);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== s.id);
    s.leave(room.id);
    if (room.players.length === 0) {
      rooms.delete(room.id);
    } else {
      if (room.ownerId === s.id) room.ownerId = room.players[0].id;
      if (room.status === 'playing') {
        // Reassign targets pointing to disconnected player
        for (const p of room.players) {
          if (p.targetId === s.id) p.targetId = pickRandomTarget(room, p.id);
        }
        emitTargetsUpdate(room);
        checkGameEnd(room);
      }
      io.to(room.id).emit('room_updated', roomToClient(room));
    }
    broadcastRoomList();
  }
});

if (process.env.NODE_ENV === 'production') {
  const distDir = path.join(__dirname, '../dist/public');
  app.use(express.static(distDir));
  app.get('*', (_req, res) => { res.sendFile(path.join(distDir, 'index.html')); });
}

const PORT = parseInt(process.env.PORT || process.env.SOCKET_PORT || '3001', 10);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[socket-server] listening on :${PORT}`);
});
