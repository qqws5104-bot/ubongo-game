// 2026-10-16 바코드 스캔 두 좌석 동기화 확인. 서버: TUTORIAL=0 RACE_PIECE_KINDS=react node server.js
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const mk = async () => (await b.newContext({ viewport: { width: 900, height: 800 } })).newPage();
  const p1 = await mk(); await p1.goto("http://localhost:3000/"); const room = new URL(p1.url()).searchParams.get("room");
  const p2 = await mk(); await p2.goto("http://localhost:3000/?room=" + room);
  await p1.waitForSelector("[data-courier]"); await p1.click('[data-courier="cookbang"]'); await p1.waitForTimeout(300); await p2.click('[data-courier="cheonil"]'); await p2.waitForTimeout(300);
  await p1.keyboard.press("Space"); await p2.keyboard.press("Space");
  await p1.waitForSelector(".mx-belt"); await p2.waitForSelector(".mx-belt");
  let same = 0, diff = 0; const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const [a, c] = await Promise.all([p1.evaluate(() => document.querySelector(".mx-belt").className), p2.evaluate(() => document.querySelector(".mx-belt").className)]);
    seen.add(a); if (a === c) same++; else diff++;
    await p1.waitForTimeout(70);
  }
  console.log("same", same, "diff", diff, [...seen]);
  // 실제 플레이: p1이 초록에 2번 스캔해서 조각 획득
  let got = false;
  for (let i = 0; i < 200 && !got; i++) {
    const cls = await p1.evaluate(() => document.querySelector(".mx-belt") ? document.querySelector(".mx-belt").className : "won");
    if (cls.includes(" go")) { await p1.keyboard.press("Space"); await p1.waitForTimeout(120); }
    got = await p1.evaluate(() => !!document.querySelector(".mx-card.won"));
    if (i % 20 === 0) console.log(i, cls, await p1.evaluate(() => (document.querySelector(".mx-count span")||{}).textContent + " | " + ((document.querySelector(".mx-flash")||{}).textContent||"")));
    await p1.waitForTimeout(25);
  }
  console.log("p1 won piece:", got);
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
