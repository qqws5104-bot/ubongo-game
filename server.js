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
const BUILD_TAG = ((INDEX_HTML.match(/var BUILD_TAG = "([^"]*)"/) || [])[1]) || "unknown";
// 클라이언트의 자동 재접속 지연(1.2초, build_client.py의 connectWS)보다 넉넉히 길게 잡아서, 순간적인
// 연결 끊김 정도는 "진짜로 나감"으로 오인하지 않도록 하는 유예 시간. ws.on("close")에서 사용.
const SEAT_RELEASE_GRACE_MS = 5000;

// ---- 2026-10-21 플레이 기록 (원래 playlog.js -- 배포 파일 4개를 유지하려고 여기에 넣음) ----
const PLAYLOG = (() => {

const MAX = 20000;
const DIR = path.join(__dirname, "logs");
const FILE = path.join(DIR, "playlog.jsonl");
let events = [];
let label = process.env.PLAYLOG_LABEL || ""; // 테스트 조건 이름 (예: "test1-공개", "test1-기본")

try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {}

function add(ev) {
  const e = label ? Object.assign({ label }, ev) : ev;
  events.push(e);
  if (events.length > MAX) events.shift();
  try { fs.appendFile(FILE, JSON.stringify(e) + "\n", () => {}); } catch (err) {}
}
function clear(newLabel) { events = []; if (typeof newLabel === "string") label = newLabel.slice(0, 40); }
function all() { return events; }
function getLabel() { return label; }

const KIND = { react: "바코드 스캔", pick: "송장 주소 확인", mash: "테이프 붙이기", arrows: "배달 길 외우기" };
const BLD = { apt: "아파트", mansion: "맨션", house: "주택" };
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const sec = (ms) => (ms == null ? "—" : (ms / 1000).toFixed(1) + "초");
const pct = (n, d) => (d ? Math.round((n / d) * 100) + "%" : "—");
const num = (x, d) => (x == null ? "—" : x.toFixed(d == null ? 1 : d));

// 요약 숫자 (JSON) -- 테스트 2·3의 표가 이걸로 만들어진다
function summarize(list) {
  const ev = list || events;
  const pieces = ev.filter((e) => e.t === "piece");
  const games = {};
  pieces.forEach((e) => {
    const k = (e.kind || "?") + "|" + (e.half || 1);
    const g = games[k] || (games[k] = { kind: e.kind, half: e.half || 1, n: 0, ms: [], fails: [], timeouts: [] });
    g.n++; if (e.ms != null) g.ms.push(e.ms); if (e.fails != null) g.fails.push(e.fails); if (e.timeouts != null) g.timeouts.push(e.timeouts);
  });
  const fin = ev.filter((e) => e.t === "finish");
  const firsts = fin.filter((e) => e.first), seconds = fin.filter((e) => !e.first);
  const rounds = ev.filter((e) => e.t === "round").length;
  const picks = ev.filter((e) => e.t === "picks");
  const firstPick = { apt: 0, mansion: 0, house: 0 }, offered = { apt: 0, mansion: 0, house: 0 };
  let lateRandom = 0;
  picks.forEach((p) => {
    p.offered.forEach((o) => { if (o.b) offered[o.b]++; });
    if (p.first) (p.picks[p.first] || []).forEach((o) => { if (o.b) firstPick[o.b]++; });
    const late = p.first === "1" ? "2" : "1";
    if (p.random && p.random[late]) lateRandom++;
  });
  const del = ev.filter((e) => e.t === "deliver"), blk = ev.filter((e) => e.t === "blocked");
  const blds = {};
  ["apt", "mansion", "house"].forEach((b) => {
    const d = del.filter((e) => e.b === b), k = blk.filter((e) => e.b === b);
    blds[b] = { done: d.length, ms: med(d.map((e) => e.ms)), blocked: k.length };
  });
  const halves = ev.filter((e) => e.t === "half");
  const src = { first: { n: 0, done: 0 }, late: { n: 0, done: 0 }, random: { n: 0, done: 0 } };
  halves.forEach((h) => ["1", "2"].forEach((s) => ["first", "late", "random"].forEach((k) => { src[k].n += h.per[s][k].n; src[k].done += h.per[s][k].done; })));
  return {
    label, events: ev.length, rounds,
    games: Object.values(games).map((g) => ({ kind: g.kind, half: g.half, n: g.n, msAvg: avg(g.ms), msMed: med(g.ms), failsAvg: avg(g.fails), timeoutsAvg: avg(g.timeouts) })),
    race: { firstFinishMed: med(firsts.map((e) => e.sinceRound)), gapMed: med(seconds.filter((e) => e.gapMs != null).map((e) => e.gapMs)),
      assembleMed: med(fin.filter((e) => e.assembleMs != null).map((e) => e.assembleMs)), lateFinished: seconds.length, lateRandom,
      // 1등이 들어올 때 상대가 어디까지 왔었나 (팽팽했는지)
      oppAtFirst: firsts.reduce((o, e) => { o[e.oppStage || "?"] = (o[e.oppStage || "?"] || 0) + 1; return o; }, {}) },
    picks: { firstPick, offered, rounds: picks.length },
    delivery: blds,
    bySource: src,
  };
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function summaryHtml() {
  const s = summarize();
  const row = (cells) => "<tr>" + cells.map((c) => "<td>" + c + "</td>").join("") + "</tr>";
  const head = (cells) => "<tr>" + cells.map((c) => "<th>" + c + "</th>").join("") + "</tr>";
  const games = s.games.sort((a, b) => (a.kind > b.kind ? 1 : -1) || a.half - b.half)
    .map((g) => row([esc(KIND[g.kind] || g.kind), g.half === 2 ? "후반" : "전반", g.n, sec(g.msMed), sec(g.msAvg), num(g.failsAvg), num(g.timeoutsAvg)])).join("");
  const p = s.picks, totOff = p.offered.apt + p.offered.mansion + p.offered.house, totPick = p.firstPick.apt + p.firstPick.mansion + p.firstPick.house;
  const picks = ["apt", "mansion", "house"].map((b) => row([BLD[b], pct(p.offered[b], totOff), pct(p.firstPick[b], totPick)])).join("");
  const dl = ["apt", "mansion", "house"].map((b) => { const d = s.delivery[b]; return row([BLD[b], d.done, sec(d.ms), d.blocked, pct(d.blocked, d.done + d.blocked)]); }).join("");
  const src = ["first", "late", "random"].map((k) => row([{ first: "1등이 고른 택배", late: "늦게 완성해서 고른 택배", random: "무작위로 받은 택배" }[k], s.bySource[k].n, pct(s.bySource[k].done, s.bySource[k].n)])).join("");
  const opp = Object.keys(s.race.oppAtFirst).map((k) => esc({ pieces: "조각 모으는 중", ubongo: "판 맞추는 중", out: "포기", done: "완성" }[k] || k) + " " + s.race.oppAtFirst[k]).join(" · ") || "—";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>플레이 기록</title>
<style>body{font-family:system-ui,'Malgun Gothic',sans-serif;background:#f6f2ea;color:#1e2235;margin:0;padding:24px;max-width:960px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}p{margin:4px 0;color:#4a4f63}
table{border-collapse:collapse;width:100%;background:#fff;border-radius:8px;overflow:hidden}th,td{padding:8px 10px;border-bottom:1px solid #eee;text-align:left;font-size:14px}th{background:#1e2235;color:#fff;font-weight:600}
.k{display:inline-block;background:#fff;border-radius:8px;padding:10px 14px;margin:4px 8px 4px 0}.k b{display:block;font-size:20px}a{color:#2f6fe0}</style>
<h1>플레이 기록 요약${s.label ? " · " + esc(s.label) : ""}</h1>
<p>기록 ${s.events}개 · 라운드 ${s.rounds}개 · <a href="/playlog.jsonl">원본 내려받기(JSONL)</a> · 새 테스트 시작: <code>/playlog/clear?yes=1&amp;label=조건이름</code></p>
<h2>테스트 1 · 퍼즐 완성 경쟁</h2>
<div><span class="k">1등 완성 (라운드 시작부터, 중간값)<b>${sec(s.race.firstFinishMed)}</b></span><span class="k">1등과 2등 차이 (중간값)<b>${sec(s.race.gapMed)}</b></span><span class="k">조각 다 모은 뒤 판 맞추기 (중간값)<b>${sec(s.race.assembleMed)}</b></span><span class="k">늦은 사람 완성 / 시간 초과<b>${s.race.lateFinished} / ${s.race.lateRandom}</b></span></div>
<p>1등이 들어올 때 상대 상태: ${opp}</p>
<h2>테스트 2 · 미니게임별</h2>
<table>${head(["게임", "하프", "횟수", "걸린 시간(중간값)", "걸린 시간(평균)", "실수(평균)", "시간 초과(평균)"])}${games || row(["기록 없음", "", "", "", "", "", ""])}</table>
<h2>테스트 3 · 택배 선택 → 배송</h2>
<table>${head(["건물", "레일에 나온 비율", "1등이 고른 비율"])}${picks}</table>
<p></p>
<table>${head(["어떻게 얻은 택배", "개수", "배송 성공률"])}${src}</table>
<p></p>
<table>${head(["건물", "배송 성공", "배송 시간(중간값)", "막힌 횟수", "막힌 비율"])}${dl}</table>`;
}

return { add, clear, all, summarize, summaryHtml, getLabel };
})();

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
    // 2026-10-14: RACE_MODE=0 환경변수로 띄우면 확보 단계가 예전 방식(레일에서 각자 골라 확보) -- 예전 회귀 테스트용(regress.sh).
    let rules = process.env.RACE_MODE === "0" ? { raceMode: false } : undefined;
    // 2026-10-15 시작 전 튜토리얼: 실제 서버에선 켠다. TUTORIAL=0 이면 끔(예전 브라우저 테스트용 -- regress.sh)
    if (process.env.TUTORIAL !== "0") rules = Object.assign({}, rules || {}, { tutorial: true });
    // RACE_GAMES=sticker,tape 처럼 주면 레이스 첫 게임 후보를 그걸로 (테스트/현장 고정용)
    if (process.env.RACE_GAMES) rules = Object.assign({}, rules || {}, { raceGamePool: process.env.RACE_GAMES === "none" ? [] : process.env.RACE_GAMES.split(",").map((x) => x.trim()).filter(Boolean) }); // none = 첫 게임 없음
    // RACE_PIECE_KINDS=react 처럼 주면 조각 게임 종류를 그걸로 (테스트용)
    if (process.env.RACE_PIECE_KINDS) rules = Object.assign({}, rules || {}, { racePieceKinds: process.env.RACE_PIECE_KINDS.split(",").map((x) => x.trim()).filter(Boolean) });
    const room = new GameRoom(code, (state) => broadcast(code, state), rules);
    room.setLogger(PLAYLOG.add); // 2026-10-21 플레이 기록
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
    res.end("ok " + BUILD_TAG); // 2026-10-14: 배포된 빌드 확인용 (화면 왼쪽 위 작은 글씨와 같은 값)
    return;
  }
  // 2026-10-07: /rail 은 레일 사이트(공용 레일 화면). 방 코드가 없으면 화면이 코드 입력칸을 보여 주므로(새 방을 만들지 않는다 --
  // 레일 화면은 이미 있는 방에 붙는 것) 같은 클라이언트를 그대로 내려준다.
  // 2026-10-21 플레이 기록: /playlog (요약 표) · /playlog.jsonl (원본) · /playlog/clear?yes=1&label=조건 (비우기)
  if (url.pathname === "/playlog") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PLAYLOG.summaryHtml());
    return;
  }
  if (url.pathname === "/playlog.json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(PLAYLOG.summarize()));
    return;
  }
  if (url.pathname === "/playlog.jsonl") {
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "content-disposition": "attachment; filename=playlog.jsonl", "cache-control": "no-store" });
    res.end(PLAYLOG.all().map((e) => JSON.stringify(e)).join("\n") + "\n");
    return;
  }
  if (url.pathname === "/playlog/clear") {
    if (url.searchParams.get("yes") === "1") PLAYLOG.clear(url.searchParams.get("label") || "");
    res.writeHead(302, { location: "/playlog" });
    res.end();
    return;
  }
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
  const conn = { ws, clientId: null, seat: null, role: url.searchParams.get("role") === "rail" ? "rail" : (url.searchParams.get("role") === "main" ? "main" : "player") };
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
      // 2026-10-15: 레이스 택배 고르기는 레일 화면에서 (자리 = 왼쪽 1번 / 오른쪽 2번). 서버의 racePick이 고를 자격(먼저 투입 등)을 확인한다.
      if (type === "rail-pick" && (msg.side === "1" || msg.side === "2") && Number.isInteger(msg.idx)) entry.room.racePick(msg.side, msg.idx);
      return;
    }
    // 2026-10-16 (사용자 결정): 배송 입력은 메인 컴퓨터(메인 모니터 화면) 키보드에서만 -- Ctrl+호실 = 1번(빨강), Shift+호실 = 2번(파랑),
    //   Ctrl/Shift+↑↓ = 엘리베이터. 메인 화면은 좌석이 없고 이 세 가지만 보낼 수 있다.
    if (conn.role === "main") {
      if (typeof clientId === "string" && clientId) conn.clientId = clientId;
      const team = msg.team === "1" || msg.team === "2" ? msg.team : null;
      if (type === "wall-press" && typeof msg.unit === "string") entry.room.wallPress(team, msg.unit);
      if (type === "wall-release" && typeof msg.unit === "string" && team) entry.room.wallRelease(team, msg.unit);
      if (type === "wall-elev") entry.room.wallElevator(team, msg.dir); // 2026-10-21: 팀 키 없이도 (team null)
      if (type === "wall-slot" && Number.isInteger(msg.slot)) entry.room.wallSlot(team, msg.slot); // 2026-10-22 엘리베이터 전쟁: 지금 층의 N번째 호실
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
      case "tutorial-next":
      case "tutorial-prev":
        if (!conn.seat) return;
        entry.room.tutorialStep(conn.seat, msg.type === "tutorial-next" ? "next" : "prev");
        break;
      case "tutorial-skip":
        if (!conn.seat) return;
        entry.room.tutorialSkip(conn.seat);
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
      // 2026-10-14 확보 단계 레이스 라운드: 진행 신호(sticker-done / ubongo-done / give-up)와 먼저 끝낸 사람의 고르기
      case "race-step":
        if (!conn.seat || typeof msg.step !== "string") return;
        entry.room.raceStep(conn.seat, msg.step, typeof msg.round === "number" ? msg.round : null, msg.meta && typeof msg.meta === "object" ? msg.meta : null);
        break;
      case "race-pick":
        if (!conn.seat || typeof msg.idx !== "number") return;
        entry.room.racePick(conn.seat, msg.idx);
        break;
      case "game-closed":
        // 플레이어가 레일이 열어 준 게임을 포기/닫았다 -> 다시 누를 수 있게.
        if (!conn.seat) return;
        if (entry.busy[conn.seat]) { entry.busy[conn.seat] = false; broadcast(code, entry.room.state); }
        break;
      // 2026-10-22 (사용자 결정): 엘리베이터 이동 전쟁 입력은 각자 플레이어 화면에서 (▲▼ / 그 층 호실)
      case "wall-elev":
        if (!conn.seat || (msg.dir !== "up" && msg.dir !== "down")) return;
        entry.room.wallElevator(conn.seat, msg.dir);
        break;
      case "wall-slot":
        if (!conn.seat || !Number.isInteger(msg.slot)) return;
        entry.room.wallSlot(conn.seat, msg.slot);
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
      const stillThere = Array.from(entry.sockets).some((c) => c.role === "player" && c.clientId && c.clientId === conn.clientId);
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
