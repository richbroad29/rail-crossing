#!/usr/bin/env node
// Unattended recorder for the VPS. Replaces the macOS record.sh (zsh, `date -j`,
// caffeinate) — none of which exist here, and none of which are needed on a box that
// never sleeps, which is the whole reason the run moved off the laptop.
//
//   node record-vps.js <OUTDIR> <DURATION_MIN> [--label X] [--interval 5] [--no-ux]
//
// Records RAW payloads verbatim rather than derived metrics, so any question thought of
// after the fact can be re-asked of the recording without re-running the day.
//
//  main.jsonl    localhost /crossing/:id?limit=50   every INTERVAL (default 5s)
//  live.jsonl    localhost /crossing/:id/live       every INTERVAL
//  health.jsonl  localhost /health                  every 30s   (restart detection)
//  public.jsonl  https://api.railcrossing.uk/...    every 30s   (the path real users take,
//                                                   through Caddy+TLS, with status+latency)
//  meta.json     backend HEAD, uptime, /triggers, frontend sha256s
//  frontend/     the deployed shared/*.js, pinned AND fed to the replay harness
//
// limit=50, not the default 6: an inverted period at position 12 is invisible otherwise.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const args = process.argv.slice(2);
const OUT = args[0];
const DUR_MIN = parseFloat(args[1]);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const LABEL = opt('--label', 'block');
const INTERVAL = parseFloat(opt('--interval', '5')) * 1000;
const UX = !args.includes('--no-ux');
const CROSS = opt('--crossing', 'portslade');
if (!OUT || !DUR_MIN) { console.error('usage: record-vps.js <OUTDIR> <DURATION_MIN> [--label X] [--interval 5] [--no-ux]'); process.exit(2); }

const UX_EVENT_THROTTLE_MS = 90 * 1000;    // at most one event-triggered capture per 90s
const UX_HEARTBEAT_MS = 10 * 60 * 1000;    // plus a baseline shot every 10 min
const END = Date.now() + DUR_MIN * 60 * 1000;

fs.mkdirSync(OUT, { recursive: true });
const streams = {};
const w = (name, obj) => {
  streams[name] = streams[name] || fs.createWriteStream(path.join(OUT, name + '.jsonl'), { flags: 'a' });
  streams[name].write(JSON.stringify(obj) + '\n');
};
const log = m => {
  const line = `${new Date().toISOString()} [${LABEL}] ${m}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT, 'recorder.log'), line + '\n');
};

const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
const sagent = new https.Agent({ keepAlive: true, maxSockets: 2 });

function getLocal(p) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const req = http.get({ host: '127.0.0.1', port: 3000, path: p, agent, timeout: 8000 }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ ok: true, status: res.statusCode, ms: Date.now() - t0, bytes: Buffer.byteLength(d), body: JSON.parse(d) }); }
        catch (e) { resolve({ ok: false, status: res.statusCode, ms: Date.now() - t0, err: 'parse: ' + e.message, raw: d.slice(0, 300) }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - t0, err: 'timeout' }); });
    req.on('error', e => resolve({ ok: false, ms: Date.now() - t0, err: e.message }));
  });
}

function getUrl(url) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const req = https.get(url, { agent: sagent, timeout: 12000 }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, ms: Date.now() - t0, bytes: Buffer.byteLength(d), body: d }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - t0, err: 'timeout' }); });
    req.on('error', e => resolve({ ok: false, ms: Date.now() - t0, err: e.message }));
  });
}

// ---------------------------------------------------------------- UX capture triggers
let lastUxEvent = 0, lastUxBeat = 0, uxRunning = false, uxCount = 0;
function fireUx(reason) {
  if (!UX || uxRunning) return;
  uxRunning = true; uxCount++;
  const tag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '_' + reason.replace(/[^a-z0-9]+/gi, '-').slice(0, 30);
  // Memory-capped transient scope: if a capture ever runs away it is killed by its own
  // cgroup, never by the OOM killer picking the backend and taking the live site down.
  const child = spawn('systemd-run', ['--user', '--scope', '-p', 'MemoryMax=450M', '-q',
    'node', path.join(__dirname, 'ux-capture.js'), OUT, tag, reason],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => out += d);
  const kill = setTimeout(() => child.kill('SIGKILL'), 120000);
  child.on('close', code => {
    clearTimeout(kill); uxRunning = false;
    log(`ux #${uxCount} ${reason} exit=${code} ${out.trim().split('\n').pop() || ''}`);
  });
  child.on('error', e => { clearTimeout(kill); uxRunning = false; log(`ux spawn failed: ${e.message}`); });
}

// Fingerprint of the things whose CHANGE is worth a picture.
function fingerprint(m) {
  const cs = m.upcomingClosures || [];
  const c0 = cs[0] || {};
  return {
    state: m.state,
    pending: cs.some(c => c.closePending),
    holding: cs.some(c => c.holdingOpen),
    confirmed: cs.some(c => c.closeConfirmed),
    count: cs.length,
    firstStart: c0.start || null,
    current: m.currentClosure ? 1 : 0,
  };
}

// Inline anomaly signatures — cheap, and they earn a screenshot at the moment it happens
// rather than only a row in a log to be found on Tuesday.
function anomalies(m) {
  const a = [];
  const cs = (m.upcomingClosures || []).filter(c => c.start && c.end);
  for (let i = 1; i < cs.length; i++) {
    if (new Date(cs[i].start) < new Date(cs[i - 1].end)) { a.push('period-inversion'); break; }   // C15
  }
  if (m.nextCloseTime && m.nextOpenTime && m.state === 'CLOSED'
      && new Date(m.nextCloseTime) < new Date(m.nextOpenTime)) a.push('close-before-open');       // C15 field case
  const c0 = cs[0];
  if (c0 && c0.start && c0.predictedStart && new Date(c0.predictedStart) < new Date(c0.start)) a.push('pred-before-start'); // C5
  if (m.state === 'CLOSED' && m.currentClosure === null) a.push('closed-no-current');             // C4
  return a;
}

// ---------------------------------------------------------------------------- startup
(async () => {
  log(`recording ${CROSS} -> ${OUT} for ${DUR_MIN} min (interval ${INTERVAL / 1000}s, ux=${UX})`);

  const meta = { label: LABEL, startedAt: new Date().toISOString(), durationMin: DUR_MIN, interval: INTERVAL / 1000, crossing: CROSS };

  // Pin what is deployed. A mid-window restart or deploy silently invalidates conclusions;
  // this has happened before and nearly produced a false "production is broken" finding.
  await new Promise(r => execFile('git', ['-C', process.env.HOME + '/rail-crossing', 'rev-parse', 'HEAD'],
    (e, so) => { meta.backendHead = e ? 'unknown' : so.trim(); r(); }));
  const h0 = await getLocal('/health');
  meta.startUptime = h0.ok ? h0.body.uptime : null;
  const trig = await getLocal(`/crossing/${CROSS}/triggers`);
  if (trig.ok) fs.writeFileSync(path.join(OUT, 'triggers.json'), JSON.stringify(trig.body, null, 1));

  // Download the DEPLOYED frontend: pins the version AND is what the replay harness runs.
  // backend-v2 is backend-only, so there is no shared/ on this box to replay.
  const fedir = path.join(OUT, 'frontend', 'shared');
  fs.mkdirSync(fedir, { recursive: true });
  meta.frontend = {};
  for (const f of ['predict.js', 'closure-card.js', 'crossing.js', 'crossings.json']) {
    const r = await getUrl('https://railcrossing.uk/shared/' + f);
    if (r.ok) {
      fs.writeFileSync(path.join(fedir, f), r.body);
      meta.frontend[f] = { sha256: crypto.createHash('sha256').update(r.body).digest('hex').slice(0, 16), bytes: r.bytes };
    } else meta.frontend[f] = { error: r.err || r.status };
  }
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
  log(`backend=${(meta.backendHead || '').slice(0, 7)} uptime=${Math.round(meta.startUptime || 0)}s frontend=${Object.values(meta.frontend).map(v => v.sha256 || 'ERR').join(',')}`);

  let i = 0, prevFp = null, errs = 0, samples = 0;
  fireUx('block-start');

  const tick = async () => {
    if (Date.now() >= END) return finish();
    const t = Math.floor(Date.now() / 1000);

    const [m, l] = await Promise.all([getLocal(`/crossing/${CROSS}?limit=50`), getLocal(`/crossing/${CROSS}/live`)]);
    if (m.ok) { w('main', { t, ms: m.ms, bytes: m.bytes, main: m.body }); samples++; }
    else { errs++; w('errors', { t, what: 'main', err: m.err, status: m.status }); }
    if (l.ok) w('live', { t, ms: l.ms, bytes: l.bytes, live: l.body });
    else { errs++; w('errors', { t, what: 'live', err: l.err, status: l.status }); }

    if (m.ok) {
      const fp = fingerprint(m.body);
      const an = anomalies(m.body);
      if (an.length) w('anomalies', { t, an, state: m.body.state });
      const changed = prevFp && Object.keys(fp).some(k => fp[k] !== prevFp[k]);
      const now = Date.now();
      if (an.length && now - lastUxEvent > UX_EVENT_THROTTLE_MS) { lastUxEvent = now; fireUx('anomaly-' + an[0]); }
      else if (changed && now - lastUxEvent > UX_EVENT_THROTTLE_MS) {
        const what = fp.state !== prevFp.state ? 'state-' + fp.state
          : fp.pending !== prevFp.pending ? 'closePending-' + fp.pending
          : fp.holding !== prevFp.holding ? 'holdingOpen-' + fp.holding
          : fp.confirmed !== prevFp.confirmed ? 'closeConfirmed-' + fp.confirmed : 'closures-changed';
        lastUxEvent = now; fireUx(what);
      } else if (now - lastUxBeat > UX_HEARTBEAT_MS) { lastUxBeat = now; fireUx('heartbeat'); }
      prevFp = fp;
    }

    if (i % 6 === 0) {
      getLocal('/health').then(h => { if (h.ok) w('health', { t, health: h.body }); });
      // The DEFAULT limit, which is what the apps actually request. main.jsonl uses limit=50
      // for completeness, so its byte counts would overstate the real per-poll cost by ~3x —
      // and a wrongly-extrapolated cost figure has already had to be retracted once here.
      getLocal(`/crossing/${CROSS}`).then(a => { if (a.ok) w('appview', { t, bytes: a.bytes, ms: a.ms, closureCount: a.body.closureCount, shown: (a.body.upcomingClosures || []).length }); });
      getUrl(`https://api.railcrossing.uk/crossing/${CROSS}`).then(p =>
        w('public', { t, ok: p.ok, status: p.status, ms: p.ms, bytes: p.bytes, err: p.err || null }));
    }
    if (i % 60 === 0) {
      fs.writeFileSync(path.join(OUT, 'heartbeat'), String(Date.now()));   // watchdog liveness
      log(`t+${Math.round((Date.now() - (END - DUR_MIN * 60000)) / 60000)}min samples=${samples} errors=${errs} ux=${uxCount}`);
    }
    i++;
    setTimeout(tick, INTERVAL);
  };

  const finish = async () => {
    const h1 = await getLocal('/health');
    meta.endUptime = h1.ok ? h1.body.uptime : null;
    meta.finishedAt = new Date().toISOString();
    meta.samples = samples; meta.errors = errs; meta.uxCaptures = uxCount;
    // A restart mid-window makes before/after non-comparable. Flag it loudly in the meta.
    meta.restartSuspected = (meta.startUptime != null && meta.endUptime != null && meta.endUptime < meta.startUptime);
    fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
    fs.writeFileSync(path.join(OUT, 'record.done'), new Date().toISOString() + '\n');
    log(`done samples=${samples} errors=${errs} ux=${uxCount} restartSuspected=${meta.restartSuspected}`);
    Object.values(streams).forEach(s => s.end());
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGTERM', finish);
  process.on('SIGINT', finish);
  tick();
})();
