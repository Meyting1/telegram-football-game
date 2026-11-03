const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true, game: "Neon Pitch", version: "0.3.0" }));

const rooms = new Map();
const W = 900, H = 560, DISC_R = 16, BALL_R = 9;
const GOAL_TOP = 215, GOAL_BOTTOM = 345;
const TURN_MS = 15000;

function makeState() {
  const discs = [];
  for (let i = 0; i < 5; i++) {
    const y = 150 + i * 65;
    discs.push({ id: `a${i}`, team: 0, x: 150 + (i % 2) * 28, y, vx: 0, vy: 0 });
    discs.push({ id: `b${i}`, team: 1, x: 750 - (i % 2) * 28, y, vx: 0, vy: 0 });
  }
  return {
    width: W, height: H, discs,
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0 },
    scores: [0, 0], turn: 0, turnEndsAt: Date.now() + TURN_MS,
    status: "waiting", players: [null, null], lastGoal: null
  };
}
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function snapshot(room) {
  return {
    ...room.state,
    players: room.state.players.map(p => p ? p.name : null),
    roomCode: room.code
  };
}
function emitState(room) {
  io.to(room.code).emit("state", snapshot(room));
}
function isMoving(room) {
  return [...room.state.discs, room.state.ball].some(o =>
    Math.abs(o.vx) > 0.10 || Math.abs(o.vy) > 0.10
  );
}
function resetAfterGoal(room, scorer) {
  const s = room.state;
  s.scores[scorer]++;
  s.lastGoal = scorer;
  s.discs.forEach((d, i) => {
    d.vx = 0; d.vy = 0;
    const row = i % 5;
    d.x = d.team === 0 ? 150 + (row % 2) * 28 : 750 - (row % 2) * 28;
    d.y = 150 + row * 65;
  });
  s.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
  s.turn = 1 - scorer;
  s.turnEndsAt = Date.now() + TURN_MS;
}
function tick(room) {
  const s = room.state;
  if (s.status !== "playing") return;

  const objects = [...s.discs, s.ball];
  for (const o of objects) {
    o.x += o.vx; o.y += o.vy;
    o.vx *= 0.986; o.vy *= 0.986;
    if (Math.abs(o.vx) < 0.025) o.vx = 0;
    if (Math.abs(o.vy) < 0.025) o.vy = 0;

    const r = o === s.ball ? BALL_R : DISC_R;
    if (o.y < r) { o.y = r; o.vy = Math.abs(o.vy) * 0.82; }
    if (o.y > H - r) { o.y = H - r; o.vy = -Math.abs(o.vy) * 0.82; }

    const inMouth = o.y > GOAL_TOP && o.y < GOAL_BOTTOM;
    if (!inMouth) {
      if (o.x < r) { o.x = r; o.vx = Math.abs(o.vx) * 0.82; }
      if (o.x > W - r) { o.x = W - r; o.vx = -Math.abs(o.vx) * 0.82; }
    }
  }

  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      const a = objects[i], b = objects[j];
      const ra = a === s.ball ? BALL_R : DISC_R;
      const rb = b === s.ball ? BALL_R : DISC_R;
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      const minDist = ra + rb;
      if (dist < minDist) {
        if (dist < 0.001) { dx = 1; dy = 0; dist = 1; }
        const nx = dx / dist, ny = dy / dist;
        const overlap = minDist - dist;
        a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
        b.x += nx * overlap / 2; b.y += ny * overlap / 2;
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel < 0) {
          const impulse = -(1 + 0.9) * rel / 2;
          a.vx -= impulse * nx; a.vy -= impulse * ny;
          b.vx += impulse * nx; b.vy += impulse * ny;
        }
      }
    }
  }

  if (s.ball.x < -BALL_R && s.ball.y > GOAL_TOP && s.ball.y < GOAL_BOTTOM) {
    resetAfterGoal(room, 1);
    io.to(room.code).emit("goal", { scorer: 1 });
  } else if (s.ball.x > W + BALL_R && s.ball.y > GOAL_TOP && s.ball.y < GOAL_BOTTOM) {
    resetAfterGoal(room, 0);
    io.to(room.code).emit("goal", { scorer: 0 });
  }

  if (!isMoving(room) && Date.now() >= s.turnEndsAt) {
    s.turn = 1 - s.turn;
    s.turnEndsAt = Date.now() + TURN_MS;
  }
}
setInterval(() => {
  for (const room of rooms.values()) {
    tick(room);
    emitState(room);
  }
}, 1000 / 30);

function addPlayer(socket, room, slot, name) {
  room.state.players[slot] = { id: socket.id, name };
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.slot = slot;
  if (room.state.players.every(Boolean)) {
    room.state.status = "playing";
    room.state.turnEndsAt = Date.now() + TURN_MS;
  }
  socket.emit("joined", { code: room.code, slot });
  emitState(room);
}
function cleanName(value) {
  return String(value || "Player").trim().slice(0, 18) || "Player";
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name } = {}) => {
    const code = makeCode();
    const room = { code, state: makeState() };
    rooms.set(code, room);
    addPlayer(socket, room, 0, cleanName(name));
  });

  socket.on("joinRoom", ({ code, name } = {}) => {
    code = String(code || "").trim().toUpperCase().slice(0, 8);
    const room = rooms.get(code);
    if (!room) return socket.emit("notice", "اتاقی با این کد پیدا نشد.");
    const slot = room.state.players.findIndex(p => !p);
    if (slot < 0) return socket.emit("notice", "این اتاق پر است.");
    addPlayer(socket, room, slot, cleanName(name));
  });

  socket.on("shoot", ({ discId, dx, dy, power } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state.status !== "playing") return;
    const s = room.state, slot = socket.data.slot;
    if (slot !== s.turn || isMoving(room) || Date.now() > s.turnEndsAt) return;
    const disc = s.discs.find(d => d.id === discId && d.team === slot);
    if (!disc) return;
    let x = Number(dx), y = Number(dy), p = Number(power);
    if (![x, y, p].every(Number.isFinite)) return;
    const length = Math.hypot(x, y) || 1;
    p = Math.max(0, Math.min(14, p));
    disc.vx = (x / length) * p;
    disc.vy = (y / length) * p;
    s.turnEndsAt = Date.now() + 25000;
    emitState(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const slot = socket.data.slot;
    if (room.state.players[slot]?.id === socket.id) {
      room.state.players[slot] = null;
      room.state.status = "waiting";
      emitState(room);
    }
  });
});

server.listen(PORT, () => console.log(`Neon Pitch listening on ${PORT}`));
