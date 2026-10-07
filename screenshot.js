"use strict";
const { chromium } = require("playwright");
const path = require("path");

const BASE = "http://localhost:3000";
const OUT = "/tmp/shots";
require("fs").mkdirSync(OUT, { recursive: true });

async function clickSel(page, selector) {
  return page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; }, selector);
}
async function pressSpace(page) {
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true })));
}
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
  await p1.screenshot({ path: path.join(OUT, "1_seat_picker.png") });

  await clickSel(p1, '[data-action="pick-seat"][data-seat="1"]');
  await clickSel(p2, '[data-action="pick-seat"][data-seat="2"]');
  await waitFor(async () => (await bodyText(p1)).includes("좌석 · 플레이어 1"), { label: "p1 seat" });
  await waitFor(async () => (await bodyText(p1)).includes("스페이스바"), { label: "lobby" });
  await p1.screenshot({ path: path.join(OUT, "2_lobby.png") });

  await pressSpace(p1);
  await waitFor(async () => (await bodyText(p1)).includes("준비 완료"), { label: "p1 ready" });
  await p1.screenshot({ path: path.join(OUT, "3_lobby_one_ready.png") });
  await pressSpace(p2);
  await waitFor(async () => (await bodyText(p1)).includes("택배 확보"), { label: "secure phase" });
  await p1.screenshot({ path: path.join(OUT, "4_secure_phase.png") });

  // open a puzzle overlay
  await clickSel(p1, '[data-action="open-cell"][data-cell="fresh-1"]');
  await waitFor(async () => (await p1.locator(".overlay:not(.hidden)").count()) > 0, { label: "puzzle overlay" });
  await p1.screenshot({ path: path.join(OUT, "5_puzzle_overlay.png") });
  await clickSel(p1, '[data-action="complete-cell"]');
  await p1.waitForTimeout(300);

  await waitFor(async () => (await bodyText(p1)).includes("엘리베이터"), { label: "elevator phase", timeout: 25000 });
  await clickSel(p1, '[data-action="vote-up"]');
  await clickSel(p2, '[data-action="vote-up"]');
  await clickSel(p2, '[data-action="vote-up"]');
  await p1.waitForTimeout(400);
  await p1.screenshot({ path: path.join(OUT, "6_elevator_live_votes.png") });

  // disconnect banner: intercept the ws endpoint (plain page.route doesn't catch WS traffic --
  // routeWebSocket is the dedicated API), then reload p2 so its fresh connection attempt fails
  // outright, reliably firing onclose/onerror -> banner
  await ctx2.routeWebSocket("**/ws*", (ws) => { ws.close(); });
  await p2.reload();
  await waitFor(async () => (await p2.locator("#conn-banner").count()) > 0, { label: "disconnect banner", timeout: 15000 });
  await p2.screenshot({ path: path.join(OUT, "7_disconnect_banner.png") });
  await ctx2.unrouteAll();

  // let the game play out quickly to reach the end screen
  for (let round = 0; round < 5; round++) {
    await clickSel(p1, '[data-action="vote-up"]').catch(() => {});
    await p1.waitForTimeout(5300);
  }
  await waitFor(async () => (await bodyText(p1)).includes("총점"), { label: "end screen", timeout: 10000 });
  await p1.screenshot({ path: path.join(OUT, "8_end_screen.png"), fullPage: true });

  await browser.close();
  console.log("screenshots saved to", OUT);
}

main().catch((e) => { console.error("FAILED", e); process.exit(1); });
