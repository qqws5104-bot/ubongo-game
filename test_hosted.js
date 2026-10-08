// Two-player end-to-end test against the REAL local WS server (not a mock), simulating two
// separate devices via two separate browser contexts (independent sessionStorage/clientId).
// Covers the full 2026-08-27 rework: 17-cell board (일반4/깨지기4/귀중품3/확정6), currency scoring,
// per-round priority-package pick in its own timed 10s "priority" window (re-picked every round,
// bonus only applies if delivered that same round; early advance when both confirm), 후반-only dedicated 택배도둑 placement window
// (its own state between each round's ready-gate and voting), and the full
// 전반 -> halftime -> 후반 -> end flow.
"use strict";
const { chromium } = require("playwright");
const { totalScore: serverTotalScore } = require("./game-room.js");
const { COURIERS } = require("./game-data.js");
const COURIER_NAME = {};
COURIERS.forEach((c) => { COURIER_NAME[c.key] = c.name; });

const BASE = "http://localhost:3000";

function log(...args) { console.log("[test]", ...args); }

// Playwright's locator-based .click() is unreliable in this sandboxed headless environment
// (actionability retries keep re-resolving to a stale/disabled node even after the real click
// already landed and the app re-rendered past it) -- proven workaround: dispatch the click
// directly via page.evaluate(), exactly what the app's delegated document click listener would
// see, without Playwright's actionability polling.
async function clickSel(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
}
async function countSel(page, selector) {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
}
async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}
async function pressSpace(page) {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }));
  });
}

async function waitFor(fn, { timeout = 10000, interval = 100, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("timeout waiting for: " + label);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// 방금 연 칸을 "풀었다"로 처리한다: 미니게임 칸(박스 포장/이상 확인/송장 붙이기)은 테스트 훅으로,
// 우봉고 칸(귀중품)은 기존 "완료" 버튼으로.
// 2026-10-06 레일 화면: 일반/깨지기/귀중품은 종류 버튼(open-type), 확정 층수만 층 버튼(open-cell)으로 연다.
const CAT_IDX = { normal: 0, fragile: 1, valuable: 2, "fixed-floor": 3 };
function openSel(id) {
  const kind = id.replace(/-\d+$/, "");
  return kind === "fixed-floor" ? `[data-action="open-cell"][data-cell="${id}"]` : `.rail-btn[data-action="open-type"][data-cat="${CAT_IDX[kind]}"]:not(:disabled)`;
}
const takenTotal = (page) => page.evaluate(() => document.querySelectorAll(".rail-box .pip.gone").length);

async function finishOpenCell(page) {
  return page.evaluate(() => {
    if (document.querySelector(".mg-root") && window.__mgFinish) return window.__mgFinish();
    const b = document.querySelector('[data-action="complete-cell"]');
    if (b) { b.click(); return true; }
    return false;
  });
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

  // ---- discover a fresh room code via the redirect, exactly as a real first visitor would ----
  const seedCtx = await browser.newContext();
  const seedPage = await seedCtx.newPage();
  await seedPage.goto(BASE + "/");
  const url1 = new URL(seedPage.url());
  const room = url1.searchParams.get("room");
  if (!room || !/^[A-Z2-9]{4}$/.test(room)) throw new Error("bad room code: " + room);
  log("room code:", room);
  await seedCtx.close();

  // 2026-10-06: ?mgtest=1 -- 미니게임 칸을 실제로 풀지 않고 window.__mgFinish()로 "풀었다" 처리할 수 있게 하는
  // 테스트 전용 훅 (확보 시간이 6초라 17개 칸을 진짜로 풀 수 없다). 실제 플레이는 test_minigames_live.js 담당.
  const roomUrl = BASE + "/?room=" + room + "&mgtest=1";

  // ---- two separate "devices" ----
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();

  const errors = [];
  for (const [label, p] of [["p1", p1], ["p2", p2]]) {
    p.on("pageerror", (e) => errors.push(label + " pageerror: " + e.message));
    p.on("console", (msg) => {
      const loc = (msg.location() && msg.location().url) || "";
      if (msg.type() === "error" && !/fonts\.googleapis\.com|fonts\.gstatic\.com|ERR_TUNNEL_CONNECTION_FAILED|favicon\.ico/.test(msg.text() + loc)) {
        errors.push(label + " console.error: " + msg.text() + " (at " + loc + ")");
      }
    });
  }

  // ---- track the raw server "state" broadcasts each page receives, by listening on the actual
  // WebSocket frames -- lets privacy assertions compare "what the raw state contains" against
  // "what actually got rendered" ----
  const lastState = { p1: null, p2: null };
  function trackState(page, key) {
    page.on("websocket", (ws) => {
      ws.on("framereceived", (frame) => {
        try {
          const payload = typeof frame.payload === "string" ? frame.payload : frame.payload.toString();
          const msg = JSON.parse(payload);
          if (msg && msg.type === "state") lastState[key] = msg.state;
        } catch (e) { /* ignore non-JSON / binary frames */ }
      });
    });
  }
  trackState(p1, "p1");
  trackState(p2, "p2");

  await p1.goto(roomUrl);
  await p2.goto(roomUrl);

  // ---- seat picker present on both ----
  await waitFor(() => countSel(p1, ".seat-pick").then((n) => n > 0), { label: "p1 seat picker" });
  await waitFor(() => countSel(p2, ".seat-pick").then((n) => n > 0), { label: "p2 seat picker" });
  log("seat picker rendered on both pages");

  // 2026-08-27: "플레이어 1/2" 버튼 대신 가상 택배사 5종 아이콘 픽커로 바뀌었다 -- 좌석 번호는
  // 서버가 정해서 돌려주므로(pick-courier) 테스트에서 미리 못 정한다. 대신 두 플레이어가 서로 다른
  // 택배사를 고르는 것, 그리고 한쪽이 고른 건 다른 쪽에서 잠기는 것(사용자가 명시적으로 확인해달라고
  // 한 요구사항)을 검증한다.
  await clickSel(p1, '[data-action="pick-courier"][data-courier="cookbang"]');
  await waitFor(async () => (await bodyText(p1)).includes("내 좌석 · " + COURIER_NAME.cookbang), { label: "p1 picked cookbang courier" });
  // p1이 이미 고른 택배사는 p2 화면에서 disabled여야 한다 (상태 브로드캐스트가 p2에게도 반영된 뒤).
  await waitFor(async () => (await p2.evaluate(() =>
    document.querySelector('[data-action="pick-courier"][data-courier="cookbang"]').disabled
  )), { label: "cookbang courier locked on p2's screen once p1 took it" });
  log("confirmed: courier taken by p1 is locked out on p2's picker");
  await clickSel(p2, '[data-action="pick-courier"][data-courier="cheonil"]');
  await waitFor(async () => (await bodyText(p2)).includes("내 좌석 · " + COURIER_NAME.cheonil), { label: "p2 picked cheonil courier" });
  log("p1 -> " + COURIER_NAME.cookbang + ", p2 -> " + COURIER_NAME.cheonil + " confirmed (서로 다른 택배사, 좌석 번호는 서버가 자동 배정)");

  // ---- lobby: press space on both, verify auto-start into secure phase ----
  await pressSpace(p1);
  await waitFor(async () => (await bodyText(p1)).includes("준비 완료"), { label: "p1 ready chip flips" });
  await pressSpace(p2);
  await waitFor(async () => {
    const t1 = await bodyText(p1);
    const t2 = await bodyText(p2);
    return t1.includes("택배 확보") && t2.includes("택배 확보");
  }, { label: "both entered secure phase", timeout: 5000 });
  log("both players entered secure phase (lobby -> secure auto-start via spacebar confirmed)");

  const hasTimer1 = await countSel(p1, "#side-timer");
  if (!hasTimer1) throw new Error("side timer missing on p1 in secure phase");

  // ---- 17-cell board sanity: 4 category rows (4/4/3/6) ----
  const boardRowCount = await countSel(p1, ".board-row");
  if (boardRowCount !== 4) throw new Error(`expected 4 category rows on the 17-cell board, found ${boardRowCount}`);
  const totalPips = await countSel(p1, ".rail-box .pip");
  if (totalPips !== 17) throw new Error(`expected 17 total box pips across all categories, found ${totalPips}`);
  const perRow = await p1.evaluate(() => Array.from(document.querySelectorAll(".board-row")).map((r) => r.querySelectorAll(".pip").length));
  if (perRow.join(",") !== "4,4,3,6") throw new Error(`categories must have 4/4/3/6 boxes, got ${perRow.join("/")}`);
  const typeBtns = await countSel(p1, ".rail-btn[data-action=\"open-type\"]"), floorBtns = await countSel(p1, ".floor-btn");
  if (typeBtns !== 3 || floorBtns !== 6) throw new Error(`rail screen: expected 3 type buttons + 6 floor buttons, got ${typeBtns}/${floorBtns}`);
  // 내 자리 쪽에만 버튼이 있다 (1번 = 왼쪽, 2번 = 오른쪽), 상대 쪽은 비어 있다
  const sideOfBtns = await p1.evaluate(() => { const r = document.querySelector(".board-row"); const kids = Array.from(r.children); return kids.findIndex((k) => k.classList.contains("mine")); });
  if (sideOfBtns !== 0) throw new Error(`seat 1's buttons should be on the LEFT of the rail, got column ${sideOfBtns}`);
  const sideOfBtns2 = await p2.evaluate(() => { const r = document.querySelector(".board-row"); const kids = Array.from(r.children); return kids.findIndex((k) => k.classList.contains("mine")); });
  if (sideOfBtns2 !== 2) throw new Error(`seat 2's buttons should be on the RIGHT of the rail, got column ${sideOfBtns2}`);
  log("confirmed: rail screen -- 4 rows, 4/4/3/6 box pips (17), my buttons on my side (1번=왼쪽, 2번=오른쪽)");

  // ---- give up: opening a cell and clicking give-up must NOT mark it taken ----
  await clickSel(p1, openSel("normal-1"));
  await waitFor(async () => (await countSel(p1, ".overlay:not(.hidden)")) > 0, { label: "p1 puzzle overlay opens" });
  // 포기 버튼: 우봉고 오버레이는 [data-action="give-up"], 디지털 미니게임은 .mg-giveup
  await clickSel(p1, '[data-action="give-up"], .mg-giveup');
  await p1.waitForTimeout(200);
  const normal1StillOpen = await countSel(p1, openSel("normal-1"));
  const takenCountAfterGiveUp = await takenTotal(p1);
  if (normal1StillOpen !== 1) throw new Error("giving up should leave the cell untaken (still clickable), but it did not");
  if (takenCountAfterGiveUp !== 0) throw new Error(`giving up should not take any cell, but ${takenCountAfterGiveUp} cell(s) show as taken`);
  log("give-up confirmed: cell stays untaken, no invoice granted");

  // ---- 공유 보드(2026-10-06): 종류별 개수(4/4/3/6)를 두 사람이 나눠 가진다. 둘 다 같은 칸(normal-1)을 열어 끝내면 한 사람은 그 칸을,
  // 다른 사람은 같은 종류의 다른 빈 칸을 받는다 -- 합쳐서 2개가 줄어든다 ----
  await Promise.all([
    clickSel(p1, openSel("normal-1")),
    clickSel(p2, openSel("normal-1")),
  ]);
  await p1.waitForTimeout(150);
  await Promise.all([finishOpenCell(p1), finishOpenCell(p2)]);
  await waitFor(async () => (await countSel(p1, '.board-row[data-cat="0"] .pip.gone')) === 2, { label: "두 사람이 각각 일반택배 1개씩 확보 (공유 보드에서 2개 줄어듦)" });
  await waitFor(async () => (await countSel(p2, '.board-row[data-cat="0"] .pip.gone')) === 2, { label: "p2 화면에도 같은 남은 개수" });
  const mine1 = await countSel(p1, '.my-chip');
  const mine2 = await countSel(p2, '.my-chip');
  if (mine1 !== 1 || mine2 !== 1) throw new Error(`each player should own exactly one box (mine1=${mine1}, mine2=${mine2})`);
  // 상대가 뭘 가져갔는지는 내 화면에 안 보인다 -- 내 칩은 내 것 하나뿐이고, 남은 개수만 줄어든다
  const leftTxt = await p1.textContent('.board-row[data-cat="0"] .cat-left');
  if (!/남은\s*2\s*\/\s*4/.test(leftTxt)) throw new Error(`일반택배 should show 남은 2 / 4, got "${leftTxt}"`);
  log("공유 보드 확인: 같은 칸을 동시에 끝내도 각자 1개씩 확보, 남은 개수 4 -> 2");

  async function secureCell(p, cellId) {
    const sel = openSel(cellId);
    const count = await countSel(p, sel);
    if (count === 0) return false;
    await clickSel(p, sel);
    await p.waitForTimeout(150);
    return finishOpenCell(p);
  }

  // ---- 확정 층수 택배(fixed-floor) cells must show their bound floor label even before securing,
  // and the resulting invoice must land on exactly that floor once secured. ----
  const fixedFloorFace = await p1.evaluate(() => { const b = document.querySelector('[data-cell="fixed-floor-3"]'); return b ? b.textContent.trim() : null; });
  if (fixedFloorFace !== "2F") throw new Error("fixed-floor floor button did not render its floor label (expected 2F, got " + fixedFloorFace + ")");
  await secureCell(p1, "fixed-floor-3"); // num index 2 -> FLOORS[2] = "2F"
  // 이미 p1이 선점한 층은 p2 화면에서 열 수 없다 (선점자 우선)
  // (상대 화면에 브로드캐스트가 도착하기까지 잠깐 걸린다 -- 즉시 세면 경쟁 상태로 가끔 실패했다)
  await waitFor(async () => (await countSel(p2, '[data-action="open-cell"][data-cell="fixed-floor-3"]')) === 0, { label: "a floor already taken by the opponent must not be openable" });
  await secureCell(p2, "fixed-floor-6");
  log("확정 층수 택배: p1이 2F를 선점하면 p2는 열 수 없고, p2는 다른 층(5F)을 확보");

  // secure a healthy spread of cells for both players so there's real inventory for the elevator
  // phase (including enough on p1 to make same-floor collisions likely across 17 cells)
  for (const id of [
    "normal-3", "normal-4",
    "fixed-floor-1", "fixed-floor-2", "fixed-floor-4", "fixed-floor-5",
    "fragile-1", "fragile-2", "fragile-3",
    "valuable-1", "valuable-2", "valuable-3",
  ]) {
    await secureCell(p1, id);
  }
  await secureCell(p2, "fragile-4");
  log("secured additional cells for both players");

  // ---- wait out the secure phase (server override, shortened for this test run) -> straight into
  // the elevator phase's "idle" (pre-round-1) ready-gate. There is no more standalone "priority"
  // phase -- the priority picker is now embedded directly in this gate (and in the between-round
  // "result" gate), re-picked fresh every round. ----
  await waitFor(async () => {
    const t1 = await bodyText(p1);
    const t2 = await bodyText(p2);
    return t1.includes("엘리베이터") && t2.includes("엘리베이터");
  }, { label: "both entered elevator phase (half 1)", timeout: 15000 });
  log("secure phase ended -> elevator phase entered directly on both (no standalone priority phase)");

  // ---- pre-round-1 ready gate: entering "elevator" must NOT auto-start voting, and must not show
  // the thief window yet either (그건 준비 완료 이후, 그리고 후반에서만) ----
  const voteButtonsBeforeReady = await countSel(p1, '[data-action="vote-up"]');
  if (voteButtonsBeforeReady !== 0) throw new Error("vote buttons should not render before both players ready up for round 1");
  const thiefWindowBeforeReady = await countSel(p1, ".thief-window");
  if (thiefWindowBeforeReady !== 0) throw new Error("thief window should not render before both players ready up (and never during 전반)");
  log("confirmed: elevator phase does not auto-start voting or the thief window -- idle ready-gate shown first");

  // Note: ".invoice-list" now legitimately renders twice during idle/result gates -- once for my
  // package list under the gauge (.elev-left), and once more inside the embedded priority-picker
  // card (which reuses the same list markup for its pickable items) -- so the meaningful
  // assertion is specifically about the one under the gauge, checked here.
  const listUnderGauge = await countSel(p1, ".elev-left .invoice-list");
  if (listUnderGauge !== 1) throw new Error(`expected my invoice list inside .elev-left (under the gauge), found ${listUnderGauge} there`);

  // 2026-10-06: the priority picker no longer lives in the ready-gate -- it has its own 10s timed
  // "priority" window that opens once both players are ready (see priorityStep below).
  if ((await countSel(p1, ".priority-picker, .priority-window")) !== 0) throw new Error("priority picker must not render in the idle ready-gate any more");

  await pressSpace(p1);
  await p1.waitForTimeout(150);
  const stillIdleAfterOnlyP1 = (await countSel(p1, '[data-action="vote-up"]')) === 0 && (await countSel(p1, ".thief-window")) === 0;
  if (!stillIdleAfterOnlyP1) throw new Error("round 1 advanced after only p1 pressed space -- pre-round-1 both-ready gate is broken");
  await pressSpace(p2);
  log("pre-round-1 both-ready gate held while only one player was ready");

  // ---- play out a full 5-round half, handling the optional "choosing" (same-floor conflict)
  // sub-state whenever it appears, plus (후반 only) a dedicated "thief" placement window that now
  // appears before every round's voting -- both players click vote-up every round, which drives
  // the shared floor to the top and keeps it there, making same-floor collisions likely across 17
  // secured cells. ----
  // ---- 우선 택배 지정 전용 10초 창 (2026-10-06). 둘 다 스페이스로 준비하면 맨 먼저 열린다.
  // mode: "pick"(지정/해제/재지정 + 확정 버튼 + 조기 진행 시간 측정) | "timeout"(아무도 확정 안 함 -> 10초 후 자동 진행)
  //       | "space"(스페이스로 확정) | 그 외(확정 버튼만). 창이 아예 안 열리는 경우(둘 다 지정할 택배 없음)도 허용. ----
  async function priorityStep(label, round, mode, isHalf2) {
    const nextSel = isHalf2 ? ".thief-window" : '[data-action="vote-up"]';
    await waitFor(async () => (await countSel(p1, ".priority-window")) > 0 || (await countSel(p1, nextSel)) > 0, { label: `${label} round ${round}: priority window (or straight on)`, timeout: 6000 });
    if (!(await countSel(p1, ".priority-window"))) { log(`${label} round ${round}: no priority window (nothing left to pick for either player)`); return; }
    if (round > 1 && (await countSel(p1, ".priority-window .invoice.is-priority")) !== 0) throw new Error(`${label} round ${round}: previous round's priority pick leaked into the new window -- should reset every round`);
    const clockTxt = await p1.evaluate(() => { const e = document.getElementById("priority-clock"); return e ? e.textContent : null; });
    if (!clockTxt || !/^\d+:\d\d$/.test(clockTxt.trim())) throw new Error(`${label} round ${round}: #priority-clock missing or malformed: ${clockTxt}`);
    const secs = (t) => { const [m, ss] = t.trim().split(":").map(Number); return m * 60 + ss; };
    if (secs(clockTxt) < 8 || secs(clockTxt) > 10) throw new Error(`${label} round ${round}: priority clock should start at ~10s, got ${clockTxt}`);
    const t0 = Date.now();
    const pickable = '.priority-window .invoice[data-action="pick-priority"]';
    const hasPick = (await countSel(p1, pickable)) > 0;
    if (mode === "pick" && hasPick) {
      await clickSel(p1, pickable);
      await waitFor(async () => (await countSel(p1, ".priority-window .invoice.is-priority")) === 1, { label: "p1's priority pick highlights" });
      if ((await countSel(p2, ".priority-window .invoice.is-priority")) !== 0) throw new Error("p2's priority window must never reflect p1's pick -- picks are per-player");
      await clickSel(p1, ".priority-window .invoice.is-priority"); // 다시 누르면 선택 해제
      await waitFor(async () => (await countSel(p1, ".priority-window .invoice.is-priority")) === 0, { label: "p1's priority pick clears when re-clicked" });
      await clickSel(p1, pickable);
      await waitFor(async () => (await countSel(p1, ".priority-window .invoice.is-priority")) === 1, { label: "p1 re-picks priority" });
      log(`${label} round ${round}: priority pick/clear/re-pick OK, private from p2`);
    } else if (mode === "timeout" && hasPick) {
      await clickSel(p1, pickable);
    }
    if (mode === "timeout") {
      // 아무도 확정하지 않으면 PRIORITY_PICK_MS(10초)가 지나야 넘어간다 -- 너무 일찍도, 너무 늦게도 안 됨.
      await waitFor(async () => (await countSel(p1, ".priority-window")) === 0, { label: `${label} round ${round}: priority window times out`, timeout: 13000 });
      const dt = Date.now() - t0;
      if (dt < 8500 || dt > 12500) throw new Error(`${label} round ${round}: unconfirmed priority window should last ~10s, lasted ${dt}ms`);
      log(`${label} round ${round}: 확정 없이 ${(dt / 1000).toFixed(1)}초 후 자동 진행 (10초 타이머)`);
      return;
    }
    const t1 = Date.now();
    if (mode === "space") { await pressSpace(p1); await pressSpace(p2); }
    else {
      await clickSel(p1, '[data-action="confirm-priority"]');
      if (mode === "pick") {
        await waitFor(async () => (await countSel(p1, ".priority-window .invoice.pickable")) === 0, { label: "p1 locked after confirming" });
        await clickSel(p1, ".priority-window .invoice"); // 확정 후 변경 시도는 무시돼야 한다
        await p1.waitForTimeout(150);
        if (hasPick && (await countSel(p1, ".priority-window .invoice.is-priority")) !== 1) throw new Error("confirmed priority pick changed after confirmation");
      }
      await p1.waitForTimeout(250);
      if ((await countSel(p1, ".priority-window")) === 0) throw new Error(`${label} round ${round}: window closed after only p1 confirmed`);
      if ((await countSel(p2, '[data-action="confirm-priority"]')) > 0) await clickSel(p2, '[data-action="confirm-priority"]');
    }
    await waitFor(async () => (await countSel(p1, ".priority-window")) === 0, { label: `${label} round ${round}: priority window closes once both confirm`, timeout: 4000 });
    const early = Date.now() - t1;
    if (early > 4000) throw new Error(`${label} round ${round}: both confirmed but the window took ${early}ms to close`);
    log(`${label} round ${round}: 둘 다 확정 -> ${early}ms 만에 조기 진행 (${mode})`);
  }

  async function playHalf(halfLabel, isHalf2) {
    for (let round = 1; round <= 7; round++) {
      if (!isHalf2) {
        const strayThief = await countSel(p1, ".thief-window");
        if (strayThief !== 0) throw new Error(`${halfLabel} round ${round}: thief window rendered during 전반 -- should be 후반-only`);
      }
      const prioMode = halfLabel === "전반" ? ({ 1: "pick", 2: "timeout", 3: "space" }[round] || "confirm") : (round === 1 ? "space" : "confirm");
      await priorityStep(halfLabel, round, prioMode, isHalf2);

      if (isHalf2 && round === 7) {
        // 마지막 라운드엔 택배도둑 창이 열리지 않는다 (도둑은 다음 라운드부터 작동하는데 다음이 없음)
        await waitFor(async () => (await countSel(p1, '[data-action="vote-up"]')) > 0, { label: `${halfLabel} round 7: voting starts with no thief window`, timeout: 6000 });
        if (await countSel(p1, ".thief-window")) throw new Error("thief window must not open in the final round");
      } else if (isHalf2) {
        await waitFor(async () => (await countSel(p1, ".thief-window")) > 0, { label: `${halfLabel} round ${round}: thief window`, timeout: 6000 });
        if (await countSel(p1, '.thief-floors [data-action="place-thief"]')) {
          await clickSel(p1, '.thief-floors [data-action="place-thief"]');
          await waitFor(async () => (await bodyText(p1)).includes("배치했어요"), { label: `${halfLabel} round ${round}: p1's thief placement confirmed in UI`, timeout: 3000 });
        }
        if (await countSel(p2, '[data-action="skip-thief"]')) await clickSel(p2, '[data-action="skip-thief"]');
        await waitFor(async () => (await countSel(p1, '[data-action="vote-up"]')) > 0, { label: `${halfLabel} round ${round}: voting starts after thief window`, timeout: 6000 });
      } else {
        await waitFor(async () => (await countSel(p1, '[data-action="vote-up"]')) > 0, { label: `${halfLabel} round ${round}: voting starts`, timeout: 6000 });
      }

      if (halfLabel === "전반" && round === 1) {
        // no click count is ever shown -- neither mine nor the opponent's (checked once, here,
        // right as round 1 voting opens).
        await clickSel(p1, '[data-action="vote-up"]');
        await p1.waitForTimeout(300);
        const p1Text = await bodyText(p1);
        if (/[▲▼]\s*\d+/.test(p1Text.replace(/\n/g, " "))) throw new Error("a raw click counter (mine or the opponent's) is rendered during voting -- should be hidden");
        log("confirmed: no click count is ever shown (mine or the opponent's)");
      }

      await clickSel(p1, '[data-action="vote-up"]');
      await clickSel(p2, '[data-action="vote-up"]');

      // either a same-floor choice window opens (rare-but-possible with this many secured cells)
      // or we go straight to the round-result screen -- handle both.
      await waitFor(async () => {
        const t1 = await bodyText(p1);
        return t1.includes("먼저 보낼") || t1.includes(`라운드 ${round} 결과`);
      }, { label: `${halfLabel} round ${round}: choosing or result screen`, timeout: 8000 });

      if ((await bodyText(p1)).includes("먼저 보낼")) {
        const choiceSel = '.choice-list [data-action="choose-delivery"]';
        if ((await countSel(p1, choiceSel)) > 0) await clickSel(p1, choiceSel);
        if ((await countSel(p2, choiceSel)) > 0) await clickSel(p2, choiceSel);
        log(`${halfLabel} round ${round}: same-floor choice UI exercised`);
      }

      await waitFor(async () => (await bodyText(p1)).includes(`라운드 ${round} 결과`), { label: `${halfLabel} round ${round} result screen (p1)`, timeout: 8000 });
      await waitFor(async () => (await bodyText(p2)).includes(`라운드 ${round} 결과`), { label: `${halfLabel} round ${round} result screen (p2)`, timeout: 8000 });

      const hasCallout = (await countSel(p1, ".delivered-callout")) > 0;
      if (!hasCallout) throw new Error(`${halfLabel} round ${round}: delivered-items callout did not render on the result screen`);

      const listUnderGaugeResult = await countSel(p1, ".elev-left .invoice-list");
      if (listUnderGaugeResult !== 1) throw new Error(`${halfLabel} round ${round}: expected my invoice list inside .elev-left (under the gauge), found ${listUnderGaugeResult} there`);

      await pressSpace(p1);
      await p1.waitForTimeout(150);
      await pressSpace(p2);

      if (round < 7) {
        await waitFor(async () => {
          const t1 = await bodyText(p1);
          const t2 = await bodyText(p2);
          return t1.includes(`라운드 ${round + 1} / 7`) && t2.includes(`라운드 ${round + 1} / 7`);
        }, { label: `${halfLabel}: advance to round ${round + 1}`, timeout: 5000 });
      }
    }
    log(`${halfLabel}: all 7 rounds completed`);
  }

  await playHalf("전반", false);

  // ---- halftime transition: must appear after 전반's 7th round, on both viewers ----
  await waitFor(async () => {
    const t1 = await bodyText(p1);
    const t2 = await bodyText(p2);
    return t1.includes("전반 종료") && t2.includes("전반 종료");
  }, { label: "both reached halftime screen", timeout: 10000 });
  log("halftime screen reached after 전반");

  await pressSpace(p1);
  await p1.waitForTimeout(150);
  const stillHalftimeAfterOnlyP1 = (await bodyText(p1)).includes("전반 종료");
  if (!stillHalftimeAfterOnlyP1) throw new Error("halftime advanced after only p1 pressed space -- both-ready gate is broken");
  await pressSpace(p2);
  await waitFor(async () => {
    const t1 = await bodyText(p1);
    const t2 = await bodyText(p2);
    return t1.includes("택배 확보") && t2.includes("택배 확보");
  }, { label: "both entered 후반 secure phase", timeout: 5000 });
  log("halftime both-ready gate held, then correctly restarted the secure phase for 후반");

  // ---- 후반's board must be freshly reset (no cells pre-taken) ----
  const takenAtHalf2Start = await takenTotal(p1);
  if (takenAtHalf2Start !== 0) throw new Error(`후반 secure phase should start with a fresh board, but ${takenAtHalf2Start} cell(s) are already taken`);
  log("confirmed: 후반 starts with a completely fresh 17-cell board");

  for (const id of ["normal-1", "normal-2", "fixed-floor-1", "fixed-floor-2", "fragile-1", "valuable-1"]) {
    await secureCell(p1, id);
  }
  await secureCell(p2, "normal-3");
  await secureCell(p2, "fixed-floor-4");

  // ---- secure phase ends straight into elevator's idle gate again, same as half 1 -- no
  // standalone priority phase. Pick a priority invoice here too (light touch -- the full
  // pick/clear/re-pick UI mechanics were already exercised in half 1), then ready up; playHalf's
  // round-1 iteration handles the (후반-only) thief window before voting starts. ----
  await waitFor(async () => {
    const t1 = await bodyText(p1);
    const t2 = await bodyText(p2);
    return t1.includes("엘리베이터") && t2.includes("엘리베이터");
  }, { label: "both entered elevator phase (half 2)", timeout: 15000 });
  const idleVoteButtonsHalf2 = await countSel(p1, '[data-action="vote-up"]');
  if (idleVoteButtonsHalf2 !== 0) throw new Error("vote buttons should not render before both players ready up for 후반 round 1");
  const idleThiefWindowHalf2 = await countSel(p1, ".thief-window");
  if (idleThiefWindowHalf2 !== 0) throw new Error("thief window should not render before both players ready up, even in 후반");
  log("secure phase ended -> elevator phase entered directly on both for 후반 too, idle gate confirmed clean");

  await pressSpace(p1);
  await p1.waitForTimeout(150);
  await pressSpace(p2);

  await playHalf("후반", true);

  // ---- final end screen: two halves' worth of tables (2 players x 2 halves = 4 score-tables),
  // plus a grand-total currency line per player ----
  await waitFor(async () => {
    const t1 = await bodyText(p1);
    const t2 = await bodyText(p2);
    return t1.includes("총점") && t2.includes("총점");
  }, { label: "both reached end screen", timeout: 10000 });

  const scoreTableCountP1 = await countSel(p1, ".score-table");
  if (scoreTableCountP1 !== 4) throw new Error(`end screen: expected 4 rendered score-tables (2 players x 전반/후반), found ${scoreTableCountP1}`);
  const scoreTableCountP2 = await countSel(p2, ".score-table");
  if (scoreTableCountP2 !== 4) throw new Error(`end screen: expected 4 rendered score-tables on p2's view too, found ${scoreTableCountP2}`);
  log("confirmed: both halves' full itemized results are shown on the final results screen");

  // 총점 칩 라벨이 이제 "플레이어 N"이 아니라 그 좌석이 고른 택배사 이름이라(예: "쿡방 총점"),
  // 좌석 번호 -> 택배사 이름 매핑을 courierPick(전체 상태에 이미 들어있음)에서 만들어 파싱한다.
  // 반환값은 예전처럼 좌석 번호("1"/"2")로 키를 유지 -- 아래 rawScores/halfHistory 비교가 전부
  // 좌석 번호 기준이라 그대로 맞춰줘야 한다.
  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  async function endScores(p, courierPick) {
    const text = await bodyText(p);
    const winnerLine = text.split("\n").find((l) => l.includes("승리") || l.includes("무승부")) || "";
    const scores = {};
    ["1", "2"].forEach((s) => {
      const name = COURIER_NAME[courierPick[s]] || ("플레이어 " + s);
      const re = new RegExp(escapeRegExp(name) + "\\s*총점\\s*\\n?\\s*([+-]?[\\d,]+)원");
      const m = text.match(re);
      if (m) scores[s] = Number(m[1].replace(/,/g, ""));
    });
    return { winnerLine, scores };
  }
  const courierPick = lastState.p1.courierPick;
  const end1 = await endScores(p1, courierPick);
  const end2 = await endScores(p2, courierPick);
  log("p1 end screen:", end1.winnerLine, JSON.stringify(end1.scores));
  log("p2 end screen:", end2.winnerLine, JSON.stringify(end2.scores));
  if (end1.winnerLine !== end2.winnerLine) throw new Error("p1 and p2 disagree on the winner banner -- shared state diverged!\n  p1: " + end1.winnerLine + "\n  p2: " + end2.winnerLine);
  if (end1.scores["1"] !== end2.scores["1"] || end1.scores["2"] !== end2.scores["2"]) {
    throw new Error("p1 and p2 disagree on final scores -- shared state diverged!\n  p1: " + JSON.stringify(end1.scores) + "\n  p2: " + JSON.stringify(end2.scores));
  }
  log("both players see identical final scores (shared server state confirmed consistent)");

  // ---- grand total must equal the sum of both halves' snapshotted scores, and must match the
  // authoritative game-room.js scores field broadcast in the raw state ----
  const rawScores = lastState.p1.scores;
  if (!rawScores || rawScores["1"] !== end1.scores["1"] || rawScores["2"] !== end1.scores["2"]) {
    throw new Error(`displayed grand total doesn't match state.scores -- displayed: ${JSON.stringify(end1.scores)}, raw: ${JSON.stringify(rawScores)}`);
  }
  const halfHistory = lastState.p1.halfHistory;
  if (!halfHistory || halfHistory.length !== 2) throw new Error(`expected 2 halfHistory entries at game end, found ${halfHistory ? halfHistory.length : 0}`);
  const summed1 = halfHistory.reduce((s, h) => s + h.scores["1"], 0);
  const summed2 = halfHistory.reduce((s, h) => s + h.scores["2"], 0);
  if (summed1 !== rawScores["1"] || summed2 !== rawScores["2"]) {
    throw new Error(`grand total isn't the sum of both halves -- halfHistory sums: {"1":${summed1},"2":${summed2}}, state.scores: ${JSON.stringify(rawScores)}`);
  }
  log("confirmed: grand total = sum of both halves' scores, matches server-authoritative state.scores");

  // ---- client/server scoring drift check for each half snapshot, using the authoritative
  // totalScore() from game-room.js itself (imported directly, not reimplemented here) ----
  halfHistory.forEach((h, i) => {
    const r1 = serverTotalScore("1", { players: h.players });
    const r2 = serverTotalScore("2", { players: h.players });
    if (r1 !== h.scores["1"] || r2 !== h.scores["2"]) {
      throw new Error(`half ${i + 1} snapshot score mismatch -- stored: ${JSON.stringify(h.scores)}, recomputed: {"1":${r1},"2":${r2}}`);
    }
  });
  log("confirmed: both halves' snapshotted scores match game-room.js's authoritative totalScore() (no client/server drift)");

  // ---- 2026-08-28 신설: 종료 화면 "다시 시작" 버튼 -- 같은 방에서 좌석/택배사 유지한 채 새 게임 ----
  await waitFor(async () => (await countSel(p1, '[data-action="restart-ready"]')) > 0, { label: "restart button rendered on end screen" });
  await clickSel(p1, '[data-action="restart-ready"]');
  await waitFor(async () => (await bodyText(p1)).includes("대기"), { label: "p1 shows a waiting state right after clicking restart" });
  await p1.waitForTimeout(200);
  if ((await bodyText(p1)).includes("택배 확보")) {
    throw new Error("restart must NOT take effect until BOTH players click -- p1 alone flipped the phase");
  }
  await clickSel(p2, '[data-action="restart-ready"]');
  await waitFor(async () => {
    const t1 = await bodyText(p1);
    const t2 = await bodyText(p2);
    return t1.includes("택배 확보") && t2.includes("택배 확보");
  }, { label: "both players enter a fresh secure phase once BOTH click restart", timeout: 5000 });
  log("confirmed: restart button needs both players' clicks, then re-enters secure phase directly (no lobby/seat-repick)");

  if (!(await bodyText(p1)).includes(COURIER_NAME.cookbang)) {
    throw new Error("courier pick should survive a restart, but p1's courier name is missing from the new secure-phase screen");
  }
  log("confirmed: seat/courier assignment survives restart");

  const takenAfterRestart = await takenTotal(p1);
  if (takenAfterRestart !== 0) throw new Error(`expected a completely fresh board after restart, found ${takenAfterRestart} already-taken cell(s)`);
  log("confirmed: board is completely fresh after restart");

  if (lastState.p1.half !== 1) throw new Error(`expected half reset to 1 after restart, got ${lastState.p1.half}`);
  if (lastState.p1.halfHistory.length !== 0) throw new Error(`expected halfHistory cleared after restart, found ${lastState.p1.halfHistory.length} entries`);
  if (lastState.p1.scores !== null) throw new Error("expected scores cleared (null) after restart");
  log("confirmed: half/halfHistory/scores fully reset after restart");

  if (errors.length) {
    log("!! console/page errors captured during run:");
    errors.forEach((e) => log("   " + e));
    throw new Error(errors.length + " console/page error(s) occurred during the run");
  }

  await browser.close();
  log("ALL CHECKS PASSED");
}

main().catch((e) => {
  console.error("[test] FAILED:", e);
  process.exit(1);
});
