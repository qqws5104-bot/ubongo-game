// 2026-10-08: 실물 우봉고 복귀 후 확보 단계 검증 (전반/후반 퍼즐 이미지 + 조각 수 + 완료/포기).
//   종류별 조각(색) 수 = 일반 2 / 깨지기 3 / 귀중품 4 / 확정 층수 3 (사용자: "2~4개가 제일 적당").
//   전반과 후반은 서로 다른 이미지 세트를 쓴다. "완료"는 자기 신고(서버는 이미지를 모른다), "포기"는 아무 일도 안 일어난다.
// 사전 준비: SECURE_PHASE_MS를 임시로 단축(40 * 1000 -- 전반에 칸을 여러 번 열어 보므로 너무 짧으면 안 됨) + build_client.py 재빌드 + 서버 재시작. 끝나면 원복.
// (디지털 미니게임 버전은 test_half_difficulty_digital.js -- python3 set_mini.py digital 상태에서 돈다.)
"use strict";
const { chromium } = require("playwright");
const { COURIERS } = require("./game-data.js");
const COURIER_NAME = {};
COURIERS.forEach((c) => { COURIER_NAME[c.key] = c.name; });

const BASE = "http://localhost:3000";
function log(...args) { console.log("[test-half-diff]", ...args); }

async function clickSel(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
}
async function countSel(page, selector) { return page.evaluate((sel) => document.querySelectorAll(sel).length, selector); }
async function bodyText(page) { return page.evaluate(() => document.body.innerText); }
async function pressSpace(page) {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }));
  });
}
async function waitFor(fn, { timeout = 15000, interval = 100, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("timeout waiting for: " + label);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// 2026-10-06: 라운드 준비(스페이스) 직후 우선 택배 지정 10초 창이 열린다 -- 지정할 택배가 있는 쪽은 "확정"으로 통과시킨다.
async function passPriority(p1, p2, nextSel) {
  await waitFor(async () => (await countSel(p1, ".priority-window")) > 0 || (await countSel(p1, nextSel)) > 0, { label: "priority window (or straight on)", timeout: 8000 });
  if ((await countSel(p1, ".priority-window")) === 0) return;
  if (await countSel(p1, '[data-action="confirm-priority"]')) await clickSel(p1, '[data-action="confirm-priority"]');
  if (await countSel(p2, '[data-action="confirm-priority"]')) await clickSel(p2, '[data-action="confirm-priority"]');
  await waitFor(async () => (await countSel(p1, ".priority-window")) === 0, { label: "priority window closes", timeout: 4000 });
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const seedCtx = await browser.newContext();
  const seedPage = await seedCtx.newPage();
  await seedPage.goto(BASE + "/");
  const room = new URL(seedPage.url()).searchParams.get("room");
  await seedCtx.close();
  log("room:", room);
  const roomUrl = BASE + "/?room=" + room + "&mgtest=1"; // 미니게임 칸 빠른 처리용 테스트 훅

  const ctx1 = await browser.newContext(), ctx2 = await browser.newContext();
  const p1 = await ctx1.newPage(), p2 = await ctx2.newPage();
  const errors = [];
  for (const [label, p] of [["p1", p1], ["p2", p2]]) {
    p.on("pageerror", (e) => errors.push(label + " pageerror: " + e.message));
  }

  await p1.goto(roomUrl);
  await p2.goto(roomUrl);
  await waitFor(() => countSel(p1, ".seat-pick").then((n) => n > 0), { label: "seat picker" });

  await clickSel(p1, '[data-action="pick-courier"][data-courier="cookbang"]');
  await waitFor(async () => (await bodyText(p1)).includes(COURIER_NAME.cookbang), { label: "p1 picks cookbang" });
  await clickSel(p2, '[data-action="pick-courier"][data-courier="cheonil"]');
  await waitFor(async () => (await bodyText(p2)).includes(COURIER_NAME.cheonil), { label: "p2 picks cheonil" });

  await pressSpace(p1); await pressSpace(p2);
  await waitFor(async () => (await bodyText(p1)).includes("택배 확보"), { label: "전반 secure phase" });
  log("전반 secure phase 진입 -- 아무것도 확보하지 않음(전반 결과는 이 테스트와 무관)");
  const PIECES = { normal: 2, fragile: 3, valuable: 4, "fixed-floor": 3 };
  const NAME = { normal: "일반택배", fragile: "깨지기 쉬운 택배", valuable: "귀중품", "fixed-floor": "확정 층수 택배" };
  const CAT = { normal: 0, fragile: 1, valuable: 2 };
  const openOverlay = async (id) => {
    const kind = id.replace(/-\d+$/, "");
    await clickSel(p1, kind === "fixed-floor" ? '[data-action="open-cell"][data-cell="' + id + '"]' : '.rail-btn[data-action="open-type"][data-cat="' + CAT[kind] + '"]');
    await waitFor(async () => (await countSel(p1, "#puzzle-overlay img")) === 1, { label: "puzzle overlay for " + id, timeout: 4000 });
    return p1.evaluate(() => ({ head: document.querySelector("#puzzle-overlay .puzzle-frame > div").textContent, src: document.querySelector("#puzzle-overlay img").src.length + ":" + document.querySelector("#puzzle-overlay img").src.slice(-60) }));
  };
  const closeOverlay = async () => { await clickSel(p1, '[data-action="give-up"]'); await waitFor(async () => (await countSel(p1, "#puzzle-overlay img")) === 0, { label: "overlay closes" }); };
  const imgs = { 1: {}, 2: {} };
  async function checkHalf(half) {
    for (const id of ["normal-1", "fragile-1", "valuable-1", "fixed-floor-3"]) {
      const kind = id.replace(/-\d+$/, "");
      const o = await openOverlay(id);
      assert_(o.head.includes(NAME[kind]) && o.head.includes("조각 " + PIECES[kind] + "개"), `${half === 1 ? "전반" : "후반"} ${NAME[kind]}: 조각 ${PIECES[kind]}개여야 함, got '${o.head}'`);
      imgs[half][kind] = o.src;
      await closeOverlay();
    }
    log(`${half === 1 ? "전반" : "후반"} 우봉고: 일반 2 / 깨지기 3 / 귀중품 4 / 확정 층수 3 조각 표시`);
  }
  await waitFor(async () => (await bodyText(p1)).includes("우봉고"), { label: "board names the game 우봉고" });
  await checkHalf(1);
  // 포기 = 확보 안 됨, 완료 = 확보됨(자기 신고)
  await openOverlay("normal-1"); await closeOverlay();
  assert_((await countSel(p1, '.board-row[data-cat="0"] .my-chip')) === 0, "포기하면 확보되지 않는다");
  await openOverlay("normal-1");
  await clickSel(p1, '[data-action="complete-cell"]');
  await waitFor(async () => (await countSel(p1, '.board-row[data-cat="0"] .my-chip')) === 1, { label: "완료 -> 확보 (my-chip)" });
  log("포기 -> 미확보, 완료 -> 확보(호수 칩 생김)");

  await waitFor(async () => {
    const t1 = await bodyText(p1), t2 = await bodyText(p2);
    return t1.includes("엘리베이터") && t2.includes("엘리베이터");
  }, { label: "전반 elevator phase (idle gate) 도달", timeout: 50000 });
  log("전반 elevator phase 진입");

  // 전반 5라운드: 확보한 게 없어 배송도 없다 -- idle/result 게이트만 통과시키며 흘려보낸다.
  for (let round = 1; round <= 7; round++) {
    await pressSpace(p1); await pressSpace(p2); // idle 또는 이전 라운드의 result 게이트 통과
    await passPriority(p1, p2, '[data-action="vote-up"]');
    await waitFor(async () => (await countSel(p1, '[data-action="vote-up"]')) > 0, { label: `전반 round ${round} voting 시작`, timeout: 8000 });
    await clickSel(p1, '[data-action="vote-up"]');
    await clickSel(p2, '[data-action="vote-up"]');
    await waitFor(async () => (await bodyText(p1)).includes(`라운드 ${round} 결과`), { label: `전반 round ${round} 결과`, timeout: 8000 });
  }
  log("전반 7라운드 통과");
  // 7라운드 결과 게이트도 다른 라운드와 동일하게 "둘 다 스페이스"로 넘겨야 half가 끝난다
  // (setElevatorReady: el.state==="result"이고 round>=ELEVATOR_ROUNDS일 때 비로소 _finishHalf 호출).
  await pressSpace(p1); await pressSpace(p2);

  await waitFor(async () => (await bodyText(p1)).includes("전반 종료"), { label: "halftime 화면", timeout: 8000 });
  await pressSpace(p1); await pressSpace(p2);
  await waitFor(async () => (await bodyText(p1)).includes("택배 확보"), { label: "후반 secure phase", timeout: 8000 });
  log("후반 secure phase 진입");

  // ---- 후반 보드: 같은 조각 수, 다른 이미지 ----
  await checkHalf(2);
  for (const kind of Object.keys(PIECES)) assert_(imgs[1][kind] !== imgs[2][kind], `${NAME[kind]}: 전반과 후반은 다른 퍼즐 이미지여야 함`);
  log("전반/후반 퍼즐 이미지가 서로 다름");

  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  await browser.close();
  log("ALL CHECKS PASSED");
}
function assert_(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); }
main().catch((e) => { console.error("[test-half-diff] FAILED:", e); process.exit(1); });
