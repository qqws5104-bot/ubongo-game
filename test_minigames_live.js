// 2026-10-06: 라이브 게임 안에서 "택배 종류별 미니게임"이 실제로 도는지 검증 (진짜 브라우저 2개 + 진짜 WS 서버).
//
// test_minigames.js는 시험장 페이지에서 게임 자체를 검증하고, 이 파일은 그 게임이 실제 게임에 붙었을 때의
// 통합 문제를 본다:
//   - 카테고리별로 올바른 게임이 뜨는가 (일반=박스 포장 / 깨지기=이상 확인 / 확정 층수=송장 붙이기 / 귀중품=지도 배달)
//   - 진짜로 풀면 칸이 확보되고(secure-cell), 포기하면 확보되지 않는가
//   - ★ 플레이 도중에 상대가 칸을 확보해 서버 상태 브로드캐스트가 와도 내 게임이 안 날아가는가
//     (render()가 #app을 통째로 갈아엎기 때문에, 미니게임을 #app 안에 두면 이게 깨진다)
//   - 확보 시간이 끝나면 열려 있던 게임이 닫히는가
//
// 사전 준비: game-data.js의 SECURE_PHASE_MS를 임시로 40초로 줄이고(`40 * 1000`) build_client.py 재빌드 +
// 서버 재시작. 끝나면 반드시 원복 (HANDOVER 5.3).
"use strict";
const { chromium } = require("playwright");
const { COURIERS, FLOORS, TYPES } = require("./game-data.js");
const COURIER_NAME = {};
COURIERS.forEach((c) => { COURIER_NAME[c.key] = c.name; });

const BASE = "http://localhost:3000";
function log(...a) { console.log("[test-minigames-live]", ...a); }
function assert(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", space: "Space" };

async function clickSel(page, sel) {
  return page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }, sel);
}
const countSel = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const bodyText = (page) => page.evaluate(() => document.body.innerText);
async function pressSpace(page) {
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true })));
}
async function waitFor(fn, { timeout = 8000, interval = 80, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("timeout waiting for: " + label);
    await sleep(interval);
  }
}

// 확보된 칸은 클라이언트가 data-cell/data-action을 떼어낸다(renderBoard) -- 그래서 "확보됨"은 열기 버튼이 사라진 것으로 판단.
// 2026-10-06 레일 화면: 일반/깨지기/귀중품은 종류 버튼(open-type)으로, 확정 층수만 층 버튼(open-cell)으로 연다.
const CAT_IDX = { normal: 0, fragile: 1, valuable: 2, "fixed-floor": 3 };
const openSel = (id) => { const kind = id.replace(/-\d+$/, ""); return kind === "fixed-floor" ? `[data-action="open-cell"][data-cell="${id}"]` : `.rail-btn[data-action="open-type"][data-cat="${CAT_IDX[kind]}"]:not(:disabled)`; };
const myCount = (page, cat) => countSel(page, `.board-row[data-cat="${cat}"] .my-chip`);   // 내가 확보한 일반/깨지기/귀중품 개수
const isFloorMine = (page, floorIdx) => page.evaluate((i) => { const f = Array.from(document.querySelectorAll('.board-row[data-cat="3"] .floor-btn'))[i]; return !!f && f.classList.contains("mine"); }, floorIdx);
const isFloorOpenable = (page, id) => countSel(page, `[data-action="open-cell"][data-cell="${id}"]`).then((n) => n === 1);

// 박스 포장 봇(2026-10-07 조각 퍼즐): data-plan(정답 배치) / data-pk(현재 조각, x, y, 회전, 놓은 수) 훅으로 조각을 하나씩 돌려 옮겨 엔터.
const pkState = async (page) => (await page.getAttribute("#mg-layer .mg-body", "data-pk")).split(",").map(Number);
const pkPlan = async (page) => JSON.parse(await page.getAttribute("#mg-layer .mg-body", "data-plan"));
async function pkPlace(page, i, plan) {
  let [cur] = await pkState(page), g = 0;
  while (cur !== i) { await page.keyboard.press("Tab"); [cur] = await pkState(page); assert(++g < 12, "Tab cycles to the wanted piece"); }
  for (let r = 0; (await pkState(page))[3] % 4 !== 0 && r < 4; r++) await page.keyboard.press("Space");
  let [, px, py] = await pkState(page); g = 0;
  const { x: tx, y: ty } = plan.pieces[i];
  while (px !== tx || py !== ty) {
    await page.keyboard.press(px < tx ? "ArrowRight" : px > tx ? "ArrowLeft" : py < ty ? "ArrowDown" : "ArrowUp");
    [, px, py] = await pkState(page); assert(++g < 60, "piece reaches its target cell");
  }
  await page.keyboard.press("Enter");
}
async function pkSolve(page, from) { // from번째 조각부터 끝까지
  const plan = await pkPlan(page);
  for (let i = from || 0; i < plan.pieces.length; i++) await pkPlace(page, i, plan);
}

// 열려 있는 미니게임을 진짜로 푼다 (사람이 하는 것과 같은 입력: 키보드 / 마우스 드래그).
async function playOpenGame(page) {
  const kind = await page.evaluate(() => {
    const r = document.querySelector("#mg-layer .mg-root");
    const m = r && r.className.match(/mg-kind-(\w+)/);
    return m ? m[1] : null;
  });
  if (kind === "pack") {
    await pkSolve(page);
  } else if (kind === "inspect") {
    const seq = (await page.getAttribute("#mg-layer .mg-body", "data-seq")).split(",");
    for (const k of seq) await page.keyboard.press(KEY[k]);
  } else if (kind === "map") {
    await playMap(page);
  } else if (kind === "sticker") {
    // 송장 붙이기는 키보드 전용: 송장 코드와 같은 박스까지 ←로 커서를 옮기고 스페이스.
    for (let guard = 0; guard < 80; guard++) {
      if (!(await page.$("#mg-layer .mg-root")) || (await page.$(".mg-done.is-on"))) break;
      const pick = await page.evaluate(() => {
        const l = document.querySelector(".mg-label[data-label]:not([data-stuck])");
        if (!l) return null;
        const boxes = Array.from(document.querySelectorAll(".mg-bx"));
        return { want: parseInt(l.getAttribute("data-want"), 10), here: boxes.findIndex((b) => b.classList.contains("is-cursor")) };
      });
      if (!pick) { await sleep(150); continue; }
      if (pick.here !== pick.want) { await page.keyboard.press("ArrowRight"); continue; }
      await page.keyboard.press("Space");
      await sleep(450); // 다음 송장이 나오거나 게임이 끝나길 기다림
    }
  }
  return kind;
}


// 지도 배달 봇: data-* 테스트 훅으로 목표 좌표를 읽고, 깜빡임이 끝나길 기다린 뒤 BFS 경로를 방향키로 걸어 순서대로 스페이스.
const MAPDIR = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
function mapBfs(info, from, to) {
  const [W, H] = info.grid, bl = new Set(info.blocked.map((b) => b.join(",")));
  const prev = new Map([[from.join(","), null]]); const q = [from];
  while (q.length) {
    const p = q.shift();
    if (p[0] === to[0] && p[1] === to[1]) break;
    for (const d of Object.keys(MAPDIR)) {
      const n = [p[0] + MAPDIR[d][0], p[1] + MAPDIR[d][1]], k = n.join(",");
      if (n[0] < 0 || n[1] < 0 || n[0] >= W || n[1] >= H || bl.has(k) || prev.has(k)) continue;
      prev.set(k, { from: p, d }); q.push(n);
    }
  }
  const dirs = []; let cur = to.join(",");
  while (prev.get(cur)) { const st = prev.get(cur); dirs.unshift(st.d); cur = st.from.join(","); }
  return dirs;
}
async function playMap(page) {
  const info = await page.evaluate(() => {
    const b = document.querySelector("#mg-layer .mg-body");
    const P = (s) => (s ? s.split(";").filter(Boolean).map((t) => t.split(",").map(Number)) : []);
    return { grid: b.dataset.grid.split(",").map(Number), depot: b.dataset.depot.split(",").map(Number), blocked: P(b.dataset.blocked), targets: P(b.dataset.targets) };
  });
  await waitFor(async () => (await countSel(page, "#mg-layer .mg-map.is-covered")) === 0, { timeout: 7000, label: "map shows after the invoices" });
  let at = info.depot;
  for (const t of info.targets) {
    for (const d of mapBfs(info, at, t)) { await page.keyboard.press(KEY[d]); await sleep(85); }
    await page.keyboard.press("Space"); await sleep(60);
    at = t;
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const seedCtx = await browser.newContext();
  const seedPage = await seedCtx.newPage();
  await seedPage.goto(BASE + "/");
  const room = new URL(seedPage.url()).searchParams.get("room");
  await seedCtx.close();
  const roomUrl = BASE + "/?room=" + room + "&mgtest=1";
  log("room:", room);

  const ctx1 = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const ctx2 = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const p1 = await ctx1.newPage(), p2 = await ctx2.newPage();
  const errors = [];
  for (const [label, p] of [["p1", p1], ["p2", p2]]) {
    p.on("pageerror", (e) => errors.push(label + " pageerror: " + e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|ERR_|Failed to load resource|favicon/.test(m.text())) errors.push(label + " console: " + m.text()); });
  }
  await p1.goto(roomUrl); await p2.goto(roomUrl);
  await waitFor(() => countSel(p1, ".seat-pick").then((n) => n > 0), { label: "seat picker" });
  await clickSel(p1, '[data-action="pick-courier"][data-courier="cookbang"]');
  await waitFor(async () => (await bodyText(p1)).includes(COURIER_NAME.cookbang), { label: "p1 courier" });
  await clickSel(p2, '[data-action="pick-courier"][data-courier="cheonil"]');
  await waitFor(async () => (await bodyText(p2)).includes(COURIER_NAME.cheonil), { label: "p2 courier" });
  await pressSpace(p1); await pressSpace(p2);
  await waitFor(async () => (await bodyText(p1)).includes("택배 확보"), { label: "secure phase" });
  log("확보 단계 진입");

  // ---- a. 보드의 카테고리별 게임 이름 표시 ----
  // (보드가 그려지는 순간과 "택배 확보" 문구가 뜨는 순간이 같은 틱이 아닐 수 있어 기다린다 -- 한 번 이 경쟁 상태로 실패함)
  await waitFor(async () => (await bodyText(p1)).includes("지도 배달"), { label: "board game names rendered" });
  const board = await bodyText(p1);
  for (const name of ["박스 포장", "이상 확인", "송장 붙이기", "지도 배달"]) assert(board.includes(name), `board should name the game '${name}'`);
  log("보드에 카테고리별 게임 이름 표시: 박스 포장 / 이상 확인 / 송장 붙이기 / 지도 배달");

  // ---- b. 일반택배 -> 박스 포장, 남은 확보 시간 표시 ----
  await clickSel(p1, openSel("normal-1"));
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-kind-pack")) === 1, { label: "일반택배 = 박스 포장" });
  const clock = await p1.textContent("#mg-clock");
  assert(/^\d:\d\d$/.test(clock), "secure-phase clock shown inside the game layer, got: " + clock);
  log(`일반택배 칸 -> 박스 포장 열림, 확보 남은 시간 ${clock} 표시`);

  // ---- c. ★ 플레이 도중 상대의 확보로 상태 브로드캐스트가 와도 내 게임이 유지되는가 ----
  const pkPlan1 = await pkPlan(p1);
  await pkPlace(p1, 0, pkPlan1); await pkPlace(p1, 1, pkPlan1);
  assert((await pkState(p1))[4] === 2, "2 pieces placed before the broadcast");
  await clickSel(p2, openSel("normal-2"));
  await waitFor(async () => (await countSel(p2, "#mg-layer .mg-root")) === 1, { label: "p2 game open" });
  await p2.evaluate(() => window.__mgFinish());                      // p2가 칸 하나 확보 -> 서버가 p1에게도 state 브로드캐스트
  await waitFor(async () => (await myCount(p2, 0)) === 1, { label: "p2 secured one normal box" });
  await sleep(300);                                                   // p1 쪽 render() 이후까지 여유
  assert((await countSel(p1, "#mg-layer .mg-kind-pack")) === 1, "p1's game must still be open after a state broadcast");
  assert((await pkState(p1))[4] === 2, "p1's progress (2 placed pieces) must survive the broadcast");
  log("★ 플레이 도중 상대가 칸을 확보해 상태 브로드캐스트가 와도 내 게임/진행도 유지됨");

  // ---- d. 박스 포장을 진짜로 끝내면 확보 ----
  await pkSolve(p1, 2);
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-root")) === 0, { label: "pack closes after completion" });
  await waitFor(async () => (await myCount(p1, 0)) === 1, { label: "normal box secured on p1" });
  assert((await countSel(p1, openSel("normal-3"))) === 1, "the normal-box button stays available (2 left)");
  log("박스 포장 완주 -> 레이어 닫힘 + normal-1 확보");

  // ---- e. 깨지기 -> 이상 확인 (진짜로 분류/폐기) ----
  await clickSel(p1, openSel("fragile-1"));
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-kind-inspect")) === 1, { label: "깨지기 = 이상 확인" });
  assert((await p1.$$("#mg-layer .mg-pkg")).length === 9, "fragile starts at level 2 (9 packages)");
  await playOpenGame(p1);
  await waitFor(async () => (await myCount(p1, 1)) === 1, { label: "fragile box secured" });
  log("깨지기 택배 칸 -> 이상 확인(9개) 완주 -> fragile-1 확보");

  // ---- f. 확정 층수 -> 송장 붙이기 (송장에 그 칸의 층이 찍힘) ----
  await clickSel(p1, openSel("fixed-floor-2"));
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-kind-sticker")) === 1, { label: "확정 층수 = 송장 붙이기" });
  const labelText = await p1.textContent("#mg-layer .mg-label .lb-room");
  assert(/^[A-E]-\d\d$/.test(labelText.trim()), `sticker label shows a letter-number code like B-17, got ${labelText}`);
  await playOpenGame(p1);
  await waitFor(() => isFloorMine(p1, 1), { label: "fixed-floor-2 (1F) secured" });
  // 확보된 칸의 얼굴에는 송장 목적지(호수)가 찍힌다 -- 보드에서 1F 행 칸(fixed-floor 행의 2번째)의 .invoice-label을 읽는다.
  const faceText = await p1.evaluate(() => {
    const f = Array.from(document.querySelectorAll('.board-row[data-cat="3"] .floor-btn'))[1];
    const lab = f && f.querySelector("small");
    return lab ? lab.textContent : null;
  });
  assert(/^10\d호$/.test(faceText), `invoice on fixed-floor-2 must be a 1F room (10N호), got ${faceText}`);
  log(`확정 층수 칸 -> 송장 붙이기(송장 '${labelText}') 완주 -> 확보, 송장 목적지 ${faceText} (1F)`);

  // ---- g. 귀중품 -> 지도 배달 (전반 = 난이도 보통: 6x4 지도, 목표 3, 호실 번호 유지) ----
  await clickSel(p1, openSel("valuable-1"));
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-kind-map")) === 1, { label: "귀중품 = 지도 배달" });
  assert((await countSel(p1, ".puzzle-frame")) === 0, "valuable no longer shows the Ubongo puzzle image");
  const mapBody = await p1.evaluate(() => { const b = document.querySelector("#mg-layer .mg-body"); return { grid: b.dataset.grid, targets: b.dataset.targets.split(";").length }; });
  assert(mapBody.grid === "6,4" && mapBody.targets === 3, "전반 지도 배달은 6x4 지도 / 목표 3개, got " + JSON.stringify(mapBody));
  await playOpenGame(p1);
  await waitFor(async () => (await myCount(p1, 2)) === 1, { label: "valuable secured by really playing the map game" });
  log("귀중품 칸 -> 지도 배달(6x4, 송장 3장) 진짜로 플레이해서 완주 -> valuable 확보");

  // ---- f2. 송장 붙이기를 키보드만으로 (2026-10-07): ←→로 박스 고르고 스페이스 ----
  await clickSel(p1, openSel("fixed-floor-5"));
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-kind-sticker")) === 1, { label: "sticker for fixed-floor-5" });
  for (let guard = 0; await countSel(p1, "#mg-layer .mg-root") === 1 && guard < 40; guard++) {
    const pick = await p1.evaluate(() => {
      const l = document.querySelector(".mg-label[data-label]:not([data-stuck])");
      if (!l) return null;
      const boxes = Array.from(document.querySelectorAll(".mg-bx"));
      return { want: parseInt(l.getAttribute("data-want"), 10), here: boxes.findIndex((b) => b.classList.contains("is-cursor")) };
    });
    if (!pick) { await sleep(150); continue; }
    if (pick.here !== pick.want) { await p1.keyboard.press("ArrowRight"); continue; }
    await p1.keyboard.press("Space"); await sleep(450);
  }
  await waitFor(() => isFloorMine(p1, 4), { label: "fixed-floor-5 secured with the keyboard only" });
  log("확정 층수 칸 -> 송장 붙이기를 키보드(←→ + 스페이스)만으로 완주 -> 확보");

  // ---- h. 포기: 확보되지 않음 ----
  await clickSel(p1, openSel("fixed-floor-3"));
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-kind-sticker")) === 1, { label: "sticker open for give-up" });
  await clickSel(p1, "#mg-layer .mg-giveup");
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-root")) === 0, { label: "give-up closes" });
  assert(await isFloorOpenable(p1, "fixed-floor-3"), "giving up must not secure the cell");
  log("포기 -> 레이어 닫힘, 칸 미확보");

  // ---- h2. 공유 보드: 내가 게임을 하는 동안 상대가 먼저 끝내면 (2026-10-06) ----
  // p2가 테스트 훅(__mgFinish)으로 칸을 "푼 것으로" 확보한다. 열어 둔 칸은 잠기지 않으므로 상대가 그 칸을 가져갈 수도 있다.
  async function p2Finish(cellId) {
    await clickSel(p2, openSel(cellId));
    await waitFor(async () => (await countSel(p2, "#mg-layer .mg-root")) === 1, { label: `p2 opened ${cellId}` });
    assert(await p2.evaluate(() => window.__mgFinish()), "p2 __mgFinish");
    await waitFor(async () => (await countSel(p2, "#mg-layer .mg-root")) === 0, { label: `p2 finished ${cellId}` });
  }
  const toastText = (pg) => pg.evaluate(() => { const t = document.getElementById("toast"); return t ? t.textContent : ""; });
  // (1) 확정 층수: 내가 하던 그 층을 상대가 먼저 확보 -> 내 게임이 닫히고 안내가 뜬다 (선점자 우선)
  await clickSel(p1, openSel("fixed-floor-4"));
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-kind-sticker")) === 1, { label: "p1 sticker for fixed-floor-4" });
  await p2Finish("fixed-floor-4");
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-root")) === 0, { label: "p1 game closes when the opponent takes the floor first" });
  assert((await toastText(p1)).includes("먼저 확보"), "p1 should be told the floor was taken first, got: " + (await toastText(p1)));
  assert((await countSel(p1, '.board-row[data-cat="3"] .floor-btn.is-gone:not(.mine)')) >= 1, "a floor taken by the opponent is shown as closed (마감)");
  assert((await countSel(p1, openSel("fixed-floor-4"))) === 0, "the floor taken by the opponent is no longer openable");
  log("확정 층수: 상대가 먼저 확보하면 내 게임이 닫히고 안내(선점자 우선), 그 층 버튼은 마감으로 표시");
  // (2) 일반 종류: 같은 종류 빈 칸이 남아 있으면 내 게임은 그대로, 마지막 개수까지 소진되면 닫힌다
  await clickSel(p1, openSel("fragile-2"));
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-kind-inspect")) === 1, { label: "p1 inspect for fragile-2" });
  await p2Finish("fragile-2"); // p1이 열어 둔 칸 자체를 상대가 가져가도, 같은 종류 빈 칸이 있으니 내 게임은 유지
  await sleep(400);
  assert((await countSel(p1, "#mg-layer .mg-kind-inspect")) === 1, "my game must stay open while the category still has free cells");
  await p2Finish("fragile-3"); // 이제 1개 남음 (fragile 4칸 - p1이 1, p2가 2 = 3 -> 남은 1)
  assert((await countSel(p1, "#mg-layer .mg-kind-inspect")) === 1, "still one cell left -> game stays open");
  await p2Finish("fragile-4"); // 마지막 1개까지 소진
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-root")) === 0, { label: "p1 game closes when the category is exhausted" });
  assert((await toastText(p1)).includes("소진"), "p1 should be told the category ran out, got: " + (await toastText(p1)));
  const fragLeft = await p1.textContent('.board-row[data-cat="1"] .cat-left');
  assert(/남은\s*0\s*\/\s*4/.test(fragLeft), "깨지기 shows 남은 0 / 4, got " + fragLeft);
  log("일반 종류: 같은 종류 빈 칸이 있는 동안은 게임 유지, 마지막 개수가 소진되면 닫히고 안내 + 남은 0 / 4 표시");

  // ---- i. 확보 시간이 끝나면 열려 있던 게임이 닫힌다 ----
  await clickSel(p1, openSel("normal-3"));
  await waitFor(async () => (await countSel(p1, "#mg-layer .mg-root")) === 1, { label: "game open at the end" });
  await waitFor(async () => (await bodyText(p1)).includes("엘리베이터"), { timeout: 40000, label: "secure phase ends -> elevator" });
  assert((await countSel(p1, "#mg-layer .mg-root")) === 0, "an open game must be closed when the secure phase ends");
  assert(await p1.evaluate(() => document.getElementById("mg-layer").classList.contains("hidden")), "layer hidden after the phase ended");
  log("확보 시간 종료 -> 열려 있던 게임이 자동으로 닫히고 엘리베이터 단계로 넘어감");

  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  await browser.close();
  log("ALL CHECKS PASSED");
}

main().catch((e) => { console.error("[test-minigames-live] FAILED:", e); process.exit(1); });
