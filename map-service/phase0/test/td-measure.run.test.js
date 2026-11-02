'use strict';

// td-measure end to end, in-process: the real stompit, a fake STOMP server, a fake /health, the
// real Report writing real files. Durations are a second or so; every timing the interlock and
// the sampler use is shortened through the same seams the real script exposes.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { healthyBody } = require('./helpers/fake-health');
const { feed } = require('./helpers/td-gen');
const { makeRig, check, noSecrets, LOGIN } = require('./helpers/rig');
const { run } = require('../bin/td-measure');
const stomp = require('../lib/stomp');

const TOPIC = '/topic/TD_ALL_SIG_AREA';
const cleanups = [];
const rig = makeRig(cleanups, { minutes: 1 });

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch (_) { /* best effort */ } }
  stomp._resetForTest();
});

// ---- the clean run -----------------------------------------------------------------------------------

test('a clean run: planted frames counted exactly, report written, no secret anywhere, and we leave properly', async () => {
  const r = await rig();
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe();
  const t = Date.now();
  for (let i = 0; i < 30; i++) {
    r.srv.publish(TOPIC, JSON.stringify([
      { CC_MSG: { time: String(t + i), area_id: 'LA', msg_type: 'CC', descr: `D${i}`, to: '0001' } },
      { CA_MSG: { time: String(t + i + 40), area_id: 'LA', msg_type: 'CA', descr: `D${i}`, from: '0001', to: '0002' } },
      { CT_MSG: { time: String(t + i), area_id: 'LA', msg_type: 'CT', report_time: '1000' } }
    ]));
  }
  const code = await p;
  assert.equal(code, 0, r.text());

  const rep = r.readReport();
  assert.equal(rep.exitCode, 0);
  assert.deepEqual(rep.checks.map(c => [c.id, c.status]), [['SECOND_CONNECTION', 'PASS'], ['INTERLOCK', 'PASS'], ['TD_VOLUME', 'INFO'], ['MEMORY_FIT', 'WARN']]);
  assert.match(check(rep, 'MEMORY_FIT').message, /only .* min were measured/, 'a one-second run cannot vouch for memory');

  // The planted numbers, exactly.
  const td = rep.facts.td;
  assert.equal(td.frames, 30);
  assert.equal(td.events, 90);
  assert.deepEqual(td.eventsByType, { CA: 30, CC: 30, CT: 30 });
  assert.deepEqual(td.eventsPerArea, { LA: 90 });
  assert.equal(td.areas, 1);
  assert.equal(td.distinctDescriptions, 30);
  assert.equal(rep.facts.state.edges, 1);
  // All 30 steps ride the one edge, and each edge keeps a ring of at most 20 timings: that cap is
  // the memory bound the projection assumes, so 20 (not 30) is the correct number to see.
  assert.equal(rep.facts.state.samples, 20);
  assert.equal(rep.facts.state.sampleCap, 20);
  assert.equal(rep.facts.state.occupancy, 1);
  assert.ok(rep.facts.tdPerBucket.length >= 2, 'the series has buckets');
  assert.ok(rep.facts.eventLoopLag.p99Ms >= 0);
  assert.ok(rep.facts.memory.peakRssMB > 0);
  assert.ok(rep.facts.memory.samples >= 3);

  // Machine facts come first and are recorded.
  assert.ok(rep.facts.machine.nodeVersion);
  assert.ok(rep.facts.machine.cpuCount >= 0);
  assert.equal(rep.facts.machine.crossingServiceMemoryMB, 66, 'from /health');
  assert.equal(rep.facts.run.overlapsDailyReload === true || rep.facts.run.overlapsDailyReload === false, true);

  // What the server saw: one connection, non-durable, and a clean goodbye.
  assert.equal(r.srv.connections.length, 1);
  assert.deepEqual(Object.keys(r.srv.framesOf('SUBSCRIBE')[0].headers).sort(), ['ack', 'destination', 'id']);
  assert.equal(r.srv.framesOf('DISCONNECT').length, 1);
  assert.equal(rep.facts.interlock.enabled, true);
  assert.equal(rep.facts.interlock.tripped, null);
  assert.ok(rep.facts.interlock.polls >= 4, `polled ${rep.facts.interlock.polls} times`);
  assert.equal(rep.facts.interlock.afterWeLeft.disturbed, false);

  // The paste-back block, and the follow-up command for the journal.
  const text = r.text();
  assert.match(text, /===== td-measure .* paste from here =====/);
  assert.match(text, /PASS\s+SECOND_CONNECTION\s+connected in \d+ ms/);
  assert.match(text, /fact\s+eventsPerSecMean = /);
  assert.match(text, /fact\s+peakRssMB = /);
  assert.match(text, /fact\s+memAvailableMB = /);
  assert.match(text, /journalctl -u rail-crossing --since/);
  assert.deepEqual(fs.readdirSync(r.opts.outDir).filter(f => /^td-measure-.*\.(json|txt)$/.test(f)).length, 2);

  noSecrets(text);
  noSecrets(r.filesText());
  assert.equal(r.signals.listenerCount('SIGINT'), 0, 'signal handlers are removed afterwards');
});

test('the report only ever goes to the out folder', async () => {
  const r = await rig();
  const before = fs.readdirSync(r.dir).sort();
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe();
  r.srv.publish(TOPIC, '[]');
  await p;
  const after = fs.readdirSync(r.dir).sort();
  assert.deepEqual(after.filter(f => !before.includes(f)), ['out'], 'nothing new beside the out folder');
});

// ---- the interlock, end to end -------------------------------------------------------------------------

test('the crossing service goes stale mid-run: the interlock aborts, disconnects, writes the report, exits non-zero', async () => {
  const mk = healthyBody();
  const r = await rig({ healthBody: n => { const b = mk(); if (n > 5) b.td.staleSecs = 120; return b; }, extraDeps: { durationMs: 30000 } });
  const t0 = Date.now();
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe();
  const stopFeed = feed(r.srv, TOPIC, { perSec: 50 });
  const code = await p;
  stopFeed();
  assert.ok(Date.now() - t0 < 6000, `aborted promptly, not after the 30 s run (took ${Date.now() - t0} ms)`);
  assert.equal(code, 1);

  const rep = r.readReport();
  assert.equal(rep.exitCode, 1);
  assert.equal(check(rep, 'SECOND_CONNECTION').status, 'FAIL');
  assert.match(check(rep, 'SECOND_CONNECTION').message, /looked disturbed .*\(td-stale\).*120s \(limit 60s\).*closed at once/);
  assert.equal(check(rep, 'INTERLOCK').status, 'FAIL');
  assert.equal(rep.facts.interlock.tripped.rule, 'td-stale');
  assert.equal(r.srv.framesOf('DISCONNECT').length, 1, 'it said goodbye rather than just dropping');
  assert.ok(rep.facts.td.frames > 0, 'the data gathered before the abort is kept');
  const text = r.text();
  assert.match(text, /INTERLOCK TRIPPED - stopping now: the crossing service has had no TD message for 120s/);
  assert.match(text, /STOPPED: the crossing service looked disturbed \(td-stale\)/);
  assert.match(text, /still looks unwell after we disconnected.*tell us BEFORE restarting anything/);
  assert.match(text, /FAIL\s+SECOND_CONNECTION/);
  noSecrets(text);
});

test('the crossing service\'s /health stops answering mid-run: three failed polls in a row abort the run', async () => {
  const r = await rig({ extraDeps: { durationMs: 30000 } });
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe();
  r.health.setMode('500');
  const code = await p;
  assert.equal(code, 1);
  const rep = r.readReport();
  assert.equal(rep.facts.interlock.tripped.rule, 'health-unreachable');
  assert.match(rep.facts.interlock.tripped.message, /3 times running.*HTTP 500/);
  assert.equal(rep.facts.interlock.failedPolls, 3);
  assert.equal(r.srv.framesOf('DISCONNECT').length, 1);
});

test('/health unreachable at the start: refuses, explains, opens NO connection, still writes a report', async () => {
  const r = await rig({ healthUp: false });
  const code = await run(r.opts, r.deps);
  assert.equal(code, 1);
  assert.equal(r.srv.connections.length, 0, 'the NROD connection was never opened');
  const text = r.text();
  assert.match(text, /NOT STARTING\.[\s\S]*Could not read the crossing service.s health check at http:\/\/127\.0\.0\.1:\d+\/health \(ECONNREFUSED\)/);
  assert.match(text, /curl -s http:\/\/127\.0\.0\.1:\d+\/health/);
  assert.match(text, /--no-interlock/);
  const rep = r.readReport();
  assert.equal(check(rep, 'INTERLOCK').status, 'FAIL');
  assert.match(check(rep, 'INTERLOCK').message, /^refused to start: could not read/);
  assert.equal(rep.checks.length, 1, 'no verdict is invented for what was never run');
  assert.match(text, /FAIL\s+INTERLOCK\s+refused to start/);
});

test('the crossing service already unwell at the start: refuses (nothing to attribute our effect to)', async () => {
  const mk = healthyBody({ td: { connected: false } });
  const r = await rig({ healthBody: mk });
  const code = await run(r.opts, r.deps);
  assert.equal(code, 1);
  assert.equal(r.srv.connections.length, 0);
  assert.match(r.text(), /already looks unwell.*td\.connected is false/);
});

test('--no-interlock: starts, shouts about it, records it, and does not poll /health', async () => {
  const r = await rig({ extraOpts: { interlock: false } });
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe();
  r.srv.publish(TOPIC, JSON.stringify([{ CT_MSG: { time: String(Date.now()), area_id: 'LA', msg_type: 'CT' } }]));
  const code = await p;
  assert.equal(code, 0);
  assert.equal(r.health.requests, 1, 'only the one best-effort read for the machine facts');
  const text = r.text();
  assert.match(text, /THE SAFETY INTERLOCK IS OFF/);
  assert.match(text, /WARN\s+INTERLOCK\s+DISABLED by --no-interlock/);
  assert.match(text, /WARN\s+SECOND_CONNECTION.*not watched.*unverified/);
  const rep = r.readReport();
  assert.equal(rep.facts.interlock.enabled, false);
  assert.ok(rep.notes.some(n => /THE SAFETY INTERLOCK IS OFF/.test(n)), 'recorded in the report itself');
});

test('an older crossing service (no td block in /health) is watched through its LA log instead', async () => {
  const mk = healthyBody();
  // Daytime London, so the log fallback is valid; the log "grows" on every look.
  const offset = Date.parse('2026-11-02T11:00:00Z') - Date.now();
  let size = 1000;
  const r = await rig({
    healthBody: () => { const b = mk(); delete b.td; return b; },
    extraDeps: { now: () => Date.now() + offset, statFile: async () => ({ size: (size += 50), mtimeMs: Date.now() + offset - 30000 }) }
  });
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe();
  r.srv.publish(TOPIC, JSON.stringify([{ CT_MSG: { time: String(Date.now()), area_id: 'LA', msg_type: 'CT' } }]));
  const code = await p;
  assert.equal(code, 0, r.text());
  const rep = r.readReport();
  assert.equal(rep.facts.interlock.mode, 'log');
  assert.match(check(rep, 'INTERLOCK').message, /LA-log signal/);
  assert.ok(rep.notes.some(n => /watching its LA log instead/.test(n)));
});

test('an older crossing service at night: refuses to start (the log is legitimately silent overnight)', async () => {
  const mk = healthyBody();
  const offset = Date.parse('2026-11-02T02:00:00Z') - Date.now();
  const r = await rig({
    healthBody: () => { const b = mk(); delete b.td; return b; },
    extraDeps: { now: () => Date.now() + offset, statFile: async () => ({ size: 1, mtimeMs: Date.now() + offset - 1000 }) }
  });
  const code = await run(r.opts, r.deps);
  assert.equal(code, 1);
  assert.equal(r.srv.connections.length, 0);
  assert.match(r.text(), /NOT STARTING\.[\s\S]*no "td" block in \/health[\s\S]*06:00 and 23:00 London[\s\S]*02:00:00/);
});

// ---- NROD-side failures ----------------------------------------------------------------------------------

test('a refused login is a plain-words FAIL, not a crash — and the login never appears', async () => {
  const r = await rig({ pass: 'wrong-password' });
  const code = await run(r.opts, r.deps);
  assert.equal(code, 1);
  const rep = r.readReport();
  assert.equal(check(rep, 'SECOND_CONNECTION').status, 'FAIL');
  assert.match(check(rep, 'SECOND_CONNECTION').message, /could not open the second connection: NROD refused the login/);
  assert.match(check(rep, 'SECOND_CONNECTION').message, /NR_FEED_USER and NR_FEED_PASS in /);
  assert.equal(check(rep, 'TD_VOLUME').status, 'WARN');
  const all = r.text() + r.filesText();
  assert.ok(!all.includes(LOGIN));
  assert.ok(!all.includes('wrong-password'));
  assert.equal(r.srv.connections.length, 1);
  assert.match(r.text(), /could not connect:/);
});

test('NROD refusing the TD subscription itself is a FAIL that says what NROD said', async () => {
  const r = await rig({ stompOpts: { forbidden: [TOPIC] } });
  const code = await run(r.opts, r.deps);
  assert.equal(code, 1);
  const rep = r.readReport();
  assert.match(check(rep, 'SECOND_CONNECTION').message, /dropped before any TD message arrived: This login is not allowed to read \/topic\/TD_ALL_SIG_AREA/);
  noSecrets(r.text() + r.filesText());
});

test('NROD dropping the connection mid-run: the data so far is kept, and the verdict is a WARN that says so', async () => {
  const r = await rig({ extraDeps: { durationMs: 30000 } });
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe();
  const stopFeed = feed(r.srv, TOPIC, { perSec: 50 });
  await new Promise(res => setTimeout(res, 300));
  r.srv.dropAll();
  const code = await p;
  stopFeed();
  assert.equal(code, 0, 'a WARN is not a failure');
  const rep = r.readReport();
  assert.equal(check(rep, 'SECOND_CONNECTION').status, 'WARN');
  assert.match(check(rep, 'SECOND_CONNECTION').message, /connected and receiving.*dropped after/);
  assert.ok(rep.facts.td.frames >= 5);
  assert.equal(check(rep, 'INTERLOCK').status, 'PASS', 'the crossing service was fine');
});

test('a server that accepts TCP and never answers CONNECT cannot hang the run: the connect bound ends it, as a FAIL', async () => {
  const r = await rig({ stompOpts: { mode: 'blackhole' } });
  const t0 = Date.now();
  // The real bound is 30 s; shortened through the same seam so the test is quick.
  const code = await run(r.opts, { ...r.deps, connectTimeoutMs: 300 });
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.equal(code, 1);
  const rep = r.readReport();
  assert.equal(check(rep, 'SECOND_CONNECTION').status, 'FAIL');
  assert.match(check(rep, 'SECOND_CONNECTION').message, /could not open the second connection: Timed out talking to NROD/);
  assert.equal(check(rep, 'INTERLOCK').status, 'PASS', 'the crossing service was watched throughout and was fine');
  assert.equal(r.srv.framesOf('DISCONNECT').length, 0, 'never connected, so nothing to disconnect');
  await r.srv.waitFor(() => r.srv.connections[0].closed, 2000, 'the half-open socket to be closed');
});

// ---- the operator --------------------------------------------------------------------------------------------

test('Ctrl-C: stops cleanly, disconnects, still writes the report, and the verdict says it was cut short', async () => {
  const r = await rig({ extraDeps: { durationMs: 30000 } });
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe();
  r.srv.publish(TOPIC, JSON.stringify([{ CT_MSG: { time: String(Date.now()), area_id: 'LA', msg_type: 'CT' } }]));
  await new Promise(res => setTimeout(res, 150));
  r.signals.emit('SIGINT');
  const code = await p;
  assert.equal(code, 0);
  const rep = r.readReport();
  assert.equal(check(rep, 'SECOND_CONNECTION').status, 'WARN');
  assert.match(check(rep, 'SECOND_CONNECTION').message, /stopped early \(SIGINT\)/);
  assert.equal(r.srv.framesOf('DISCONNECT').length, 1);
  assert.match(r.text(), /SIGINT received - stopping cleanly/);
  assert.equal(r.signals.listenerCount('SIGINT'), 0);
  assert.deepEqual(r.exits, []);
});

test('a dropped SSH session (SIGHUP) is treated like Ctrl-C, not left to kill the run unceremoniously', async () => {
  const r = await rig({ extraDeps: { durationMs: 30000 } });
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe();
  r.signals.emit('SIGHUP');
  await p;
  assert.equal(r.srv.framesOf('DISCONNECT').length, 1);
  assert.ok(r.readReport(), 'the report exists');
});

test('a second Ctrl-C quits at once', async () => {
  const r = await rig({ extraDeps: { durationMs: 30000 } });
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe();
  r.signals.emit('SIGINT');
  r.signals.emit('SIGINT');
  await p;
  assert.deepEqual(r.exits, [130]);
  assert.match(r.text(), /SIGINT again - quitting at once/);
});

// ---- the machine ------------------------------------------------------------------------------------------------

test('the memory guard stops the run before it can hurt the box, and MEMORY_FIT says to use a second machine', async () => {
  const r = await rig({ extraDeps: { durationMs: 30000, meminfo: () => ({ memAvailableMB: 100 }) } });
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe();
  r.srv.publish(TOPIC, JSON.stringify([{ CT_MSG: { time: String(Date.now()), area_id: 'LA', msg_type: 'CT' } }]));
  const code = await p;
  const rep = r.readReport();
  assert.equal(check(rep, 'MEMORY_FIT').status, 'FAIL');
  assert.match(check(rep, 'MEMORY_FIT').message, /use a second machine/);
  assert.match(check(rep, 'MEMORY_FIT').message, /stopped early by the memory-floor guard/);
  assert.match(check(rep, 'SECOND_CONNECTION').message, /memory-floor guard/);
  assert.equal(code, 1);
  assert.match(r.text(), /GUARD memory-floor - stopping now: the machine's available memory fell to 100 MB/);
  assert.equal(r.srv.framesOf('DISCONNECT').length, 1);
});

// ---- operator errors ---------------------------------------------------------------------------------------------------

test('an unreadable credentials file: exit 2, plain words, nothing written', async () => {
  const r = await rig();
  const code = await run({ ...r.opts, envFile: '/nonexistent/.env' }, r.deps);
  assert.equal(code, 2);
  assert.match(r.err.join(''), /Cannot read the credentials file \/nonexistent\/\.env.*--env/);
  assert.equal(fs.existsSync(r.opts.outDir), false);
  assert.equal(r.srv.connections.length, 0);
});

test('a credentials file missing the password: exit 2, and it does not echo what it did find', async () => {
  const r = await rig();
  fs.writeFileSync(r.opts.envFile, `NR_FEED_USER=${LOGIN}\n`);
  const code = await run(r.opts, r.deps);
  assert.equal(code, 2);
  assert.match(r.err.join(''), /NR_FEED_USER and NR_FEED_PASS must both be set/);
  assert.ok(!r.err.join('').includes(LOGIN));
});

test('an out folder that cannot be written is refused BEFORE anything is opened, in plain words', async () => {
  const r = await rig();
  const blocker = path.join(r.dir, 'a-file');
  fs.writeFileSync(blocker, 'x');
  const code = await run({ ...r.opts, outDir: path.join(blocker, 'out') }, r.deps);
  assert.equal(code, 2);
  assert.match(r.err.join(''), /Cannot write the report to .*a-file.out \(ENOTDIR\)\. Pick a folder you can write to with --out\./);
  assert.equal(r.srv.connections.length, 0, 'no NROD connection');
  assert.equal(r.health.requests, 0, 'not even a look at the crossing service');
});

test('an out folder that breaks DURING the run: the summary is still printed, with what to do', async () => {
  const r = await rig({ extraDeps: { durationMs: 800 } });
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe();
  r.srv.publish(TOPIC, JSON.stringify([{ CT_MSG: { time: String(Date.now()), area_id: 'LA', msg_type: 'CT' } }]));
  // The folder was checked and created at the start; now put a file where it was (works as root too).
  fs.rmSync(r.opts.outDir, { recursive: true, force: true });
  fs.writeFileSync(r.opts.outDir, 'in the way');
  const code = await p;
  assert.ok(code >= 1);
  const text = r.text();
  assert.match(text, /===== td-measure .* paste from here =====/);
  assert.match(text, /Could not write the report files to .*out \(EEXIST\)/);
  assert.match(text, /copy it from the terminal/);
});

test('frames that carry no events at all do not break the verdicts (a null peak once crashed TD_VOLUME)', async () => {
  const r = await rig();
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe();
  r.srv.publish(TOPIC, '[]');
  r.srv.publish(TOPIC, 'not even json');
  const code = await p;
  assert.equal(code, 0, r.text());
  const rep = r.readReport();
  assert.equal(rep.facts.td.frames, 2);
  assert.equal(rep.facts.td.events, 0);
  assert.equal(rep.facts.td.parseErrors, 1);
  assert.equal(check(rep, 'TD_VOLUME').status, 'INFO');
  assert.match(check(rep, 'TD_VOLUME').message, /busiest second 0/);
});
