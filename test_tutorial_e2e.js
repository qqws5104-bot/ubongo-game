// 2026-10-15 시작 전 튜토리얼 -- 서버를 기본(튜토리얼 켬)으로 띄운 상태에서 브라우저 2개 + 메인 모니터 + 레일 화면.
//   둘 다 준비 -> 튜토리얼 1/6 -> 각자 Space/→ 다음, ← 이전 -> 한 사람만 건너뛰기는 안 넘어감 -> 둘 다 끝까지 보면 확보 시작
//   두 번째 방: 둘 다 ↑(건너뛰기) -> 바로 확보 시작. SHOT_DIR=/경로 면 장마다 스크린샷.
"use strict";
const { chromium } = require("playwright");
const BASE = "http://localhost:3000";
const SHOT = process.env.SHOT_DIR || null;
function log(...a) { console.log("[test-tutorial]", ...a); }
function assert(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p) => p.evaluate(() => document.body.innerText);
const count = (p, s) => p.evaluate((s) => document.querySelectorAll(s).length, s);
const click = (p, s) => p.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); return !!e; }, s);
const key = (p, code, k) => p.evaluate(({ code, k }) => document.dispatchEvent(new KeyboardEvent("keydown", { code, key: k, bubbles: true, cancelable: true })), { code, k });
async function waitFor(fn, { timeout = 15000, label = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeout) throw new Error("timeout waiting for: " + label); await sleep(100); }
}
const pageNum = (p) => p.evaluate(() => { const e = document.querySelector(".tut-num"); return e ? e.textContent.trim() : null; });

async function setup(browser, errors, withViews) {
  const mk = async (w, h) => { const p = await (await browser.newContext({ viewport: { width: w || 1280, height: h || 820 } })).newPage(); p.on("pageerror", (e) => errors.push(e.message)); return p; };
  const seed = await mk(); await seed.goto(BASE + "/"); const room = new URL(seed.url()).searchParams.get("room"); await seed.close();
  const p1 = await mk(), p2 = await mk();
  await p1.goto(BASE + "/?room=" + room); await p2.goto(BASE + "/?room=" + room);
  let mainv = null, rail = null;
  if (withViews) { mainv = await mk(1920, 1080); rail = await mk(1280, 900); await mainv.goto(BASE + "/?room=" + room + "&view=main"); await rail.goto(BASE + "/rail?room=" + room); }
  await waitFor(() => count(p1, ".seat-pick").then((n) => n > 0), { label: "seat picker" });
  await click(p1, '[data-action="pick-courier"][data-courier="cookbang"]');
  await waitFor(async () => (await text(p1)).includes("내 좌석 · 쿡방"), { label: "p1 seat" });
  await click(p2, '[data-action="pick-courier"][data-courier="cheonil"]');
  await waitFor(async () => (await text(p2)).includes("내 좌석 · 천일배송"), { label: "p2 seat" });
  await key(p1, "Space", " "); await key(p2, "Space", " ");
  await waitFor(async () => (await pageNum(p1)) === "1 / 6" && (await pageNum(p2)) === "1 / 6", { label: "tutorial page 1 on both" });
  return { p1, p2, mainv, rail };
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const errors = [];
  // ---- 방 1: 끝까지 보기 ----
  let { p1, p2, mainv, rail } = await setup(browser, errors, true);
  assert((await text(p1)).includes("이렇게 진행돼요"), "1장 제목");
  await waitFor(async () => (await text(mainv)).includes("이렇게 진행돼요"), { label: "main monitor shows tutorial" });
  await waitFor(async () => (await text(rail)).includes("진행 방법을 보는 중"), { label: "rail shows waiting" });
  log("둘 다 준비 -> 튜토리얼 1/6 (플레이어 + 메인 모니터), 레일은 대기 안내");
  for (let i = 1; i <= 6; i++) {
    if (SHOT) await p1.screenshot({ path: SHOT + "/tut_" + i + ".png" });
    await key(p1, "Space", " ");
    if (i < 6) await waitFor(async () => (await pageNum(p1)) === (i + 1) + " / 6", { label: "p1 page " + (i + 1) });
  }
  await waitFor(async () => (await text(p1)).includes("다 봤어요!"), { label: "p1 finished" });
  assert((await pageNum(p2)) === "1 / 6", "상대는 자기 속도");
  await waitFor(async () => (await text(p2)).includes("다 봤어요"), { label: "p2 sees p1 done" });
  if (SHOT) await mainv.screenshot({ path: SHOT + "/tut_main.png" });
  // ← 이전, → 다음
  await key(p2, "ArrowRight", "ArrowRight");
  await waitFor(async () => (await pageNum(p2)) === "2 / 6", { label: "p2 → next" });
  await key(p2, "ArrowLeft", "ArrowLeft");
  await waitFor(async () => (await pageNum(p2)) === "1 / 6", { label: "p2 ← prev" });
  log("각자 Space/→ 다음, ← 이전 · 먼저 다 본 사람은 대기");
  // p2가 건너뛰기 -> p1은 이미 다 봤으니 바로 시작
  await key(p2, "ArrowUp", "ArrowUp");
  await waitFor(async () => (await text(p1)).includes("택배 확보") && !(await text(p1)).includes("진행 방법"), { label: "secure starts after p1 done + p2 skip" });
  log("한쪽이 다 보고 다른 쪽이 건너뛰기 -> 확보 시작");
  // 2026-10-15 기본: 첫 미니게임 없이 바로 택배 쌓기 -- 레일엔 문제, 플레이어 화면엔 투입 버튼
  await waitFor(() => count(p1, '.race-blank [data-action="race-done"]').then((n) => n === 1), { label: "straight to ubongo (no first game)" });
  assert((await count(p1, "#mg-layer .mg-root")) === 0, "첫 미니게임 없음");
  await waitFor(() => count(rail, ".race-puzzle img").then((n) => n === 1), { label: "rail shows puzzle right away" });
  if (SHOT) { await p1.screenshot({ path: SHOT + "/race_start_p1.png" }); await rail.screenshot({ path: SHOT + "/race_start_rail.png" }); }
  log("확보 시작 = 바로 택배 쌓기 (첫 미니게임 없음), 레일에 문제");
  await p1.close(); await p2.close(); await mainv.close(); await rail.close();

  // ---- 방 2: 한 사람만 건너뛰기는 안 넘어감, 둘 다 누르면 바로 시작 ----
  ({ p1, p2 } = await setup(browser, errors, false));
  await click(p1, '[data-action="tutorial-skip"]');
  await sleep(500);
  assert((await pageNum(p1)) === "1 / 6" && (await pageNum(p2)) === "1 / 6", "한 사람만 건너뛰기면 그대로");
  assert((await text(p2)).includes("건너뛰기"), "상대 화면에 건너뛰기 표시");
  await click(p2, '[data-action="tutorial-skip"]');
  await waitFor(async () => !(await text(p1)).includes("진행 방법") && (await text(p1)).includes("택배 확보"), { label: "both skip -> secure" });
  log("한 사람만 건너뛰기 -> 그대로, 둘 다 -> 바로 시작");
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  await browser.close();
  log("ALL CHECKS PASSED");
}
main().catch((e) => { console.error("[test-tutorial] FAILED:", e); process.exit(1); });
