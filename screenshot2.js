"use strict";
const { chromium } = require("playwright");
const path = require("path");
const OUT = "/tmp/shots2";
require("fs").mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:3000";

async function clickSel(page, selector) { return page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; }, selector); }
async function pressSpace(page) { await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }))); }
async function bodyText(page) { return page.evaluate(() => document.body.innerText); }
async function waitFor(fn, { timeout = 15000, interval = 150, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - start > timeout) throw new Error("timeout: " + label); await new Promise((r) => setTimeout(r, interval)); }
}

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const http = require("http");
  const room = await new Promise((resolve, reject) => {
    http.get(BASE + "/", (res) => resolve(new URL(res.headers.location, BASE).searchParams.get("room"))).on("error", reject);
  });
  const roomUrl = BASE + "/?room=" + room;

  const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();
  await p1.goto(roomUrl);
  await p2.goto(roomUrl);
  await waitFor(async () => (await p1.locator(".seat-pick").count()) > 0, { label: "seat picker" });

  await clickSel(p1, '[data-action="pick-seat"][data-seat="1"]');
  await clickSel(p2, '[data-action="pick-seat"][data-seat="2"]');
  await waitFor(async () => (await bodyText(p1)).includes("좌석 · 플레이어 1"), { label: "p1 seat" });
  await pressSpace(p1);
  await pressSpace(p2);
  await waitFor(async () => (await bodyText(p1)).includes("택배 확보"), { label: "secure phase" });

  // secure one cell so the board shows both a taken box and open boxes side by side
  await clickSel(p1, '[data-action="open-cell"][data-cell="fresh-2"]');
  await waitFor(async () => (await p1.locator(".overlay:not(.hidden)").count()) > 0, { label: "overlay" });
  await clickSel(p1, '[data-action="complete-cell"]');
  await p1.waitForTimeout(200);
  await p1.screenshot({ path: path.join(OUT, "1_board_boxes.png") });
  // zoomed crop-ish shot via clip on the board card area
  await p1.locator(".board-grid").screenshot({ path: path.join(OUT, "2_board_boxes_closeup.png") });

  // secure a couple more so there's something to deliver in round 1 (target floor 1F, start floor is 1F,
  // so anything with floorIdx===1 delivers in round 1 automatically without needing to move)
  async function secureUntilFloor1(p, seatLabel) {
    // keep trying cells until we get an invoice landing on 1F (floorIdx 1) -- random, so just secure a few
    for (const id of ["normal-2", "normal-3", "fragile-2", "valuable-2"]) {
      const sel = `[data-action="open-cell"][data-cell="${id}"]`;
      if (await p.locator(sel).count()) {
        await clickSel(p, sel);
        await p.waitForTimeout(150);
        if (await p.locator('[data-action="complete-cell"]').count()) await clickSel(p, '[data-action="complete-cell"]');
        await p.waitForTimeout(150);
      }
    }
  }
  await secureUntilFloor1(p1, "p1");
  await secureUntilFloor1(p2, "p2");

  await waitFor(async () => (await bodyText(p1)).includes("엘리베이터"), { label: "elevator phase", timeout: 15000 });

  // pre-round-1 ready gate: nothing has been voted on yet, so this must show the idle ready-row,
  // not vote buttons
  await p1.waitForTimeout(200);
  await p1.screenshot({ path: path.join(OUT, "0_elevator_idle_ready_gate.png") });
  await pressSpace(p1);
  await pressSpace(p2);
  await waitFor(async () => (await p1.locator('[data-action="vote-up"]').count()) > 0, { label: "round 1 voting starts" });

  // round 1: vote, then wait for result screen (which may or may not show a delivered item,
  // depending on random floor assignment -- either way the callout section should render)
  await clickSel(p1, '[data-action="vote-up"]');
  await clickSel(p2, '[data-action="vote-up"]');
  await p1.screenshot({ path: path.join(OUT, "3_elevator_voting_own_count_only.png") });

  await waitFor(async () => (await bodyText(p1)).includes("라운드 1 결과"), { label: "round 1 result", timeout: 8000 });
  await p1.waitForTimeout(200);
  await p1.screenshot({ path: path.join(OUT, "4_elevator_result_ready_gate.png") });

  await pressSpace(p1);
  await p1.waitForTimeout(200);
  await p1.screenshot({ path: path.join(OUT, "5_elevator_result_p1_ready_waiting_p2.png") });

  // play out the rest of the rounds so we can screenshot the end screen -- both players' full
  // itemized lists should be visible there again (per the latest request)
  await pressSpace(p2);
  for (let round = 2; round <= 5; round++) {
    await waitFor(async () => (await p1.locator('[data-action="vote-up"]:not([disabled])').count()) > 0, { label: `round ${round} voting starts` });
    await clickSel(p1, '[data-action="vote-up"]');
    await clickSel(p2, '[data-action="vote-up"]');
    await waitFor(async () => (await bodyText(p1)).includes(`라운드 ${round} 결과`), { label: `round ${round} result`, timeout: 8000 });
    await pressSpace(p1);
    await pressSpace(p2);
  }
  await waitFor(async () => (await bodyText(p1)).includes("총점"), { label: "end screen", timeout: 10000 });
  await p1.waitForTimeout(200);
  await p1.screenshot({ path: path.join(OUT, "6_end_screen_both_lists_visible.png"), fullPage: true });

  await browser.close();
  console.log("saved to", OUT);
}

main().catch((e) => { console.error("FAILED", e); process.exit(1); });
