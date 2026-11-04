'use strict';
// Phase 2 browser checks: trains on the track (curve, platform, held), stacked trains, the station board,
// the panel's next-station line and lateness pill, the national line layer at every zoom (continuity
// checked, not just shot), a 10-frame sequence of a train crossing a berth boundary, and a video.
// Screenshots go to OUT (default map/test/visual/out). Prints measurements; returns the failure count.
const fs = require('fs');
const path = require('path');
const L = require('./lib.js');
const stations = require('../../../map-service/data/stations.json').stations;

const SIZES = [['m', 390, 844], ['d', 1440, 900]];
let failed = 0;
const say = (ok, msg) => { if (!ok) failed++; console.log((ok ? 'ok   ' : 'FAIL ') + msg); };

async function ctxFor(browser, w, h, scheme, query, hash, extra) {
  return L.open(browser, Object.assign({ viewport: { width: w, height: h }, colorScheme: scheme, hasTouch: w < 600, deviceScaleFactor: 1 }, extra || {}), hash || '', query || '');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Errors that come from the machine or the free tile host rather than the page: a laptop that sleeps
// mid-run suspends network IO, and OpenFreeMap tile requests in flight when a context closes are cancelled.
const benign = (e) => /ERR_NETWORK_IO_SUSPENDED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(e) || /^requestfailed: https:\/\/tiles\.openfreemap\.org\//.test(e);
const real = (errors) => errors.filter((e) => !benign(e));

// Find a tracked train matching a predicate evaluated in the page; returns {id, cx, cy}.
async function pick(page, fn) {
  return page.evaluate((src) => {
    const f = new Function('r', 'RM', 'return (' + src + ')(r, RM)');
    let best = null;
    RM.debug.store.forEach((r) => { if (!best && r.mode === 'track' && r.es && r.es.init && f(r, RM)) best = { id: r.id, cx: r.cx, cy: r.cy, hc: r.hc }; });
    return best;
  }, fn.toString());
}
async function waitFor(page, fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await pick(page, fn); if (v) return v; await sleep(500); }
  return null;
}
const centre = (page, p, z, off) => page.evaluate(([p, z, off]) => { const r = RM.debug.store.get(p.id); RM.debug.map.jumpTo({ center: r ? [r.cx, r.cy] : [p.cx, p.cy], zoom: z }); if (off) RM.debug.map.panBy(off, { duration: 0 }); }, [p, z, off || null]);
async function settle(page, ms) { await sleep((ms || 700) + 1500); }              // the map never reports idle while trains animate

async function trainViews(browser) {
  for (const [pf, w, h] of SIZES) {
    for (const scheme of ['light', 'dark']) {
      const tag = pf + '-' + scheme;
      // &debugtrack=1 keeps the service's own line (here the mock's synthetic track) drawn at street zoom, so
      // the shots show the trains sitting on the track the engine is following
      const { page, ctx, errors } = await ctxFor(browser, w, h, scheme, '&debugtrack=1');
      await page.evaluate(() => RM.debug.map.jumpTo({ center: [-0.15, 50.88], zoom: 11.3 }));
      await sleep(9000);                                       // spans arrive, trains settle onto the track
      const tracked = await page.evaluate(() => { let n = 0, t = 0; RM.debug.store.forEach((r) => { t++; if (r.mode === 'track') n++; }); return [n, t]; });
      say(tracked[0] >= Math.floor(tracked[1] * 0.8), tag + ': ' + tracked[0] + ' of ' + tracked[1] + ' trains are following the track at zoom 11');

      // a pass train to hold at a signal: chosen now, while the whole box is in the store
      const mover = await pick(page, (r) => r.es.v > 10 && r.pl === 'i' && r.plans[r.es.k].stop == null && r.plans[r.es.k].span.length > 500);
      if (mover) await L.setMock('hold=' + mover.id + '&secs=900');

      // 1. mid-span on a curve, aligned to the track
      const curvy = await page.evaluate(() => {
        const E = RM.engine; let best = null, bd = 0;
        RM.debug.store.forEach((r) => {
          if (r.mode !== 'track' || !r.es || !r.es.init || r.es.v < 8) return;
          const sp = r.plans[r.es.k].span; if (!sp) return;
          const s = r.es.s; if (s < 60 || s > sp.length - 60) return;
          const d = Math.abs(E.angDiff(E.bearingAt(sp, s - 40, 6), E.bearingAt(sp, s + 40, 6)));
          if (d > bd) { bd = d; best = { id: r.id, cx: r.cx, cy: r.cy, turn: d }; }
        });
        return best;
      });
      if (curvy) {
        await centre(page, curvy, 16.2); await settle(page, 300);
        await L.shot(page, 'p2-curve-' + tag);
        const al = await page.evaluate((id) => {
          const r = RM.debug.store.get(id), sp = r.plans[r.es.k].span, E = RM.engine;
          const tan = E.bearingAt(sp, r.es.s, 12);
          return { d: Math.abs(E.angDiff(r.ch, tan)), turn: 0, v: r.es.v };
        }, curvy.id);
        say(al.d < 12, tag + ': curve train (track turns ' + curvy.turn.toFixed(0) + ' deg over 80 m) points within ' + al.d.toFixed(1) + ' deg of the track tangent');
      }

      // 2. a calling train standing at its platform
      await page.evaluate(() => RM.debug.map.jumpTo({ center: [-0.15, 50.88], zoom: 11.3 })); await sleep(6000);
      const dwell = await waitFor(page, (r) => r.es.stopped && r.plans[r.es.k].stop != null && Math.abs(r.es.s - r.plans[r.es.k].stop) < 5, 120000);
      if (dwell) { await centre(page, dwell, 17); await settle(page, 300); await L.shot(page, 'p2-dwell-' + tag); say(true, tag + ': dwelling train ' + dwell.hc + ' shot'); }
      else say(false, tag + ': no dwelling train found');

      // 3. the held train: its next step was delayed 15 minutes, so the drawn train stops short of the signal
      if (mover) {
        await page.evaluate(() => RM.debug.map.jumpTo({ center: [-0.15, 50.88], zoom: 11.3 })); await sleep(4000);
        const held = await page.evaluate((id) => new Promise((resolve) => {
          const t0 = performance.now();
          const iv = setInterval(() => { const r = RM.debug.store.get(id); if (r && r.wait) { clearInterval(iv); resolve(true); } else if (performance.now() - t0 > 100000) { clearInterval(iv); resolve(false); } }, 500);
        }), mover.id);
        say(held, tag + ': train ' + mover.hc + ' is drawn waiting at a signal after its step was delayed');
        if (held) {
          await page.evaluate((id) => RM.debug.select(id, { fly: false }), mover.id);
          await centre(page, mover, 16.2, w < 600 ? [0, 130] : [-190, 0]); await settle(page, 400); await L.shot(page, 'p2-held-' + tag);
          const pill = await page.evaluate(() => { const e = document.querySelector('[data-testid="waiting-pill"]'); return e ? e.textContent : null; });
          say(pill === 'Waiting at a signal', tag + ': the panel says "' + pill + '"');
        }
      } else say(false, tag + ': no train to hold');
      if (real(errors).length) { failed++; console.log('FAIL console errors:\n   ' + real(errors).join('\n   ')); }
      await ctx.close();
    }
  }
}

async function stacked(browser) {
  const r = await L.setMock('stack=BTN&n=3');
  say(r.stacked >= 2, 'stacked case: ' + r.stacked + ' extra trains standing at Brighton');
  for (const [pf, w, h] of SIZES) for (const scheme of ['light', 'dark']) {
    const tag = pf + '-' + scheme, b = stations.BTN;
    const { page, ctx, errors } = await ctxFor(browser, w, h, scheme);
    await page.evaluate((b) => RM.debug.map.jumpTo({ center: [b.lon, b.lat], zoom: 17 }), b);
    await sleep(6000);
    const m = await page.evaluate((b) => {
      const kx = 111320 * Math.cos(b.lat * Math.PI / 180), out = [];
      RM.debug.store.forEach((r) => {
        if (!r.stopped) return;
        const d = Math.hypot((r.cx - b.lon) * kx, (r.cy - b.lat) * 110540);
        if (d < 60) out.push({ id: r.id, ph: r.ph, fan: r.fan, d: d });
      });
      return out;
    }, b);
    const heads = new Set(m.map((x) => Math.round(x.ph)));
    say(m.length >= 2 && heads.size === 1, tag + ': ' + m.length + ' stopped trains at Brighton all face ' + Array.from(heads).join('/') + ' deg (no cross), fan offsets ' + m.map((x) => x.fan.toFixed(1)).join(', '));
    await L.shot(page, 'p2-stacked-' + tag);
    if (real(errors).length) { failed++; console.log('FAIL console errors:\n   ' + real(errors).join('\n   ')); }
    await ctx.close();
  }
}

async function approx(browser) {
  const { page, ctx, errors } = await ctxFor(browser, 1440, 900, 'light');
  await sleep(2000);
  const a = await page.evaluate(() => { let best = null; RM.debug.store.forEach((r) => { if (!best && r.pl === 'a') best = { id: r.id, cx: r.cx, cy: r.cy }; }); return best; });
  if (a) { await page.evaluate((a) => RM.debug.map.jumpTo({ center: [a.cx, a.cy], zoom: 14 }), a); await sleep(2500); await L.shot(page, 'p2-approx-z14'); say(true, 'approximate-position train at zoom 14 shot (a faint dashed body, no ring)'); }
  if (real(errors).length) failed++;
  await ctx.close();
}

async function panelAndStation(browser) {
  for (const [pf, w, h] of SIZES) for (const scheme of ['light', 'dark']) {
    const tag = pf + '-' + scheme;
    const { page, ctx, errors } = await ctxFor(browser, w, h, scheme);
    await page.evaluate(() => RM.debug.map.jumpTo({ center: [-0.2, 50.95], zoom: 11 }));
    await sleep(5000);
    const id = await page.evaluate(() => { let best = null; RM.debug.store.forEach((r) => { if (!best && r.svc && r.svc.next && typeof r.svc.late === 'number' && r.lat > 50.8 && r.lat < 51.1) best = r.id; }); return best; });
    await page.evaluate((id) => RM.debug.select(id, { fly: true }), id);
    await sleep(5000);
    const txt = await page.evaluate(() => ({ pill: (document.querySelector('[data-testid="late-pill"]') || {}).textContent, next: (document.querySelector('[data-testid="next-line"]') || {}).textContent,
      calls: document.querySelectorAll('.calls li').length, sw: document.documentElement.scrollWidth, iw: innerWidth }));
    say(!!txt.pill && /^Next: .+ \d\d:\d\d/.test(txt.next || ''), tag + ': panel top line "' + txt.next + '" and pill "' + txt.pill + '", ' + txt.calls + ' calling points');
    say(txt.sw <= txt.iw, tag + ': no horizontal scroll');
    await L.shot(page, 'p2-panel-' + tag);
    if (w < 600) { await page.evaluate(() => document.querySelector('.sheet-handle').click()); await sleep(500); await L.shot(page, 'p2-panel-expanded-' + tag); }
    else { await page.evaluate(() => { const s = document.querySelector('.p-scroll'); s.scrollTop = 520; }); await sleep(300); await L.shot(page, 'p2-panel-calls-' + tag); }

    // the station board
    await page.evaluate(() => { location.hash = '#s=HOV'; });
    await sleep(3500);
    const board = await page.evaluate(() => ({ rows: document.querySelectorAll('.brow').length, tabs: Array.from(document.querySelectorAll('.seg-btn')).map((b) => b.textContent), sw: document.documentElement.scrollWidth, iw: innerWidth }));
    say(board.rows > 0 && board.tabs.length === 4, tag + ': station board (Hove) has ' + board.rows + ' departures, tabs ' + board.tabs.join('/'));
    await L.shot(page, 'p2-station-dep-' + tag);
    for (const [k, name] of [['arr', 'arr'], ['pass', 'pass']]) {
      await page.click('#tab-' + k); await sleep(500);
      const n = await page.evaluate(() => document.querySelectorAll('.brow').length);
      await L.shot(page, 'p2-station-' + name + '-' + tag);
      say(n > 0, tag + ': ' + name + ' tab has ' + n + ' rows');
    }
    const tags = await page.evaluate(() => Array.from(document.querySelectorAll('.btag')).map((e) => e.textContent));
    say(tags.length > 0 && tags.every((t) => /Freight|Empty train|Special working/.test(t)), tag + ': freight / empty trains labelled plainly: ' + Array.from(new Set(tags)).join(', '));
    await page.click('#tab-dep'); await sleep(400);
    const row = await page.$('button.brow'); const tid = row ? await row.getAttribute('data-train') : null;
    if (row) { await row.click(); await sleep(2500); const sel = await page.evaluate(() => location.hash); say(sel === '#t=' + tid, tag + ': tapping a board row selected that train (' + sel + ')'); }
    say((await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)), tag + ': no horizontal scroll with the board');
    if (real(errors).length) { failed++; console.log('FAIL console errors:\n   ' + real(errors).join('\n   ')); }
    await ctx.close();
  }
}

// every line continuous at every zoom: each branch terminus has a rendered rail feature on it
async function network(browser) {
  const checks = [['EGR', 'East Grinstead'], ['UCK', 'Uckfield'], ['CAT', 'Caterham'], ['BTN', 'Brighton'], ['HRH', 'Horsham'], ['SEF', 'Seaford']];
  for (const scheme of ['light', 'dark']) for (const [pf, w, h] of SIZES) {
    const { page, ctx, errors } = await ctxFor(browser, w, h, scheme);
    await sleep(2500);
    for (const z of [6, 8, 9.5, 11]) {
      if (process.env.P2_DEBUG) console.log('  ... jump to', z, new Date().toISOString());
      await page.evaluate((z) => RM.debug.map.jumpTo({ center: [0.0, 51.1], zoom: z }), z);
      await settle(page, 1500);
      const r = await page.evaluate(([checks, z]) => {
        const map = RM.debug.map, ids = ['rm-net-lo', 'rm-net-hi', 'rm-rail'].filter((i) => map.getLayer(i));
        return checks.map(([crs, lon, lat]) => {
          const p = map.project([lon, lat]), pad = 10;
          const f = map.queryRenderedFeatures([[p.x - pad, p.y - pad], [p.x + pad, p.y + pad]], { layers: ids });
          return [crs, f.length, p.x > 0 && p.y > 0 && p.x < innerWidth && p.y < innerHeight];
        });
      }, [checks.map(([c]) => [c, stations[c].lon, stations[c].lat]), z]);
      const inView = r.filter((x) => x[2]);
      const missing = inView.filter((x) => x[1] === 0).map((x) => x[0]);
      say(missing.length === 0, scheme + ' ' + pf + ' zoom ' + z + ': line drawn at ' + inView.length + ' of ' + checks.length + ' termini in view' + (missing.length ? ' (MISSING ' + missing.join(',') + ')' : ''));
      if (pf === 'd' || z === 8) await L.shot(page, 'p2-network-z' + String(z).replace('.', '_') + '-' + pf + '-' + scheme);
    }
    if (pf === 'd') {
      await page.evaluate(() => RM.debug.map.jumpTo({ center: [-2.6, 54.2], zoom: 5.2 }));
      await settle(page, 1500); await L.shot(page, 'p2-network-national-' + scheme);
    }
    if (real(errors).length) { failed++; console.log('FAIL console errors:\n   ' + real(errors).join('\n   ')); }
    await ctx.close();
  }
}

// ten frames, one second apart, of a train crossing a berth boundary, camera fixed on the boundary
async function sequence(browser) {
  const { page, ctx, errors } = await ctxFor(browser, 1440, 900, 'light');
  await page.evaluate(() => RM.debug.map.jumpTo({ center: [-0.2, 50.95], zoom: 11 }));
  await sleep(8000);
  // a pass train, moving, with the next boundary 8-12 s away on a curve
  const cand = await page.evaluate(() => {
    let best = null;
    RM.debug.store.forEach((r) => {
      if (best || r.mode !== 'track' || !r.es || !r.es.init || r.es.v < 12) return;
      const p = r.plans[r.es.k], remain = (p.L - r.es.s) / r.es.v;
      if (remain > 6 && remain < 40 && r.pl === 'i') best = { id: r.id, remain: remain, hc: r.hc };
    });
    return best;
  });
  if (!cand) { say(false, 'sequence: no candidate'); await ctx.close(); return; }
  const info = await page.evaluate((id) => {
    const r = RM.debug.store.get(id), p = r.plans[r.es.k], E = RM.engine, q = E.locate(p.span, p.L, { x: 0, y: 0, brg: 0 });
    RM.debug.select(id, { fly: false });                       // a selected train is kept even outside the subscribed box
    RM.debug.map.jumpTo({ center: [q.x, q.y], zoom: 16.4 });
    return { lon: q.x, lat: q.y, k: r.es.k, sp: p.sp };
  }, cand.id);
  // a per-frame log of the train's drawn position, taken inside the page on every animation frame
  await page.evaluate((id) => {
    window.__log = []; window.__logOn = true;
    const loop = () => { const r = RM.debug.store.get(id); if (r && r.es) window.__log.push([performance.now(), r.cx, r.cy, r.es.v, r.plans[r.es.k].sp, r.es.s, r.es.t]); if (window.__logOn) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }, cand.id);
  const frames = [];
  const t0 = Date.now(), wait = Math.max(0, (cand.remain - 5) * 1000);
  await sleep(wait);
  for (let i = 0; i < 10; i++) {
    const t = Date.now();
    const f = await L.shot(page, 'p2-seq-' + String(i).padStart(2, '0'));
    const st = await page.evaluate((id) => { const r = RM.debug.store.get(id); return r ? { sp: r.plans[r.es.k].sp, s: r.es.s, v: r.es.v, x: r.cx, y: r.cy, t: performance.now() } : null; }, cand.id);
    frames.push([f, st]);
    await sleep(Math.max(0, 1000 - (Date.now() - t)));
  }
  void t0;
  const crossed = frames.some((f) => f[1] && f[1].sp !== info.sp);
  say(crossed, 'sequence: train ' + cand.hc + ' crossed the berth boundary during the 10 frames');
  const log = await page.evaluate(() => { window.__logOn = false; return window.__log; });
  const kxs = 111320 * Math.cos(50.95 * Math.PI / 180);
  let worst = 0, gaps = 0, n = 0, maxDt = 0, crossAt = -1;
  for (let i = 1; i < log.length; i++) {
    const dt = (log[i][6] - log[i - 1][6]) / 1000, wall = (log[i][0] - log[i - 1][0]) / 1000;      // engine time between frames
    if (dt <= 0) continue;
    if (log[i][4] !== log[i - 1][4] && crossAt < 0) crossAt = i;
    if (wall > 0.1) { gaps++; maxDt = Math.max(maxDt, wall); continue; }            // a frame the browser spent on a screenshot, not on drawing
    const d = Math.hypot((log[i][1] - log[i - 1][1]) * kxs, (log[i][2] - log[i - 1][2]) * 110540), v = (log[i][3] + log[i - 1][3]) / 2;
    n++; worst = Math.max(worst, Math.abs(d - v * dt));
  }
  say(n > 100 && worst < 0.45, 'sequence: over ' + n + ' consecutive frames (' + log.length + ' logged, ' + gaps + ' screenshot gaps up to ' + maxDt.toFixed(1) + ' s skipped) the drawn train never moved more than ' + worst.toFixed(2) + ' m (limit 0.45: includes a ~1 m junction gap slid away at <= 25 m/s) from speed x time, across the berth boundary at frame ' + crossAt);
  // a contact sheet of the ten frames
  const sheet = await ctx.newPage();
  const imgs = frames.map((f) => 'data:image/png;base64,' + fs.readFileSync(f[0]).toString('base64'));
  await sheet.setContent('<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(5,1fr);gap:4px;width:3000px">' + imgs.map((s, i) => '<figure style="margin:0;position:relative"><img src="' + s + '" style="width:100%;display:block"><figcaption style="position:absolute;left:6px;top:4px;color:#fff;font:700 18px system-ui;text-shadow:0 0 3px #000">t+' + i + ' s</figcaption></figure>').join('') + '</body>');
  await sheet.setViewportSize({ width: 3000, height: 1000 });
  await sheet.screenshot({ path: path.join(L.CFG.out, 'p2-seq-sheet.png'), fullPage: true });
  if (real(errors).length) { failed++; console.log('FAIL console errors:\n   ' + real(errors).join('\n   ')); }
  await ctx.close();
}

async function video(browser) {
  if (!fs.existsSync(path.join(process.env.HOME, 'Library/Caches/ms-playwright')) || !fs.readdirSync(path.join(process.env.HOME, 'Library/Caches/ms-playwright')).some((d) => /^ffmpeg/.test(d))) { console.log('skip screen recording: playwright ffmpeg is not installed (npx playwright-core install ffmpeg); the 10-frame sequence stands in'); return; }
  const dir = path.join(L.CFG.out, 'video');
  fs.mkdirSync(dir, { recursive: true });
  const { page, ctx } = await ctxFor(browser, 900, 640, 'light', '', '', { recordVideo: { dir, size: { width: 900, height: 640 } } });
  await page.evaluate(() => RM.debug.map.jumpTo({ center: [-0.2, 50.95], zoom: 11 }));
  await sleep(7000);
  const id = await page.evaluate(() => { let best = null; RM.debug.store.forEach((r) => { if (!best && r.mode === 'track' && r.es.v > 12 && r.pl === 'i') best = r.id; }); return best; });
  await page.evaluate((id) => RM.debug.select(id, { fly: false }), id);
  await page.evaluate((id) => { const r = RM.debug.store.get(id); RM.debug.map.jumpTo({ center: [r.cx, r.cy], zoom: 14.5 }); RM.debug.map.panBy([-120, 0], { duration: 0 }); }, id);
  await page.evaluate((id) => { setTimeout(() => RM.debug.select && 0, 0); }, id);
  const follow = page.evaluate(() => { const b = Array.from(document.querySelectorAll('.btn')).find((x) => /Follow/.test(x.textContent)); if (b) b.click(); });
  await follow;
  await sleep(24000);
  const v = page.video();
  await ctx.close();
  const f = v ? await v.path() : null;
  say(!!f, 'screen recording: ' + f);
}

module.exports = async function phase2(browser, only) {
  failed = 0;
  const run = (name, fn) => (!only || only === name) ? fn(browser) : null;
  await run('network', network);
  await run('views', trainViews);
  await run('stacked', stacked);
  await run('approx', approx);
  await run('panel', panelAndStation);
  await run('sequence', sequence);
  await run('video', video);
  return failed;
};
