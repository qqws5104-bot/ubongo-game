// 2026-10-07: 레일 사이트(/rail) 검증 -- 진짜 서버 + 브라우저 3개(플레이어 2 + 레일 화면).
//   - /rail 은 방 코드 없이 열면 코드 입력칸, 코드를 넣으면 /rail?room=코드
//   - 레일 화면이 붙으면 플레이어 화면이 "레일 모드"(대기 카드, 버튼 없음)로 바뀌고, 떠나면 원래 보드로 돌아온다
//   - 왼쪽(1번)/오른쪽(2번) 버튼은 각각 그 자리 플레이어 화면에만 게임을 띄운다 (상대 화면엔 안 뜸)
//   - 게임 중에는 그 쪽 버튼이 잠기고(플레이 중 표시), 끝내거나 포기하면 다시 풀린다
//   - 확정 층수 택배는 층 버튼 6개: 확보된 층은 양쪽에서 잠긴다
//   - 종류가 소진되면 양쪽 버튼이 잠기고 "소진"이 보인다
//   - 레일 화면은 플레이어 메시지(secure-cell 등)를 보내도 게임에 영향이 없다 (ws 직접 접속으로 확인)
// 사전 준비: SECURE_PHASE_MS를 임시로 40초(`40 * 1000`)로 줄이고 build_client.py 재빌드 + 서버 재시작. 끝나면 원복 (HANDOVER 5.3).
// SHOT_DIR=/경로 를 주면 스크린샷을 저장한다.
"use strict";
const { chromium } = require("playwright");
const WebSocket = require("ws");
const path = require("path");
const BASE = "http://localhost:3000";
const SHOT_DIR = process.env.SHOT_DIR || "";
function log(...a) { console.log("[test-rail]", ...a); }
function assert(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (p, sel) => p.evaluate((s) => document.querySelectorAll(s).length, sel);
const click = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }, sel);
const text = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const disabled = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return e ? e.disabled : null; }, sel);
const space = (p) => p.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true })));
async function waitFor(fn, { timeout = 6000, interval = 60, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - start > timeout) throw new Error("timeout waiting for: " + label); await sleep(interval); }
}

// 레일 화면 셀렉터: side(1|2), cat(0..3)
const railBtn = (side, cat) => `.board-row[data-cat="${cat}"] .rail-side.side-${side} .rail-btn`;
const floorBtn = (side, cat, num) => `.board-row[data-cat="${cat}"] .rail-side.side-${side} .floor-btn[data-cell="fixed-floor-${num}"]`;
const leftOf = (cat) => `.board-row[data-cat="${cat}"] .cat-left b`;

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const errors = [];
  const mk = async (label, viewport) => {
    const ctx = await browser.newContext({ viewport });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(label + " pageerror: " + e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|ERR_|Failed to load resource|favicon/.test(m.text())) errors.push(label + " console: " + m.text()); });
    return p;
  };
  const shot = async (p, name) => { if (SHOT_DIR) await p.screenshot({ path: path.join(SHOT_DIR, name + ".png") }); };

  // ---- 방 만들고 플레이어 2명 입장 ----
  const p1 = await mk("p1", { width: 1100, height: 900 }), p2 = await mk("p2", { width: 1100, height: 900 });
  await p1.goto(BASE + "/?mgtest=1");
  await waitFor(() => p1.url().includes("room="), { label: "redirect" });
  const room = new URL(p1.url()).searchParams.get("room");
  const roomUrl = BASE + "/?room=" + room + "&mgtest=1";
  await p1.goto(roomUrl); await p2.goto(roomUrl);
  await waitFor(() => count(p1, ".seat-pick").then((n) => n > 0), { label: "seat picker" });
  await click(p1, '[data-action="pick-courier"][data-courier="cookbang"]');
  await waitFor(async () => (await p1.evaluate(() => document.body.innerText)).includes("쿡방"), { label: "p1 courier" });
  await click(p2, '[data-action="pick-courier"][data-courier="cheonil"]');
  await sleep(300);
  await space(p1); await space(p2);
  await waitFor(() => count(p1, '[data-action="open-type"]').then((n) => n > 0), { label: "secure phase (fallback board)" });
  assert((await count(p1, ".board-row")) === 4, "레일 화면이 없을 땐 플레이어 화면이 예전 레일 보드 그대로");
  log("레일 화면이 없으면 플레이어 화면은 기존 보드(버튼 포함) 그대로");

  // ---- /rail: 코드 입력 -> 방 연결 ----
  const rail = await mk("rail", { width: 1280, height: 720 });
  await rail.goto(BASE + "/rail");
  await waitFor(() => count(rail, "#rail-code").then((n) => n === 1), { label: "rail code input" });
  assert((await count(rail, "body.rail-view")) === 1, "body.rail-view");
  await rail.fill("#rail-code", room.toLowerCase());
  await click(rail, '[data-action="rail-join"]');
  await waitFor(() => rail.url().includes("/rail?room=" + room), { label: "rail join navigates" });
  await waitFor(() => count(rail, ".rv .board-row").then((n) => n === 4), { label: "rail board rows" });
  log("/rail: 방 코드 없이 열면 입력칸, 코드를 넣으면 /rail?room=코드로 이동해 레일이 열림");

  // 플레이어가 레일 모드로
  await waitFor(() => count(p1, "[data-rail-wait]").then((n) => n === 1), { label: "p1 rail mode" });
  await waitFor(() => count(p2, "[data-rail-wait]").then((n) => n === 1), { label: "p2 rail mode" });
  assert((await count(p1, ".rail-btn, .floor-btn")) === 0 && (await count(p2, ".rail-btn, .floor-btn")) === 0, "레일 모드의 플레이어 화면엔 확보 버튼이 없다");
  assert((await text(p1, "[data-rail-wait] .rw-sub b")) === "왼쪽" && (await text(p2, "[data-rail-wait] .rw-sub b")) === "오른쪽", "1번=왼쪽, 2번=오른쪽 안내");
  // 레일: 양쪽 버튼 존재 (일반 3종 x 2쪽 + 확정 층수 6x2)
  assert((await count(rail, ".rail-btn")) === 6, "레일 일반 3종 x 양쪽 = 6개 버튼, got " + (await count(rail, ".rail-btn")));
  assert((await count(rail, ".floor-btn")) === 12, "층 버튼 6개 x 양쪽");
  assert((await text(rail, leftOf(0))) === "4", "남은 4개");
  await shot(rail, "rail_1_open");
  log("플레이어 화면은 레일 모드(버튼 없음, 내 쪽 안내), 레일 화면엔 양쪽 버튼이 있음");

  // ---- 왼쪽(1번) 버튼 -> p1 화면에만 게임 ----
  // 우봉고 모드(기본, 2026-10-08): 플레이어 화면에 #puzzle-overlay(이미지 + 완료/포기). 디지털 모드: #mg-layer 미니게임. 둘 다 처리한다.
  const hasGame = (p) => count(p, "#mg-layer .mg-root, #mg-layer .mg-wrap, #puzzle-overlay img").then((n) => n > 0);
  const finish = (p) => p.evaluate(() => {
    if (document.querySelector(".mg-root") && window.__mgFinish) return window.__mgFinish();
    const b = document.querySelector('[data-action="complete-cell"]'); if (b) { b.click(); return true; }
    return false;
  });
  const giveUp = (p) => p.evaluate(() => {
    const b = document.querySelector('[data-action="give-up"]') || Array.from(document.querySelectorAll("#mg-layer button")).find((x) => x.textContent.trim() === "포기");
    if (!b) return false; b.click(); return true;
  });
  await click(rail, railBtn(1, 0));
  await waitFor(() => hasGame(p1), { label: "p1 game opens" });
  await sleep(300);
  assert(!(await hasGame(p2)), "상대(2번) 화면엔 게임이 안 뜬다");
  await waitFor(() => count(rail, ".rv-side.is-busy").then((n) => n === 1), { label: "busy mark" });
  assert(await disabled(rail, railBtn(1, 0)) && await disabled(rail, railBtn(1, 1)), "게임 중인 1번 쪽 버튼은 전부 잠김");
  assert(!(await disabled(rail, railBtn(2, 0))), "2번 쪽 버튼은 그대로 눌림");
  log("왼쪽 버튼 -> 1번 플레이어 화면에만 게임, 그 쪽 버튼 잠금(플레이 중 표시)");

  // ---- 끝내면 확보 + 잠금 해제 ----
  assert(await finish(p1), "p1 finish");
  await waitFor(async () => (await text(rail, leftOf(0))) === "3", { label: "남은 3개" });
  await waitFor(async () => (await disabled(rail, railBtn(1, 0))) === false, { label: "1번 버튼 풀림" });
  assert((await count(p1, "[data-rail-wait] .rw-row[data-cat='0'] .my-chip")) === 1, "p1 대기 카드에 내가 확보한 호수 칩");
  assert((await count(p2, "[data-rail-wait] .rw-row[data-cat='0'] .my-chip")) === 0, "p2에겐 p1의 호수가 안 보임");
  assert(!(await rail.evaluate(() => /\d0\d호/.test(document.body.innerText))), "레일 화면엔 누구의 호수도 안 나온다");
  log("끝내면 남은 개수 4 -> 3, 1번 버튼 풀림, 호수는 본인 화면에만");

  // ---- 오른쪽(2번) 버튼 ----
  await click(rail, railBtn(2, 0));
  await waitFor(() => hasGame(p2), { label: "p2 game opens" });
  assert(!(await hasGame(p1)), "1번 화면엔 안 뜸");
  // 게임 중 중복 누름은 서버가 무시: 연타해도 게임은 하나
  await click(rail, railBtn(2, 0)); await click(rail, railBtn(2, 1));
  await sleep(300);
  assert(await finish(p2), "p2 finish");
  await waitFor(async () => (await text(rail, leftOf(0))) === "2", { label: "남은 2개" });
  log("오른쪽 버튼 -> 2번 플레이어 화면에만 게임, 끝내면 2개로");

  // ---- 포기하면 잠금 해제 + 개수 그대로 ----
  await click(rail, railBtn(1, 1));
  await waitFor(() => hasGame(p1), { label: "p1 fragile game" });
  await waitFor(async () => (await disabled(rail, railBtn(1, 1))) === true, { label: "busy again" });
  assert(await giveUp(p1), "포기 버튼");
  await waitFor(async () => !(await hasGame(p1)), { label: "game closed by giving up" });
  await waitFor(async () => (await disabled(rail, railBtn(1, 1))) === false, { label: "포기 -> 버튼 풀림" });
  assert((await text(rail, leftOf(1))) === "4", "포기하면 개수는 그대로");
  log("포기 버튼 -> 버튼 풀림, 남은 개수 그대로");

  // ---- 확정 층수 택배: 층 버튼 ----
  await click(rail, floorBtn(1, 3, 3)); // 3번째 칸 = 2F
  await waitFor(() => hasGame(p1), { label: "p1 sticker game" });
  assert(await finish(p1), "p1 finish sticker");
  await waitFor(async () => (await text(rail, leftOf(3))) === "5", { label: "확정 층수 남은 5" });
  assert(await disabled(rail, floorBtn(1, 3, 3)) && await disabled(rail, floorBtn(2, 3, 3)), "확보된 층은 양쪽에서 잠긴다");
  assert((await disabled(rail, floorBtn(2, 3, 4))) === false, "다른 층은 열려 있다");
  log("층 버튼: 확보된 층(2F)은 양쪽 모두 잠기고 남은 개수 5");

  // ---- 소진: 일반택배 2개 더 ----
  for (let i = 0; i < 2; i++) {
    const side = i % 2 === 0 ? 1 : 2, pg = side === 1 ? p1 : p2;
    await click(rail, railBtn(side, 0));
    await waitFor(() => hasGame(pg), { label: "game " + i });
    await finish(pg);
    await waitFor(async () => (await text(rail, leftOf(0))) === String(1 - i), { label: "남은 " + (1 - i) });
  }
  assert(await disabled(rail, railBtn(1, 0)) && await disabled(rail, railBtn(2, 0)), "소진되면 양쪽 버튼 잠김");
  assert((await rail.evaluate(() => document.querySelector('.board-row[data-cat="0"]').innerText)).includes("소진"), "소진 표시");
  await shot(rail, "rail_2_exhausted");
  log("일반택배 4개 모두 확보 -> 양쪽 버튼 잠김 + 소진 표시");

  // ---- 레일 화면의 ws는 플레이어 메시지를 못 보낸다 ----
  const before = await text(rail, leftOf(1));
  const rws = new WebSocket("ws://localhost:3000/ws?room=" + room + "&role=rail");
  await new Promise((r) => rws.on("open", r));
  rws.send(JSON.stringify({ type: "hello", clientId: "evil", seat: "1" }));
  rws.send(JSON.stringify({ type: "secure-cell", clientId: "evil", seat: "1", cellId: "fragile-1" }));
  rws.send(JSON.stringify({ type: "rail-press", side: "3", cat: 1 }));
  rws.send(JSON.stringify({ type: "rail-press", side: "1", cat: "x" }));
  await sleep(400);
  assert((await text(rail, leftOf(1))) === before, "레일 연결이 보낸 secure-cell은 무시된다");
  rws.close();
  log("레일 연결은 rail-press 외 메시지/잘못된 인자를 무시");

  // ---- 레일 화면을 닫으면 플레이어 화면이 원래 보드로 ----
  await rail.context().close();
  await waitFor(() => count(p1, '[data-action="open-type"]').then((n) => n > 0), { label: "p1 fallback board" });
  await waitFor(() => count(p2, '[data-action="open-type"]').then((n) => n > 0), { label: "p2 fallback board" });
  assert((await count(p1, "[data-rail-wait]")) === 0, "레일 모드 해제");
  log("레일 화면을 닫으면 플레이어 화면이 기존 보드로 복귀");

  await browser.close();
  assert(errors.length === 0, "브라우저 오류: " + errors.join(" | "));
  log("ALL CHECKS PASSED");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
