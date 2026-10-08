// 2026-10-06: 미니게임 4종(박스 포장 / 불량 검수 / 송장 붙이기 / 지도 배달(2026-10-07)) 시험장 검증.
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
  async function launch(kind, level, rule, extra) {
    await page.evaluate(({ kind, level, rule, extra }) => {
      if (window.__ctl) { window.__ctl.destroy(); window.__ctl = null; }
      document.getElementById("menu").hidden = true;
      document.getElementById("play").hidden = false;
      MiniGames.setMistakeRule(rule || "reset");
      window.__res = null;
      window.__ctl = MiniGames.start(document.getElementById("host"), Object.assign({
        kind, level, testHooks: true, label: "1F", onDone: (r) => { window.__res = r; }, onCancel: () => { window.__cancelled = true; },
      }, extra || {}));
    }, { kind, level, rule, extra: extra || null });
  }
  const result = () => page.evaluate(() => window.__res);
  const miss = async () => parseInt((await page.textContent(".mg-miss")).replace(/\D/g, ""), 10);
  async function shot(name) { if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, name + ".png") }); }

  // ================= 박스 포장 (2026-10-07: 조각 채워 넣기 퍼즐) =================
  // 테스트 훅: .mg-body[data-plan] = 칸 크기 + 조각별 {presses: 정답 방향까지 회전 횟수, x, y: 정답 위치},
  //            .mg-body[data-pk]   = "지금 고른 조각, x, y, 회전, 놓은 조각 수"
  const pkState = async () => (await page.getAttribute(".mg-body", "data-pk")).split(",").map(Number);
  const pkPlan = async () => JSON.parse(await page.getAttribute(".mg-body", "data-plan"));
  async function pkMoveTo(tx, ty) {
    let [, px, py] = await pkState(), g = 0;
    while (px !== tx || py !== ty) {
      await page.keyboard.press(px < tx ? "ArrowRight" : px > tx ? "ArrowLeft" : py < ty ? "ArrowDown" : "ArrowUp");
      [, px, py] = await pkState(); assert(++g < 60, "piece reaches its target cell");
    }
  }
  async function pkPlacePiece(i, plan) { // i번 조각을 정답 방향/위치로 놓는다
    let [cur] = await pkState(), g = 0;
    while (cur !== i) { await page.keyboard.press("Tab"); [cur] = await pkState(); assert(++g < 12, "Tab cycles to the wanted piece"); }
    for (let r = 0; (await pkState())[3] % 4 !== 0 && r < 4; r++) await page.keyboard.press("Space"); // 정답 방향 = 회전 0 (이전에 손으로 돌려 둔 조각도 처리)
    await pkMoveTo(plan.pieces[i].x, plan.pieces[i].y);
    await page.keyboard.press("Enter");
  }
  async function solvePack() {
    const plan = await pkPlan();
    for (let i = 0; i < plan.pieces.length; i++) await pkPlacePiece(i, plan);
  }
  const PK = [{ cols: 3, rows: 3, n: 3 }, { cols: 4, rows: 4, n: 4 }, { cols: 5, rows: 4, n: 5 }];
  for (let lv = 1; lv <= 3; lv++) {
    await launch("pack", lv);
    const plan = await pkPlan();
    assert(plan.cols === PK[lv - 1].cols && plan.rows === PK[lv - 1].rows && plan.pieces.length === PK[lv - 1].n, `pack L${lv}: ${PK[lv - 1].cols}x${PK[lv - 1].rows} box, ${PK[lv - 1].n} pieces, got ${JSON.stringify(plan).slice(0, 80)}`);
    assert((await page.$$(".pk-cell")).length === plan.cols * plan.rows, "the box has cols x rows cells");
    assert((await page.$$(".pk-piece")).length === plan.pieces.length, "every piece is in the tray");
    const area = await page.$$eval(".pk-piece .pk-mini.on", (els) => els.length);
    assert(area === plan.cols * plan.rows, `piece cells add up to the box area (${area} vs ${plan.cols * plan.rows}) -- the puzzle is always solvable`);
    if (lv === 2) await shot("pack_L2_start");
    await solvePack();
    await waitFor(result, { label: `pack L${lv} done` });
    const r = await result();
    assert(r.ok && r.kind === "pack" && r.level === lv && r.mistakes === 0, "pack clean run result: " + JSON.stringify(r));
    log(`pack L${lv}: ${plan.cols}x${plan.rows} 상자를 조각 ${plan.pieces.length}개로 채워 클리어 (${r.ms}ms, 실수 0)`);
  }
  // 여러 판 뽑아도 항상 풀린다 (정답 배치가 있고, 마지막 조각을 놓는 순간 끝난다)
  for (let k = 0; k < 8; k++) {
    await launch("pack", k % 2 ? 3 : 2);
    await solvePack();
    await waitFor(result, { label: "random pack solvable" });
    assert((await result()).mistakes === 0, "random pack solved without mistakes");
  }
  log("pack: 무작위로 8판 더 뽑아도 정답 배치로 항상 클리어");

  // 조작: 이동은 상자 안으로 제한, 회전/되돌리기/조각 바꾸기, 겹치게 놓으면 실수 + 잠금
  await launch("pack", 2);
  {
    const plan = await pkPlan();
    let [cur, px, py] = await pkState();
    for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
    for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowUp");
    [cur, px, py] = await pkState();
    assert(px === 0 && py === 0, "a piece cannot be moved out of the box (top-left), got " + [px, py]);
    for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
    for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowDown");
    const [, qx, qy] = await pkState();
    const dims = await page.$eval(".pk-piece.is-active .pk-mg", (e) => ({ w: parseInt(getComputedStyle(e).getPropertyValue("--cols"), 10), n: e.querySelectorAll(".pk-mini").length }));
    assert(qx === plan.cols - dims.w && qy <= plan.rows - 1 && qy >= 0, `moved to the far corner but still inside the box: ${[qx, qy]} (piece is ${dims.w} wide)`);
    // 회전: 4번 돌리면 제자리, 회전 중에도 상자 밖으로 안 나간다
    const before = await page.$eval(".pk-piece.is-active .pk-mg", (e) => e.innerHTML);
    for (let i = 0; i < 4; i++) await page.keyboard.press("Space");
    assert((await page.$eval(".pk-piece.is-active .pk-mg", (e) => e.innerHTML)) === before, "four rotations return to the same orientation");
    await page.keyboard.press("Space");
    const [, rx, ry, rr] = await pkState();
    const d2 = await page.$eval(".pk-piece.is-active .pk-mg", (e) => parseInt(getComputedStyle(e).getPropertyValue("--cols"), 10));
    assert(rr === ((await pkState())[3]) && rx + d2 <= plan.cols, "after rotating, the piece is still inside the box");
    // Tab: 다른 조각을 고르고, 처음으로 돌아온다
    const [c0] = await pkState();
    await page.keyboard.press("Tab");
    const [c1] = await pkState();
    assert(c1 !== c0, "Tab selects another piece");
    for (let i = 0; i < plan.pieces.length - 1; i++) await page.keyboard.press("Tab");
    assert((await pkState())[0] === c0, "Tab cycles through all pieces and returns");
    assert((await miss()) === 0, "moving / rotating / switching pieces is free (no mistakes)");
  }
  // 겹치게 놓기 = 실수 +1 + 잠깐 멈춤(그동안 입력 무시), 이후 되돌리기로 풀어 낸다
  await launch("pack", 2);
  {
    const plan = await pkPlan();
    await pkPlacePiece(0, plan);                                        // 0번 조각을 정답 자리에 놓는다
    assert((await pkState())[4] === 1, "one piece placed");
    assert((await page.$$(".pk-cell.is-fill")).length > 0 && (await page.$$(".pk-piece.is-placed")).length === 1, "placed cells are filled and the tray piece is dimmed");
    // 다음 조각을 방금 놓은 조각 위로 옮겨서 놓기
    await pkMoveTo(0, 0);
    // 놓은 조각과 겹치는 자리를 찾을 때까지 훑는다 (겹치면 빨갛게 표시됨)
    for (let yy = 0; yy < plan.rows && !(await page.$$(".pk-cell.is-bad")).length; yy++) {
      for (let xx = 0; xx < plan.cols && !(await page.$$(".pk-cell.is-bad")).length; xx++) { await page.keyboard.press("ArrowRight"); }
      if (!(await page.$$(".pk-cell.is-bad")).length) { for (let xx = 0; xx < plan.cols; xx++) await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowDown"); }
    }
    assert((await page.$$(".pk-cell.is-bad")).length > 0, "a ghost overlapping a placed piece is shown in red");
    await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    assert((await miss()) === 1, "placing on an occupied cell is one mistake; the repeat during the lock is ignored");
    assert((await page.textContent(".mg-freeze-note")).length > 0, "a note explains why it failed");
    assert((await pkState())[4] === 1, "nothing was placed");
    await sleep(750);
    // 되돌리기: 마지막으로 놓은 조각이 다시 손에 들리고, 그 칸이 비워진다
    await page.keyboard.press("Backspace");
    assert((await pkState())[4] === 0, "undo takes the last piece back");
    assert((await page.$$(".pk-cell.is-fill")).length === 0, "the box is empty again");
    assert((await pkState())[0] === 0, "the undone piece is the one in hand");
    assert((await miss()) === 1, "undo is free");
    // 되돌린 뒤 정상적으로 끝까지 풀린다
    await solvePack();
    await waitFor(result, { label: "pack after undo done" });
    assert((await result()).mistakes === 1, "the single mistake is recorded in the result");
    log("pack: 이동은 상자 안으로 제한, 회전/조각 바꾸기(Tab) 자유, 겹치게 놓기 = 실수+잠금, 되돌리기(Backspace) 후 정상 클리어");
  }
  // 화면 버튼(터치용)과 트레이 조각 클릭
  await launch("pack", 1);
  {
    await page.dispatchEvent('.mg-key[data-pk="next"]', "pointerdown");
    assert((await pkState())[0] === 1, "on-screen 'next piece' button works");
    await page.dispatchEvent('.pk-piece[data-pi="2"]', "pointerdown");
    assert((await pkState())[0] === 2, "tapping a tray piece selects it");
    const r0 = (await pkState())[3];
    await page.dispatchEvent('.mg-key[data-pk="rotate"]', "pointerdown");
    assert((await pkState())[3] === (r0 + 1) % 4, "on-screen rotate works");
    await page.dispatchEvent('.mg-key[data-pk="right"]', "pointerdown");
    log("pack: 화면 버튼/트레이 터치로도 조작 가능");
  }

  // ================= 이상 확인 (벨트 분류) =================
  const INSPECT = [{ n: 6, bad: 2 }, { n: 9, bad: 3 }, { n: 11, bad: 4 }];
  const inspectSeq = async () => (await page.getAttribute(".mg-body", "data-seq")).split(",");
  for (let lv = 1; lv <= 3; lv++) {
    await launch("inspect", lv);
    const seq = await inspectSeq();
    assert(seq.length === INSPECT[lv - 1].n, `inspect L${lv} should queue ${INSPECT[lv - 1].n} packages, got ${seq.length}`);
    assert(seq.filter((a) => a === "space").length === INSPECT[lv - 1].bad, `inspect L${lv} should have ${INSPECT[lv - 1].bad} anomalies`);
    assert((await page.$$(".mg-pkg")).length === seq.length, "every queued package is rendered");
    if (lv === 2) await shot("inspect_L2_start");
    for (let i = 0; i < seq.length; i++) {
      await page.keyboard.press(KEY[seq[i]]);
      if (lv === 2 && i === 2) await shot("inspect_L2_mid");
    }
    await waitFor(result, { label: `inspect L${lv} done` });
    const r = await result();
    assert(r.ok && r.mistakes === 0, "inspect clean run: " + JSON.stringify(r));
    log(`inspect L${lv}: 택배 ${seq.length}개(이상 ${INSPECT[lv - 1].bad}개) 분류/폐기 클리어 (${r.ms}ms)`);
  }
  // 오입력: 실수 +1, 앞 택배는 그대로, 0.45초 잠금(그 사이 정답 키도 무시), 풀린 뒤엔 정상
  await launch("inspect", 2);
  {
    const seq = await inspectSeq();
    const wrong = ["left", "down", "right", "space"].find((a) => a !== seq[0]);
    await page.keyboard.press(KEY[wrong]);
    assert((await miss()) === 1, "wrong action counts as a mistake");
    await page.keyboard.press(KEY[seq[0]]); // 잠금 중
    assert((await page.textContent(".mg-found")) === "0", "the correct key during the lock must be ignored");
    await sleep(1000);
    await page.keyboard.press(KEY[seq[0]]);
    assert((await page.textContent(".mg-found")) === "1", "after the lock the correct key is accepted");
    for (let i = 1; i < seq.length; i++) await page.keyboard.press(KEY[seq[i]]);
    await waitFor(result, { label: "inspect after-lock done" });
    assert((await result()).mistakes === 1, "inspect mistakes recorded");
    log("inspect: 틀린 칸=실수+0.9초 잠금(그 사이 입력 무시), 풀리면 정상 진행");
  }
  // 이상한 택배를 분류 키로 보내거나 멀쩡한 택배를 폐기하면 둘 다 실수
  await launch("inspect", 3);
  {
    const seq = await inspectSeq();
    const iBad = seq.indexOf("space"), iOk = seq.findIndex((a) => a !== "space");
    let pos = 0, expectedMiss = 0;
    const advanceTo = async (target) => { while (pos < target) { await page.keyboard.press(KEY[seq[pos]]); pos++; } };
    const first = Math.min(iBad, iOk), second = Math.max(iBad, iOk);
    for (const t of [first, second]) {
      await advanceTo(t);
      const wrongKey = seq[t] === "space" ? "left" : "space";   // 이상한 택배엔 분류 키, 멀쩡한 택배엔 폐기 키
      await page.keyboard.press(KEY[wrongKey]);
      expectedMiss++;
      assert((await miss()) === expectedMiss, `mistake #${expectedMiss} (${seq[t] === "space" ? "classified an anomaly" : "discarded a good package"})`);
      await sleep(1000);
    }
    while (pos < seq.length) { await page.keyboard.press(KEY[seq[pos]]); pos++; }
    await waitFor(result, { label: "inspect mixed-mistake done" });
    assert((await result()).mistakes === 2, "both kinds of wrong action recorded");
    log("inspect: 이상한 택배를 분류 키로, 멀쩡한 택배를 폐기 키로 보내면 각각 실수");
  }
  // 터치/마우스용 칸 버튼도 같은 동작
  await launch("inspect", 1);
  {
    const seq = await inspectSeq();
    for (const a of seq) await page.dispatchEvent(`.mg-bin[data-a="${a}"]`, "pointerdown");
    await waitFor(result, { label: "inspect via on-screen buttons" });
    assert((await result()).mistakes === 0, "on-screen buttons work like the keys");
    log("inspect: 화면 버튼(포인터)으로도 클리어");
  }

  // ================= 송장 붙이기 (박스 찾아 붙이기) -- 키보드 전용 =================
  // 구성(박스 수/코드 중복 없음/송장이 정확히 한 박스와 맞음)을 레벨별로 확인하고, 마우스 끌기는 더 이상 동작하지 않음을 확인한다.
  // 키보드/패드 조작 자체는 아래 "송장 붙이기: 키보드" 블록에서 검사한다.
  async function stickerState() {
    return page.evaluate(() => {
      const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
      const l = document.querySelector('.mg-label[data-label]:not([data-stuck])');
      const boxes = Array.from(document.querySelectorAll(".mg-bx")).map((b) => ({
        code: b.querySelector(".bx-addr b").textContent, hole: !!b.querySelector(".bx-hole"), done: b.classList.contains("is-done"), r: rect(b),
        chips: Array.from(b.querySelectorAll(".bx-chip")).map((c) => c.textContent.trim()),
      }));
      return { l: l ? { r: rect(l), code: l.querySelector(".lb-room").textContent, want: parseInt(l.getAttribute("data-want"), 10), chips: Array.from(l.querySelectorAll(".bx-chip")).map((c) => c.textContent.trim()) } : null, boxes };
    });
  }
  async function drag(from, to, steps = 12) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps });
    await page.mouse.up();
  }
  const ctr = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const BOXES = [4, 7, 8], LABELS = [2, 4, 5];
  for (let lv = 1; lv <= 3; lv++) {
    await launch("sticker", lv);
    await page.evaluate(() => window.scrollTo(0, 0));
    const st0 = await stickerState();
    assert(st0.boxes.length === BOXES[lv - 1], `sticker L${lv}: ${BOXES[lv - 1]} boxes, got ${st0.boxes.length}`);
    assert(st0.boxes.every((b) => b.hole), `sticker L${lv}: every box has one hidden character in its code`);
    assert(st0.boxes.every((b) => b.chips.length === 2), "every box has a 취급 and a 층 slot (known or '?')");
    assert(st0.l.chips.length === 2 && !st0.l.chips.includes("?"), "the invoice shows all three facts");
    assert(JSON.parse(await page.getAttribute(".mg-body", "data-plan")).seq.length === LABELS[lv - 1], `sticker L${lv}: ${LABELS[lv - 1]} invoices`);
    if (lv >= 2) assert(st0.boxes.some((b) => b.chips.includes("?")), "from level 2 some boxes hide their 취급/층, so the code alone is not enough");
    assert((await page.$$(".mg-pad .mg-key")).length === 5, "on-screen pad (4 arrows + space) is shown");
    if (lv === 2) await shot("sticker_L2_start");
  }
  // 생성 보장 (여러 번 뽑아서): 송장과 보이는 정보가 전부 맞는 박스는 항상 정확히 하나, 레벨 3은 모든 송장에 "코드만 맞는" 함정 박스가 있다
  {
    const bad = await page.evaluate(() => {
      const out = { notUnique: 0, noTrap: 0, runs: 0 };
      for (const lv of [2, 3]) for (let i = 0; i < 40; i++) {
        const host = document.createElement("div"); document.body.appendChild(host);
        const ctl = MiniGames.start(host, { kind: "sticker", level: lv, testHooks: true, onDone() {}, onCancel() {} });
        const plan = JSON.parse(host.querySelector(".mg-body").dataset.plan);
        const boxes = Array.from(host.querySelectorAll(".mg-bx")).map((b) => ({
          code: b.querySelector(".bx-addr b").innerHTML.replace(/<u class="bx-hole"><\/u>/g, "?"), chips: Array.from(b.querySelectorAll(".bx-chip")).map((c) => c.textContent.trim()),
        }));
        const lab = host.querySelector(".mg-label"); const inv = { code: lab.querySelector(".lb-room").textContent, chips: Array.from(lab.querySelectorAll(".bx-chip")).map((c) => c.textContent.trim()) };
        const codeOk = (b) => b.code.split("").every((ch, j) => ch === "?" || ch === inv.code[j]);
        const full = boxes.filter((b) => codeOk(b) && b.chips.every((c, j) => c === "?" || c === inv.chips[j]));
        if (full.length !== 1) out.notUnique++;
        if (lv === 3 && boxes.filter(codeOk).length < 2) out.noTrap++; // 이 송장(첫 번째)에 코드만 맞는 박스가 따로 있어야 함
        out.runs++; ctl.destroy(); host.remove();
      }
      return out;
    });
    assert(bad.notUnique === 0, "the first invoice always matches exactly one box on everything that is visible: " + JSON.stringify(bad));
    assert(bad.noTrap === 0, "level 3 always has a code-only decoy for the first invoice: " + JSON.stringify(bad));
    log(`sticker: 80번 뽑아서 송장당 정답 박스 항상 1개, 레벨 3은 항상 코드만 맞는 함정 박스 있음 (${bad.runs}판)`);
  }
  // 마우스로 송장을 끌어다 맞는 박스 위에 놓아도 아무 일도 일어나지 않는다 (붙지도, 실수도 없음)
  await launch("sticker", 1);
  {
    await page.evaluate(() => window.scrollTo(0, 0));
    const st = await stickerState();
    const right = st.boxes[st.l.want];
    await drag(ctr(st.l.r), ctr(right.r));
    await sleep(200);
    assert((await page.$$('.mg-label[data-stuck]')).length === 0 && (await page.$$('.mg-bx.is-done')).length === 0, "dragging with the mouse no longer attaches anything");
    const st2 = await stickerState();
    assert(Math.abs(st2.l.r.x - st.l.r.x) < 2 && Math.abs(st2.l.r.y - st.l.r.y) < 2, "the label does not move when dragged");
    assert((await miss()) === 0, "mouse drag is not a mistake either, it is just ignored");
    // 화면 패드(터치용)로는 된다: 맞는 박스까지 →, 그다음 SPACE
    let g = 0;
    while ((await page.evaluate(() => Array.from(document.querySelectorAll(".mg-bx")).findIndex((b) => b.classList.contains("is-cursor")))) !== st.l.want) {
      await page.dispatchEvent('.mg-key[data-k="right"]', "pointerdown"); assert(++g < 50, "pad reaches the box");
    }
    await page.dispatchEvent('.mg-key[data-k="space"]', "pointerdown");
    await waitFor(async () => (await page.$$('.mg-bx.is-done')).length === 1, { label: "on-screen pad attaches the label" });
    log("sticker: 마우스 끌기는 무시(붙지도 실수도 없음), 화면 패드(터치) 버튼으로는 동작");
  }

  // ================= 송장 붙이기: 키보드 (2026-10-07) =================
  {
    const STK_N = [4, 7, 8], STK_K = [2, 4, 5];
    const cursorIdx = () => page.evaluate(() => Array.from(document.querySelectorAll(".mg-bx")).findIndex((b) => b.classList.contains("is-cursor")));
    // 송장이 가리키는 정답 박스 번호 (테스트 훅 data-want). 송장이 아직 안 나왔으면 null.
    const labelWant = () => page.evaluate(() => { const l = document.querySelector(".mg-label[data-label]:not([data-stuck])"); return l ? parseInt(l.getAttribute("data-want"), 10) : null; });
    // DOM에 보이는 정보만으로 "송장과 보이는 부분이 전부 맞는 박스"를 센다 -- 재설계(2026-10-07)의 핵심 보장: 항상 정확히 하나.
    const compatBoxes = () => page.evaluate(() => {
      const l = document.querySelector(".mg-label[data-label]:not([data-stuck])"); if (!l) return null;
      const txt = (n) => n.textContent.trim();
      const invCode = txt(l.querySelector(".lb-room")), chips = Array.from(l.querySelectorAll(".bx-chip")).map(txt);
      return Array.from(document.querySelectorAll(".mg-bx")).map((b, i) => {
        const html = b.querySelector(".bx-addr b").innerHTML, bc = html.replace(/<u class="bx-hole"><\/u>/g, "?");
        const bchips = Array.from(b.querySelectorAll(".bx-chip")).map(txt);
        let ok = bc.length === invCode.length;
        for (let j = 0; j < invCode.length && ok; j++) if (bc[j] !== "?" && bc[j] !== invCode[j]) ok = false;
        if (bchips[0] !== "?" && bchips[0] !== chips[0]) ok = false;
        if (bchips[1] !== "?" && bchips[1] !== chips[1]) ok = false;
        return ok && !b.classList.contains("is-done") ? i : -1;
      }).filter((i) => i >= 0);
    });
    for (let lv = 1; lv <= 3; lv++) {
      await launch("sticker", lv);
      assert((await cursorIdx()) === 0, "keyboard cursor starts on the first box");
      let guard = 0;
      for (let done = 0; done < STK_K[lv - 1]; done++) {
        await waitFor(async () => (await labelWant()) !== null, { label: "label ready" });
        const want = await labelWant(), cand = await compatBoxes();
        assert(cand.length === 1 && cand[0] === want, `exactly one box matches everything that is visible (got ${JSON.stringify(cand)}, want ${want})`);
        // 목표 박스까지 ←→ 로 이동 (한 바퀴 안에 반드시 도착)
        while ((await cursorIdx()) !== want) { await page.keyboard.press("ArrowRight"); assert(++guard < 200, "cursor should reach the matching box"); }
        await page.keyboard.press("Space");
        await waitFor(async () => (await page.$$(".mg-bx.is-done")).length === done + 1, { label: "box accepts the label by keyboard" });
        if (done + 1 < STK_K[lv - 1]) assert(!(await page.$$eval(".mg-bx.is-done", (els) => els.some((e) => e.classList.contains("is-cursor")))), "cursor skips boxes that already have a label");
      }
      await waitFor(result, { label: `sticker keyboard L${lv} done` });
      const r = await result();
      assert(r.ok && r.kind === "sticker" && r.mistakes === 0, "sticker keyboard clean run: " + JSON.stringify(r));
      log(`sticker L${lv}: 키보드(←→ 박스 고르기 + 스페이스)만으로 송장 ${STK_K[lv - 1]}장 클리어 (실수 0)`);
    }
    // ←→ 는 한 바퀴 돌고, ↑↓ 는 윗줄/아랫줄로 간다 (8개 = 4개+4개 두 줄)
    await launch("sticker", 3);
    await page.keyboard.press("ArrowLeft");
    assert((await cursorIdx()) === 7, "ArrowLeft from the first box wraps to the last");
    await page.keyboard.press("ArrowRight");
    assert((await cursorIdx()) === 0, "ArrowRight wraps back to the first");
    await page.keyboard.press("ArrowDown");
    assert((await cursorIdx()) >= 4, "ArrowDown moves to the second row, got " + (await cursorIdx()));
    await page.keyboard.press("ArrowUp");
    assert((await cursorIdx()) < 4, "ArrowUp moves back to the first row, got " + (await cursorIdx()));
    await page.keyboard.press("ArrowUp");
    assert((await cursorIdx()) < 4, "ArrowUp on the first row stays put");
    // 틀린 박스에 스페이스 = 실수 +1 + 잠깐 멈춤(연타는 또 세지 않음), 송장은 그대로, 이후 맞는 박스엔 붙는다
    const wantW = await labelWant();
    while ((await cursorIdx()) === wantW) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space"); await page.keyboard.press("Space");
    assert((await miss()) === 1, "wrong box by keyboard = 1 mistake (the second press during the lock is ignored)");
    assert((await page.$$(".mg-bx.is-done")).length === 0, "nothing is stuck on a wrong box");
    await sleep(1000);
    while ((await cursorIdx()) !== wantW) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await waitFor(async () => (await page.$$(".mg-bx.is-done")).length === 1, { label: "correct box after the lock" });
    assert((await miss()) === 1, "a correct attach adds no mistake");
    log("sticker 키보드: ←→ 한 바퀴/↑↓ 줄 이동, 틀린 박스 = 실수 + 0.9초 멈춤(연타 무시), 이후 맞는 박스엔 붙음");
  }

  // ================= 지도 배달 (2026-10-07, 귀중품) =================
  // 흐름: 송장 단계(지도 가려짐, 송장만 붙은 택배가 팝업으로 뜬다) -> 지도 단계(택배 사라짐, 호실 번호가 적힌 집을 찾아 순서대로 배달)
  //       시작 20초 뒤부터 "송장 다시 보기"(공짜)가 열린다
  const MAPCFG = [
    { cols: 5, rows: 4, houses: 8,  targets: 2, flash: 4500, similar: 0, blocks: 0 },
    { cols: 6, rows: 4, houses: 11, targets: 3, flash: 3000, similar: 4, blocks: 2 },
    { cols: 7, rows: 5, houses: 14, targets: 4, flash: 2500, similar: 6, blocks: 6 },
  ];
  assert(await page.evaluate(() => MiniGames.MAP_REPLAY_AFTER_MS) === 20000, "map replay unlocks 20 seconds after the game starts");
  const DIRV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const mapInfo = () => page.evaluate(() => {
    const b = document.querySelector(".mg-body");
    const P = (s) => (s ? s.split(";").filter(Boolean).map((t) => t.split(",").map(Number)) : []);
    return { grid: b.dataset.grid.split(",").map(Number), depot: b.dataset.depot.split(",").map(Number), blocked: P(b.dataset.blocked), targets: P(b.dataset.targets) };
  });
  const courierAt = () => page.evaluate(() => { const c = document.querySelector(".mg-courier"); return [c.style.getPropertyValue("--cx"), c.style.getPropertyValue("--cy")].map(Number); });
  const invoiceNums = () => page.$$eval(".mg-cover .mg-parcel", (els) => els.map((e) => ({ n: e.querySelector(".pn").textContent, room: e.querySelector(".pl").textContent.replace("호", ""), done: e.classList.contains("is-done") })));
  const labelAt = (x, y) => page.evaluate(([x, y]) => { const l = document.querySelector(`.mg-tile[data-x="${x}"][data-y="${y}"] .mg-lab`); return l ? l.textContent : null; }, [x, y]);
  function bfsDirs(info, from, to) {
    const [W, H] = info.grid, bl = new Set(info.blocked.map((b) => b.join(",")));
    const prev = new Map([[from.join(","), null]]); const q = [from];
    while (q.length) {
      const p = q.shift();
      if (p[0] === to[0] && p[1] === to[1]) break;
      for (const d of Object.keys(DIRV)) {
        const n = [p[0] + DIRV[d][0], p[1] + DIRV[d][1]], k = n.join(",");
        if (n[0] < 0 || n[1] < 0 || n[0] >= W || n[1] >= H || bl.has(k) || prev.has(k)) continue;
        prev.set(k, { from: p, d }); q.push(n);
      }
    }
    const dirs = []; let cur = to.join(",");
    if (!prev.has(cur)) return null;
    while (prev.get(cur)) { const s = prev.get(cur); dirs.unshift(s.d); cur = s.from.join(","); }
    return dirs;
  }
  async function walkTo(info, from, to) {
    const dirs = bfsDirs(info, from, to);
    assert(dirs, `target ${to} must be reachable from ${from}`);
    for (const d of dirs) { await page.keyboard.press(KEY[d]); await sleep(85); } // 한 칸 최소 간격(70ms)보다 천천히
    const at = await courierAt();
    assert(at[0] === to[0] && at[1] === to[1], `courier should be at ${to}, got ${at}`);
  }
  const waitMapShown = () => waitFor(async () => (await page.$$(".mg-map.is-covered")).length === 0, { timeout: 7000, label: "map appears" });

  for (let lv = 1; lv <= 3; lv++) {
    const cfg = MAPCFG[lv - 1];
    await launch("map", lv);
    const info = await mapInfo();
    assert(info.grid[0] === cfg.cols && info.grid[1] === cfg.rows, `map L${lv} grid ${cfg.cols}x${cfg.rows}, got ${info.grid}`);
    assert(info.targets.length === cfg.targets, `map L${lv} should have ${cfg.targets} targets`);
    assert((await page.$$(".mg-tile.is-house")).length === cfg.houses, `map L${lv} should have ${cfg.houses} houses`);
    assert(info.blocked.length === cfg.blocks && (await page.$$(".mg-tile.is-block")).length === cfg.blocks, `map L${lv} should have ${cfg.blocks} blocked tiles`);
    const labels = await page.$$eval(".mg-lab", (els) => els.map((e) => e.textContent));
    assert(new Set(labels).size === labels.length && labels.every((t) => /^[1-5]0[1-9]$/.test(t)), "house labels are unique 3-digit room numbers: " + labels);
    for (const t of info.targets) assert(bfsDirs(info, info.depot, t), `target ${t} reachable (blocked tiles must never cut a house off)`);
    // 송장 단계: 지도는 가려져 있고(안 보임), 호실 번호가 순서(1..N)와 함께 목록으로만 뜬다
    assert((await page.$$(".mg-map.is-covered")).length === 1, "the map is covered while the parcels pop up");
    assert(await page.$eval(".mg-cover", (e) => getComputedStyle(e).display !== "none"), "the cover is actually displayed");
    const inv = await invoiceNums();
    assert(inv.length === cfg.targets && inv.every((v, i) => v.n === String(i + 1) && /^[1-5]0[1-9]$/.test(v.room) && !v.done), "N parcels with only a room number are shown in order: " + JSON.stringify(inv));
    assert((await page.$$(".mg-cover .mg-parcel .pbox")).length === cfg.targets, "each parcel is a box carrying just the invoice");
    assert(await page.$eval(".mg-replay", (e) => e.disabled && /초 뒤/.test(e.textContent)), "replay is locked at the start and shows a countdown");
    for (let i = 0; i < info.targets.length; i++) assert((await labelAt(...info.targets[i])) === inv[i].room, `target ${i + 1} house carries invoice room ${inv[i].room}`);
    assert((await page.$$(".mg-tile.is-target")).length === 0, "no target is highlighted on the map (you must find the houses yourself)");
    // 송장 단계의 키 입력은 무시된다
    await page.keyboard.press("ArrowUp"); await page.keyboard.press("Space");
    const c0 = await courierAt();
    assert(c0[0] === info.depot[0] && c0[1] === info.depot[1] && (await miss()) === 0, "keys are ignored while the invoices are showing (no move, no mistake)");
    if (lv === 2) { await sleep(900); await shot("map_L2_invoice"); }
    // 비슷한 번호 미끼: 목표와 같은 층 또는 같은 호를 가진 미끼 집이 설정한 수 이상
    const targetRooms = new Set(inv.map((v) => v.room));
    const decoys = labels.filter((t) => !targetRooms.has(t));
    const similarCount = decoys.filter((t) => inv.some((v) => v.room[0] === t[0] || v.room[2] === t[2])).length;
    const guaranteed = Math.min(cfg.similar, cfg.targets); // 생성기는 목표 하나당 비슷한 미끼를 최대 하나씩만 보장한다(나머지는 우연)
    assert(similarCount >= guaranteed, `map L${lv}: at least ${guaranteed} decoys look like a target (same floor or same room), got ${similarCount}`);
    await waitMapShown();
    assert(await page.$eval(".mg-cover", (e) => getComputedStyle(e).display === "none"), "the parcels disappear once the map shows");
    assert(await page.$eval(".mg-tile.is-house .mg-lab", (e) => getComputedStyle(e).visibility !== "hidden"), "house numbers stay visible on the map");
    if (lv === 2) await shot("map_L2_map");
    if (lv === 3) await shot("map_L3_map");
    // 순서대로 배달
    let at = info.depot;
    for (let i = 0; i < info.targets.length; i++) {
      assert(!(await result()), "must not finish before the last delivery");
      await walkTo(info, at, info.targets[i]);
      at = info.targets[i];
      await page.keyboard.press("Space");
      await sleep(60);
      assert((await page.$$(".mg-tile.is-delivered")).length === i + 1, `delivery ${i + 1} confirmed on the map`);
      assert((await page.$$(".mg-dot.is-done")).length === i + 1, "progress dots follow");
    }
    await waitFor(result, { label: `map L${lv} done` });
    const r = await result();
    assert(r.ok && r.kind === "map" && r.level === lv && r.mistakes === 0, "map clean run: " + JSON.stringify(r));
    log(`map L${lv}: ${cfg.cols}x${cfg.rows} 지도, 집 ${cfg.houses}(비슷한 번호 미끼 ${similarCount}), 송장 ${cfg.targets}장, 공사장 ${cfg.blocks} -- 택배 팝업 후 지도가 뜨고 클리어 (${r.ms}ms, 실수 0)`);
  }

  // 오배달 / 송장 다시 보기(20초 뒤 해금, 공짜) / 막힌 칸
  {
    await launch("map", 1, null, { replayAfterMs: 12000 });
    const info = await mapInfo();
    await waitMapShown();
    assert(await page.$eval(".mg-replay", (e) => e.disabled && /초 뒤/.test(e.textContent)), "replay is still locked right after the map shows");
    await page.click(".mg-replay", { force: true }).catch(() => {});
    assert((await page.$$(".mg-map.is-covered")).length === 0, "clicking a locked replay does nothing");
    // (1) 도로(센터)에서 스페이스 = 실수 + 멈춤, 멈춰 있는 동안의 연타는 또 세지 않는다
    await page.keyboard.press("Space"); await page.keyboard.press("Space");
    assert((await miss()) === 1, "Space on a road tile is one mistake; the repeat during the lock does not count again");
    assert((await page.textContent(".mg-freeze-note")).length > 0, "a lock note is shown");
    await sleep(900);
    // (2) 엉뚱한 집(송장에 없는 호실)에서 스페이스 = 실수
    const targetKeys = new Set(info.targets.map((t) => t.join(",")));
    const other = await page.$$eval(".mg-tile.is-house", (els) => els.map((e) => [+e.dataset.x, +e.dataset.y]));
    const wrongHouse = other.find((h) => !targetKeys.has(h.join(",")));
    await walkTo(info, info.depot, wrongHouse);
    await page.keyboard.press("Space");
    assert((await miss()) === 2, "Space on a house that is not on the invoice is a mistake");
    assert((await page.$$(".mg-tile.is-delivered")).length === 0, "...and nothing is delivered");
    await sleep(900);
    // (3) 두 번째 호실을 먼저 가서 배달 시도 = 순서 틀림 = 실수
    await walkTo(info, wrongHouse, info.targets[1]);
    await page.keyboard.press("Space");
    assert((await miss()) === 3, "delivering to the 2nd invoice room first is a mistake (order matters)");
    await sleep(900);
    // (4) 20초(테스트에선 12초) 전에는 송장 다시 보기가 잠겨 있다 -> 해금 후 첫 호실 배달 -> 다시 보기(공짜)
    await walkTo(info, info.targets[1], info.targets[0]);
    await page.keyboard.press("Space");
    await sleep(60);
    assert((await page.$$(".mg-tile.is-delivered")).length === 1, "first target delivered");
    await waitFor(() => page.$eval(".mg-replay", (e) => !e.disabled && e.textContent === "송장 다시 보기"), { timeout: 12000, label: "replay unlocks" });
    await page.click(".mg-replay");
    assert((await miss()) === 3, "replay is free (no extra mistake)");
    assert((await page.$$(".mg-map.is-covered")).length === 1, "the map is covered again while the parcels replay");
    const inv2 = await invoiceNums();
    assert(inv2.length === info.targets.length && inv2[0].done && !inv2[1].done && inv2.every((v, i) => v.n === String(i + 1)), "replay shows every parcel in the original order, delivered ones marked: " + JSON.stringify(inv2));
    assert(await page.$eval(".mg-replay", (e) => e.disabled), "replay button is disabled while the parcels show");
    await page.keyboard.press("ArrowUp");
    const cc = await courierAt();
    assert(cc[0] === info.targets[0][0] && cc[1] === info.targets[0][1], "the courier does not move while the map is covered");
    await waitMapShown();
    // 다시 본 뒤 나머지를 순서대로 -> 완료
    let at = info.targets[0];
    for (let i = 1; i < info.targets.length; i++) { await walkTo(info, at, info.targets[i]); at = info.targets[i]; await page.keyboard.press("Space"); await sleep(60); }
    await waitFor(result, { label: "map done after mistakes" });
    assert((await result()).mistakes === 3, "final result carries the 3 mistakes");
    log("map: 도로/송장에 없는 집/순서 틀린 집에서 배달 = 실수 + 0.8초 멈춤(연타 무시), 송장 다시 보기는 시작 후 일정 시간(실게임 20초) 뒤에 열리고 공짜, 지도를 다시 가리고 전체 택배를 원래 번호로 재표시(배달한 건 체크)");
  }
  {
    await launch("map", 3);
    const info = await mapInfo();
    await waitMapShown();
    // 막힌 칸(공사장)은 들어갈 수 없다: 도달 가능한 칸 중 공사장과 인접한 곳으로 가서 그쪽으로 밀어 본다
    const bl = new Set(info.blocked.map((b) => b.join(",")));
    let probe = null;
    for (const b of info.blocked) for (const d of Object.keys(DIRV)) {
      const r = [b[0] - DIRV[d][0], b[1] - DIRV[d][1]];
      if (r[0] < 0 || r[1] < 0 || r[0] >= info.grid[0] || r[1] >= info.grid[1] || bl.has(r.join(","))) continue;
      if (bfsDirs(info, info.depot, r)) { probe = { r, d }; break; }
    }
    assert(probe, "there is a reachable tile next to a blocked tile");
    await walkTo(info, info.depot, probe.r);
    await page.keyboard.press(KEY[probe.d]); await sleep(120);
    const after = await courierAt();
    assert(after[0] === probe.r[0] && after[1] === probe.r[1], "courier cannot enter a blocked tile");
    assert((await miss()) === 0, "bumping a wall/blocked tile is not a mistake");
    log("map L3: 공사장 칸은 들어갈 수 없고(실수 아님), 모든 집은 공사장에 안 막히고 갈 수 있음");
  }

  // ================= destroy 정리 =================
  await launch("pack", 1);
  await page.evaluate(() => { window.__ctl.destroy(); window.__ctl = null; });
  assert((await page.$$(".mg-root")).length === 0, "destroy() removes the game from the DOM");
  await page.keyboard.press("ArrowUp"); await page.keyboard.press("Space"); // 리스너가 남아 있으면 에러/오동작
  log("destroy(): DOM 제거 + 이후 키 입력에 반응 없음 (리스너 정리됨)");

  // ================= 시험장 UI 전체 흐름 (실제 버튼) =================
  await page.goto(URL + "?mgtest=1");
  await page.click('button[data-kind="pack"][data-lv="1"]');
  await page.click('button[data-go="pack"]');
  await waitFor(async () => (await page.$$(".mg-root")).length === 1, { label: "game opened from the UI" });
  await solvePack();
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
