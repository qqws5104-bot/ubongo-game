// 2026-08-28: 사용자가 "택배도둑이 들고간 택배를 성공처리하네 계속"이라고 재차 리포트.
//
// test_theft_scoring.js는 GameRoom을 직접 구동해 서버 로직(scoreInvoice/resultLabel/round log)이
// 정확함을 이미 확인했지만, 그건 클라이언트가 실제로 화면에 뭘 그리는지까지는 보지 못한다. 사용자가
// "계속" 눈으로 본다고 재차 말했으므로, 이번엔 진짜 브라우저(Playwright) + 진짜 WS 서버로 처음부터
// 끝까지 플레이해서, 도난당한 송장이 (a) 라운드 결과 화면, (b) 내 송장 목록, (c) 최종 결과 화면
// 세 군데 모두에서 실제 렌더링 텍스트/스타일로 "미배송"/실패로 보이는지 직접 확인한다.
//
// test_hosted.js의 검증된 idle/voting/result 대기 패턴(텍스트 매칭 기반, 임의의 sleep 없음)을 그대로
// 재사용한다 -- 임의 sleep으로 라운드 타이밍을 추측하면 서버 상태와 어긋나기 쉽다는 걸 시행착오로 확인함.
"use strict";
const { chromium } = require("playwright");
const { COURIERS } = require("./game-data.js");
const COURIER_NAME = {};
COURIERS.forEach((c) => { COURIER_NAME[c.key] = c.name; });

const BASE = "http://localhost:3000";
function log(...args) { console.log("[test-theft-e2e]", ...args); }

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

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const seedCtx = await browser.newContext();
  const seedPage = await seedCtx.newPage();
  await seedPage.goto(BASE + "/");
  const room = new URL(seedPage.url()).searchParams.get("room");
  await seedCtx.close();
  log("room:", room);
  const roomUrl = BASE + "/?room=" + room;

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

  await waitFor(async () => {
    const t1 = await bodyText(p1), t2 = await bodyText(p2);
    return t1.includes("엘리베이터") && t2.includes("엘리베이터");
  }, { label: "전반 elevator phase (idle gate) 도달", timeout: 15000 });
  log("전반 elevator phase 진입");

  // 전반 5라운드: 확보한 게 없어 배송도 없다 -- idle/result 게이트만 통과시키며 흘려보낸다.
  for (let round = 1; round <= 5; round++) {
    await pressSpace(p1); await pressSpace(p2); // idle 또는 이전 라운드의 result 게이트 통과
    await waitFor(async () => (await countSel(p1, '[data-action="vote-up"]')) > 0, { label: `전반 round ${round} voting 시작`, timeout: 8000 });
    await clickSel(p1, '[data-action="vote-up"]');
    await clickSel(p2, '[data-action="vote-up"]');
    await waitFor(async () => (await bodyText(p1)).includes(`라운드 ${round} 결과`), { label: `전반 round ${round} 결과`, timeout: 8000 });
  }
  log("전반 5라운드 통과");
  // 5라운드 결과 게이트도 다른 라운드와 동일하게 "둘 다 스페이스"로 넘겨야 half가 끝난다
  // (setElevatorReady: el.state==="result"이고 round>=ELEVATOR_ROUNDS일 때 비로소 _finishHalf 호출).
  await pressSpace(p1); await pressSpace(p2);

  await waitFor(async () => (await bodyText(p1)).includes("전반 종료"), { label: "halftime 화면", timeout: 8000 });
  await pressSpace(p1); await pressSpace(p2);
  await waitFor(async () => (await bodyText(p1)).includes("택배 확보"), { label: "후반 secure phase", timeout: 8000 });
  log("후반 secure phase 진입");

  // p2가 확정 층수 택배의 B1칸(fixed-floor-1)을 확보 -- floorIdx가 확정적으로 0(B1)이 된다.
  await clickSel(p2, '[data-action="open-cell"][data-cell="fixed-floor-1"]');
  await waitFor(async () => (await countSel(p2, ".overlay:not(.hidden)")) > 0, { label: "p2 퍼즐 오버레이" });
  await clickSel(p2, '[data-action="complete-cell"]');
  await waitFor(async () => (await countSel(p2, ".cell.taken")) > 0, { label: "p2 fixed-floor-1 확보 확인" });
  log("p2가 B1행 확정 층수 택배 확보 완료");

  await waitFor(async () => {
    const t1 = await bodyText(p1), t2 = await bodyText(p2);
    return t1.includes("엘리베이터") && t2.includes("엘리베이터");
  }, { label: "후반 elevator phase (idle gate) 도달", timeout: 15000 });

  // ---- 후반 round 1: idle 게이트 통과 -> thief window. p1이 B1(층 인덱스 0)에 도둑 배치, p2는 넘김 ----
  await pressSpace(p1); await pressSpace(p2);
  await waitFor(async () => (await countSel(p1, ".thief-window")) > 0, { label: "후반 round 1 thief window", timeout: 8000 });
  await clickSel(p1, '.thief-floors [data-action="place-thief"][data-floor-idx="0"]');
  await waitFor(async () => (await bodyText(p1)).includes("배치했어요"), { label: "p1 thief 배치 확인" });
  await clickSel(p2, '[data-action="skip-thief"]');
  await waitFor(async () => (await countSel(p1, '[data-action="vote-up"]')) > 0, { label: "round 1 voting 시작" });

  // round 1은 투표 없이(엘리베이터가 시작 층 1F에 그대로 머물도록) 그냥 흘려보낸다 -- p2의 B1행
  // 송장이 이 라운드에 배송되면(도둑이 아직 활성화 전이라 정상 성공) 시나리오가 깨진다.
  await waitFor(async () => (await bodyText(p1)).includes("라운드 1 결과"), { label: "round 1 결과", timeout: 8000 });
  await pressSpace(p1); await pressSpace(p2);

  // ---- 후반 round 2: 지난 라운드 도둑이 이제 활성화. p2가 넘김(p1은 이미 usedThisHalf라 자동 skip) ----
  await waitFor(async () => (await countSel(p1, ".thief-window")) > 0, { label: "후반 round 2 thief window", timeout: 8000 });
  await clickSel(p2, '[data-action="skip-thief"]');
  await waitFor(async () => (await countSel(p1, '[data-action="vote-up"]')) > 0, { label: "round 2 voting 시작" });

  // 엘리베이터를 1F(시작) -> B1로 한 칸 내려서, p2의 B1행 송장이 이번 라운드에 배송(=도난)되게 한다.
  await clickSel(p1, '[data-action="vote-down"]');
  await waitFor(async () => (await bodyText(p1)).includes("라운드 2 결과"), { label: "round 2 결과", timeout: 8000 });

  // ---- 핵심 검증 1: p2의 라운드 결과 화면(내 송장 목록 + 이번 라운드 배송 안내) ----
  const p2ResultText = await bodyText(p2);
  log("p2 round-2 결과 화면 텍스트 일부:", p2ResultText.replace(/\n+/g, " | ").slice(0, 500));
  if (!p2ResultText.includes("도난당했어요")) {
    throw new Error("REGRESSION: p2's round-result callout does not mention the theft -- expected '택배도둑에게 도난당했어요!'");
  }
  log("확인: 라운드 결과 화면에 '도난당했어요' 안내가 정확히 표시됨");

  // ---- 핵심 검증 2: p2의 송장 목록에서 그 송장의 스티커가 '미배송'(pending 스타일)인지,
  // 초록 '성공' 배지(class="sticker"만, pending 없음)로 잘못 표시되진 않는지 ----
  const invoiceCheck = await p2.evaluate(() => {
    const invoices = Array.from(document.querySelectorAll(".invoice"));
    const target = invoices.find((el) => el.querySelector(".meta .d") && el.querySelector(".meta .d").textContent.includes("B0"));
    if (!target) return { found: false };
    const sticker = target.querySelector(".sticker");
    return {
      found: true,
      stickerText: sticker ? sticker.textContent : null,
      stickerIsPending: sticker ? sticker.classList.contains("pending") : null,
    };
  });
  log("p2 송장 목록에서 찾은 B1행 송장 스티커 상태:", JSON.stringify(invoiceCheck));
  if (!invoiceCheck.found) throw new Error("could not find the B1 (확정 층수 택배) invoice row in p2's invoice list");
  if (invoiceCheck.stickerText !== "미배송") {
    throw new Error(`REGRESSION: stolen invoice's sticker text should be "미배송", got "${invoiceCheck.stickerText}"`);
  }
  if (!invoiceCheck.stickerIsPending) {
    throw new Error("REGRESSION: stolen invoice's sticker should have the muted/pending style, not the green success style");
  }
  log("확인: 송장 목록에서도 도난 송장이 초록 '성공' 배지가 아니라 미배송(pending) 스타일로 표시됨");

  // ---- 나머지 라운드들은 그냥 흘려보내 후반 끝까지 진행, 최종 결과 화면 확인 ----
  await pressSpace(p1); await pressSpace(p2);
  for (let round = 3; round <= 5; round++) {
    await waitFor(async () => (await countSel(p1, ".thief-window")) > 0, { label: `후반 round ${round} thief window`, timeout: 8000 });
    if (await countSel(p1, '[data-action="skip-thief"]')) await clickSel(p1, '[data-action="skip-thief"]');
    if (await countSel(p2, '[data-action="skip-thief"]')) await clickSel(p2, '[data-action="skip-thief"]');
    await waitFor(async () => (await countSel(p1, '[data-action="vote-up"]')) > 0, { label: `후반 round ${round} voting`, timeout: 8000 });
    await clickSel(p1, '[data-action="vote-up"]');
    await clickSel(p2, '[data-action="vote-up"]');
    await waitFor(async () => (await bodyText(p1)).includes(`라운드 ${round} 결과`), { label: `후반 round ${round} 결과`, timeout: 8000 });
    await pressSpace(p1); await pressSpace(p2);
  }
  log("후반 5라운드 전체 완료");

  await waitFor(async () => (await bodyText(p1)).includes("승리") || (await bodyText(p1)).includes("무승부"), { label: "end 화면", timeout: 8000 });

  // ---- 핵심 검증 3: 최종 결과 화면(후반 표)에서도 이 송장이 '미배송'으로 표시되는지 ----
  const endText = await p2.evaluate(() => document.body.innerText);
  const b1Row = endText.split("\n").find((line) => line.includes("B0") && /미배송|성공/.test(line));
  log("최종 결과 화면의 해당 행:", b1Row);
  if (!b1Row || !b1Row.includes("미배송")) {
    throw new Error(`REGRESSION: final results table should show 미배송 for the stolen B1 invoice, found row: ${b1Row}`);
  }
  log("확인: 최종 결과 화면에서도 도난 송장이 정확히 '미배송'으로 표시됨");

  if (errors.length) throw new Error("page errors: " + errors.join("; "));

  await browser.close();
  log("ALL CHECKS PASSED -- 도난당한 택배는 라운드 결과 화면, 송장 목록, 최종 결과 화면 세 군데 모두에서 일관되게 '미배송'/실패로 표시됨 (성공으로 보이는 곳 없음)");
}

main().catch((e) => { console.error("[test-theft-e2e] FAILED:", e); process.exit(1); });
