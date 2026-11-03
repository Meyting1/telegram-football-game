const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const rooms = new Map();
const makeCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();

function publicRoom(room) {
  return {
    code: room.code,
    players: room.players.map(p => ({ id: p.id, name: p.name })),
    started: room.players.length === 2,
    turn: room.turn
  };
}

io.on("connection", socket => {
  socket.on("joinRoom", ({ code, name }) => {
    let roomCode = (code || "").trim().toUpperCase();
    if (!roomCode) {
      do { roomCode = makeCode(); } while (rooms.has(roomCode));
      rooms.set(roomCode, { code: roomCode, players: [], turn: 0, busy: false });
    }
    const room = rooms.get(roomCode);
    if (!room || room.players.length >= 2 || room.players.some(p => p.id === socket.id)) {
      socket.emit("joinError", "این اتاق وجود ندارد یا ظرفیت آن تکمیل شده است.");
      return;
    }
    room.players.push({ id: socket.id, name: (name || "بازیکن").slice(0, 18) });
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerIndex = room.players.length - 1;
    io.to(roomCode).emit("roomUpdate", publicRoom(room));
    if (room.players.length === 2) {
      io.to(roomCode).emit("gameStart", { firstTurn: room.turn });
    }
  });

  socket.on("shoot", data => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.players.length !== 2 || room.busy) return;
    if (room.players[room.turn]?.id !== socket.id) return;
    const disc = Number(data?.disc);
    const vx = Number(data?.vx);
    const vy = Number(data?.vy);
    if (!Number.isInteger(disc) || disc < 0 || disc > 4 ||
        !Number.isFinite(vx) || !Number.isFinite(vy) ||
        Math.hypot(vx, vy) > 850) return;
    room.busy = true;
    io.to(room.code).emit("shot", { player: room.turn, disc, vx, vy });
  });

  socket.on("turnFinished", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.busy) return;
    // Only the active player may finish the turn.
    if (room.players[room.turn]?.id !== socket.id) return;
    room.turn = 1 - room.turn;
    room.busy = false;
    io.to(room.code).emit("turnUpdate", { turn: room.turn });
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    rooms.delete(code);
    io.to(code).emit("opponentLeft");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game server listening on http://localhost:${PORT}`));
