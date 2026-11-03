'use strict';
// Behaviour checks in a real browser against the mock: keyboard search, deep links, follow, share,
// chips, theme persistence, reduced motion, tab order, help dialog, loopback-only ?api=.
const L = require('./lib.js');

module.exports = async function e2e(browser) {
  let fails = 0;
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  const open = (opts, hash) => L.open(browser, Object.assign({ permissions: ['clipboard-read', 'clipboard-write'] }, opts || {}), hash || '');

  { // search by keyboard, panel focus, follow, share
    const { page, errors, ctx } = await open();
    await page.evaluate(() => RM.debug.map.jumpTo({ center: [-0.35, 50.92], zoom: 9 }));
    await page.waitForTimeout(1500);
    await page.focus('#q');
    await page.keyboard.type('bright', { delay: 30 });
    await page.waitForTimeout(500);
    ok(await page.getAttribute('#q', 'aria-expanded') === 'true', 'search: results list opens (aria-expanded)');
    const n = await page.locator('#results [role=option]').count();
    ok(n > 0, 'search: has options (' + n + ')');
    ok(await page.getAttribute('#q', 'aria-activedescendant') === 'opt-0', 'search: first option active');
    await page.keyboard.press('ArrowDown');
    ok((await page.getAttribute('#q', 'aria-activedescendant')) === (n > 1 ? 'opt-1' : 'opt-0'), 'search: ArrowDown moves');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    ok(await page.evaluate(() => !document.getElementById('panel').hidden), 'search: Enter opens the panel');
    ok(/#s=[A-Z]{3}/.test(await page.evaluate(() => location.hash)), 'search: hash updated to #s=');
    ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'panelTitle'), 'panel: focus moves to the panel title');
    await page.keyboard.press('Escape');
    ok(await page.evaluate(() => document.getElementById('panel').hidden), 'Escape closes the panel');
    ok(await page.evaluate(() => location.hash === ''), 'hash cleared on close');
    await page.focus('#q');
    const hc = await page.evaluate(() => { let h = null; RM.debug.store.forEach((r) => { if (!h && r.svc) h = r.hc; }); return h; });
    await page.keyboard.type(hc.toLowerCase(), { delay: 30 });
    await page.waitForTimeout(700);
    ok(await page.locator('#results .opt').first().innerText().then((t) => t.includes(hc)), 'search: headcode matches case-insensitively (' + hc + ')');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    ok(/#t=/.test(await page.evaluate(() => location.hash)), 'train picked: #t= in the URL');
    ok((await page.locator('#panel h2').first().innerText()).trim() === hc, 'panel title is the headcode');
    await page.click('text=Follow this train');
    ok(await page.getAttribute('.p-actions .btn', 'aria-pressed') === 'true', 'follow: pressed');
    await page.waitForTimeout(3000);
    await page.mouse.move(300, 500); await page.mouse.down(); await page.mouse.move(400, 520, { steps: 5 }); await page.mouse.up();
    ok(await page.evaluate(() => document.querySelector('.p-actions .btn').getAttribute('aria-pressed')) === 'false', 'follow: dragging the map stops it');
    ok(await page.evaluate(() => !document.getElementById('panel').hidden), 'dragging the map does not close the panel');
    await page.click('text=Share link');
    await page.waitForTimeout(400);
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    ok(/\/map\/index\.html#t=/.test(clip), 'share: link copied to clipboard (' + clip + ')');
    ok(!/api=/.test(clip), 'share: link does not carry the ?api override');
    ok(errors.length === 0, 'no console errors in the interaction run' + (errors.length ? ': ' + errors.join(' | ') : ''));
    await ctx.close();
  }

  { // chips
    const { page, ctx } = await open();
    await page.evaluate(() => RM.debug.map.jumpTo({ center: [-0.35, 50.92], zoom: 9 }));
    await page.waitForTimeout(2500);
    const txt = await page.locator('.chip[data-cls=stopping] .count').innerText();
    const real = await page.evaluate(() => RM.debug.store.counts().stopping);
    ok(+txt.replace(/,/g, '') === real, 'chips: count matches store (' + txt + ')');
    const before = await page.evaluate(() => RM.debug.store.fill(performance.now(), {}).n);
    await page.click('.chip[data-cls=stopping]');
    const after = await page.evaluate(() => RM.debug.store.fill(performance.now(), JSON.parse(localStorage.getItem('map.hidden'))).n);
    ok(after < before && await page.getAttribute('.chip[data-cls=stopping]', 'aria-pressed') === 'false', 'chips: toggling hides that class (' + before + ' -> ' + after + ')');
    ok(/hidden/.test(await page.getAttribute('.chip[data-cls=stopping]', 'aria-label')), 'chips: aria-label says hidden');
    await ctx.close();
  }

  { // deep links
    const a0 = await open();
    const id = await a0.page.evaluate(() => { let i = null; RM.debug.store.forEach((r) => { if (!i && r.svc) i = r.id; }); return i; });
    await a0.ctx.close();
    const a = await open({}, '#t=' + id);
    await a.page.waitForTimeout(3500);
    ok(await a.page.evaluate(() => !document.getElementById('panel').hidden && document.querySelector('#panel h2').textContent.length === 4), '#t=<id>: opens that train');
    await a.ctx.close();
    const b = await open({}, '#s=btn');
    await b.page.waitForTimeout(3500);
    ok((await b.page.locator('#panel h2').first().innerText()) === 'Brighton', '#s=btn: opens Brighton station');
    ok(Math.abs(await b.page.evaluate(() => RM.debug.map.getCenter().lat) - 50.83) < 0.1, '#s=btn: map moved to Brighton');
    await b.ctx.close();
    const c = await open({}, '#t=doesnotexist');
    await c.page.waitForTimeout(2500);
    ok(/Train not found/.test(await c.page.locator('#panel h2').first().innerText()), '#t=unknown: friendly message');
    await c.ctx.close();
    const d = await open({}, '#t=<script>alert(1)</script>');
    await d.page.waitForTimeout(1500);
    ok(await d.page.evaluate(() => document.getElementById('panel').hidden), 'malicious #t= is ignored');
    await d.ctx.close();
  }

  { // theme
    const { page, ctx } = await open({ colorScheme: 'light' });
    ok(await page.evaluate(() => document.documentElement.dataset.theme) === 'light', 'theme: follows system (light)');
    await page.click('#btnTheme'); await page.click('#btnTheme');
    ok(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'theme: toggle reaches dark');
    await page.waitForTimeout(1500);
    await page.reload(); await page.waitForFunction(() => window.RM && RM.debug && RM.debug.store.size > 0);
    ok(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'theme: choice persists across reload');
    await page.click('#btnTheme');
    ok(await page.evaluate(() => document.documentElement.dataset.theme) === 'light', 'theme: back to automatic follows system');
    await ctx.close();
  }

  { // motion
    const r = await open({ reducedMotion: 'reduce' });
    await r.page.waitForTimeout(4000);
    ok(await r.page.evaluate(() => { let n = 0; const now = performance.now(); RM.debug.store.forEach((x) => { if (x.dur > 0 && now < x.t0 + x.dur) n++; }); return n; }) === 0, 'reduced motion: no train is gliding');
    await r.ctx.close();
    const m = await open({ reducedMotion: 'no-preference' });
    await m.page.waitForTimeout(6000);
    const anim = await m.page.evaluate(() => { let n = 0; RM.debug.store.forEach((x) => { if (x.dur > 0) n++; }); return n; });
    ok(anim > 0, 'normal motion: trains do glide (' + anim + ' with a glide set)');
    await m.ctx.close();
  }

  { // keyboard
    const { page, ctx } = await open();
    const seen = [];
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press('Tab');
      seen.push(await page.evaluate(() => { const e = document.activeElement; return e ? (e.id || e.getAttribute('aria-label') || e.className || e.tagName) : null; }));
    }
    console.log('tab order: ' + seen.join(' | '));
    ok(seen.some((s) => /Back to Rail Crossing/.test(s)) && seen.includes('q') && seen.includes('btnTheme') && seen.includes('btnHelp'), 'keyboard: header controls reachable');
    ok(seen.some((s) => /chip/.test(s)), 'keyboard: chips reachable');
    await page.focus('#btnHelp'); await page.keyboard.press('Enter');
    ok(await page.evaluate(() => document.getElementById('about').open), 'help dialog opens from keyboard');
    await page.keyboard.press('Escape');
    ok(await page.evaluate(() => !document.getElementById('about').open), 'help dialog closes with Escape');
    await ctx.close();
  }

  { // ?api= loopback only
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    const reqs = [];
    page.on('request', (r) => reqs.push(r.url()));
    await page.route('**/*', (route) => { const h = new URL(route.request().url()).hostname; return /^(evil\.example|api\.railcrossing\.uk)$/.test(h) ? route.abort() : route.continue(); });
    await page.goto('http://127.0.0.1:' + L.CFG.webPort + '/map/index.html?api=' + encodeURIComponent('https://evil.example'));
    await page.waitForTimeout(2500);
    ok(reqs.every((u) => new URL(u).hostname !== 'evil.example'), 'api override: evil host never contacted');
    ok(reqs.some((u) => /api\.railcrossing\.uk\/map\/v1/.test(u)), 'api override: fell back to the default API base');
    await ctx.close();
  }

  console.log(fails ? fails + ' FAILED' : 'e2e: ALL PASSED');
  return fails;
};
