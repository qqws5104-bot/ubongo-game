"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { GameRoom } = require("./game-room");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf-8");
// 클라이언트의 자동 재접속 지연(1.2초, build_client.py의 connectWS)보다 넉넉히 길게 잡아서, 순간적인
// 연결 끊김 정도는 "진짜로 나감"으로 오인하지 않도록 하는 유예 시간. ws.on("close")에서 사용.
const SEAT_RELEASE_GRACE_MS = 5000;

// ---- room registry ----
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I -- avoids read-aloud ambiguity
function makeRoomCode() {
  let s = "";
  for (let i = 0; i < 4; i++) s += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
  return s;
}

const rooms = new Map(); // code -> { room: GameRoom, sockets: Set<{ws, clientId, seat}> }

function getOrCreateRoom(code) {
  let entry = rooms.get(code);
  if (!entry) {
    const room = new GameRoom(code, (state) => broadcast(code, state));
    entry = { room, sockets: new Set() };
    rooms.set(code, entry);
  }
  return entry;
}

function broadcast(code, state) {
  const entry = rooms.get(code);
  if (!entry) return;
  const payload = JSON.stringify({ type: "state", state });
  for (const conn of entry.sockets) {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(payload);
  }
}

// periodic sweep: drop rooms that have had zero open sockets for a while, so a long-lived
// (non-free-tier) deployment doesn't accumulate abandoned game state forever
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of rooms) {
    if (entry.sockets.size === 0 && now - entry.room.lastActivityAt > 30 * 60 * 1000) {
      entry.room.destroy();
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

// ---- http server: redirect bare "/" to a fresh room, serve the client for "/?room=CODE" ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://" + req.headers.host);
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (url.pathname !== "/") {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const room = url.searchParams.get("room");
  if (!room) {
    let code = makeRoomCode();
    while (rooms.has(code)) code = makeRoomCode(); // astronomically unlikely, but keep it honest
    res.writeHead(302, { location: "/?room=" + code });
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(INDEX_HTML);
});

// ---- websocket layer ----
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://" + req.headers.host);
  const code = (url.searchParams.get("room") || "").toUpperCase();
  if (!code) { ws.close(4000, "missing room"); return; }
  const entry = getOrCreateRoom(code);
  const conn = { ws, clientId: null, seat: null };
  entry.sockets.add(conn);

  ws.send(JSON.stringify({ type: "state", state: entry.room.state }));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    const { type, clientId, seat } = msg;
    if (typeof clientId === "string" && clientId) conn.clientId = clientId;
    if (seat === "1" || seat === "2") conn.seat = seat;

    switch (type) {
      case "hello":
        // nothing further to do -- state was already sent on connect; this just registers
        // clientId/seat on the connection object (above) for disconnect bookkeeping
        break;
      case "pick-seat": {
        if (!conn.clientId || (seat !== "1" && seat !== "2")) return;
        const res = entry.room.pickSeat(seat, conn.clientId);
        if (!res.ok) ws.send(JSON.stringify({ type: "error", code: res.code, seat }));
        break;
      }
      // 2026-08-27 신설: 좌석 선택 화면이 "플레이어 1/2" 대신 가상 택배사 아이콘 5개를 보여주면서
      // 생긴 메시지 -- 클라이언트는 자기가 몇 번 좌석이 될지 미리 모르므로 courierKey만 보내고,
      // 좌석 번호는 room.pickCourier가 정해서 돌려준다. 성공하면 그 좌석 번호를 이 커넥션에도
      // 기록해둬야(conn.seat) 뒤이은 secure-cell/vote 같은 메시지들이 제대로 처리된다 -- pick-seat과
      // 달리 이 메시지엔 seat 필드가 없어서 위쪽의 공통 destructuring이 대신 채워주지 못한다.
      case "pick-courier": {
        if (!conn.clientId || typeof msg.courier !== "string") return;
        const res = entry.room.pickCourier(msg.courier, conn.clientId);
        if (res.ok) conn.seat = res.seat;
        else ws.send(JSON.stringify({ type: "error", code: res.code }));
        break;
      }
      case "set-ready":
        if (!conn.seat) return;
        entry.room.setReady(conn.seat);
        break;
      case "elevator-ready":
        if (!conn.seat) return;
        entry.room.setElevatorReady(conn.seat);
        break;
      case "secure-cell":
        if (!conn.seat || typeof msg.cellId !== "string") return;
        entry.room.secureCell(conn.seat, msg.cellId);
        break;
      case "vote":
        if (!conn.seat || (msg.dir !== "up" && msg.dir !== "down")) return;
        entry.room.vote(conn.seat, msg.dir);
        break;
      case "set-priority":
        if (!conn.seat || (msg.invoiceId !== null && typeof msg.invoiceId !== "string")) return;
        entry.room.setPriorityPick(conn.seat, msg.invoiceId);
        break;
      case "choose-delivery":
        if (!conn.seat || typeof msg.invoiceId !== "string") return;
        entry.room.chooseDelivery(conn.seat, msg.invoiceId);
        break;
      case "place-thief":
        if (!conn.seat || (msg.floorIdx !== null && typeof msg.floorIdx !== "number")) return;
        entry.room.placeThief(conn.seat, msg.floorIdx);
        break;
      case "halftime-ready":
        if (!conn.seat) return;
        entry.room.halftimeReady(conn.seat);
        break;
      case "restart-ready":
        // 2026-08-28 신설: 종료 화면의 "다시 시작" 버튼 -- 같은 방에서 좌석/택배사 유지한 채 새 게임.
        if (!conn.seat) return;
        entry.room.restartReady(conn.seat);
        break;
      default:
        break;
    }
  });

  ws.on("close", () => {
    entry.sockets.delete(conn);
    if (conn.seat && conn.clientId) {
      const seat = conn.seat;
      const clientId = conn.clientId;
      // 2026-08-28 버그 수정: 예전엔 close 즉시(유예 없이) releaseSeatIfOrphaned를 불렀다. 그런데
      // 클라이언트는 연결이 끊기면 1.2초 뒤 자동 재접속하도록 되어 있어서(build_client.py의
      // connectWS/ws.onclose), 와이파이 순단·탭 백그라운드·모바일 화면 잠금처럼 아주 흔한 순간적
      // 끊김에도 "재접속하기 전" 시점에 이 코드가 먼저 실행돼 로비 단계의 courierPick까지 매번
      // 지워버렸다 -- 재접속 시 pick-seat으로 좌석은 되찾지만 courierPick은 다시 안 보내므로,
      // 결과적으로 화면엔 "택배사 선택" 대신 (아무도 못 고른 채) "스페이스바 대기" 화면만 뜨는
      // 버그로 이어졌다("한번씩 대기 시간에 택배사 선택이 안 떠" 리포트). 진짜로 나간 사람과
      // 순간적 재접속을 구분하기 위해, 해제를 지연시키고 그 사이에 같은 clientId가 다시 붙으면
      // (stillConnected를 그 시점에 다시 계산하므로) 해제를 건너뛴다.
      setTimeout(() => {
        const stillConnected = new Set(Array.from(entry.sockets).map((c) => c.clientId).filter(Boolean));
        entry.room.releaseSeatIfOrphaned(seat, clientId, stillConnected);
      }, SEAT_RELEASE_GRACE_MS);
    }
  });
});

server.listen(PORT, () => {
  console.log("live_game server listening on port " + PORT);
});
