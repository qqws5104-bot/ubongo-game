// 2026-10-06: 미니게임 3종(박스 포장 / 불량 검수 / 송장 붙이기) 시험장 검증.
//
// minigame_proto.html(로컬 파일)을 진짜 브라우저로 열어서 3종을 난이도 1~3 전부 실제로 "플레이"한다
// (키보드/클릭/마우스 드래그). 정상 클리어뿐 아니라 오입력 3규칙, 잘못된 클릭 잠금, 빗나간 드래그 복귀,
// destroy() 후 키 리스너 정리까지 확인한다. 서버는 필요 없다 (정적 파일).
//   사전: python3 build_minigame_proto.py
"use strict";
const path = require("path");
const { chromium } = require("playwright");

const URL = "file://" + path.join(__dirname, "minigame_proto.html");
const SHOT_DIR = process.env.SHOT_DIR || null;
function log(...a) { console.log("[test-minigames]", ...a); }
function assert(cond, msg) { if (!cond) throw new Error("ASSERT FAILED: " + msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", space: "Space" };

async function waitFor(fn, { timeout = 5000, interval = 50, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("timeout waiting for: " + label);
    await sleep(interval);
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  await page.goto(URL);

  // ---- 헬퍼: API로 직접 게임을 띄운다 (testHooks로 정답 위치를 노출) ----
  async function launch(kind, level, rule) {
    await page.evaluate(({ kind, level, rule }) => {
      if (window.__ctl) { window.__ctl.destroy(); window.__ctl = null; }
      document.getElementById("menu").hidden = true;
      document.getElementById("play").hidden = false;
      MiniGames.setMistakeRule(rule || "reset");
      window.__res = null;
      window.__ctl = MiniGames.start(document.getElementById("host"), {
        kind, level, testHooks: true, label: "B08호", onDone: (r) => { window.__res = r; }, onCancel: () => { window.__cancelled = true; },
      });
    }, { kind, level, rule });
  }
  const result = () => page.evaluate(() => window.__res);
  const miss = async () => parseInt((await page.textContent(".mg-miss")).replace(/\D/g, ""), 10);
  async function shot(name) { if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, name + ".png") }); }

  // ================= 박스 포장 =================
  const PACK_LEN = [4, 6, 8];
  for (let lv = 1; lv <= 3; lv++) {
    await launch("pack", lv);
    const seq = (await page.getAttribute(".mg-body", "data-seq")).split(",");
    assert(seq.length === PACK_LEN[lv - 1], `pack L${lv} should have ${PACK_LEN[lv - 1]} arrows, got ${seq.length}`);
    for (let i = 2; i < seq.length; i++) assert(!(seq[i] === seq[i - 1] && seq[i] === seq[i - 2]), "no 3 identical keys in a row");
    if (lv === 2) await shot("pack_L2_start");
    for (const k of seq) await page.keyboard.press(KEY[k]);
    assert(!(await result()), "pack must NOT finish before the final SPACE");
    assert((await page.$$(".mg-chip.is-done")).length === seq.length, "all arrow chips done before SPACE");
    if (lv === 2) await shot("pack_L2_before_tape");
    await page.keyboard.press("Space");
    await waitFor(result, { label: `pack L${lv} done` });
    const r = await result();
    assert(r.ok && r.kind === "pack" && r.level === lv && r.mistakes === 0, "pack clean run result: " + JSON.stringify(r));
    if (lv === 2) await shot("pack_L2_done");
    log(`pack L${lv}: ${seq.length}키+SPACE 클리어 (${r.ms}ms, 실수 0)`);
  }

  // 오입력 규칙 1: reset -- 처음부터
  await launch("pack", 2, "reset");
  {
    const seq = (await page.getAttribute(".mg-body", "data-seq")).split(",");
    await page.keyboard.press(KEY[seq[0]]); await page.keyboard.press(KEY[seq[1]]);
    assert((await page.$$(".mg-chip.is-done")).length === 2, "2 chips done before the mistake");
    const wrong = ["up", "down", "left", "right"].find((d) => d !== seq[2]);
    await page.keyboard.press(KEY[wrong]);
    await sleep(250);
    assert((await page.$$(".mg-chip.is-done")).length === 0, "reset rule: all chips must reset to start after a wrong key");
    assert((await page.$$(".mg-flap.is-closed")).length === 0, "reset rule: flaps must reopen");
    assert((await miss()) === 1, "mistake counter should be 1");
    for (const k of seq) await page.keyboard.press(KEY[k]);
    await page.keyboard.press("Space");
    await waitFor(result, { label: "pack reset-rule done" });
    assert((await result()).mistakes === 1, "recorded mistakes should be 1");
    log("pack 오입력=reset: 틀리면 입력 전체가 처음부터 다시, 이후 정상 클리어 + 실수 1회 기록");
  }
  // 규칙 2: freeze -- 0.5초 멈췄다가 이어서
  await launch("pack", 1, "freeze");
  {
    const seq = (await page.getAttribute(".mg-body", "data-seq")).split(",");
    await page.keyboard.press(KEY[seq[0]]);
    const wrong = ["up", "down", "left", "right"].find((d) => d !== seq[1]);
    await page.keyboard.press(KEY[wrong]);
    await page.keyboard.press(KEY[seq[1]]); // 정지 중이라 무시돼야 함
    assert((await page.$$(".mg-chip.is-done")).length === 1, "freeze rule: input during the 0.5s freeze must be ignored");
    await sleep(650);
    await page.keyboard.press(KEY[seq[1]]);
    assert((await page.$$(".mg-chip.is-done")).length === 2, "freeze rule: progress resumes where it left off (not reset)");
    for (let i = 2; i < seq.length; i++) await page.keyboard.press(KEY[seq[i]]);
    await page.keyboard.press("Space");
    await waitFor(result, { label: "pack freeze-rule done" });
    log("pack 오입력=freeze: 0.5초 정지 중 입력 무시, 풀리면 있던 자리부터 이어서");
  }
  // 규칙 3: ignore
  await launch("pack", 1, "ignore");
  {
    const seq = (await page.getAttribute(".mg-body", "data-seq")).split(",");
    await page.keyboard.press(KEY[seq[0]]);
    const wrong = ["up", "down", "left", "right"].find((d) => d !== seq[1]);
    await page.keyboard.press(KEY[wrong]);
    await sleep(250);
    assert((await page.$$(".mg-chip.is-done")).length === 1, "ignore rule: progress untouched by a wrong key");
    assert((await miss()) === 1, "ignore rule still counts the mistake");
    for (let i = 1; i < seq.length; i++) await page.keyboard.press(KEY[seq[i]]);
    await page.keyboard.press("Space");
    await waitFor(result, { label: "pack ignore-rule done" });
    log("pack 오입력=ignore: 진행 그대로, 실수만 기록");
  }
  // 스페이스를 너무 일찍 눌러도 오입력 취급 + 키 반복(e.repeat)은 무시
  await launch("pack", 1, "reset");
  {
    await page.keyboard.press("Space"); // 첫 키는 화살표여야 하므로 오입력
    assert((await miss()) === 1, "early SPACE counts as a mistake");
    await page.evaluate(() => {
      const want = document.querySelector(".mg-body").getAttribute("data-seq").split(",")[0];
      const key = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" }[want];
      document.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true, repeat: true }));
    });
    await sleep(100);
    assert((await page.$$(".mg-chip.is-done")).length === 0, "auto-repeat keydown must be ignored (holding a key must not spam inputs)");
    log("pack: 너무 이른 스페이스=오입력, 키 꾹 누름(repeat)은 무시");
  }

  // ================= 불량 검수 =================
  const INSPECT = [{ tiles: 9, defects: 2 }, { tiles: 12, defects: 3 }, { tiles: 20, defects: 4 }];
  for (let lv = 1; lv <= 3; lv++) {
    await launch("inspect", lv);
    const tiles = await page.$$(".mg-tile");
    const defects = await page.$$(".mg-tile[data-defect]");
    assert(tiles.length === INSPECT[lv - 1].tiles, `inspect L${lv} tile count ${tiles.length}`);
    assert(defects.length === INSPECT[lv - 1].defects, `inspect L${lv} defect count ${defects.length}`);
    if (lv === 2) await shot("inspect_L2_start");
    for (let i = 0; i < defects.length; i++) {
      await defects[i].click();
      if (lv === 2 && i === 1) await shot("inspect_L2_mid");
    }
    await waitFor(result, { label: `inspect L${lv} done` });
    const r = await result();
    assert(r.ok && r.mistakes === 0, "inspect clean run: " + JSON.stringify(r));
    log(`inspect L${lv}: ${INSPECT[lv - 1].tiles}칸 중 불량 ${INSPECT[lv - 1].defects}개 클리어 (${r.ms}ms)`);
  }
  // 잘못된 클릭: 실수 +1, 0.6초 잠금(그 사이 정답 클릭도 무시), 풀린 뒤엔 정상
  await launch("inspect", 2);
  {
    const good = await page.$$(".mg-tile[data-defect]");
    const badEl = await page.evaluateHandle(() => Array.from(document.querySelectorAll(".mg-tile")).find((t) => !t.hasAttribute("data-defect")));
    await badEl.asElement().click();
    assert((await miss()) === 1, "wrong tile click counts as a mistake");
    await good[0].click(); // 잠금 중
    assert((await page.$$(".mg-tile.is-found")).length === 0, "clicks during the 0.6s lock must be ignored");
    await sleep(700);
    for (const g of good) await g.click();
    await waitFor(result, { label: "inspect after-lock done" });
    assert((await result()).mistakes === 1, "inspect mistakes recorded");
    log("inspect: 멀쩡한 상자 클릭=실수, 0.6초 잠금 중 클릭 무시, 풀리면 정상 진행");
  }

  // ================= 송장 붙이기 =================
  async function geom() {
    return page.evaluate(() => {
      const t = document.querySelector(".mg-target.is-on");
      const l = document.querySelector('.mg-label[data-label]:not([data-stuck])');
      const s = document.querySelector(".mg-stage").getBoundingClientRect();
      const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
      return { t: t ? rect(t) : null, l: l ? rect(l) : null, s: { x: s.left, y: s.top, w: s.width, h: s.height } };
    });
  }
  async function drag(from, to, steps = 12) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps });
    await page.mouse.up();
  }
  for (let lv = 1; lv <= 3; lv++) {
    await launch("sticker", lv);
    await page.evaluate(() => window.scrollTo(0, 0));
    for (let n = 1; n <= lv; n++) {
      await waitFor(async () => (await geom()).l && (await geom()).t, { label: `sticker L${lv} label #${n} ready` });
      const g = await geom();
      if (lv === 2 && n === 1) await shot("sticker_L2_start");
      await drag({ x: g.l.x + g.l.w / 2, y: g.l.y + g.l.h / 2 }, { x: g.t.x + g.t.w / 2, y: g.t.y + g.t.h / 2 });
      await waitFor(async () => (await page.$$('.mg-label[data-stuck]')).length === n, { label: `sticker L${lv} #${n} stuck` });
      if (lv === 2 && n === 1) await shot("sticker_L2_one_stuck");
    }
    await waitFor(result, { label: `sticker L${lv} done` });
    const r = await result();
    assert(r.ok && r.mistakes === 0, "sticker clean run: " + JSON.stringify(r));
    log(`sticker L${lv}: 송장 ${lv}장 붙이기 클리어 (${r.ms}ms)`);
  }
  // 빗나간 드래그: 점선 밖(박스 위)에 놓으면 실수 +1 + 트레이로 복귀, 정상 위치로 다시 놓으면 성공
  await launch("sticker", 3); // 가장 좁은 점선
  {
    const g = await geom();
    // 점선 중심에서 가로로 충분히 비껴 놓는다(어려움 난이도 여유 = 가로 ±2%) -- 박스 윗면 위의 다른 곳
    const off = { x: g.t.x + g.t.w / 2 + g.s.w * 0.07, y: g.t.y + g.t.h / 2 };
    await drag({ x: g.l.x + g.l.w / 2, y: g.l.y + g.l.h / 2 }, off);
    assert((await miss()) === 1, "a drop on the parcel but outside the dashed box is a mistake");
    assert((await page.$$('.mg-label[data-stuck]')).length === 0, "missed drop must not stick");
    await sleep(350);
    const g2 = await geom();
    assert(Math.abs(g2.l.y - g.l.y) < 4 && Math.abs(g2.l.x - g.l.x) < 4, "missed label must return to the tray");
    // 트레이 근처에서 그냥 놓는 건 실수 아님
    await drag({ x: g2.l.x + g2.l.w / 2, y: g2.l.y + g2.l.h / 2 }, { x: g2.l.x + g2.l.w / 2 + 30, y: g2.l.y + g2.l.h / 2 });
    assert((await miss()) === 1, "dropping near the tray must NOT count as a mistake");
    log("sticker: 빗나간 드래그=실수+트레이 복귀, 트레이 근처에서 놓은 건 실수 아님");
  }

  // ================= destroy 정리 =================
  await launch("pack", 1);
  await page.evaluate(() => { window.__ctl.destroy(); window.__ctl = null; });
  assert((await page.$$(".mg-root")).length === 0, "destroy() removes the game from the DOM");
  await page.keyboard.press("ArrowUp"); await page.keyboard.press("Space"); // 리스너가 남아 있으면 에러/오동작
  log("destroy(): DOM 제거 + 이후 키 입력에 반응 없음 (리스너 정리됨)");

  // ================= 시험장 UI 전체 흐름 (실제 버튼) =================
  await page.goto(URL);
  await page.click('button[data-kind="pack"][data-lv="1"]');
  await page.click('button[data-go="pack"]');
  await waitFor(async () => (await page.$$(".mg-root")).length === 1, { label: "game opened from the UI" });
  const seq = (await page.getAttribute(".mg-body", "data-seq")).split(",");
  for (const k of seq) await page.keyboard.press(KEY[k]);
  await page.keyboard.press("Space");
  await waitFor(async () => (await page.$$("table")).length > 0, { label: "log table after done", timeout: 4000 });
  const txt = await page.textContent("#tables");
  assert(txt.includes("박스 포장") && txt.includes("원/초"), "log shows the run and 원/초");
  assert((await page.$$('button[data-again]')).length === 1, "'같은 설정으로 한 번 더' button shown");
  await shot("proto_after_run");
  // Esc로 포기
  await page.click('button[data-go="inspect"]');
  await waitFor(async () => (await page.$$(".mg-root")).length === 1, { label: "inspect opened" });
  await page.keyboard.press("Escape");
  assert((await page.$$(".mg-root")).length === 0 && !(await page.$eval("#menu", (e) => e.hidden)), "Esc gives up and returns to the menu");
  log("시험장 UI: 시작 → 플레이 → 기록표(원/초) 갱신 → '한 번 더' 버튼, Esc 포기 모두 정상");

  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  await browser.close();
  log("ALL CHECKS PASSED");
}

main().catch((e) => { console.error("[test-minigames] FAILED:", e); process.exit(1); });
