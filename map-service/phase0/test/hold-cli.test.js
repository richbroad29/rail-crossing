'use strict';

// lib/hold.js (every way a run can end, and that the first one wins) and lib/cli.js (argument
// parsing that fails in plain words, scrubbed progress lines, signal wiring).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');
const { StopController, holdTopic } = require('../lib/hold');
const cli = require('../lib/cli');

// A session stand-in with just the surface holdTopic uses.
function fakeSession() {
  const s = new EventEmitter();
  s.subscribedAt = null;
  s.closedInfo = null;
  s.stats = { frames: 0, firstFrameAt: null, lastFrameAt: null, maxGapMs: 0, handlerErrors: 0, firstHandlerError: null };
  s.subscribed = []; s.closes = 0;
  s.subscribe = (topic, onBody) => { s.subscribed.push(topic); s.onBody = onBody; s.subscribedAt = Date.now(); };
  s.close = async () => { s.closes++; return { clean: true, how: 'receipt', ms: 1 }; };
  s.deliver = body => { const t = Date.now(); if (s.stats.firstFrameAt === null) s.stats.firstFrameAt = t; s.stats.lastFrameAt = t; s.stats.frames++; s.onBody(body, {}, t); };
  return s;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- holdTopic -------------------------------------------------------------------------------------

test('hold: ends on the duration, subscribes once, and leaves properly', async () => {
  const s = fakeSession();
  const got = [];
  const p = holdTopic({ session: s, topic: '/topic/X', onBody: b => got.push(b), durationMs: 60, stop: new StopController() });
  await sleep(10);
  s.deliver('a'); s.deliver('b');
  const r = await p;
  assert.equal(r.endedBy, 'duration');
  assert.equal(r.subscribed, true);
  assert.deepEqual(s.subscribed, ['/topic/X']);
  assert.equal(s.closes, 1);
  assert.equal(r.frames, 2);
  assert.ok(r.firstFrameAfterMs >= 5 && r.firstFrameAfterMs < 60);
  assert.deepEqual(got, ['a', 'b']);
  assert.equal(r.close.how, 'receipt');
});

test('hold: endedAt is when the run ENDED, not when the goodbye finished', async () => {
  const s = fakeSession();
  s.close = async () => { await sleep(200); s.closes++; return { clean: true, how: 'receipt', ms: 200 }; };
  const t0 = Date.now();
  const r = await holdTopic({ session: s, topic: '/topic/X', onBody() {}, durationMs: 50, stop: new StopController() });
  assert.ok(Date.now() - t0 >= 240, 'the slow goodbye really did take time');
  assert.ok(r.endedAt - r.startedAt >= 45 && r.endedAt - r.startedAt < 150, `measured window ${r.endedAt - r.startedAt} ms excludes the 200 ms goodbye`);
});

test('hold: a stop request (interlock trip, Ctrl-C) ends it at once, carrying the reason', async () => {
  const s = fakeSession();
  const stop = new StopController();
  const t0 = Date.now();
  const p = holdTopic({ session: s, topic: '/topic/X', onBody() {}, durationMs: 60000, stop });
  setTimeout(() => stop.request({ type: 'interlock', verdict: { rule: 'td-stale' } }), 20);
  const r = await p;
  assert.equal(r.endedBy, 'interlock');
  assert.equal(r.detail.verdict.rule, 'td-stale');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(s.closes, 1);
});

test('hold: a signal is just another stop reason', async () => {
  const s = fakeSession();
  const stop = new StopController();
  const p = holdTopic({ session: s, topic: '/topic/X', onBody() {}, durationMs: 60000, stop });
  setTimeout(() => stop.request({ type: 'signal', name: 'SIGTERM' }), 10);
  const r = await p;
  assert.equal(r.endedBy, 'signal');
  assert.equal(r.detail.name, 'SIGTERM');
});

test('hold: a stop requested BEFORE it starts (during connect) means it never subscribes', async () => {
  const s = fakeSession();
  const stop = new StopController();
  stop.request({ type: 'interlock', verdict: { rule: 'health-unreachable' } });
  const r = await holdTopic({ session: s, topic: '/topic/X', onBody() {}, durationMs: 60000, stop });
  assert.equal(r.endedBy, 'interlock');
  assert.equal(r.subscribed, false);
  assert.deepEqual(s.subscribed, []);
  assert.equal(s.closes, 1, 'but it still says goodbye');
});

test('hold: the first stop request wins; later ones are ignored', () => {
  const stop = new StopController();
  assert.equal(stop.request({ type: 'signal', name: 'SIGINT' }), true);
  assert.equal(stop.request({ type: 'interlock' }), false);
  assert.equal(stop.reason.type, 'signal');
});

test('hold: NROD dropping us (an UNEXPECTED close) ends it; our own close does not count', async () => {
  const s = fakeSession();
  const p = holdTopic({ session: s, topic: '/topic/X', onBody() {}, durationMs: 60000, stop: new StopController() });
  await sleep(10);
  s.emit('closed', { unexpected: false, error: null });   // ignored
  await sleep(10);
  s.emit('closed', { unexpected: true, error: { kind: 'server-closed' } });
  const r = await p;
  assert.equal(r.endedBy, 'closed');
  assert.equal(r.detail.error.kind, 'server-closed');
});

test('hold: a session that died before we got going is seen at once', async () => {
  const s = fakeSession();
  const origSubscribe = s.subscribe;
  s.subscribe = (...a) => { origSubscribe(...a); s.closedInfo = { unexpected: true, error: { kind: 'not-authorised' } }; };
  const r = await holdTopic({ session: s, topic: '/topic/X', onBody() {}, durationMs: 60000, stop: new StopController() });
  assert.equal(r.endedBy, 'closed');
  assert.equal(r.detail.error.kind, 'not-authorised');
});

test('hold: a feed that goes quiet is "silent" — but only if it really is', async () => {
  const s = fakeSession();
  const p = holdTopic({ session: s, topic: '/topic/X', onBody() {}, durationMs: 60000, silenceMs: 120, stop: new StopController() });
  const r = await p;
  assert.equal(r.endedBy, 'silent');
  assert.ok(r.detail.silentForMs >= 120);

  const live = fakeSession();
  const stop = new StopController();
  const q = holdTopic({ session: live, topic: '/topic/X', onBody() {}, durationMs: 400, silenceMs: 150, stop });
  const feeder = setInterval(() => live.deliver('x'), 30);
  const r2 = await q;
  clearInterval(feeder);
  assert.equal(r2.endedBy, 'duration', 'steady traffic keeps the silence watchdog quiet');
});

test('hold: periodic work runs on its interval, can stop the run, and stops running afterwards', async () => {
  const s = fakeSession();
  let calls = 0;
  const r = await holdTopic({
    session: s, topic: '/topic/X', onBody() {}, durationMs: 60000, stop: new StopController(),
    tick: { everyMs: 20, fn: ctl => { calls++; if (calls === 3) ctl.stop('guard', { rule: 'memory-floor' }); } }
  });
  assert.equal(r.endedBy, 'guard');
  assert.equal(r.detail.rule, 'memory-floor');
  assert.equal(calls, 3);
  await sleep(100);
  assert.equal(calls, 3, 'the interval was cleared');
});

test('hold: a tick that throws ends the run as an error rather than crashing it', async () => {
  const r = await holdTopic({
    session: fakeSession(), topic: '/topic/X', onBody() {}, durationMs: 60000, stop: new StopController(),
    tick: { everyMs: 10, fn: () => { throw new Error('sampler broke'); } }
  });
  assert.equal(r.endedBy, 'error');
  assert.equal(r.detail.message, 'sampler broke');
});

test('hold: whichever comes first wins', async () => {
  const stop = new StopController();
  const r = await holdTopic({ session: fakeSession(), topic: '/topic/X', onBody() {}, durationMs: 30, stop });
  assert.equal(r.endedBy, 'duration');
  stop.request({ type: 'signal', name: 'SIGINT' });   // too late; nothing to assert beyond "no throw"
});

// ---- cli ---------------------------------------------------------------------------------------------

test('cli: an unknown option, a missing value and a stray word each say what to do', () => {
  assert.throws(() => cli.parseOptions(['--bogus']), e => e instanceof cli.UsageError && /Unknown option --bogus.*--help/.test(e.message));
  assert.throws(() => cli.parseOptions(['--env']), e => e instanceof cli.UsageError && /--env needs a value/.test(e.message));
  assert.throws(() => cli.parseOptions(['stray']), e => e instanceof cli.UsageError && /Unexpected extra word.*--help/.test(e.message));
  assert.throws(() => cli.parseOptions(['--out', '--debug']), e => e instanceof cli.UsageError && /--help/.test(e.message));
});

test('cli: options parse, including the extras a script adds', () => {
  const v = cli.parseOptions(['--env', '/x/.env', '--no-interlock', '--minutes', '5', '--debug'], { minutes: { type: 'string' } });
  assert.deepEqual(v, { env: '/x/.env', 'no-interlock': true, minutes: '5', debug: true });
  assert.equal(cli.parseOptions(['-h']).help, true);
  assert.equal(cli.parseOptions(['--help']).help, true);
});

test('cli: intOption — whole numbers in range, the default when absent, plain words otherwise', () => {
  const o = { min: 1, max: 240, def: 60 };
  assert.equal(cli.intOption('minutes', undefined, o), 60);
  assert.equal(cli.intOption('minutes', '1', o), 1);
  assert.equal(cli.intOption('minutes', '240', o), 240);
  assert.equal(cli.intOption('minutes', ' 90 ', o), 90);
  for (const bad of ['0', '241', '-5', '1.5', 'abc', '', '1e2', '0x10', '60m']) {
    assert.throws(() => cli.intOption('minutes', bad, o), e => e instanceof cli.UsageError && /--minutes must be a whole number from 1 to 240/.test(e.message) && e.message.includes(`"${bad}"`), bad);
  }
});

test('cli: resolveCommon — defaults, ~ expansion, the out folder next to the scripts, validation', () => {
  const os = require('os');
  const d = cli.resolveCommon({});
  assert.equal(d.envFile, path.join(os.homedir(), 'rail-crossing/backend/.env'));
  assert.equal(d.tdLogDir, path.join(os.homedir(), 'rail-crossing/backend/data/logs/td'));
  assert.equal(d.healthUrl, 'http://127.0.0.1:3000/health');
  assert.equal(d.outDir, path.join(cli.PHASE0_DIR, 'out'));
  assert.ok(d.outDir.endsWith(path.join('map-service', 'phase0', 'out')));
  assert.equal(d.interlock, true);
  assert.deepEqual(d.stomp, { host: undefined, port: undefined });
  const c = cli.resolveCommon({ env: '~/x/.env', out: '~/reports', 'no-interlock': true, 'stomp-host': '127.0.0.1', 'stomp-port': '61618', debug: true });
  assert.equal(c.envFile, path.join(os.homedir(), 'x/.env'));
  assert.equal(c.outDir, path.join(os.homedir(), 'reports'));
  assert.equal(c.interlock, false);
  assert.deepEqual(c.stomp, { host: '127.0.0.1', port: 61618 });
  assert.equal(c.debug, true);
  for (const bad of ['localhost:3000/health', 'ftp://x/health', 'not a url', '']) {
    if (bad === '') continue; // empty means "use the default"
    assert.throws(() => cli.resolveCommon({ 'health-url': bad }), e => e instanceof cli.UsageError && /--health-url must be a web address/.test(e.message), bad);
  }
  assert.equal(cli.resolveCommon({ 'health-url': 'https://example.org/health' }).healthUrl, 'https://example.org/health');
  assert.throws(() => cli.resolveCommon({ 'stomp-port': '70000' }), /--stomp-port must be a whole number/);
});

test('cli: ensureOutDir creates the folder, accepts one that exists, and refuses one that cannot be a folder', () => {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-out-'));
  const nested = path.join(dir, 'a', 'b', 'out');
  assert.doesNotThrow(() => cli.ensureOutDir(nested));
  assert.ok(fs.statSync(nested).isDirectory());
  assert.doesNotThrow(() => cli.ensureOutDir(nested), 'again is fine');
  const file = path.join(dir, 'a-file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => cli.ensureOutDir(path.join(file, 'out')), e => e instanceof cli.UsageError && /Cannot write the report to .*\(ENOTDIR\).*--out/.test(e.message));
  assert.throws(() => cli.ensureOutDir(file), e => e instanceof cli.UsageError, 'a file is not a folder');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cli: progress lines carry a UTC clock, and a credential in the text never gets out', () => {
  const out = [];
  const say = cli.makeSay({ write: s => out.push(s) }, ['hunter2'], () => Date.parse('2026-11-02T10:15:30Z'));
  say('connected as rich with hunter2');
  assert.deepEqual(out, ['[10:15:30] connected as rich with ***\n']);
  const write = cli.makeWrite({ write: s => out.push(s) }, ['hunter2']);
  write('box hunter2');
  assert.equal(out[1], 'box ***\n');
});

test('cli: a closed terminal (an SSH drop) cannot crash a progress line', () => {
  const say = cli.makeSay({ write() { throw Object.assign(new Error('write EIO'), { code: 'EIO' }); } }, []);
  assert.doesNotThrow(() => say('anything'));
  assert.doesNotThrow(() => cli.makeWrite({ write() { throw new Error('x'); } }, [])('anything'));
});

test('cli: fmtDuration', () => {
  assert.equal(cli.fmtDuration(0), '0s');
  assert.equal(cli.fmtDuration(59400), '59s');
  assert.equal(cli.fmtDuration(61000), '1m 01s');
  assert.equal(cli.fmtDuration(3725000), '1h 02m 05s');
});

test('cli: friendlyError — no stack unless asked, and what to do when it is unexpected', () => {
  assert.equal(cli.friendlyError(new cli.UsageError('bad flag')), 'bad flag');
  assert.match(cli.friendlyError(Object.assign(new Error('Cannot read the credentials file /x'), { code: 'ENV_UNREADABLE' })), /^Cannot read the credentials file/);
  const err = new Error('boom');
  const plain = cli.friendlyError(err);
  assert.match(plain, /Something unexpected went wrong: boom\./);
  assert.match(plain, /--debug/);
  assert.ok(!/\n\s+at /.test(plain), 'no stack frames');
  assert.match(cli.friendlyError(err, { debug: true }), /Error: boom\n\s+at /);
  assert.match(cli.friendlyError('a string'), /a string/);
});

test('cli: signal handlers are installed for INT, TERM and HUP, and can be removed', () => {
  const em = new EventEmitter();
  const seen = [];
  const off = cli.watchSignals(em, n => seen.push(n));
  em.emit('SIGINT'); em.emit('SIGTERM'); em.emit('SIGHUP');
  assert.deepEqual(seen, ['SIGINT', 'SIGTERM', 'SIGHUP']);
  off();
  em.emit('SIGINT');
  assert.equal(seen.length, 3);
  assert.equal(em.listenerCount('SIGINT') + em.listenerCount('SIGTERM') + em.listenerCount('SIGHUP'), 0);
});

test('cli: the journal check names the window, in UTC, with a minute of slack before and 30 s after', () => {
  const lines = cli.journalCheckLines(Date.parse('2026-11-02T10:15:00Z'), Date.parse('2026-11-02T11:15:20Z')).join('\n');
  assert.match(lines, /--since "2026-11-02 10:14:00 UTC" --until "2026-11-02 11:15:50 UTC"/);
  assert.match(lines, /grep -E "TD \(STOMP\|subscribe\|reconnecting\|feed silent\)"/);
  assert.match(lines, /No output means/);
});
