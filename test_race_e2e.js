// 2026-10-14 확보 단계 레이스 라운드 -- 진짜 브라우저 2개 + 레일 화면 + 메인 모니터로 처음부터 엘리베이터 진입까지.
//   - 확보가 시작되면 두 사람 모두 같은 첫 게임(5종 중 무작위)이 자동으로 뜬다 (상대 진행 띠 포함)
//   - 택배 쌓기 문제 그림은 레일 화면(과 메인 모니터)에만 하나, 플레이어 화면엔 투입/포기 버튼만
//   - 송장 붙이기를 끝내면 우봉고 문제 + 투입 버튼, 상대 화면에는 내 진행 단계가 보인다
//   - 택배 3개는 종류만 보인다. 먼저 투입한 사람이 ← ↑ → 로 고르면 자기 화면에만 송장(층·금액)이 나온다
//   - 늦은 사람은 마감 안에 투입하면 남은 것 중 고른다, 마감을 넘기면 못 가져감, 남은 건 레일로 돌아감
//   - 레일 화면/메인 모니터는 관전 화면(같은 레이스 상태)
// 필요: SECURE_PHASE_MS 100초 이상 (늦은 사람 투입 마감 30초를 한 번 기다리므로, regress.sh가 맞춘다). SHOT_DIR=/경로 면 단계별 스크린샷 저장.
"use strict";
const { chromium } = require("playwright");
const BASE = "http://localhost:3000";
const SHOT = process.env.SHOT_DIR || null;
function log(...a) { console.log("[test-race-e2e]", ...a); }
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
async function shot(p, name) { if (SHOT) await p.screenshot({ path: SHOT + "/" + name + ".png" }); }

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const errors = [];
  const mk = async (w, h) => { const p = await (await browser.newContext({ viewport: { width: w || 1280, height: h || 820 } })).newPage(); p.on("pageerror", (e) => errors.push(e.message)); return p; };
  const seed = await mk(); await seed.goto(BASE + "/"); const room = new URL(seed.url()).searchParams.get("room"); await seed.close();
  const p1 = await mk(), p2 = await mk(), rail = await mk(1280, 900), mainv = await mk(1920, 1080);
  const url = BASE + "/?room=" + room + "&mgtest=1";
  await p1.goto(url); await p2.goto(url);
  await rail.goto(BASE + "/rail?room=" + room); await mainv.goto(BASE + "/?room=" + room + "&view=main");
  await waitFor(() => count(p1, ".seat-pick").then((n) => n > 0), { label: "seat picker" });
  await click(p1, '[data-action="pick-courier"][data-courier="cookbang"]');
  await waitFor(async () => (await text(p1)).includes("내 좌석 · 쿡방"), { label: "p1 seat" });
  await click(p2, '[data-action="pick-courier"][data-courier="cheonil"]');
  await waitFor(async () => (await text(p2)).includes("내 좌석 · 천일배송"), { label: "p2 seat" });
  await key(p1, "Space", " "); await key(p2, "Space", " ");

  // ---- 라운드 1: 둘 다 같은 첫 게임 화면 (2026-10-14: RACE_GAME_POOL 중 무작위) ----
  const gameKind = (p) => p.evaluate(() => { const r = document.querySelector("#mg-layer .mg-root"); if (!r) return null; const m = r.className.match(/mg-kind-(\w+)/); return m ? m[1] : null; });
  await waitFor(() => count(p1, "#mg-layer .mg-root").then((n) => n === 1), { label: "p1 first game opens" });
  await waitFor(() => count(p2, "#mg-layer .mg-root").then((n) => n === 1), { label: "p2 first game opens" });
  const g1 = await gameKind(p1);
  assert(g1 && g1 === (await gameKind(p2)), "두 사람이 같은 게임: " + g1);
  assert(["sticker", "inspect", "match", "weigh", "tape"].includes(g1), "게임 후보 안: " + g1);
  const g1name = await p1.evaluate((k) => MiniGames.KINDS[k].name, g1);
  assert((await p1.evaluate(() => document.getElementById("race-strip").textContent)).includes(g1name + " 중"), "상대 진행 띠에 게임 이름");
  await shot(p1, "race_1_sticker");
  log("확보 시작 -> 두 사람 모두 같은 첫 게임(" + g1name + ") 자동 시작, 상대 진행 띠 표시");
  assert((await count(rail, ".race-puzzle")) === 0, "첫 게임 중엔 레일에 문제 없음");
  await waitFor(async () => (await text(rail)).includes(g1name + " 중"), { label: "rail waiting screen" });
  assert((await count(p1, ".race-parcel")) === 0, "첫 게임 중 플레이어 화면엔 택배 없음");
  // 레일/메인: 택배 3개, 종류만
  await waitFor(() => count(mainv, ".race-parcel").then((n) => n === 3), { label: "main shows 3 parcels" });
  await shot(rail, "race_r_rail_playing"); await shot(mainv, "race_m_main_playing");

  // p1 송장 끝 -> 우봉고
  await p1.evaluate(() => window.__mgFinish());
  await waitFor(() => count(p1, ".race-blank [data-action=\"race-done\"]").then((n) => n === 1), { label: "p1 blank during ubongo" });
  assert((await count(p1, ".race-puzzle")) === 0 && (await count(p1, ".race-parcel")) === 0, "택배 쌓기 중 플레이어 화면엔 문제도 택배도 없음");
  await waitFor(() => count(rail, ".race-puzzle img").then((n) => n === 1), { label: "rail shows the single puzzle" });
  assert((await count(rail, ".race-parcel")) === 0 && (await count(rail, ".race-lane")) === 0, "레일 화면엔 택배 쌓기 문제만");
  await waitFor(() => count(mainv, ".race-puzzle img").then((n) => n === 1), { label: "main shows the puzzle" });
  await shot(rail, "race_r_rail_puzzle");
  assert((await count(p1, "#mg-layer .mg-root")) === 0, "송장 게임 닫힘");
  await waitFor(async () => (await p2.evaluate(() => document.getElementById("race-strip") && document.getElementById("race-strip").textContent)).includes("택배 쌓기"), { label: "p2 strip shows p1 on ubongo" });
  await shot(p1, "race_2_ubongo");
  await p2.evaluate(() => window.__mgFinish());
  await waitFor(() => count(p2, ".race-blank [data-action=\"race-done\"]").then((n) => n === 1), { label: "p2 blank during ubongo" });
  assert((await count(p2, ".race-puzzle")) === 0 && (await count(rail, ".race-puzzle img")) === 1, "문제는 레일 화면에 하나만");
  log("첫 게임 -> 택배 쌓기: 문제는 레일 화면(과 메인 모니터)에만 하나, 플레이어 화면엔 투입/포기만");

  // p1 Space로 투입 -> 고르기
  await key(p1, "Space", " ");
  // 2026-10-15: 고르기는 레일 화면에서 (1번 A S D / 2번 J K L), 택배 카드엔 층이 보인다
  await waitFor(() => count(rail, ".rail-pk-btn.seat-1.on").then((n) => n === 3), { label: "rail: seat 1 can pick 3" });
  assert((await count(rail, ".rail-pk-btn.seat-2.on")) === 0, "p2는 아직 못 고름");
  assert((await count(rail, ".rail-pk .rp-floorbig")) === 3, "레일 카드 3장 모두 층 표시");
  assert((await count(rail, ".race-puzzle img")) === 1, "늦은 사람이 아직 쌓는 중이면 레일에 문제도 같이");
  assert((await text(p1)).includes("레일 화면에서 층을 보고 고르세요"), "p1 화면엔 레일에서 고르라는 안내");
  assert((await count(p1, "button.race-parcel")) === 0, "플레이어 화면에선 못 고름");
  assert((await text(p2)).includes("투입하면 직접 고르고"), "p2에게 안내 (투입하면 직접, 늦으면 무작위)");
  assert((await count(p2, ".race-parcel")) === 0, "늦은 사람은 투입 전까지 택배가 안 보임");
  await shot(p1, "race_3_pick_first"); await shot(p2, "race_3_pick_second"); await shot(rail, "race_r_rail_picking");
  log("먼저 투입 -> 1등만 고르기(3개), 늦은 사람에게 마감 안내");

  // p2가 투입(대기) -> p1이 →로 고름 -> p1 화면에만 송장 -> p2가 남은 2개 중 클릭
  await click(p2, '[data-action="race-done"]');
  await waitFor(async () => (await text(p2)).includes("다음은 내 차례"), { label: "p2 done, waiting" });
  await key(rail, "KeyD", "d"); // 1번 자리 세 번째(→) 택배
  await waitFor(() => count(p1, ".race-slip").then((n) => n === 1), { label: "p1 invoice slip prints" });
  assert((await count(p2, ".race-slip")) === 0, "상대 화면엔 내 송장 없음");
  assert(!(await text(rail)).includes("송장 출력"), "레일 화면엔 송장 없음");
  await waitFor(() => count(rail, ".rail-pk-btn.seat-2.on").then((n) => n === 2), { label: "p2 picks from remaining 2 at rail" });
  await shot(p1, "race_4_slip"); await shot(rail, "race_r_rail_second_pick");
  await click(rail, ".rail-pk-btn.seat-2.on");
  await waitFor(async () => (await count(p1, ".race-msg.reveal")) === 1, { label: "reveal message" });
  await waitFor(() => count(p2, ".race-slip").then((n) => n === 1), { label: "p2 slip" });
  const chips1 = await count(p1, ".race-mine .my-chip"), chips2 = await count(p2, ".race-mine .my-chip");
  assert(chips1 === 1 && chips2 === 1, "둘 다 1개씩 확보: " + chips1 + "/" + chips2);
  assert((await text(p1)).includes("레일로 돌아감"), "남은 1개는 레일로");
  await shot(p1, "race_5_reveal"); await shot(mainv, "race_m_main_reveal");
  log("레일에서 1등이 D로 고르면 자기 화면에만 송장, 2등이 레일에서 남은 2개 중 고름, 남은 1개는 레일로");

  // ---- 라운드 2: 늦은 사람이 마감을 넘김 ----
  await waitFor(() => count(p1, "#mg-layer .mg-root").then((n) => n === 1), { label: "round 2 first game", timeout: 8000 });
  assert((await text(p1)).includes("레이스 2"), "라운드 2");
  await waitFor(() => count(rail, ".race-puzzle").then((n) => n === 0), { label: "새 라운드 시작하면 레일 문제 내려감" });
  const g2 = await gameKind(p1);
  assert(g2 !== g1, "바로 앞 라운드와 다른 게임: " + g1 + " -> " + g2);
  log("라운드 2 게임: " + g2 + " (라운드 1과 다름)");
  await p1.evaluate(() => window.__mgFinish()); await p2.evaluate(() => window.__mgFinish());
  await waitFor(() => count(p2, ".race-blank [data-action=\"race-done\"]").then((n) => n === 1), { label: "p2 ubongo r2" });
  await click(p2, '[data-action="race-done"]');
  await waitFor(() => count(rail, ".rail-pk-btn.seat-2.on").then((n) => n >= 1), { label: "p2 can pick r2 at rail" });
  await key(rail, "KeyJ", "j");
  // p1은 투입하지 않는다 -> p2가 고른 순간부터 RACE_CONSOLATION_MS(20초) 뒤 p1도 남은 것 중 무작위로 하나 (2026-10-14)
  const { RACE_CONSOLATION_MS } = require("./game-data.js");
  await waitFor(async () => (await text(p1)).includes("무작위로 받아요"), { label: "p1 told about random consolation" });
  await waitFor(async () => (await count(p1, ".race-msg.reveal")) === 1, { label: "r2 reveal after consolation", timeout: RACE_CONSOLATION_MS + 6000 });
  assert((await text(p1)).includes("(무작위)"), "늦은 사람은 무작위로 받음 표시");
  assert((await count(p1, ".race-mine .my-chip")) === 2 && (await count(p2, ".race-mine .my-chip")) === 2, "둘 다 2개씩");
  log("라운드 2: 한 사람만 끝내면, 고른 뒤 20초 뒤 다른 사람도 무작위로 하나 받음");

  // ---- 라운드 3: 송장 단계에서 포기 ----
  await waitFor(() => count(p1, "#mg-layer .mg-root").then((n) => n === 1), { label: "round 3 first game", timeout: 8000 });
  await click(p1, "#mg-layer .mg-giveup");
  await waitFor(async () => (await text(p1)).includes("포기했어요"), { label: "p1 gave up" });
  await waitFor(async () => (await p2.evaluate(() => (document.getElementById("race-strip") || {}).textContent || "")).includes("탈락"), { label: "p2 sees p1 out" });
  log("라운드 3: 송장 단계 포기 -> 그 라운드 탈락, 상대 화면에 표시");

  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  await browser.close();
  log("ALL CHECKS PASSED");
}
main().catch((e) => { console.error("[test-race-e2e] FAILED:", e); process.exit(1); });
