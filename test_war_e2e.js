const { chromium } = require("playwright");
// 2026-10-22 엘리베이터 이동 전쟁 e2e (아파트 한 채). 서버: APT_WAR=1, SECURE_PHASE_MS 짧게 (re_war.sh). 앞부분은 test_wall_e2e와 같음
// (원본) 2026-10-16 벽 배송 e2e: 택배 쌓기 몫(3개 중 2개 / 5개 중 3개, 레일에서 고르기) -> 배송(메인 컴퓨터 키보드 Ctrl+호실 2초 유지) -> 오배송.
// 서버: SECURE_PHASE_MS 40초, TUTORIAL=0, WALL 기본(regress.sh 마지막 섹션).
const assert = require("assert");
const OUT = "/tmp/war_e2e_";
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
  for (let round = 1; round <= 2; round++) {
    const first = round % 2 ? "1" : "2", late = first === "1" ? "2" : "1";
    const P = { "1": p1, "2": p2 };
    await fin(p1); await fin(p2);
    await P[first].keyboard.press("Space"); await P[first].waitForTimeout(600);
    const n = await rail.locator(".rail-pk").count();
    if (round === 1) await rail.screenshot({ path: OUT + "r_rail_pick.png" });
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
  console.log("micro games seen", Object.keys(shotKinds));
  for (let i = 0; i < 90; i++) { const ph = await s.evaluate(() => document.querySelector(".d-war") ? "d" : ""); if (ph) break; await rail.waitForTimeout(1000); }
  assert(await s.locator(".d-war").count(), "메인 = 엘리베이터 전쟁 화면");
  await s.waitForTimeout(300);
  await s.screenshot({ path: OUT + "main.png" }); await p1.screenshot({ path: OUT + "p1.png" }); await rail.screenshot({ path: OUT + "rail.png" });
  assert.strictEqual(await s.locator(".wbld .wu").count(), 56, "7층 x 8호");
  // 2026-10-22 2차: 입력은 각자 플레이어 화면. 송장 = 색 상자 + 호수 (글자 없음)
  await p1.waitForSelector(".wp");
  const slips = await p1.evaluate(() => [...document.querySelectorAll(".wp-slip b")].map(e => e.textContent));
  console.log("p1 slips", slips);
  assert(slips.length > 0 && /^\d0\d$/.test(slips[0]), "송장 = 호수");
  assert.strictEqual(await p1.locator(".wp-slip .pbox").count(), slips.length, "송장마다 색 상자");
  assert.strictEqual(await p1.locator(".wp-slip :text-matches('일반|귀중|깨지기')").count(), 0, "종류 글자 없음");
  assert(await s.locator(".wbld .wu-dots .pbox").count() > 0, "메인 건물 칸에 상자");
  const pickS = slips.find((x) => x[0] !== "1") || slips[0];
  const F = +pickS[0], N = +pickS[2];
  const floor = async () => +(await p1.locator(".wp-floor b").textContent());
  let delivered = false;
  for (let tries = 0; tries < 6 && !delivered; tries++) {
    await p1.waitForSelector(".wp-move", { timeout: 12000 });
    let k = 0;
    while (k++ < 20 && (await p1.locator(".wp-move").count())) {
      const cur = await floor(); if (cur === F) break;
      await p1.click(cur < F ? ".wp-arrow.up" : ".wp-arrow.down"); await p1.waitForTimeout(80);
    }
    if (tries === 0) { await p1.screenshot({ path: OUT + "p1_move.png" }); await s.screenshot({ path: OUT + "main_move.png" }); }
    await p1.waitForSelector(".wp-doors, .wp-move", { timeout: 8000 });
    await p1.waitForSelector(".wp-doors", { timeout: 7000 }).catch(() => null);
    if (!(await p1.locator(".wp-doors").count())) continue;
    const here = await p1.evaluate(() => +document.querySelector(".wst.big b").textContent.replace(/\D/g, "") >= 0 && document.querySelectorAll(".wp-door").length);
    const doorF = +(await p1.locator(".wp-door b").first().textContent())[0];
    if (doorF !== F) { await p1.waitForSelector(".wp-move", { timeout: 8000 }); continue; }
    await p1.screenshot({ path: OUT + "p1_open.png" }); await s.screenshot({ path: OUT + "main_open.png" });
    for (let i = 0; i < 3; i++) { await p1.click('.wp-door[data-slot="' + N + '"]'); await p1.waitForTimeout(60); }
    await p1.waitForTimeout(300);
    const pt = await p1.locator("#dpop").textContent(); console.log("pop", pt);
    assert(pt.includes("배송 완료") || pt.includes("선점") || pt.includes("콤보"), "배송 완료: " + pt);
    delivered = true;
  }
  assert(delivered, "플레이어 화면에서 이동 -> 배송");
  await s.screenshot({ path: OUT + "main_done.png" });
  for (const [w, h] of [[1920, 1080], [1366, 768], [1280, 720], [1920, 1200], [1024, 768], [2560, 1440]]) {
    await s.setViewportSize({ width: w, height: h }); await s.waitForTimeout(300); await s.screenshot({ path: OUT + "main_" + w + "x" + h + ".png" });
    const ov = await s.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 2 || [...document.querySelectorAll(".wbld, .wpanel")].some(d => d.scrollHeight > d.clientHeight + 4));
    console.log("main", w, h, "overflow", ov);
  }
  console.log("errs", errs);
  assert.deepStrictEqual(errs, []);
  console.log("test_war_e2e OK");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
