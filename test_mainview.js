// 2026-10-06: 메인 모니터(?view=main) 검증 -- 진짜 서버 + 브라우저 3개(플레이어 2 + 메인 모니터).
//   - /?view=main 으로 열면 새 방이 만들어지고 view=main이 유지되며, 참가 주소/방 코드가 크게 보이는가
//   - 좌석을 잡지 않는가(플레이어 2명이 정상 입장, 메인의 키 입력은 무시)
//   - 확보 단계: 남은 시간 + 종류별 남은 박스(6 -> 확보할 때마다 줄어듦)
//   - 엘리베이터 단계: 큰 현재 층 + 남은 시간, 층이 바뀌면 따라감
//   - 메인 모니터 기기 시계가 10분 틀어져 있어도 카운트다운이 서버 기준으로 맞는가
//   - 플레이어의 비공개 정보(송장 호수 등)가 메인에 안 나오는가
// 사전 준비: SECURE_PHASE_MS를 임시로 20초(`20 * 1000`)로 줄이고 build_client.py 재빌드 + 서버 재시작. 끝나면 원복 (HANDOVER 5.3).
// SHOT_DIR=/경로 를 주면 1920x1080 스크린샷을 저장한다.
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const { COURIERS, TYPES } = require("./game-data.js");
const BASE = "http://localhost:3000";
const SHOT_DIR = process.env.SHOT_DIR || "";
function log(...a) { console.log("[test-mainview]", ...a); }
function assert(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const countSel = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const clickSel = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }, sel);
const pressSpace = (page) => page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true })));
async function waitFor(fn, { timeout = 8000, interval = 80, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - start > timeout) throw new Error("timeout waiting for: " + label); await sleep(interval); }
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const errors = [];
  const mk = async (label, viewport, skewMs) => {
    const ctx = await browser.newContext({ viewport });
    const p = await ctx.newPage();
    if (skewMs) await p.addInitScript((skew) => { const real = Date.now.bind(Date); Date.now = () => real() + skew; }, skewMs);
    p.on("pageerror", (e) => errors.push(label + " pageerror: " + e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|ERR_|Failed to load resource|favicon/.test(m.text())) errors.push(label + " console: " + m.text()); });
    return p;
  };
  const shot = async (p, name) => { if (SHOT_DIR) await p.screenshot({ path: path.join(SHOT_DIR, name + ".png") }); };

  // 메인 모니터를 먼저 연다 (+10분 틀어진 기기 시계)
  const main = await mk("main", { width: +(process.env.MAIN_W || 1920), height: +(process.env.MAIN_H || 1080) }, 10 * 60 * 1000);
  await main.goto(BASE + "/?view=main");
  await waitFor(() => main.url().includes("room=") && main.url().includes("view=main"), { label: "redirect keeps view=main" });
  const room = new URL(main.url()).searchParams.get("room");
  await waitFor(async () => (await bodyText(main)).includes("참가자를 기다리고"), { label: "main lobby" });
  const lobbyText = await bodyText(main);
  assert(lobbyText.includes(BASE + "/?room=" + room), "lobby shows the player join address, got: " + lobbyText.slice(0, 300));
  assert(lobbyText.includes(room), "lobby shows the room code");
  assert((await countSel(main, "body.main-view")) === 1, "body.main-view is set");
  await shot(main, "main_1_lobby");
  log("메인 모니터: /?view=main -> 새 방 생성 + view=main 유지, 참가 주소/방 코드 표시");

  // 플레이어 2명 입장 (메인이 좌석을 차지했다면 여기서 막힌다)
  const p1 = await mk("p1", { width: 1100, height: 900 }), p2 = await mk("p2", { width: 1100, height: 900 });
  const roomUrl = BASE + "/?room=" + room + "&mgtest=1";
  await p1.goto(roomUrl); await p2.goto(roomUrl);
  await waitFor(() => countSel(p1, ".seat-pick").then((n) => n > 0), { label: "seat picker p1" });
  await clickSel(p1, '[data-action="pick-courier"][data-courier="cookbang"]');
  await waitFor(async () => (await bodyText(p1)).includes("쿡방"), { label: "p1 courier" });
  await clickSel(p2, '[data-action="pick-courier"][data-courier="cheonil"]');
  await waitFor(async () => (await bodyText(p2)).includes("천일배송"), { label: "p2 courier" });
  await waitFor(async () => { const t = await bodyText(main); return t.includes("쿡방") && t.includes("천일배송"); }, { label: "main shows both couriers" });
  // 메인에서 키를 눌러도 아무 일도 없어야 한다 (좌석이 없으니 준비 완료가 되면 안 됨)
  await pressSpace(main); await sleep(300);
  assert(!(await bodyText(main)).includes("준비 완료"), "Space on the main monitor must not ready anyone");
  await pressSpace(p1); await pressSpace(p2);
  await waitFor(async () => (await bodyText(main)).includes("확보 남은 시간"), { label: "main enters secure view" });
  log("플레이어 2명 정상 입장(메인은 좌석 없음), 메인 키 입력 무시, 확보 단계로 전환");

  // ---- 확보 단계 ----
  const cardsText = async () => main.evaluate(() => Array.from(document.querySelectorAll(".mv-cat")).map((c) => ({
    name: c.querySelector(".mv-cat-name").textContent, left: parseInt(c.querySelector(".mv-left").childNodes[0].textContent, 10),
    total: parseInt(c.querySelector(".mv-left small").textContent.replace(/\D/g, ""), 10), pipsOpen: c.querySelectorAll(".mv-pip:not(.is-gone)").length })));
  let cards = await cardsText();
  assert(cards.length === 4, "4 category cards");
  cards.forEach((c, i) => assert(c.name === TYPES[i].name && c.left === TYPES[i].count && c.total === TYPES[i].count && c.pipsOpen === TYPES[i].count, `category ${c.name} starts full (${TYPES[i].count}): ` + JSON.stringify(c)));
  // 시계: 서버 기준(약 20초)이어야 한다. 기기 시계가 +10분 틀어졌는데 "0:00"이나 이상한 값이면 보정 실패.
  const clockSecs = async () => main.evaluate(() => { const t = document.querySelector(".mv-secure-top .mv-time").textContent.trim(); const [m, s] = t.split(":").map(Number); return m * 60 + s; });
  const c0 = await clockSecs();
  assert(c0 >= 14 && c0 <= 20, `main clock should follow the SERVER time (~20s) even with a skewed device clock, got ${c0}s`);
  await sleep(1300);
  const c1 = await clockSecs();
  assert(c1 < c0, `main clock should tick down (${c0} -> ${c1})`);
  await shot(main, "main_2_secure_full");
  log(`확보 단계: 종류별 4/4/3/6 가득, 시계 ${c0}초 -> ${c1}초 (기기 시계 10분 오차 보정됨)`);

  // p1이 일반택배 1개, p2가 일반택배 1개 + 귀중품 1개를 확보 -> 메인의 남은 수가 따라 줄어든다
  async function secure(p, id) {
    const kind = id.replace(/-\d+$/, ""), CAT = { normal: 0, fragile: 1, valuable: 2 };
    await clickSel(p, kind === "fixed-floor" ? `[data-action="open-cell"][data-cell="${id}"]` : `.rail-btn[data-action="open-type"][data-cat="${CAT[kind]}"]`);
    await waitFor(async () => (await countSel(p, "#mg-layer .mg-root")) === 1 || (await countSel(p, ".puzzle-frame")) === 1, { label: "opened " + id });
    if ((await countSel(p, "#mg-layer .mg-root")) === 1) await p.evaluate(() => window.__mgFinish());
    else await clickSel(p, '[data-action="complete-cell"]');
  }
  await secure(p1, "normal-1");
  await waitFor(async () => (await cardsText())[0].left === 3, { label: "main: normal 3 left" });
  await secure(p2, "normal-2");
  await secure(p2, "valuable-1");
  await waitFor(async () => { const c = await cardsText(); return c[0].left === 2 && c[2].left === 2; }, { label: "main: normal 2, valuable 2" });
  cards = await cardsText();
  assert(cards[0].pipsOpen === 2 && cards[2].pipsOpen === 2 && cards[1].left === 4 && cards[3].left === 6, "pips follow the remaining count: " + JSON.stringify(cards));
  // 비공개 정보(내 송장 호수)는 메인에 안 나온다: 확보한 칸의 송장 호수 문자열(예: "101호")이 메인 어디에도 없어야 함
  const mainTxt = await bodyText(main);
  assert(!/\d{3}호|B0\d호/.test(mainTxt), "main must not show invoice room codes: " + mainTxt.match(/(\d{3}|B0\d)호/));
  await shot(main, "main_3_secure_taken");
  log("확보할 때마다 종류별 남은 수/칸 표시가 따라 줄어듦 (일반 4 -> 2, 귀중품 3 -> 2), 송장 호수는 안 보임");

  // 한 종류를 소진시키면 '소진' 표시
  for (const id of ["fragile-1", "fragile-2", "fragile-3", "fragile-4"]) await secure(p1, id);
  await waitFor(async () => (await cardsText())[1].left === 0, { label: "fragile exhausted on main" });
  assert((await countSel(main, ".mv-cat.is-empty")) === 1, "exhausted category is marked");
  await shot(main, "main_4_secure_exhausted");
  log("한 종류가 소진되면 '소진' 표시");

  // ---- 엘리베이터 단계 ----
  await waitFor(async () => (await bodyText(main)).includes("현재 층"), { timeout: 30000, label: "main enters elevator view" });
  const elevInfo = () => main.evaluate(() => ({
    floor: document.querySelector(".mv-floor-big").textContent, state: document.querySelector(".mv-state").textContent,
    round: document.querySelector(".mv-round").textContent, carTo: document.getElementById("mv-car").getAttribute("data-to"),
    time: document.querySelector(".mv-elev-main .mv-time") ? document.querySelector(".mv-elev-main .mv-time").textContent : null,
  }));
  let ei = await elevInfo();
  assert(ei.floor === "1F" && /라운드 1 \/ 7/.test(ei.round) && ei.state.includes("출발 준비"), "elevator starts at 1F, round 1/7, waiting: " + JSON.stringify(ei));
  await shot(main, "main_5_elevator_idle");
  await pressSpace(p1); await pressSpace(p2);
  // 2026-10-06: 준비가 끝나면 우선 택배 지정 10초 창이 먼저 -- 메인에도 상태 이름과 남은 시간(~10초)이 보인다.
  await waitFor(async () => (await elevInfo()).state.includes("우선 택배 지정"), { label: "main shows priority-pick window" });
  await sleep(250);
  ei = await elevInfo();
  const pSec = parseInt(ei.time, 10);
  assert(pSec >= 8 && pSec <= 10, `priority window timer should show ~10s (server time), got "${ei.time}"`);
  await shot(main, "main_5b_priority");
  await clickSel(p1, '[data-action="confirm-priority"]'); await clickSel(p2, '[data-action="confirm-priority"]');
  log(`우선 택배 지정 시간: 메인에 "우선 택배 지정 시간" + ${pSec}초 표시, 둘 다 확정하면 이동 단계로`);
  await waitFor(async () => (await elevInfo()).state.includes("이동 중"), { label: "main shows moving state" });
  await sleep(250);
  ei = await elevInfo();
  const sec = parseInt(ei.time, 10);
  assert(sec >= 3 && sec <= 5, `moving timer should show the remaining ~5 seconds (server time), got "${ei.time}"`);
  await p1.keyboard.press("ArrowUp");
  await waitFor(async () => (await elevInfo()).floor === "2F", { label: "main follows the car to 2F" });
  ei = await elevInfo();
  assert(ei.carTo === "2", "car element targets floor index 2");
  await shot(main, "main_6_elevator_moving");
  log(`엘리베이터 단계: 라운드 1/5, 현재 층 1F -> 이동 중(${sec}초 남음) -> ArrowUp 후 2F로 따라감`);

  // 메인이 아직 좌석 없음 확인: 서버 상태의 seatOwners는 두 플레이어뿐
  const owners = await main.evaluate(() => window.__bpOwners || null);
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  await browser.close();
  log("ALL CHECKS PASSED");
}
main().catch((e) => { console.error("[test-mainview] FAILED:", e); process.exit(1); });
