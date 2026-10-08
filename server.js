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

const rooms = new Map(); // code -> { room: GameRoom, sockets: Set<{ws, clientId, seat, role}>, busy: {"1":bool,"2":bool} }

function getOrCreateRoom(code) {
  let entry = rooms.get(code);
  if (!entry) {
    const room = new GameRoom(code, (state) => broadcast(code, state));
    // busy: 레일 화면(/rail)이 열어 준 미니게임을 그 좌석 플레이어가 지금 하고 있는가 (레일 화면에 "플레이 중" 표시 + 중복 지시 방지).
    entry = { room, sockets: new Set(), busy: { "1": false, "2": false } };
    rooms.set(code, entry);
  }
  return entry;
}

function railInfo(entry) {
  let count = 0;
  for (const c of entry.sockets) if (c.role === "rail") count++;
  return { count, busy: entry.busy };
}

function broadcast(code, state) {
  const entry = rooms.get(code);
  if (!entry) return;
  // 확보 단계가 아니면 레일이 연 게임은 의미가 없다 -- 여기서 한 번에 정리한다.
  if (state.phase !== "secure") entry.busy = { "1": false, "2": false };
  // now: 서버 시계. 메인 모니터는 따로 있는 기기라 기기 시계가 어긋나 있을 수 있어서, 이 값으로 오차를 보정한다.
  // rail: 지금 접속 중인 레일 화면 수 + 좌석별 플레이 중 여부. 플레이어 화면은 rail.count > 0이면 "레일 화면에서 누르세요" 모드가 된다.
  const payload = JSON.stringify({ type: "state", state, now: Date.now(), rail: railInfo(entry) });
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
  // 2026-10-07: /rail 은 레일 사이트(공용 레일 화면). 방 코드가 없으면 화면이 코드 입력칸을 보여 주므로(새 방을 만들지 않는다 --
  // 레일 화면은 이미 있는 방에 붙는 것) 같은 클라이언트를 그대로 내려준다.
  if (url.pathname === "/rail") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(INDEX_HTML);
    return;
  }
  if (url.pathname !== "/") {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const room = url.searchParams.get("room");
  if (!room && url.searchParams.get("view") === "rail") {
    res.writeHead(302, { location: "/rail" });
    res.end();
    return;
  }
  if (!room) {
    let code = makeRoomCode();
    while (rooms.has(code)) code = makeRoomCode(); // astronomically unlikely, but keep it honest
    // ?view=main(메인 모니터)으로 들어온 경우 방을 새로 만들면서도 그 표시를 유지한다.
    res.writeHead(302, { location: "/?room=" + code + (url.searchParams.get("view") === "main" ? "&view=main" : "") });
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(INDEX_HTML);
});

// ---- 레일 화면(/rail)의 버튼 처리 ----
// side 쪽 플레이어가 풀 칸을 정해서(room.railCellFor) 그 좌석 주인의 모든 연결에 "open-game"을 보낸다.
// 칸 확보는 여전히 플레이어가 게임을 끝내고 보내는 secure-cell 한 가지뿐이다 (서버 규칙은 그대로).
function handleRailPress(entry, code, msg) {
  const side = msg.side;
  if (side !== "1" && side !== "2") return;
  if (!Number.isInteger(msg.cat)) return;
  if (entry.busy[side]) return; // 이미 게임 중
  const cellId = entry.room.railCellFor(side, msg.cat, typeof msg.cellId === "string" ? msg.cellId : null);
  if (!cellId) return;
  const owner = entry.room.state.seatOwners[side];
  let delivered = 0;
  const payload = JSON.stringify({ type: "open-game", cellId });
  for (const c of entry.sockets) {
    if (c.role !== "rail" && c.clientId === owner && c.ws.readyState === c.ws.OPEN) { c.ws.send(payload); delivered++; }
  }
  if (!delivered) return; // 그 플레이어가 지금 접속 중이 아니면 무시
  entry.busy[side] = true;
  broadcast(code, entry.room.state);
}

// ---- websocket layer ----
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://" + req.headers.host);
  const code = (url.searchParams.get("room") || "").toUpperCase();
  if (!code) { ws.close(4000, "missing room"); return; }
  const entry = getOrCreateRoom(code);
  const conn = { ws, clientId: null, seat: null, role: url.searchParams.get("role") === "rail" ? "rail" : "player" };
  entry.sockets.add(conn);
  // 레일 화면이 붙거나 떠나면 모두에게 알린다 (플레이어 화면이 "레일 모드"로 바뀌고 돌아오도록).
  if (conn.role === "rail") broadcast(code, entry.room.state);

  ws.send(JSON.stringify({ type: "state", state: entry.room.state, now: Date.now(), rail: railInfo(entry) }));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    const { type, clientId, seat } = msg;
    if (typeof clientId === "string" && clientId) conn.clientId = clientId;
    if (conn.role === "rail") {
      // 레일 화면은 좌석이 없고 오직 rail-press만 보낼 수 있다 (플레이어 메시지를 흉내내 게임을 건드리지 못하게).
      if (type === "rail-press") handleRailPress(entry, code, msg);
      return;
    }
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
      case "secure-cell": {
        if (!conn.seat || typeof msg.cellId !== "string") return;
        const wasBusy = entry.busy[conn.seat];
        entry.busy[conn.seat] = false; // 끝냈으니 레일 화면에서 다시 누를 수 있다 (room.secureCell의 브로드캐스트에 같이 실려 간다)
        entry.room.secureCell(conn.seat, msg.cellId);
        if (wasBusy) broadcast(code, entry.room.state); // 중복 메시지라 room이 방송을 안 했을 때를 위해
        break;
      }
      case "game-closed":
        // 플레이어가 레일이 열어 준 게임을 포기/닫았다 -> 다시 누를 수 있게.
        if (!conn.seat) return;
        if (entry.busy[conn.seat]) { entry.busy[conn.seat] = false; broadcast(code, entry.room.state); }
        break;
      case "vote":
        if (!conn.seat || (msg.dir !== "up" && msg.dir !== "down")) return;
        entry.room.vote(conn.seat, msg.dir);
        break;
      case "set-priority":
        if (!conn.seat || (msg.invoiceId !== null && typeof msg.invoiceId !== "string")) return;
        entry.room.setPriorityPick(conn.seat, msg.invoiceId);
        break;
      case "confirm-priority":
        if (!conn.seat) return;
        entry.room.confirmPriority(conn.seat);
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
    if (conn.role === "rail") { broadcast(code, entry.room.state); return; }
    // 게임 중이던 플레이어가 탭을 닫았으면 레일 화면이 영영 "플레이 중"에 묶이지 않게 푼다 (같은 clientId가 다른 연결로 남아 있으면 유지).
    if (conn.seat && entry.busy[conn.seat]) {
      const stillThere = Array.from(entry.sockets).some((c) => c.role !== "rail" && c.clientId && c.clientId === conn.clientId);
      if (!stillThere) { entry.busy[conn.seat] = false; broadcast(code, entry.room.state); }
    }
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
