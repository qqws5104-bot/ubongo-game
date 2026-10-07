// 2026-08-28 회귀 테스트: "한번씩 대기 시간에 택배사 선택이 안 떠" 버그 리포트.
//
// 근본 원인: server.js의 ws.on("close")가 유예 없이 즉시 releaseSeatIfOrphaned를 호출했다.
// 클라이언트는 연결이 끊기면 1.2초 뒤 자동 재접속하는데(build_client.py connectWS), 재접속하기도
// 전에 서버가 로비 단계의 courierPick을 지워버려서, 재접속한 클라이언트가 좌석은 되찾아도(pick-seat
// reclaim) 택배사 선택은 잃어버린 채 "스페이스바 대기" 화면만 보게 됐다.
//
// 이 테스트는 실제 WS 연결을 끊었다가(context.setOffline) 클라이언트의 자동 재접속 지연(1.2초)보다
// 조금 더 길게, 하지만 서버의 유예 시간(SEAT_RELEASE_GRACE_MS, 5초)보다는 짧게 끊어둔 뒤 다시
// 연결해서, 재접속 후에도 "내 좌석 · <택배사 이름>"이 그대로 남아 있는지 확인한다.
"use strict";
const { chromium } = require("playwright");
const { COURIERS } = require("./game-data.js");
const COURIER_NAME = {};
COURIERS.forEach((c) => { COURIER_NAME[c.key] = c.name; });

const BASE = "http://localhost:3000";

function log(...args) { console.log("[test-reconnect]", ...args); }

async function clickSel(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
}
async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
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

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

  const seedCtx = await browser.newContext();
  const seedPage = await seedCtx.newPage();
  await seedPage.goto(BASE + "/");
  const room = new URL(seedPage.url()).searchParams.get("room");
  if (!room) throw new Error("bad room code");
  await seedCtx.close();
  log("room code:", room);

  const roomUrl = BASE + "/?room=" + room;
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();

  const errors = [];
  p1.on("pageerror", (e) => errors.push("p1 pageerror: " + e.message));

  // p1의 WebSocket을 가로채서 진짜로 소켓을 끊을 수 있게 해둔다 -- context.setOffline()은 이미 열린
  // 유휴 WS 연결을 즉시 끊지 않는다는 걸 별도 프로브로 확인했다(오프라인 3초 동안 close 이벤트가 전혀
  // 안 뜸). routeWebSocket으로 실제 연결을 가로채고 나중에 .close()를 호출해야 서버 쪽 ws.on("close")가
  // 진짜로 발화한다.
  let p1WsRoute = null;
  await p1.routeWebSocket(/.*/, (ws) => { p1WsRoute = ws; ws.connectToServer(); });

  await p1.goto(roomUrl);
  await p2.goto(roomUrl);

  await clickSel(p1, '[data-action="pick-courier"][data-courier="cookbang"]');
  await waitFor(async () => (await bodyText(p1)).includes("내 좌석 · " + COURIER_NAME.cookbang),
    { label: "p1 picked cookbang courier" });
  await clickSel(p2, '[data-action="pick-courier"][data-courier="cheonil"]');
  await waitFor(async () => (await bodyText(p2)).includes("내 좌석 · " + COURIER_NAME.cheonil),
    { label: "p2 picked cheonil courier" });
  log("p1 -> " + COURIER_NAME.cookbang + ", p2 -> " + COURIER_NAME.cheonil + " (둘 다 로비, 아직 스페이스바 안 누름)");

  // ---- p1의 WS만 실제로 강제 종료 (routeWebSocket으로 가로챈 실제 연결을 close) ----
  // 클라이언트는 이 close를 감지하고 1.2초 뒤 자동으로 재접속한다(connectWS의 ws.onclose 참고).
  if (!p1WsRoute) throw new Error("p1 websocket route never attached");
  p1WsRoute.close();
  log("p1 WS forcibly closed -- server's ws.on('close') should fire now");
  await p1.waitForTimeout(2500);
  log("waited past the 1.2s auto-reconnect delay, checking p1's state");

  // 재접속 후: 서버가 courierPick을 지우지 않았어야 하므로, 좌석 선택 화면(택배사 아이콘 5개)이
  // 아니라 "내 좌석 · 쿡방" 로비 화면이 그대로 유지돼야 한다.
  await waitFor(async () => {
    const t = await bodyText(p1);
    return t.includes("내 좌석 · " + COURIER_NAME.cookbang);
  }, { label: "p1 still shows its courier after reconnect", timeout: 8000 });

  const seatPickerVisibleAfterReconnect = await p1.evaluate(() => document.querySelectorAll(".seat-pick").length > 0);
  if (seatPickerVisibleAfterReconnect) {
    throw new Error("REGRESSION: p1 fell back to the courier picker after a brief reconnect -- seat/courierPick was wiped");
  }
  log("confirmed: brief disconnect+reconnect during lobby does NOT wipe p1's courier pick");

  // ---- 이어서 둘 다 준비 완료까지 정상 진행되는지도 확인 (재접속 후 흐름이 안 끊겼는지) ----
  await p1.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }));
  });
  await waitFor(async () => (await bodyText(p1)).includes("준비 완료"), { label: "p1 ready chip flips after reconnect" });
  log("p1 could still press ready after reconnecting -- lobby flow intact");

  if (errors.length) throw new Error("page errors occurred:\n" + errors.join("\n"));

  await browser.close();
  log("ALL PASSED");
}

main().catch((e) => {
  console.error("[test-reconnect] FAILED:", e);
  process.exit(1);
});
