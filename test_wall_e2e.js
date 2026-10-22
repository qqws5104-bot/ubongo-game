const { chromium } = require("playwright");
// 2026-10-16 벽 배송 e2e: 택배 쌓기 몫(3개 중 2개 / 5개 중 3개, 레일에서 고르기) -> 배송(메인 컴퓨터 키보드 Ctrl+호실 2초 유지) -> 오배송.
// 서버: SECURE_PHASE_MS 40초, TUTORIAL=0, WALL 기본(regress.sh 마지막 섹션).
const assert = require("assert");
const OUT = "/tmp/wall_e2e_";
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const mk = async (w, h) => (await b.newContext({ viewport: { width: w || 1280, height: h || 900 } })).newPage();
  const errs = [];
  const s = await mk(); await s.goto("http://localhost:3000/?view=main"); const room = new URL(s.url()).searchParams.get("room");
  s.on("pageerror", e => errs.push("main " + e.message));
  const p1 = await mk(820, 1000), p2 = await mk(820, 1000), rail = await mk(1500, 950);
  [p1, p2, rail].forEach((p, i) => p.on("pageerror", e => errs.push(i + " " + e.message)));
  await p1.goto("http://localhost:3000/?mgtest=1&room=" + room); await p2.goto("http://localhost:3000/?mgtest=1&room=" + room);
  await rail.goto("http://localhost:3000/rail?room=" + room);
  await p1.waitForSelector("[data-courier]"); await p1.click('[data-courier="cookbang"]'); await p1.waitForTimeout(400);
  await p2.click('[data-courier="cheonil"]'); await p2.waitForTimeout(400);
  await p1.keyboard.press("Space"); await p2.keyboard.press("Space"); await p1.waitForTimeout(800);
  // 2026-10-16: 택배 쌓기 전에 첫 미니게임 (테스트 훅으로 바로 끝냄) -> 택배 수는 조각 수로 (2조각 3개 / 3조각 5개)
  // 2026-10-16: 조각마다 반응형 미니게임 -- 조각을 다 모을 때까지 하나씩 끝낸다(테스트 훅). 다 모으면 투입 버튼.
  let shotKinds = {};
  const fin = async (p) => {
    for (let k = 0; k < 6; k++) {
      await p.waitForFunction(() => !!document.querySelector("#mx-layer.on .mx-card:not(.won)") || !!document.querySelector('.race-blank [data-action="race-done"]'), null, { timeout: 8000 });
      if (await p.locator('.race-blank [data-action="race-done"]').count() && !(await p.locator("#mx-layer.on .mx-card:not(.won)").count())) return;
      const name = await p.locator("#mx-layer .mx-name").textContent();
      if (!shotKinds[name]) { shotKinds[name] = 1; await p.screenshot({ path: OUT + "mx_" + Object.keys(shotKinds).length + ".png" }); }
      await p.evaluate(() => window.__mxFinish()); await p.waitForTimeout(1300);
    }
  };
  const RAIL_KEYS = { "1": ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG"], "2": ["KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon"] };
  let saw5 = false;
  for (let round = 1; round <= 4; round++) {
    const first = round % 2 ? "1" : "2", late = first === "1" ? "2" : "1";
    const P = { "1": p1, "2": p2 };
    await fin(p1); await fin(p2);
    await P[first].keyboard.press("Space"); await P[first].waitForTimeout(600);
    const n = await rail.locator(".rail-pk").count();
    assert(n === 4 || n === 5, "택배 4개 또는 5개: " + n);
    if (n === 5) { saw5 = true; await rail.screenshot({ path: OUT + "r_rail_pick5.png" }); }
    const take = 2; // 2026-10-21: 1등 2개 고르기
    for (let k = 0; k < take; k++) { await rail.keyboard.press(RAIL_KEYS[first][k]); await rail.waitForTimeout(250); }
    assert.strictEqual(await rail.locator(".rp-owner.seat-" + first).count(), take, "1등이 " + take + "개");
    await P[late].keyboard.press("Space"); await P[late].waitForTimeout(700);
    if (n === 5) {
      // 늦은 사람도 시간 안에 완성 -> 남은 3개 중 2개 직접 고르기 (레일 화면 키, 남은 칸 = 인덱스 2,3,4)
      await rail.screenshot({ path: OUT + "r_rail_latepick.png" });
      for (const k of [2, 4]) { await rail.keyboard.press(RAIL_KEYS[late][k]); await rail.waitForTimeout(250); }
    }
    assert.strictEqual(await rail.locator(".rp-owner.seat-" + late).count(), 2, "늦게라도 완성하면 2개");
    await p1.waitForTimeout(2800);
  }
  assert(saw5, "3조각 라운드(전반 4라운드)에서 택배 5개");
  console.log("micro games seen", Object.keys(shotKinds));
  // wait for delivery phase
  for (let i = 0; i < 60; i++) { const ph = await s.evaluate(() => document.querySelector(".rv-dlv") ? "d" : ""); if (ph) break; await rail.waitForTimeout(1000); }
  await rail.waitForTimeout(500);
  await rail.screenshot({ path: OUT + "d_rail.png" }); await p1.screenshot({ path: OUT + "d_p1.png" }); await s.screenshot({ path: OUT + "d_main.png" });
  // pending units of p1 from p1 screen slips -> map to unit ids via rail
  const info = await p1.evaluate(() => [...document.querySelectorAll(".d-slip")].map(e => e.querySelector(".d-slip-b").textContent + "|" + e.querySelector(".d-slip-a").textContent));
  console.log("p1 slips", info);
  // pick a non-apt slip if possible
  const keyFor = await s.evaluate((info) => {
    const btns = [...document.querySelectorAll("[data-unit]")];
    for (const sl of info) { const [b, a] = sl.split("|"); if (b === "아파트") continue;
      const addr = b === "주택" ? a : b + " " + a; const btn = btns.find(x => x.getAttribute("aria-label") === addr);
      if (btn) return btn.querySelector("kbd").textContent + "|" + b + "|" + btn.getAttribute("data-unit"); }
    return null; }, info);
  console.log("key", keyFor);
  assert(keyFor, "p1에게 아파트 아닌 택배가 있어야 테스트 가능 (무작위라 드물게 실패할 수 있음)");
  const codeOf = (k) => ({ ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "-": "Minus", "=": "Equal", "`": "Backquote", "↵": "Enter" }[k] || ("Key" + k));
  if (keyFor) {
    // 2026-10-16 건물별: 맨션 = Ctrl 누른 채 5번 연타 / 주택 = 초인종 -> 초록(문 열림)이면 한 번 더
    const [kk, bb, uid] = keyFor.split("|"), code = codeOf(kk);
    await s.keyboard.down("Control");
    if (bb === "맨션") {
      for (let i = 0; i < 3; i++) { await s.keyboard.press(code); await s.waitForTimeout(120); }
      await s.waitForTimeout(300); await s.screenshot({ path: OUT + "d_main_holding.png" }); await p1.screenshot({ path: OUT + "d_p1_holding.png" });
      for (let i = 0; i < 2; i++) { await s.keyboard.press(code); await s.waitForTimeout(120); }
    } else {
      await s.keyboard.press(code); await s.waitForTimeout(600);
      await s.screenshot({ path: OUT + "d_main_holding.png" }); await p1.screenshot({ path: OUT + "d_p1_holding.png" });
      await s.waitForSelector('[data-unit="' + uid + '"].bell-open', { timeout: 5000 });
      await s.screenshot({ path: OUT + "d_main_bellopen.png" });
      await s.keyboard.press(code);
    }
    await s.keyboard.up("Control"); await p1.waitForTimeout(500); await p1.screenshot({ path: OUT + "d_p1_done.png" });
    { const pt = await p1.locator("#dpop").textContent(); assert(pt.includes("배송 완료") || pt.includes("선점") || pt.includes("콤보"), "배송 완료 팝업 (" + bb + "): " + pt); } await s.screenshot({ path: OUT + "d_main_done.png" });
  }
  // wrong press by blue: Shift + key of some unit
  await s.keyboard.down("Shift"); await s.keyboard.press("KeyE"); await s.keyboard.up("Shift"); await s.waitForTimeout(300);
  await s.screenshot({ path: OUT + "d_main_wrong.png" });
  const wtxt = await s.locator("#dpop").textContent();
  assert(wtxt.includes("오배송") || wtxt.includes("엘리베이터"), "파란 팀 잘못 누름 안내: " + wtxt);
  assert.strictEqual(await rail.locator(".d-team.big").count(), 2, "레일 화면 점수판");
  // 엘리베이터: 메인 컴퓨터 Shift+↑ -> 2층, 플레이어 화면엔 ▲▼ 버튼 없음
  await s.keyboard.press("ArrowUp"); await s.waitForTimeout(300); // 2026-10-21 팀 키 없이
  assert((await s.locator(".d-elev-f").first().textContent()).includes("2층"), "엘리베이터 2층");
  assert.strictEqual(await p1.locator("[data-action=\"wall-elev\"]").count(), 0, "플레이어 화면엔 엘리베이터 버튼 없음");
  console.log("errs", errs);
  if (process.env.FEVERSHOT) {
    await s.waitForSelector("body.d-fever", { timeout: 120000 });
    await s.waitForTimeout(400); await s.screenshot({ path: OUT + "d_main_fever.png" });
    // 피버 중 배송 하나 (주택/맨션이면) -- 떠오르는 점수 확인
    const k2 = await s.evaluate(() => { const st = window.__st || null; return null; });
    void k2;
  }
  for (const [w, h] of [[1920, 1080], [1366, 768], [1280, 720], [1920, 969], [1536, 864], [1440, 900], [1920, 1200], [2560, 1440], [3840, 2160], [2560, 1080], [1024, 768], [1280, 1024], [1080, 1920]]) { await s.setViewportSize({ width: w, height: h }); await s.waitForTimeout(400); await s.screenshot({ path: OUT + "d_main_" + w + "x" + h + ".png" });
    console.log("geo", w, h, JSON.stringify(await s.evaluate(() => { const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }; return { walls: r(document.querySelector(".dwalls3")), cols: [...document.querySelectorAll(".dwalls3 > .dw")].map(r), apt: r(document.querySelector(".dwalls3 .dw-apt-pic")), man: r(document.querySelector(".dwalls3 .dw-man-pic")), h1: r(document.querySelector(".dwalls3 .dw-home-pic")), keys: r(document.querySelector(".d-keys1")) }; })));
    const ov = await s.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 2 || [...document.querySelectorAll(".dwalls3 > .dw")].some(d => d.scrollHeight > d.clientHeight + 4)); console.log("main", w, h, "overflow", ov); }
  assert.deepStrictEqual(errs, []);
  console.log("test_wall_e2e OK");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
