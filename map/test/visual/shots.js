'use strict';
// The review set: phone (390x844) and desktop (1440x900), light and dark, each with the plain map,
// the details panel open, search open and the stale-feed banner; plus the national view.
// Prints, for each shot, the train count, the status text, any banner, horizontal overflow and
// console errors (there must be none).
const L = require('./lib.js');

async function one(browser, name, w, h, scheme, scenario) {
  const { page, ctx, errors } = await L.open(browser, { viewport: { width: w, height: h }, colorScheme: scheme, hasTouch: w < 600 });
  const phone = w < 600;
  if (scenario === 'national') {
    await page.waitForTimeout(3500);
  } else {
    await page.evaluate((phone) => RM.debug.map.jumpTo({ center: [-0.35, 50.92], zoom: phone ? 9 : 9.6 }), phone);
    await page.waitForTimeout(3500);
  }
  if (scenario === 'panel') {
    const id = await page.evaluate(() => {
      let best = null;
      RM.debug.store.forEach((r) => { if (!best && r.svc && r.pl === 'i' && r.lat > 50.7 && r.lat < 51.2 && r.lon > -0.9 && r.lon < 0.5) best = r.id; });
      if (!best) RM.debug.store.forEach((r) => { if (!best && r.svc && r.lat > 50.7 && r.lat < 51.2 && r.lon > -0.9 && r.lon < 0.5) best = r.id; });
      return best;
    });
    await page.evaluate((id) => RM.debug.select(id, { fly: true }), id);
    await page.waitForTimeout(4500);
  } else if (scenario === 'search') {
    await page.click('#q');
    await page.keyboard.type('bri', { delay: 40 });
    await page.waitForTimeout(900);
  }
  const file = await L.shot(page, name);
  const o = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, iw: window.innerWidth, trains: RM.debug.store.size,
    status: document.getElementById('status').textContent,
    banner: document.getElementById('banner').hidden ? null : document.getElementById('banner').textContent
  }));
  const bad = errors.length || o.sw > o.iw;
  console.log((bad ? 'FAIL ' : 'ok   ') + name + '  trains=' + o.trains + '  "' + o.status + '"' + (o.banner ? '  banner' : '') +
    '  overflow=' + (o.sw > o.iw ? 'YES' : 'no') + (errors.length ? '\n   ' + errors.join('\n   ') : ''));
  await ctx.close();
  return { file, bad };
}

module.exports = async function shots(browser, only) {
  let failed = 0;
  const jobs = [];
  for (const [p, w, h] of [['m', 390, 844], ['d', 1440, 900]]) {
    for (const scheme of ['light', 'dark']) {
      for (const sc of ['base', 'panel', 'search', 'stale']) jobs.push([`${p}-${scheme}-${sc}`, w, h, scheme, sc]);
      if (p === 'd') jobs.push([`national-${scheme}`, w, h, scheme, 'national']);
    }
  }
  for (const [name, w, h, scheme, sc] of jobs) {
    if (only && !name.includes(only)) continue;
    if (sc === 'stale') await L.setMock('stale=1');
    const r = await one(browser, name, w, h, scheme, sc);
    if (sc === 'stale') await L.setMock('stale=0');
    if (r.bad) failed++;
  }
  return failed;
};
