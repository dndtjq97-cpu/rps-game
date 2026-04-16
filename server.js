const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const os = require("os");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

// 다인원 가위바위보 결과 판정
// 2종만 나오면 이기는 쪽 win, 지는 쪽 lose
// 전원 동일 or 3종 전부 → 전원 draw
const beats = { 가위: "보", 바위: "가위", 보: "바위" };

function judgeRound(players) {
  const types = new Set(players.map((p) => p.choice));

  if (types.size === 1 || types.size === 3) {
    return players.map((p) => ({ ...p, result: "draw" }));
  }

  // 2종: 이기는 쪽 찾기
  const [a, b] = [...types];
  const winner = beats[a] === b ? a : b;

  return players.map((p) => ({
    ...p,
    result: p.choice === winner ? "win" : "lose",
  }));
}

function roomInfo(room) {
  return {
    code: room.code,
    state: room.state,
    hostName: room.hostName,
    players: room.players.map((p) => ({ name: p.name, isHost: p.isHost })),
    round: room.round,
  };
}

io.on("connection", (socket) => {
  console.log(`접속: ${socket.id}`);

  socket.on("create-room", (name) => {
    const code = generateCode();
    const room = {
      code,
      state: "lobby",
      hostId: socket.id,
      hostName: name,
      players: [{ socket, id: socket.id, name, isHost: true, choice: null, score: { win: 0, lose: 0, draw: 0 } }],
      round: 1,
    };
    rooms.set(code, room);

    socket.data = { name, roomCode: code };
    socket.join(code);
    io.to(code).emit("room-update", roomInfo(room));
  });

  socket.on("join-room", ({ name, code }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit("error-msg", "존재하지 않는 방 코드입니다.");
    if (room.state !== "lobby") return socket.emit("error-msg", "이미 게임이 진행 중인 방입니다.");
    if (room.players.length >= 10) return socket.emit("error-msg", "방이 가득 찼습니다. (최대 10명)");
    if (room.players.some((p) => p.name === name)) return socket.emit("error-msg", "이미 같은 이름이 있습니다.");

    room.players.push({ socket, id: socket.id, name, isHost: false, choice: null, score: { win: 0, lose: 0, draw: 0 } });
    socket.data = { name, roomCode: code };
    socket.join(code);
    io.to(code).emit("room-update", roomInfo(room));
  });

  socket.on("start-game", () => {
    const code = socket.data?.roomCode;
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) return socket.emit("error-msg", "2명 이상이어야 시작할 수 있습니다.");

    room.state = "playing";
    room.round = 1;
    room.players.forEach((p) => (p.choice = null));
    io.to(code).emit("game-start", { round: room.round, playerCount: room.players.length });
  });

  socket.on("choose", (choice) => {
    const code = socket.data?.roomCode;
    const room = rooms.get(code);
    if (!room || room.state !== "playing") return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.choice) return;

    player.choice = choice;

    const chosen = room.players.filter((p) => p.choice).length;
    const total = room.players.length;

    // 선택 진행 상황 브로드캐스트
    io.to(code).emit("choose-progress", { chosen, total });

    // 전원 선택 완료
    if (chosen === total) {
      const results = judgeRound(
        room.players.map((p) => ({ name: p.name, choice: p.choice }))
      );

      // 스코어 업데이트
      results.forEach((r) => {
        const p = room.players.find((pl) => pl.name === r.name);
        p.score[r.result]++;
      });

      io.to(code).emit("round-result", {
        round: room.round,
        results,
        scores: room.players.map((p) => ({ name: p.name, score: p.score })),
      });

      room.round++;
      room.players.forEach((p) => (p.choice = null));
    }
  });

  socket.on("next-round", () => {
    const code = socket.data?.roomCode;
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;

    room.state = "playing";
    room.players.forEach((p) => (p.choice = null));
    io.to(code).emit("game-start", { round: room.round, playerCount: room.players.length });
  });

  socket.on("disconnect", () => {
    console.log(`퇴장: ${socket.id}`);
    const code = socket.data?.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    room.players = room.players.filter((p) => p.id !== socket.id);

    if (room.players.length === 0) {
      rooms.delete(code);
      return;
    }

    // 호스트가 나가면 다음 사람에게 호스트 이전
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
      room.hostName = room.players[0].name;
      room.players[0].isHost = true;
    }

    io.to(code).emit("room-update", roomInfo(room));
    io.to(code).emit("player-left", socket.data.name);

    // 게임 중 나간 경우: 남은 인원이 전원 선택 완료면 결과 처리
    if (room.state === "playing" && room.players.length >= 2) {
      const chosen = room.players.filter((p) => p.choice).length;
      if (chosen === room.players.length) {
        const results = judgeRound(
          room.players.map((p) => ({ name: p.name, choice: p.choice }))
        );
        results.forEach((r) => {
          const p = room.players.find((pl) => pl.name === r.name);
          p.score[r.result]++;
        });
        io.to(code).emit("round-result", {
          round: room.round,
          results,
          scores: room.players.map((p) => ({ name: p.name, score: p.score })),
        });
        room.round++;
        room.players.forEach((p) => (p.choice = null));
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  const addresses = [];
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === "IPv4" && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  console.log(`\n가위바위보 설거지빵 서버 시작!`);
  console.log(`로컬: http://localhost:${PORT}`);
  addresses.forEach((addr) => console.log(`네트워크: http://${addr}:${PORT}`));
  console.log();
});
