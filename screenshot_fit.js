"use strict";
const { chromium } = require("playwright");
const path = require("path");
const OUT = "/tmp/shots_fit";
require("fs").mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:3000";

async function clickSel(page, selector) { return page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; }, selector); }
async function pressSpace(page) { await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }))); }
async function bodyText(page) { return page.evaluate(() => document.body.innerText); }
async function waitFor(fn, { timeout = 15000, interval = 150, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - start > timeout) throw new Error("timeout: " + label); await new Promise((r) => setTimeout(r, interval)); }
}

// common laptop logical viewport sizes (after subtracting typical browser chrome from the OS
// resolution) -- 1366x768 and 1280x800 are the most common Windows laptop panels; 1440x818 and
// 1280x760 approximate what's actually left for page content once the browser UI is subtracted.
const VIEWPORTS = [
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1280x760", width: 1280, height: 760 },
  { name: "1440x818", width: 1440, height: 818 },
  // more aggressive: realistic real-world usable height after a laptop's OS taskbar + full
  // browser chrome (tabs, bookmarks bar, extensions) eat into a 768-900px physical panel
  { name: "1280x650", width: 1280, height: 650 },
  { name: "1366x600", width: 1366, height: 600 },
  { name: "1920x550", width: 1920, height: 550 },
];

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const http = require("http");
  async function freshRoomUrl() {
    const room = await new Promise((resolve, reject) => {
      http.get(BASE + "/", (res) => resolve(new URL(res.headers.location, BASE).searchParams.get("room"))).on("error", reject);
    });
    return BASE + "/?room=" + room;
  }

  for (const vp of VIEWPORTS) {
    const roomUrl = await freshRoomUrl(); // a fresh room per viewport -- otherwise the 2nd/3rd
    // iteration tries to re-pick seats already owned by the 1st iteration's (closed) contexts
    const ctx1 = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const ctx2 = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
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

    // secure one cell so we can see the bigger invoice-label sticker in the same shot
    await clickSel(p1, '[data-action="open-cell"][data-cell="fresh-2"]');
    await waitFor(async () => (await p1.locator(".overlay:not(.hidden)").count()) > 0, { label: "overlay" });
    await clickSel(p1, '[data-action="complete-cell"]');
    await p1.waitForTimeout(200);

    const fit = await p1.evaluate(() => ({
      docHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      needsScroll: document.documentElement.scrollHeight > window.innerHeight,
    }));
    console.log(`[fit] ${vp.name}: doc=${fit.docHeight}px viewport=${fit.viewportHeight}px needsScroll=${fit.needsScroll}`);

    await p1.screenshot({ path: path.join(OUT, `secure_${vp.name}.png`) });
    await ctx1.close();
    await ctx2.close();
  }

  await browser.close();
}

main().catch((e) => { console.error("FAILED", e); process.exit(1); });
