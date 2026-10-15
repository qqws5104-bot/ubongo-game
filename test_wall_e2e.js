const { chromium } = require("playwright");
// 2026-10-16 벽 배송 e2e: 택배 쌓기 몫(3개 중 2개 / 5개 중 3개, 레일에서 고르기) -> 배송(레일 키보드 Ctrl+호실 2초 유지) -> 오배송.
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
  await p1.goto("http://localhost:3000/?room=" + room); await p2.goto("http://localhost:3000/?room=" + room);
  await rail.goto("http://localhost:3000/rail?room=" + room);
  await p1.waitForSelector("[data-courier]"); await p1.click('[data-courier="cookbang"]'); await p1.waitForTimeout(400);
  await p2.click('[data-courier="cheonil"]'); await p2.waitForTimeout(400);
  await p1.keyboard.press("Space"); await p2.keyboard.press("Space"); await p1.waitForTimeout(800);
  const st = (p) => p.evaluate(() => window.__st || null);
  // round 1: p1 first
  await p1.keyboard.press("Space"); await p1.waitForTimeout(600);
  await rail.screenshot({ path: OUT + "r1_rail_pick.png" }); await p1.screenshot({ path: OUT + "r1_p1.png" });
  await rail.keyboard.press("KeyA"); await rail.waitForTimeout(300); await rail.keyboard.press("KeyD"); await rail.waitForTimeout(400);
  assert.strictEqual(await rail.locator(".rp-owner.seat-1").count(), 2, "1등이 2개 골랐다");
  await p2.keyboard.press("Space"); await p2.waitForTimeout(700);
  await p2.screenshot({ path: OUT + "r1_p2_after.png" });
  assert.strictEqual(await rail.locator(".rp-owner.seat-2").count(), 1, "늦은 사람이 나머지 1개");
  await p1.waitForTimeout(3000);
  // round 2: p2 first
  await p2.keyboard.press("Space"); await p2.waitForTimeout(500); await rail.keyboard.press("KeyJ"); await rail.waitForTimeout(300); await rail.keyboard.press("KeyK");
  await p1.keyboard.press("Space"); await p1.waitForTimeout(3300);
  // round 3: 5 parcels
  await p1.keyboard.press("Space"); await p1.waitForTimeout(600);
  await rail.screenshot({ path: OUT + "r3_rail_pick5.png" });
  assert.strictEqual(await rail.locator(".rail-pk").count(), 5, "3라운드는 5개");
  await s.screenshot({ path: OUT + "r3_main.png" });
  for (const k of ["KeyA", "KeyS", "KeyG"]) { await rail.keyboard.press(k); await rail.waitForTimeout(250); }
  await p2.keyboard.press("Space"); await p2.waitForTimeout(800);
  await p1.screenshot({ path: OUT + "r3_p1_slips.png" });
  // wait for delivery phase
  for (let i = 0; i < 60; i++) { const ph = await rail.evaluate(() => document.querySelector(".rv-dlv") ? "d" : ""); if (ph) break; await rail.waitForTimeout(1000); }
  await rail.waitForTimeout(500);
  await rail.screenshot({ path: OUT + "d_rail.png" }); await p1.screenshot({ path: OUT + "d_p1.png" }); await s.screenshot({ path: OUT + "d_main.png" });
  // pending units of p1 from p1 screen slips -> map to unit ids via rail
  const info = await p1.evaluate(() => [...document.querySelectorAll(".d-slip")].map(e => e.querySelector(".d-slip-b").textContent + "|" + e.querySelector(".d-slip-a").textContent));
  console.log("p1 slips", info);
  // pick a non-apt slip if possible
  const keyFor = await rail.evaluate((info) => {
    const btns = [...document.querySelectorAll("[data-unit]")];
    for (const sl of info) { const [b, a] = sl.split("|"); if (b === "아파트") continue;
      const lab = a.replace("성수로 ", ""); const btn = btns.find(x => x.querySelector(".du-label").textContent === lab && (b === "맨션" ? x.classList.contains("du-mansion") : x.classList.contains("du-house")));
      if (btn) return btn.querySelector("kbd").textContent; }
    return null; }, info);
  console.log("key", keyFor);
  assert(keyFor, "p1에게 아파트 아닌 택배가 있어야 테스트 가능 (무작위라 드물게 실패할 수 있음)");
  const codeOf = (k) => ({ ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "-": "Minus", "=": "Equal", "`": "Backquote", "↵": "Enter" }[k] || ("Key" + k));
  if (keyFor) {
    await rail.keyboard.down("Control"); await rail.keyboard.down(codeOf(keyFor)); await rail.waitForTimeout(900);
    await rail.screenshot({ path: OUT + "d_rail_holding.png" }); await p1.screenshot({ path: OUT + "d_p1_holding.png" });
    await rail.waitForTimeout(1400); await rail.keyboard.up(codeOf(keyFor)); await rail.keyboard.up("Control");
    await p1.waitForTimeout(300); await p1.screenshot({ path: OUT + "d_p1_done.png" });
    assert((await p1.locator("#dpop").textContent()).includes("배송 완료"), "배송 완료 팝업"); await s.screenshot({ path: OUT + "d_main_done.png" });
  }
  // wrong press by blue: Shift + key of some unit
  await rail.keyboard.down("Shift"); await rail.keyboard.press("KeyE"); await rail.keyboard.up("Shift"); await rail.waitForTimeout(300);
  await rail.screenshot({ path: OUT + "d_rail_wrong.png" });
  const wtxt = await rail.locator("#dpop").textContent();
  assert(wtxt.includes("오배송") || wtxt.includes("엘리베이터"), "파란 팀 잘못 누름 안내: " + wtxt);
  assert.strictEqual(await s.locator(".d-team.big").count(), 2, "메인 모니터 점수판");
  console.log("errs", errs);
  assert.deepStrictEqual(errs, []);
  console.log("test_wall_e2e OK");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
