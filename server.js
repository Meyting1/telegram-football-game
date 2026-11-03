const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true, game: "Neon Pitch", version: "0.2.0" }));

const rooms = new Map();
const W = 900, H = 560, R = 13, BALL_R = 8;
const GOAL_TOP = 220, GOAL_BOTTOM = 340, GOAL_DEPTH = 24;
const FRICTION = 0.985, WALL_BOUNCE = 0.82, DISC_BOUNCE = 0.92;
const TURN_MS = 15000;

function initialState() {
  const discs = [];
  for (let i = 0; i < 5; i++) {
    discs.push({ id: "a" + i, team: 0, x: 145 + (i % 2) * 42, y: 145 + Math.floor(i / 2) * 90, vx: 0, vy: 0 });
    discs.push({ id: "b" + i, team: 1, x: 755 - (i % 2) * 42, y: 145 + Math.floor(i / 2) * 90, vx: 0, vy: 0 });
  }
  return {
    width: W, height: H, discs,
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0 },
    scores: [0, 0], turn: 0, turnEndsAt: Date.now() + TURN_MS,
    status: "waiting", players: [null, null], lastGoal: null
  };
}
function roomSnapshot(room) {
  return { ...room.state, players: room.state.players.map(p => p ? p.name : null), roomCode: room.code };
}
function emitRoom(room) { io.to(room.code).emit("state", roomSnapshot(room)); }
function moving(room) {
  const s = room.state;
  const all = [...s.discs, s.ball];
  return all.some(o => Math.abs(o.vx) > 0.12 || Math.abs(o.vy) > 0.12);
}
function resetAfterGoal(room, scorer) {
  const s = room.state;
  s.scores[scorer]++;
  s.lastGoal = scorer;
  s.discs.forEach((d, i) => {
    d.vx = d.vy = 0;
    d.x = d.team === 0 ? 145 + (i % 2) * 42 : 755 - (i % 2) * 42;
    d.y = 145 + Math.floor((i % 5) / 2) * 90;
  });
  s.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
  s.turn = 1 - scorer;
  s.turnEndsAt = Date.now() + TURN_MS;
}
function step(room) {
  const s = room.state;
  if (s.status !== "playing") return;
  const objects = [...s.discs, s.ball];
  for (const o of objects) {
    o.x += o.vx; o.y += o.vy;
    o.vx *= FRICTION; o.vy *= FRICTION;
    if (Math.abs(o.vx) < 0.025) o.vx = 0;
    if (Math.abs(o.vy) < 0.025) o.vy = 0;

    // Side walls, with an opening for the goals.
    if (o.y < R) { o.y = R; o.vy = Math.abs(o.vy) * WALL_BOUNCE; }
    if (o.y > H - R) { o.y = H - R; o.vy = -Math.abs(o.vy) * WALL_BOUNCE; }
    const inGoalMouth = o.y > GOAL_TOP && o.y < GOAL_BOTTOM;
    if (!inGoalMouth) {
      if (o.x < R) { o.x = R; o.vx = Math.abs(o.vx) * WALL_BOUNCE; }
      if (o.x > W - R) { o.x = W - R; o.vx = -Math.abs(o.vx) * WALL_BOUNCE; }
    }
  }

  // Disc-disc and disc-ball collisions.
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      const a = objects[i], b = objects[j];
      const ra = a === s.ball ? BALL_R : R, rb = b === s.ball ? BALL_R : R;
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      const min = ra + rb;
      if (dist === 0) { dx = 0.01; dy = 0; dist = 0.01; }
      if (dist < min) {
        const nx = dx / dist, ny = dy / dist;
        const overlap = min - dist;
        a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
        b.x += nx * overlap / 2; b.y += ny * overlap / 2;
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel < 0) {
          const impulse = -(1 + DISC_BOUNCE) * rel / 2;
          a.vx -= impulse * nx; a.vy -= impulse * ny;
          b.vx += impulse * nx; b.vy += impulse * ny;
        }
      }
    }
  }

  // Goal detection: the ball must cross the end line inside the mouth.
  if (s.ball.x < -BALL_R && s.ball.y > GOAL_TOP && s.ball.y < GOAL_BOTTOM) {
    resetAfterGoal(room, 1);
    io.to(room.code).emit("goal", { scorer: 1 });
  } else if (s.ball.x > W + BALL_R && s.ball.y > GOAL_TOP && s.ball.y < GOAL_BOTTOM) {
    resetAfterGoal(room, 0);
    io.to(room.code).emit("goal", { scorer: 0 });
  }

  if (!moving(room)) {
    if (Date.now() >= s.turnEndsAt) {
      s.turn = 1 - s.turn;
      s.turnEndsAt = Date.now() + TURN_MS;
    }
  }
}
setInterval(() => {
  for (const room of rooms.values()) {
    step(room);
    emitRoom(room);
  }
}, 1000 / 30);

io.on("connection", socket => {
  socket.on("joinRoom", ({ code, name }) => {
    code = String(code || "").trim().toUpperCase().slice(0, 8);
    name = String(name || "Player").trim().slice(0, 18);
    if (!code) return socket.emit("notice", "Room code is required.");
    let room = rooms.get(code);
    if (!room) {
      room = { code, state: initialState() };
      rooms.set(code, room);
    }
    let slot = room.state.players.findIndex(p => p && p.id === socket.id);
    if (slot < 0) slot = room.state.players.findIndex(p => !p);
    if (slot < 0) return socket.emit("notice", "This room is full.");
    room.state.players[slot] = { id: socket.id, name };
    socket.join(code);
    if (room.state.players.every(Boolean)) {
      room.state.status = "playing";
      room.state.turnEndsAt = Date.now() + TURN_MS;
    }
    socket.data.roomCode = code;
    socket.data.slot = slot;
    socket.emit("joined", { code, slot });
    emitRoom(room);
  });

  socket.on("shoot", ({ discId, dx, dy, power }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.state.status !== "playing") return;
    const s = room.state, slot = socket.data.slot;
    if (slot !== s.turn || moving(room)) return;
    if (Date.now() > s.turnEndsAt) return;
    const disc = s.discs.find(d => d.id === discId && d.team === slot);
    if (!disc) return;
    let x = Number(dx), y = Number(dy), p = Number(power);
    if (![x, y, p].every(Number.isFinite)) return;
    const len = Math.hypot(x, y) || 1;
    p = Math.max(0, Math.min(14, p));
    disc.vx = (x / len) * p;
    disc.vy = (y / len) * p;
    s.turnEndsAt = Date.now() + TURN_MS + 10000;
    emitRoom(room);
  });
  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const slot = socket.data.slot;
    if (room.state.players[slot]?.id === socket.id) room.state.players[slot] = null;
    room.state.status = "waiting";
    emitRoom(room);
  });
});

server.listen(PORT, () => console.log(`Neon Pitch listening on ${PORT}`));
