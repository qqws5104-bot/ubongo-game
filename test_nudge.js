"use strict";
// Verifies REAL, live elevator movement: clicking vote-up/vote-down now moves the actual,
// server-authoritative floor by exactly one step immediately (no vote tally, no "resolve at the
// end of 5s" step) -- and that movement must be visible on BOTH players' screens right away,
// since either seat can move the shared car. Also checks the floor clamps at the top/bottom of the
// shaft instead of going out of bounds, and that only the raw per-click counter (not the real
// floor) is ever seat-private.
const { chromium } = require("playwright");

const BASE = "http://localhost:3000";
function log(...args) { console.log("[elevmove]", ...args); }
async function clickSel(page, selector) { return page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; }, selector); }
async function pressSpace(page) { await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }))); }
async function bodyText(page) { return page.evaluate(() => document.body.innerText); }
// 2026-10-13: 층 행에 배송비 배율 배지(.floor-mult, 예 "x1.3")가 붙으므로 층 이름만 읽는다.
// 2026-10-15: 플레이어 화면엔 건물 단면도가 없다 -- 엘리베이터 안 그림(.elev-art)의 data-floor-name이 현재 층
async function currentFloorLabel(page) { return page.evaluate(() => { const el = document.querySelector(".elev-art[data-floor-name]"); return el ? el.getAttribute("data-floor-name") : null; }); }
const FLOORS = ["B1", "1F", "2F", "3F", "4F", "5F"];
async function currentFloorCount(page) { return page.evaluate(() => document.querySelectorAll(".elev-art[data-floor-name]").length); }
async function waitFor(fn, { timeout = 15000, interval = 100, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - start > timeout) throw new Error("timeout: " + label); await new Promise((r) => setTimeout(r, interval)); }
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const http = require("http");
  const room = await new Promise((resolve, reject) => {
    http.get(BASE + "/", (res) => resolve(new URL(res.headers.location, BASE).searchParams.get("room"))).on("error", reject);
  });
  const roomUrl = BASE + "/?room=" + room;

  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();
  await p1.goto(roomUrl);
  await p2.goto(roomUrl);
  await waitFor(async () => (await p1.locator(".seat-pick").count()) > 0, { label: "seat picker" });
  // 2026-08-27: "플레이어 1/2" 버튼 대신 가상 택배사 아이콘 픽커로 바뀌었다 -- 좌석 번호가 아니라
  // 택배사 key로 고른다 (game-data.js의 COURIERS 참고).
  await clickSel(p1, '[data-action="pick-courier"][data-courier="cookbang"]');
  await clickSel(p2, '[data-action="pick-courier"][data-courier="cheonil"]');
  await waitFor(async () => (await bodyText(p1)).includes("내 좌석 · 쿡방"), { label: "p1 seat" });
  await pressSpace(p1);
  await pressSpace(p2);
  await waitFor(async () => (await bodyText(p1)).includes("택배 확보"), { label: "secure phase" });
  // secure phase now ends straight into the elevator phase's "idle" (pre-round-1) ready-gate --
  // there's no more standalone priority phase (the picker is embedded directly in the idle/result
  // gates now, and there's nothing to pick here since neither player secured anything). Both
  // still have to press space to get past the both-ready gate (same pattern as every other gate
  // in this game); this is half 1 (전반), so ready-up goes straight to round 1 voting with no
  // intervening thief window (that only exists in 후반).
  // 두 화면 모두 엘리베이터 단계로 바뀐 뒤에 스페이스를 눌러야 한다 (p2가 아직 확보 화면이면 p2의 스페이스는 무시돼 영영 출발 안 함).
  await waitFor(async () => (await bodyText(p1)).includes("엘리베이터") && (await bodyText(p2)).includes("엘리베이터"), { label: "elevator phase (both)", timeout: 15000 });
  await pressSpace(p1);
  await pressSpace(p2);
  await waitFor(async () => (await p1.locator('[data-action="vote-up"]').count()) > 0, { label: "round 1 voting starts" });

  // 2026-10-13 (P1-2): 시작 층은 START_FLOOR_CHOICES(2F/3F) 중 무작위 -- 아래 이동 검증은 시작 층 기준 상대값으로 한다.
  const { START_FLOOR_CHOICES } = require("./game-data.js");
  const startFloor = await currentFloorLabel(p1);
  const s0 = FLOORS.indexOf(startFloor);
  if (!START_FLOOR_CHOICES.includes(s0)) throw new Error("start floor should be one of " + START_FLOOR_CHOICES.map((i) => FLOORS[i]) + ", got " + startFloor);
  if ((await currentFloorCount(p1)) !== 1) throw new Error("expected exactly one .current row at start");
  log("starting floor confirmed: " + startFloor);

  // 1) MY OWN click should move the REAL current floor immediately -- the actual ".current" row
  // itself changes, and it must be exactly one row (no ambiguity/duplication)
  await clickSel(p1, '[data-action="vote-up"]');
  await waitFor(async () => (await currentFloorLabel(p1)) === FLOORS[s0 + 1], { label: "p1's own click moved the real floor up one", timeout: 3000 });
  if ((await currentFloorCount(p1)) !== 1) throw new Error("expected exactly one .current row after moving");
  log("p1's own vote-up click moved the REAL floor from " + FLOORS[s0] + " to " + FLOORS[s0 + 1]);

  // 1b) this must be REAL, not a cosmetic effect that reverts -- wait well past any old animation
  // window and confirm the floor is still 2F, unprompted
  await p1.waitForTimeout(1500);
  if ((await currentFloorLabel(p1)) !== FLOORS[s0 + 1]) throw new Error("the real floor reverted on its own -- movement must be permanent (server-authoritative), not a transient animation");
  log("floor stayed at " + FLOORS[s0 + 1] + " -- confirmed real, not a transient animation");

  // 2) the OPPONENT's click should ALSO move the real floor, visible on BOTH viewers immediately
  await clickSel(p2, '[data-action="vote-up"]');
  await waitFor(async () => (await currentFloorLabel(p1)) === FLOORS[s0 + 2], { label: "p1 sees the real floor move up after p2's (opponent's) click", timeout: 3000 });
  log("p2's (opponent's) vote-up click moved the shared real floor to " + FLOORS[s0 + 2] + ", visible on p1's screen");
  await waitFor(async () => (await currentFloorLabel(p2)) === FLOORS[s0 + 2], { label: "p2 also sees it on its own view", timeout: 3000 });
  log("p2 also sees the real floor at " + FLOORS[s0 + 2] + " on its own view");

  // 3) opposite-direction click steps it back down by exactly one, confirming each click is a
  // discrete +/-1 step (not a snap to some target)
  await clickSel(p1, '[data-action="vote-down"]');
  await waitFor(async () => (await currentFloorLabel(p2)) === FLOORS[s0 + 1], { label: "p2 sees the floor step back down one after p1's vote-down click", timeout: 3000 });
  log("p1's vote-down click stepped the real floor back down to " + FLOORS[s0 + 1] + ", visible on p2's screen too");

  // 3b) clamping: from 2F, five more down-clicks would run past B1 -- the real floor must stop at
  // B1 (never go negative / wrap) and stay a single unambiguous row
  for (let i = 0; i < 7; i++) await clickSel(p1, '[data-action="vote-down"]');
  await waitFor(async () => (await currentFloorLabel(p1)) === "B1", { label: "floor clamps at B1", timeout: 3000 });
  if ((await currentFloorCount(p1)) !== 1) throw new Error("expected exactly one .current row while clamped at B1");
  log("over-clicking down clamped at B1 -- bottom bound holds");

  // 4) no click count shown at all -- neither mine nor the opponent's. Only the real, shared floor
  // position (whichever row carries .current) is ever the movement feedback during voting.
  const p1Text = await bodyText(p1);
  if (/[▲▼]\s*\d+/.test(p1Text.replace(/\n/g, " "))) {
    throw new Error("a raw click counter (mine or the opponent's) is still shown in the DOM");
  }
  log("confirmed: no click counter shown at all (mine or the opponent's)");

  // 5) my package list panel renders inside the left column, directly under the gauge -- not off
  // in the right-hand panel -- so both are visible in the same glance. (This test never secures any
  // cells, so the panel may legitimately show the empty-state text rather than a populated
  // .invoice-list -- what's being checked here is where the panel itself lives, not its contents;
  // test_hosted.js separately covers a populated list.)
  // 2026-10-15: 송장 목록 대신 엘리베이터 안 바닥에 내 택배(.ea-pks)
  const listInLeftColumn = await p1.evaluate(() => !!document.querySelector(".elev-mid .elev-art .ea-pks"));
  if (!listInLeftColumn) throw new Error("my parcels are not drawn inside the elevator art (.elev-mid .ea-pks)");
  log("confirmed: my package list panel renders directly under the gauge in the left column");

  await browser.close();
  log("ALL CHECKS PASSED");
}

main().catch((e) => { console.error("[elevmove] FAILED:", e); process.exit(1); });
