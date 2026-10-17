// Loads the unpacked extension into Chromium and checks the tab commands that go through background.js.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EXT = path.join(__dirname, '../extension');
const page = (title) => `<!doctype html><title>${title}</title><body style="height:3000px">
<a href="http://t.test/c" id="lc">to C</a></body>`;
let fails = 0;
const eq = (a, b, msg) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', msg, ok ? '' : `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return v; };
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromevim-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await ctx.route('http://t.test/**', (r) => r.fulfill({ contentType: 'text/html', body: page(r.request().url().slice(-1).toUpperCase()) }));
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  eq(/^chrome-extension:\/\//.test(sw.url()), true, 'service worker running');
  const active = () => sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].title);
  const titles = () => sw.evaluate(async () => (await chrome.tabs.query({ currentWindow: true })).sort((a, b) => a.index - b.index).map((t) => t.title));

  const a = ctx.pages()[0];
  await a.goto('http://t.test/a');
  const b = await ctx.newPage();
  await b.goto('http://t.test/b');
  // Content scripts live in an isolated world, so check for their effect: j scrolls the page.
  await b.keyboard.press('j');
  eq(await until(() => b.evaluate(() => scrollY)), 70, 'content script injected (j scrolls)');
  for (const p of [a, b]) p.on('pageerror', (e) => { fails++; console.log('PAGEERROR', e.message); });
  const close = (ts) => ts.filter((t) => t !== 'about:blank');

  // J / K switch tabs
  await a.bringToFront();
  await a.keyboard.press('K');
  eq(await until(async () => (await active()) === 'B' && 'B'), 'B', 'K -> next tab');
  await b.keyboard.press('K');
  eq(await until(async () => (await active()) === 'A' && 'A'), 'A', 'K wraps to first tab');
  await a.keyboard.press('J');
  eq(await until(async () => (await active()) === 'B' && 'B'), 'B', 'J -> previous tab');

  // t lists tabs; typing a label activates it
  await b.keyboard.press('t');
  await b.waitForTimeout(300);
  await b.keyboard.press('a');
  eq(await until(async () => (await active()) === 'A' && 'A'), 'A', 't + label switches tab');

  // F opens a link in a background tab next to the current one
  await a.keyboard.press('F');
  await a.keyboard.press('a');
  eq(await until(async () => close(await titles()).length === 3 && close(await titles())), ['A', 'C', 'B'], 'F opens link in new tab after current');
  eq(await active(), 'A', 'F keeps current tab active');

  // x closes the current tab
  await a.keyboard.press('x');
  eq(await until(async () => close(await titles()).length === 2 && close(await titles())), ['C', 'B'], 'x closes tab');

  // yy copies the URL
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await b.bringToFront();
  await b.keyboard.press('y');
  await b.keyboard.press('y');
  eq(await until(() => b.evaluate(() => navigator.clipboard.readText().catch(() => ''))), 'http://t.test/b', 'yy copies URL');

  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILURES` : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
