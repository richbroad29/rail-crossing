#!/usr/bin/env node
// Real-browser UX capture for the unattended audit.
//   node ux-capture.js <OUTDIR> <tag> [reason]
//
// Captures what the replay harness structurally cannot: actual pixels, uncaught
// exceptions, failed requests, and the SERVICE WORKER — CLAUDE.md is explicit that
// curl bypasses the worker and will confirm a change the app is not executing, so a
// real browser is the only way to regression-test the 2026-07-31 network-first fix.
//
// THE VIEWPORT TRAP (cost two sessions, see memory): headless Chrome's --window-size
// flag does not set the LAYOUT viewport, so content clips at the right edge of the PNG
// and reads as a horizontal-overflow bug that isn't there. puppeteer's setViewport goes
// through Emulation.setDeviceMetricsOverride and does set it — but this script never
// relies on that being true. Every capture asserts clientWidth === the width we asked
// for, and measures overflow with an in-page probe. Overflow is a NUMBER in the JSON,
// never a judgement about a picture.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const OUT = process.argv[2];
const TAG = process.argv[3];
const REASON = process.argv[4] || 'heartbeat';
if (!OUT || !TAG) {
  console.error('usage: ux-capture.js <OUTDIR> <tag> [reason]');
  process.exit(2);
}

const TARGETS = [
  { name: 'public-mobile',  url: 'https://railcrossing.uk/portslade/',         w: 390,  h: 844, dsf: 2, mobile: true,  kind: 'public'   },
  { name: 'public-desktop', url: 'https://railcrossing.uk/portslade/',         w: 1280, h: 800, dsf: 1, mobile: false, kind: 'public'   },
  { name: 'observer',       url: 'https://railcrossing.uk/portslade/observe/', w: 390,  h: 844, dsf: 2, mobile: true,  kind: 'observer' },
];

// Ids read off the deployed markup, not guessed.
// c0* / c1* are the two timeline slots. They are POSITIONAL — slot 0 is whatever happens
// next — so read c0label to know whether it is the open or the close.
const PUBLIC_IDS = ['statusTitle', 'statusMsg', 'c0label', 'c0value', 'c0sub',
  'c1label', 'c1value', 'c1sub', 'errorBox', 'showMoreBtn'];
const OBSERVER_IDS = ['predState', 'predClose', 'predCloseAt', 'predOpen', 'predOpenAt', 'predDown',
  'predDownRange', 'predWarn', 'predAge', 'predClosures', 'netText', 'pollAge', 'offsetText', 'clock'];

// The probe runs IN the page. It reports numbers; nothing here is inferred from an image.
async function probe(ids) {
  const txt = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    txt[id] = el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) : null;
  }

  const vw = document.documentElement.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '',
        id: el.id || '',
        right: Math.round(r.right),
      });
      if (offenders.length >= 12) break;
    }
  }

  const list = document.getElementById('closureList');
  const cards = list
    ? Array.from(list.querySelectorAll('.closure-card')).slice(0, 4)
        .map(c => (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220))
    : [];

  // Service worker: is one controlling this load, which script, and what is cached.
  let sw = { supported: 'serviceWorker' in navigator, controller: null, state: null, scope: null, caches: [] };
  try {
    if (sw.supported) {
      sw.controller = navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null;
      const regs = await navigator.serviceWorker.getRegistrations();
      if (regs.length) {
        sw.scope = regs[0].scope;
        const w = regs[0].active || regs[0].waiting || regs[0].installing;
        sw.state = w ? w.state : null;
        sw.waiting = !!regs[0].waiting;   // a waiting worker means the page ran OLD code
      }
      if (window.caches) sw.caches = await caches.keys();
    }
  } catch (e) { sw.error = String(e && e.message || e); }

  return {
    vw,
    scrollW: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    dpr: window.devicePixelRatio,
    offenders,
    text: txt,
    cards,
    bodyLen: (document.body.innerText || '').length,
    sw,
    href: location.href,
  };
}

(async () => {
  const dir = path.join(OUT, 'ux', TAG);
  fs.mkdirSync(dir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    // Persistent profile ON PURPOSE, and shared across blocks rather than per-block: a
    // returning visitor whose service worker is already installed is both the realistic case
    // and the one that produced the stale-code bug. A per-block profile would reinstall the
    // worker each time and quietly test only the fresh-install path.
    userDataDir: process.env.UX_PROFILE || path.join(path.dirname(path.dirname(OUT)), 'chrome-profile'),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
           '--hide-scrollbars', '--disable-background-timer-throttling'],
    protocolTimeout: 60000,
  });

  const record = { tag: TAG, reason: REASON, startedAt: new Date().toISOString(), targets: [] };

  for (const t of TARGETS) {
    const r = { name: t.name, url: t.url, requested: { w: t.w, h: t.h }, console: [], errors: [], failed: [], http: [] };
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: t.w, height: t.h, deviceScaleFactor: t.dsf, isMobile: t.mobile, hasTouch: t.mobile });

      page.on('console', m => { if (r.console.length < 40) r.console.push({ type: m.type(), text: m.text().slice(0, 300) }); });
      page.on('pageerror', e => { if (r.errors.length < 20) r.errors.push(String(e && e.message || e).slice(0, 400)); });
      page.on('requestfailed', q => {
        if (r.failed.length < 20) r.failed.push({ url: q.url().slice(0, 200), err: (q.failure() && q.failure().errorText) || '?' });
      });
      page.on('response', res => {
        if (res.status() >= 400 && r.http.length < 20) r.http.push({ url: res.url().slice(0, 200), status: res.status() });
      });

      const t0 = Date.now();
      await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // Wait for the app to have actually rendered from a real poll, not just parsed.
      const marker = t.kind === 'public' ? 'statusTitle' : 'clock';
      try {
        await page.waitForFunction(
          id => { const e = document.getElementById(id); return e && (e.textContent || '').trim().length > 0; },
          { timeout: 25000, polling: 400 }, marker);
        r.rendered = true;
      } catch { r.rendered = false; r.renderTimeout = true; }
      r.loadMs = Date.now() - t0;

      // Let one poll cycle land (the apps poll at 10s / 2.5s) so countdowns are populated.
      await new Promise(res => setTimeout(res, 3000));

      // Stamped immediately around the probe: the public app and the observer are
      // captured seconds apart, so their countdowns differ innocently. Parity scoring
      // needs the gap, or it reports a disagreement that is just elapsed time.
      r.capturedAt = Date.now();
      r.probe = await page.evaluate(probe, t.kind === 'public' ? PUBLIC_IDS : OBSERVER_IDS);

      // Assert the viewport override actually took. If this ever fails, every overflow
      // number below is meaningless and must be discarded rather than interpreted.
      r.viewportOk = r.probe.vw === t.w;
      r.overflow = r.probe.scrollW > r.probe.vw + 1 || r.probe.offenders.length > 0;

      const png = path.join(dir, `${t.name}.png`);
      await page.screenshot({ path: png, fullPage: true });
      r.png = path.relative(OUT, png);
      r.pngBytes = fs.statSync(png).size;
    } catch (e) {
      r.fatal = String(e && e.message || e).slice(0, 400);
    } finally {
      await page.close().catch(() => {});
      record.targets.push(r);
    }
  }

  await browser.close().catch(() => {});
  record.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify(record, null, 1));

  // One line to stdout so the runner's log is a readable timeline.
  const bad = record.targets.filter(t => t.fatal || t.errors.length || t.overflow || t.viewportOk === false || t.rendered === false);
  console.log(`[ux] ${TAG} (${REASON}) targets=${record.targets.length} problems=${bad.length}`
    + bad.map(b => ` ${b.name}:${b.fatal ? 'FATAL' : ''}${b.rendered === false ? 'NORENDER ' : ''}`
      + `${b.viewportOk === false ? 'VIEWPORT ' : ''}${b.errors.length ? 'JSERR ' : ''}${b.overflow ? 'OVERFLOW' : ''}`).join(''));
})().catch(e => { console.error('[ux] fatal', e); process.exit(1); });
