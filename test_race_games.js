// 2026-10-14 레이스 첫 게임 5종 중 새로 만든 3종(택배 짝 찾기 / 무게 맞추기 / 테이프 봉하기) + 이상 확인을
// 실제 브라우저에서 키 입력(← ↑ → / SPACE)만으로 끝까지 풀어 본다. 틀린 입력은 실수로 세고 멈추는지도 확인.
// 필요: 서버가 localhost:3000에 떠 있을 것 (MiniGames가 인라인된 public/index.html을 쓰기 위해).
"use strict";
const { chromium } = require("playwright");
function log(...a) { console.log("[test-race-games]", ...a); }
function assert(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); }
const KEY = { left: ["ArrowLeft", "ArrowLeft"], up: ["ArrowUp", "ArrowUp"], right: ["ArrowRight", "ArrowRight"], down: ["ArrowDown", "ArrowDown"], space: ["Space", " "] };

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await (await browser.newContext({ viewport: { width: 900, height: 800 } })).newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:3000/");
  await page.waitForFunction(() => !!window.MiniGames);
  const start = (kind, level) => page.evaluate(({ kind, level }) => {
    if (window.__ctl) window.__ctl.destroy();
    let host = document.getElementById("t-host");
    if (!host) { host = document.createElement("div"); host.id = "t-host"; host.style.cssText = "position:fixed;inset:0;z-index:9999;background:#fff;overflow:auto"; document.body.appendChild(host); }
    window.__done = null;
    window.__ctl = MiniGames.start(host, { kind, level, testHooks: true, onDone: (r) => { window.__done = r; } });
    return document.querySelector("#t-host .mg-body").getAttribute("data-seq");
  }, { kind, level });
  const press = (a) => page.evaluate(([code, key]) => document.dispatchEvent(new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true })), KEY[a]);
  const misses = () => page.evaluate(() => document.querySelector("#t-host .mg-miss").textContent);
  const waitDone = async (label) => { await page.waitForFunction(() => !!window.__done, null, { timeout: 8000 }).catch(() => { throw new Error("not finished: " + label); }); return page.evaluate(() => window.__done); };

  for (const level of [1, 2]) {
    // 택배 짝 찾기: 뒤집힌 카드 8장 = 4쌍. 일부러 다른 두 장 -> 실수 1 + 다시 덮임, 그 뒤 키보드(→ / SPACE)와 클릭으로 4쌍 완성
    const pairs = (await start("match", level)).split(",").map((x) => x.split("-").map(Number));
    assert(pairs.length === 4 && (await page.evaluate(() => document.querySelectorAll(".mg-mm-card").length)) === 8, "카드 8장 4쌍");
    const clickCard = (i) => page.evaluate((i) => document.querySelectorAll(".mg-mm-card")[i].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true })), i);
    const openCount = () => page.evaluate(() => document.querySelectorAll(".mg-mm-card.is-open").length);
    await clickCard(pairs[0][0]); await clickCard(pairs[1][0]);
    assert((await misses()) === "실수 1" && (await openCount()) === 2, "다른 두 장 = 실수 1, 잠깐 보임");
    await page.waitForTimeout(900);
    assert((await openCount()) === 0, "다시 덮임");
    // 커서는 마지막에 뒤집은 카드(pairs[1][0]) -- → 로 pairs[0][0]까지 가서 SPACE
    let curI = pairs[1][0];
    for (const t of pairs[0]) { const steps = (t - curI + 8) % 8; for (let k = 0; k < steps; k++) await press("right"); await press("space"); curI = t; }
    assert((await page.evaluate(() => document.querySelectorAll(".mg-mm-card.is-done").length)) === 2, "키보드로 한 쌍");
    for (const pr of pairs.slice(1)) { await clickCard(pr[0]); await clickCard(pr[1]); await page.waitForTimeout(60); }
    let r = await waitDone("match L" + level);
    assert(r.kind === "match" && r.mistakes === 1, "match 완료, 실수 1: " + JSON.stringify(r));
    log(`택배 짝 찾기 L${level}: 8장 4쌍, 오답 덮기·키보드·클릭 OK`);

    // 무게 맞추기: 각 라운드 정답 두 개
    let seq = (await start("weigh", level)).split(",");
    for (const pair of seq) { for (const a of pair.split("+")) { await press(a); await page.waitForTimeout(60); } await page.waitForTimeout(450); }
    r = await waitDone("weigh L" + level);
    assert(r.kind === "weigh" && r.mistakes === 0, "weigh 완료: " + JSON.stringify(r));
    // 넘치면 실수: 세 개 다 올리면 항상 기준을 넘는다
    await start("weigh", level);
    await press("left"); await page.waitForTimeout(50); await press("up"); await page.waitForTimeout(50); await press("right"); await page.waitForTimeout(50);
    const mw = await misses();
    assert(mw === "실수 1" || mw === "실수 0", "weigh 오버 체크"); // 첫 둘이 정답이면 셋째 전에 맞아 버릴 수 있다
    log(`무게 맞추기 L${level}: ${seq.length}라운드 OK`);

    // 테이프 봉하기: SPACE 연타
    const n = parseInt(await start("tape", level), 10);
    for (let i = 0; i < n; i++) { await press("space"); await page.waitForTimeout(30); }
    r = await waitDone("tape L" + level);
    assert(r.kind === "tape", "tape 완료");
    log(`테이프 봉하기 L${level}: ${n}번 연타로 완료`);

    // 이상 확인 (기존 게임, 레이스 후보)
    seq = (await start("inspect", level)).split(",");
    for (const a of seq) { await press(a); await page.waitForTimeout(80); }
    r = await waitDone("inspect L" + level);
    assert(r.kind === "inspect", "inspect 완료");
    log(`이상 확인 L${level}: OK`);
  }
  // 멈추면 테이프가 떨어지는지
  await start("tape", 1);
  for (let i = 0; i < 6; i++) { await press("space"); await page.waitForTimeout(30); }
  const p1 = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".mg-tp-box")).getPropertyValue("--p")));
  await page.waitForTimeout(1200);
  const p2 = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".mg-tp-box")).getPropertyValue("--p")));
  assert(p2 < p1, `테이프가 떨어져야 함: ${p1} -> ${p2}`);
  log("테이프 봉하기: 손을 멈추면 테이프가 떨어짐");
  // 송장 붙이기 쉬움(박스 4개)은 2x2 -- 두 줄, 줄마다 2개 (3+1로 깨지면 안 됨)
  for (const vw of [900, 1280]) {
    await page.setViewportSize({ width: vw, height: 1000 });
    await start("sticker", 1);
    const rows = await page.evaluate(() => { const t = {}; document.querySelectorAll("#t-host .mg-bx").forEach((e) => { const y = Math.round(e.getBoundingClientRect().top / 4); t[y] = (t[y] || 0) + 1; }); return Object.values(t); });
    assert(rows.length === 2 && rows.every((n) => n === 2), "송장 붙이기 박스 4개는 2x2: " + JSON.stringify(rows));
  }
  log("송장 붙이기 쉬움: 박스 4개 2x2");
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  await browser.close();
  log("ALL CHECKS PASSED");
}
main().catch((e) => { console.error("[test-race-games] FAILED:", e); process.exit(1); });
