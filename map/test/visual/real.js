'use strict';
// The page against the REAL map service (not the mock), through the loopback CORS dev proxy.
// Needs three things already running (see README.md, "Against the real service"):
//   1. map-service/dev/fake-nrod.js  replaying a TD log
//   2. map-service/bin/rail-map.js   --fake=127.0.0.1:61613 --ref-dir=...      (port 3100)
//   3. map/dev/cors-proxy.js                                                     (port 3101)
// Run:  node map/test/visual/real.js        (sets itself up; does not start the mock)
process.env.RM_VISUAL = '1';
if (process.env.NODE_TEST_CONTEXT) { console.log('Browser checks are not unit tests.'); process.exit(0); }
const path = require('path');
const L = require('./lib.js');
const { chromium } = require('playwright-core');

const PROXY = process.env.REAL_API || 'http://localhost:3101';
const PAGE = 'http://127.0.0.1:' + L.CFG.webPort + '/map/index.html?api=' + PROXY;

// What the page relies on, checked against what the service really sends.
async function contract() {
  let bad = 0;
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) bad++; };
  const get = async (p) => { const r = await fetch(PROXY + '/map/v1/' + p); return { status: r.status, headers: r.headers, body: await r.json() }; };
  const t = await get('trains');
  ok(t.status === 200 && typeof t.body.serverTime === 'number' && typeof t.body.feedStale === 'boolean' && Array.isArray(t.body.trains), '/trains envelope');
  ok(t.headers.get('access-control-allow-origin') === '*', 'proxy adds CORS (the service itself sends none)');
  const tr = t.body.trains;
  ok(tr.length > 0, 'real trains present (' + tr.length + ')');
  tr.forEach((x) => {
    if (!(typeof x.id === 'string' && typeof x.hc === 'string' && typeof x.lat === 'number' && typeof x.lon === 'number' &&
      (x.hdg === null || typeof x.hdg === 'number') && ['s', 'i', 'a'].includes(x.pl) && typeof x.at === 'number')) { bad++; console.log('FAIL train shape ' + JSON.stringify(x)); }
  });
  console.log('     headcodes seen: ' + tr.slice(0, 12).map((x) => x.hc).join(' ') + ' | hdg null: ' + tr.filter((x) => x.hdg == null).length + '/' + tr.length +
    ' | with svc: ' + tr.filter((x) => x.svc).length + ' | pl s/i/a: ' + ['s', 'i', 'a'].map((k) => tr.filter((x) => x.pl === k).length).join('/'));
  console.log('     berth samples: ' + tr.slice(0, 8).map((x) => x.area + ':' + x.berth).join(' '));
  const d = tr.length ? await get('train/' + tr[0].id) : null;
  if (d) {
    ok(d.status === 200 && d.body.train && Array.isArray(d.body.trail) && Array.isArray(d.body.recentBerths), '/train/:id detail shape');
    console.log('     detail: place=' + JSON.stringify(d.body.place) + ' service=' + (d.body.service ? 'yes' : 'null') + ' speed=' + d.body.speedMphEstimate + ' prev=' + JSON.stringify(d.body.previousHeadcodes));
    const withSvc = tr.find((x) => x.svc);
    if (withSvc) {
      const ds = (await get('train/' + withSvc.id)).body;
      console.log('     a train WITH a service: ' + JSON.stringify(ds.service).slice(0, 500));
    }
  }
  const nf = await get('train/doesnotexist');
  ok(nf.status === 404 && typeof nf.body.error === 'string', '/train/unknown is a plain-sentence 404');
  const st = await get('stations');
  ok(st.status === 200 && st.body.stations.length > 2000, '/stations (' + st.body.stations.length + ')');
  // KNOWN MISMATCH with the contract (handled in the page by stations.cleanStations): some stations have no CRS.
  const noCrs = st.body.stations.filter((s) => !s.crs);
  console.log('     MISMATCH (handled): ' + noCrs.length + ' of ' + st.body.stations.length + ' stations have an empty crs (e.g. ' + noCrs.slice(0, 3).map((s) => s.name + '/' + s.tiploc).join(', ') + ')');
  ok(st.body.stations.every((s) => s.name && typeof s.lat === 'number' && typeof s.lon === 'number'), 'every station has name, lat, lon');
  const s = await get('search?q=bright');
  ok(s.status === 200 && Array.isArray(s.body.stations) && Array.isArray(s.body.trains), '/search shape');
  const hc = tr.length ? await get('search?q=' + encodeURIComponent(tr[0].hc.slice(0, 2))) : null;
  if (hc) console.log('     train search sample: ' + JSON.stringify(hc.body.trains.slice(0, 2)));
  return bad;
}

(async () => {
  let failed = await contract();
  const web = await L.startStatic();
  const browser = await chromium.launch({ executablePath: L.CFG.chrome, headless: true });
  const shot = (p, n) => L.shot(p, n);
  try {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text()); });   // a 404 for a train that has just ended is expected
      page.on('pageerror', (e) => errors.push('pageerror ' + e.message));
      page.on('requestfailed', (r) => { if (!(r.failure() && /ABORTED/.test(r.failure().errorText))) errors.push('requestfailed ' + r.url().slice(0, 100)); });
      await page.goto(PAGE);
      await page.waitForFunction(() => window.RM && RM.debug && RM.debug.store && RM.debug.store.size > 0, null, { timeout: 30000 });
      await page.waitForTimeout(2000);
      // Real trains come and go quickly in a replay: pick one the service still knows (detail loads).
      let pick = null;
      for (let attempt = 0; attempt < 8 && !pick; attempt++) {
        const cands = await page.evaluate(() => {
          const a = []; RM.debug.store.forEach((r) => a.push({ id: r.id, lon: r.cx, lat: r.cy, hc: r.hc, hdg: r.hdg, pl: r.pl, svc: !!r.svc, trains: RM.debug.store.size }));
          return a.sort((x, y) => (y.svc - x.svc) || ((y.hdg != null) - (x.hdg != null)) || ((x.pl === 'i') - (y.pl === 'i')));
        });
        for (const c of cands) {
          const r = await fetch(PROXY + '/map/v1/train/' + c.id);
          if (r.status === 200) { pick = c; break; }
        }
        if (!pick) await page.waitForTimeout(1500);
      }
      if (!pick) throw new Error('no live real train to select');
      console.log(`${scheme}: ${pick.trains} real trains in the box; selecting ${pick.hc} (${pick.id})`);
      for (const z of [9, 12]) {
        await page.evaluate((id) => RM.debug.select(id, { fly: false }), pick.id);
        await page.waitForTimeout(1500);
        await page.evaluate(([p, z]) => RM.debug.map.jumpTo({ center: z === 9 ? [-0.3, 50.9] : [p.lon, p.lat], zoom: z }), [pick, z]);
        if (z === 12) await page.evaluate(([p]) => RM.debug.map.easeTo({ center: [p.lon, p.lat], zoom: 12, offset: [-190, 0], duration: 0 }), [pick]);
        await page.waitForTimeout(4500);
        const f = await shot(page, `real-${scheme}-z${z}-panel`);
        console.log('ok   ' + path.basename(f));
      }
      const info = await page.evaluate(() => ({ status: document.getElementById('status').textContent, panel: document.getElementById('panel').innerText.slice(0, 400) }));
      console.log('     status: "' + info.status + '"');
      console.log('     panel text: ' + JSON.stringify(info.panel));
      if (errors.length) { failed++; console.log('FAIL console errors:\n   ' + [...new Set(errors)].join('\n   ')); }
      await ctx.close();
    }
  } finally { await browser.close(); web.close(); }
  console.log(failed ? failed + ' problem(s)' : 'real-service run: all good');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
