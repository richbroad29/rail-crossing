'use strict';
// Frame-time measurement with ~1,500 synthetic trains, animation forced on. Prints the browser's own
// requestAnimationFrame cadence and the page's JS time per frame at four views, then again with the
// CPU throttled 4x. NOTE: rAF cadence and JS time do not measure GPU time directly; the headless
// browser here uses the machine's real GPU.
const L = require('./lib.js');

async function measure(page, name, c, z) {
  if (c === 'train') c = await page.evaluate(() => { let p = null; RM.debug.store.forEach((r) => { if (!p && r.svc) p = [r.cx, r.cy]; }); return p; });
  await page.evaluate(([c, z]) => RM.debug.map.jumpTo({ center: c, zoom: z }), [c, z]);
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    RM.debug.keepAnimating = true; RM.debug.reset(); RM.debug.map.jumpTo({}); window.__raf = []; window.__run = true;
    const loop = (t) => { if (!window.__run) return; window.__raf.push(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  await page.waitForTimeout(8000);
  const r = await page.evaluate(() => {
    window.__run = false; RM.debug.keepAnimating = false;
    const a = window.__raf, d = []; for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]);
    d.sort((x, y) => x - y);
    const q = (p) => +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1);
    const sm = RM.debug.summary();
    return { fps: +(a.length / ((a[a.length - 1] - a[0]) / 1000)).toFixed(1), gap: [q(0.5), q(0.95), q(1)], js: [sm.jsMs.p50, sm.jsMs.p95, sm.jsMs.max].map((v) => +v.toFixed(2)), fill: [sm.fillMs.p50, sm.fillMs.p95, sm.fillMs.max].map((v) => +v.toFixed(2)), trains: sm.trains, tracked: (() => { let n = 0; RM.debug.store.forEach((r) => { if (r.mode === 'track') n++; }); return n; })() };
  });
  console.log(name.padEnd(34), r.fps + ' fps', ' frame gap p50/p95/max ' + r.gap.join('/') + ' ms', ' JS p50/p95/max ' + r.js.join('/') + ' ms', ' of which store.fill (motion engine) p50/p95/max ' + r.fill.join('/') + ' ms', ' trains ' + r.trains + ' (' + r.tracked + ' on the track)');
  return r;
}

module.exports = async function perf(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(L.PAGE);
  await page.waitForFunction(() => window.RM && RM.debug && RM.debug.store && RM.debug.store.size > 100, null, { timeout: 30000 });
  const views = [['GB, zoom 5.2', [-2.6, 54.2], 5.2], ['regional, zoom 7', [-1.5, 52.2], 7], ['Sussex/London, zoom 9', [-0.3, 51.2], 9],
    ['city, zoom 11 (labels on)', [-0.12, 51.5], 11], ['street, zoom 16 (metres)', 'train', 16]];
  for (const [n, c, z] of views) await measure(page, n, c, z);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  for (const [n, c, z] of [views[0], views[2], views[3]]) await measure(page, n + ' [CPU x4 slower]', c, z);
  await ctx.close();
  // every train on the track at once (?trackzoom=0 makes the page follow the track at any zoom, so the
  // national view carries all ~1,500 motion plans through the engine and fetches all their spans)
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page2 = await ctx2.newPage();
  await page2.goto(L.PAGE + '&trackzoom=0');
  await page2.waitForFunction(() => window.RM && RM.debug && RM.debug.store && RM.debug.store.size > 1000, null, { timeout: 60000 });
  await page2.waitForTimeout(12000);                          // spans arrive
  for (const [n, c, z] of [['ALL tracked: GB, zoom 5.2', [-2.6, 54.2], 5.2], ['ALL tracked: Sussex/London, zoom 9', [-0.3, 51.2], 9], ['ALL tracked: city, zoom 11', [-0.12, 51.5], 11]]) await measure(page2, n, c, z);
  const cdp2 = await ctx2.newCDPSession(page2);
  await cdp2.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await measure(page2, 'ALL tracked: GB, zoom 5.2 [CPU x4 slower]', [-2.6, 54.2], 5.2);
  await ctx2.close();
  return 0;
};
