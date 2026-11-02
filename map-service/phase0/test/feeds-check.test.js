'use strict';

// feeds-check: the per-topic verdicts (pure, built from a real FeedAnalyser so the messages are
// what a real run would print), the JSON-only report, and end-to-end runs against the fake server.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { healthyBody } = require('./helpers/fake-health');
const { makeRig, check, noSecrets, LOGIN } = require('./helpers/rig');
const { run, parseCli, topicCheck, HELP, TOPICS } = require('../bin/feeds-check');
const { JsonOnlyReport } = require('../lib/json-only-report');
const { FeedAnalyser } = require('../lib/feed-fields');
const stomp = require('../lib/stomp');

const TRUST = '/topic/TRAIN_MVT_ALL_TOC';
const VSTP = '/topic/VSTP_ALL';
const cleanups = [];
const rig = makeRig(cleanups, { minutes: { trust: 3, vstp: 10 }, only: null });
const WINDOWS = { windowsMs: { trust: 600, vstp: 600 } };

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch (_) { /* best effort */ } }
  stomp._resetForTest();
});

// ---- fixtures -------------------------------------------------------------------------------------

const hdr = type => ({ msg_type: type, source_dev_id: '', user_id: '', original_data_source: 'SDR', msg_queue_timestamp: '1730000000000', source_system_id: 'TRUST' });
const movement = (over = {}, drop = []) => {
  const body = { train_id: '172A41MA02', event_type: 'ARRIVAL', loc_stanox: '87100', actual_timestamp: '1730000000000', planned_timestamp: '1730000000000', timetable_variation: '1', variation_status: 'LATE', platform: ' 2', ...over };
  for (const k of drop) delete body[k];
  return { header: hdr('0003'), body };
};
const activation = () => ({ header: hdr('0001'), body: { train_id: '172A41MA02', train_uid: 'W12345', schedule_start_date: '2026-11-02' } });
const trustFrame = (...items) => JSON.stringify(items);
const vstpCreate = (over = {}) => JSON.stringify({
  VSTPCIFMsgV1: {
    owner: 'Network Rail',
    schedule: {
      transaction_type: 'Create', CIF_train_uid: 'W99999', schedule_start_date: '2026-11-03', schedule_end_date: '2026-11-03', schedule_days_runs: '0100000', train_status: '1', CIF_stp_indicator: 'N',
      schedule_segment: [{ signalling_id: '1A23', CIF_train_category: 'EE', schedule_location: [{ location: { tiploc: { tiploc_id: 'BRGHTN' } }, scheduled_departure_time: '101500' }] }], ...over
    }
  }
});

function analysisOf(feed, bodies) {
  const a = new FeedAnalyser(feed);
  for (const b of bodies) a.ingest(b);
  return a.summary();
}
const ok = (over = {}) => ({ endedBy: 'duration', detail: null, frames: 3, firstFrameAfterMs: 400, close: { how: 'receipt' }, ...over });
const T = (over = {}) => ({ windowMs: 180000, ranMs: 180000, skipped: null, connectError: null, outcome: ok(), analysis: null, connectMs: 90, ...over });
const trustAnalysis = () => analysisOf('trust', [
  trustFrame(movement(), movement({ platform: '' }), activation()),
  trustFrame(movement({ planned_timestamp: null }, ['platform']), { header: hdr('0002'), body: { train_id: 'X' } })
]);
const errOf = (kind, extra = {}) => new stomp.StompError({ kind, phase: 'connect', topic: null, code: null, serverMessage: null, serverDetail: null, message: `a ${kind} problem`, ...extra });

// ---- topicCheck (pure) ------------------------------------------------------------------------------

test('PASS: subscribed and messages arrived — with the types, and how many carry each planned field', () => {
  const c = topicCheck(TOPICS.trust, T({ analysis: trustAnalysis(), outcome: ok({ frames: 2 }) }));
  assert.equal(c.id, 'TRUST_FEED');
  assert.equal(c.status, 'PASS');
  assert.match(c.message, /^subscribed, and 2 messages arrived in 3m 00s \(first after 0\.4 s\)\./);
  assert.match(c.message, /Types: 0003 \(movement\) 60%, 0001 \(activation\) 20%, 0002 \(cancellation\) 20%\./);
  assert.match(c.message, /0003 \(movement\) fields populated: train_id 100%, event_type 100%, loc_stanox 100%, actual_timestamp 100%, planned_timestamp 66\.7%, timetable_variation 100%, variation_status 100%, platform 33\.3%\./);
  assert.equal(c.data.topic, TRUST);
  assert.equal(c.data.frames, 2);
  assert.equal(c.data.analysis.items, 5);
});

test('PASS for VSTP quotes the CREATE fields, and short path names', () => {
  const a = analysisOf('vstp', [vstpCreate(), vstpCreate({ schedule_segment: [] })]);
  const c = topicCheck(TOPICS.vstp, T({ analysis: a, outcome: ok({ frames: 2 }) }));
  assert.equal(c.status, 'PASS');
  assert.match(c.message, /Types: VSTPCIFMsgV1:Create 100%\. VSTPCIFMsgV1:Create fields populated: transaction_type 100%, CIF_train_uid 100%/);
  assert.match(c.message, /signalling_id 50%, CIF_train_category 50%, tiploc_id 50%, scheduled_departure_time 50%\./);
});

test('PASS notes messages that were not JSON, and a window cut short', () => {
  const a = analysisOf('trust', [trustFrame(movement()), 'garbage']);
  assert.match(topicCheck(TOPICS.trust, T({ analysis: a })).message, /platform \d+(\.\d+)?%\. 1 messages were not JSON\.$/);
  const cut = (outcome) => topicCheck(TOPICS.trust, T({ analysis: trustAnalysis(), ranMs: 61000, outcome: ok(outcome) })).message;
  assert.match(cut({ endedBy: 'signal', detail: { name: 'SIGINT' } }), /platform 33\.3%\. Cut short after 1m 01s of 3m 00s by SIGINT\.$/);
  assert.match(cut({ endedBy: 'interlock', detail: { verdict: { rule: 'td-stale' } } }), /by the safety check \(td-stale\)\.$/);
  assert.match(cut({ endedBy: 'closed', detail: {} }), /by the connection being dropped\.$/);
  assert.ok(!/\.;|\.\./.test(cut({ endedBy: 'signal', detail: { name: 'SIGINT' } })), 'no stray punctuation where sentences join');
});

test('WARN: subscribed, no error, no messages — inconclusive, with the exact flag to lengthen the window', () => {
  const trust = topicCheck(TOPICS.trust, T({ outcome: ok({ frames: 0, firstFrameAfterMs: null }), analysis: analysisOf('trust', []) }));
  assert.equal(trust.status, 'WARN');
  assert.match(trust.message, /subscribed with no error, but no messages in 3m 00s: inconclusive\. Run it again with a longer window, e\.g\. --trust-minutes 10$/);
  const vstp = topicCheck(TOPICS.vstp, T({ ranMs: 600000, windowMs: 600000, outcome: ok({ frames: 0, firstFrameAfterMs: null }), analysis: analysisOf('vstp', []) }));
  assert.equal(vstp.status, 'WARN');
  assert.match(vstp.message, /inconclusive \(VSTP is sparse\)\. Run it again with a longer window, e\.g\. --vstp-minutes 60$/);
});

test('WARN: stopped early before any message — inconclusive, and says why in one phrase', () => {
  const c = topicCheck(TOPICS.trust, T({ ranMs: 20000, outcome: ok({ endedBy: 'interlock', detail: { verdict: { rule: 'td-stale' } }, frames: 0, firstFrameAfterMs: null }) }));
  assert.equal(c.status, 'WARN');
  assert.equal(c.message, 'stopped after 20s of 3m 00s by the safety check (td-stale), before any message arrived: inconclusive');
});

test('FAIL: not authorised — the exact fix in plain words, naming the feed', () => {
  const closed = (label, topic) => ok({ endedBy: 'closed', frames: 0, firstFrameAfterMs: null, detail: { unexpected: true, error: errOf('not-authorised', { topic }) } });
  const t = topicCheck(TOPICS.trust, T({ outcome: closed('TRUST', TRUST) }));
  assert.equal(t.status, 'FAIL');
  assert.equal(t.message, `NOT AUTHORISED: this login may not read ${TRUST}. Fix: switch on the TRUST feed for your account in the NROD portal, then run this again.`);
  const v = topicCheck(TOPICS.vstp, T({ outcome: closed('VSTP', VSTP) }));
  assert.match(v.message, /switch on the VSTP feed for your account in the NROD portal, then run this again\.$/);
});

test('FAIL: could not connect — explained in the words of lib/stomp, and the feed is not blamed', () => {
  const c = topicCheck(TOPICS.trust, T({ connectError: errOf('auth', { serverMessage: 'User name [***] or password is invalid.' }), outcome: null }), { envFile: '/x/.env' });
  assert.equal(c.status, 'FAIL');
  assert.match(c.message, /could not connect, so TRUST was not tested: NROD refused the login.*NR_FEED_USER and NR_FEED_PASS in \/x\/\.env/);
  assert.match(topicCheck(TOPICS.trust, T({ connectError: errOf('network', { code: 'ECONNREFUSED' }), outcome: null })).message, /Could not reach NROD.*ECONNREFUSED/);
});

test('FAIL: dropped before any message for a reason that is not authorisation', () => {
  const c = topicCheck(TOPICS.trust, T({ outcome: ok({ endedBy: 'closed', frames: 0, firstFrameAfterMs: null, detail: { error: errOf('server-error', { serverMessage: 'Too many consumers' }) } }) }));
  assert.equal(c.status, 'FAIL');
  assert.match(c.message, /connected, but the connection ended before any message arrived: NROD sent an error we do not recognise: "Too many consumers"/);
});

test('WARN: a skipped topic says why; a connect cancelled by Ctrl-C is not a failure', () => {
  assert.equal(topicCheck(TOPICS.vstp, T({ skipped: 'stopped by SIGINT before it began' })).message, 'not checked: stopped by SIGINT before it began');
  const c = topicCheck(TOPICS.trust, T({ connectError: errOf('aborted'), outcome: null }));
  assert.equal(c.status, 'WARN');
  assert.match(c.message, /^not checked: stopped before the connection was ready/);
});

// ---- the JSON-only report -------------------------------------------------------------------------------

test('JsonOnlyReport: examples are in the JSON, scrubbed, and nowhere else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-jsonly-'));
  const secret = 'hunter2$"x';
  const r = new JsonOnlyReport('unit', { outDir: dir, secrets: [secret], now: () => new Date('2026-11-02T10:15:00Z') });
  r.fact('rows', 1, { summary: true }).check('A', 'PASS', 'fine');
  r.jsonOnly('trust', { '0003': { body: { train_id: 'MARKER-EXAMPLE-123', note: `leaked ${secret}` } } });
  const chunks = [];
  r.finish({ write: s => chunks.push(s) });
  const files = fs.readdirSync(dir);
  const json = fs.readFileSync(path.join(dir, files.find(f => f.endsWith('.json'))), 'utf8');
  const txt = fs.readFileSync(path.join(dir, files.find(f => f.endsWith('.txt'))), 'utf8');
  assert.match(json, /MARKER-EXAMPLE-123/);
  assert.equal(JSON.parse(json).examples.trust['0003'].body.train_id, 'MARKER-EXAMPLE-123');
  assert.ok(!json.includes(secret) && !json.includes(JSON.stringify(secret).slice(1, -1)), 'scrubbed in the JSON');
  assert.ok(!txt.includes('MARKER-EXAMPLE-123'), 'not in the readable report');
  assert.ok(!chunks.join('').includes('MARKER-EXAMPLE-123'), 'not in the paste-back block');
  assert.equal(Object.keys(JSON.parse(json)).includes('examples'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the command line -----------------------------------------------------------------------------------------

test('parseCli: defaults 3 and 10 minutes, --only, ranges, --help', () => {
  const d = parseCli([]);
  assert.deepEqual(d.options.minutes, { trust: 3, vstp: 10 });
  assert.equal(d.options.only, null);
  assert.deepEqual(parseCli(['--trust-minutes', '5', '--vstp-minutes', '60']).options.minutes, { trust: 5, vstp: 60 });
  assert.equal(parseCli(['--only', 'vstp']).options.only, 'vstp');
  assert.equal(parseCli(['--only', 'trust']).options.only, 'trust');
  assert.throws(() => parseCli(['--only', 'darwin']), /--only must be "trust" or "vstp" \(you gave "darwin"\)/);
  assert.throws(() => parseCli(['--vstp-minutes', '0']), /--vstp-minutes must be a whole number from 1 to 240/);
  assert.throws(() => parseCli(['--trust-minutes', '241']), /--trust-minutes must be a whole number from 1 to 240/);
  assert.equal(parseCli(['--help']).help, true);
  assert.equal(parseCli(['--no-interlock']).options.interlock, false);
});

test('--help lists every option the brief names, the verdicts, and the exact command', () => {
  for (const flag of ['--trust-minutes', '--vstp-minutes', '--only', '--env', '--health-url', '--td-log-dir', '--out', '--no-interlock', '--help']) assert.ok(HELP.includes(flag), flag);
  assert.match(HELP, /nice -n 19 node bin\/feeds-check\.js/);
  assert.match(HELP, /PASS .*subscribed, and messages arrived/);
  assert.match(HELP, /WARN .*no messages in the window: inconclusive/);
  assert.match(HELP, /FAIL .*not allowed to read the feed/);
  assert.match(HELP, /AFTER switching the TRUST and VSTP feeds on/);
});

// ---- end to end ------------------------------------------------------------------------------------------------

test('both feeds deliver: two connections, one after the other, each non-durable, each left cleanly', async () => {
  const r = await rig({ extraDeps: WINDOWS });
  const p = run(r.opts, r.deps);

  await r.srv.waitForSubscribe(1);
  r.srv.publish(TRUST, trustFrame(movement({ train_id: 'MARKER-EXAMPLE-123' }), movement({ platform: '' }), activation()));
  r.srv.publish(TRUST, trustFrame(movement({ planned_timestamp: '' }, ['platform']), { header: hdr('0002'), body: { train_id: 'C1' } }));
  await r.srv.waitForSubscribe(2);                                   // the second connection exists only after the first has gone
  r.srv.publish(VSTP, vstpCreate());
  r.srv.publish(VSTP, vstpCreate({ schedule_segment: [] }));
  const code = await p;
  assert.equal(code, 0, r.text());

  const rep = r.readReport();
  assert.deepEqual(rep.checks.map(c => [c.id, c.status]), [['TRUST_FEED', 'PASS'], ['VSTP_FEED', 'PASS'], ['INTERLOCK', 'PASS']]);
  assert.equal(rep.facts.trustMessages, 2);
  assert.equal(rep.facts.vstpMessages, 2);
  assert.deepEqual(Object.fromEntries(Object.entries(rep.facts.trust.byType).map(([k, v]) => [k, v.count])), { '0003': 3, '0001': 1, '0002': 1 });
  // platform: in 2 of the 3 movements (one of those two is blank), absent from the third.
  assert.equal(rep.facts.trust.types['0003'].planned.platform.presentPct, 66.7);
  assert.equal(rep.facts.trust.types['0003'].planned.platform.populatedPct, 33.3);
  assert.equal(rep.facts.trust.types['0003'].planned.planned_timestamp.populatedPct, 66.7);
  assert.deepEqual(rep.facts.trust.topLevelKeys, { body: 5, header: 5 });
  assert.equal(rep.facts.vstp.topLevelKeys.VSTPCIFMsgV1, 2);
  assert.equal(rep.facts.vstp.types['VSTPCIFMsgV1:Create'].planned['schedule_segment[0].signalling_id'].present, 1);

  // Examples: one per type, in the JSON only.
  assert.deepEqual(Object.keys(rep.examples.trust).sort(), ['0001', '0002', '0003']);
  assert.equal(rep.examples.trust['0003'].body.train_id, 'MARKER-EXAMPLE-123');
  assert.deepEqual(Object.keys(rep.examples.vstp), ['VSTPCIFMsgV1:Create']);
  assert.ok(!r.readText().includes('MARKER-EXAMPLE-123'));
  assert.ok(!r.text().includes('MARKER-EXAMPLE-123'));

  // The server's view: strictly one connection at a time, each with its own id and a clean goodbye.
  assert.equal(r.srv.connections.length, 2);
  assert.deepEqual(r.srv.frames.map(f => `${f.connId}:${f.command}`), ['1:CONNECT', '1:SUBSCRIBE', '1:DISCONNECT', '2:CONNECT', '2:SUBSCRIBE', '2:DISCONNECT']);
  const subs = r.srv.framesOf('SUBSCRIBE');
  assert.deepEqual(subs.map(f => f.headers.destination), [TRUST, VSTP]);
  for (const s of subs) assert.deepEqual(Object.keys(s.headers).sort(), ['ack', 'destination', 'id']);
  const ids = r.srv.framesOf('CONNECT').map(f => f.headers['client-id']);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.match(id, /^rail-map-phase0-\d+-[0-9a-f]{8}$/);

  const text = r.text();
  assert.match(text, /===== feeds-check .* paste from here =====/);
  assert.match(text, /PASS\s+TRUST_FEED\s+subscribed, and 2 messages arrived/);
  assert.match(text, /fact\s+trustMessages = 2/);
  assert.match(text, /journalctl -u rail-crossing --since/);
  noSecrets(text);
  noSecrets(r.filesText());
});

test('TRUST not switched on: FAIL with the fix, and VSTP is still checked', async () => {
  const r = await rig({ stompOpts: { forbidden: [TRUST] }, extraDeps: WINDOWS });
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe(2);
  r.srv.publish(VSTP, vstpCreate());
  const code = await p;
  assert.equal(code, 1);
  const rep = r.readReport();
  assert.equal(check(rep, 'TRUST_FEED').status, 'FAIL');
  assert.equal(check(rep, 'TRUST_FEED').message, `NOT AUTHORISED: this login may not read ${TRUST}. Fix: switch on the TRUST feed for your account in the NROD portal, then run this again.`);
  assert.equal(check(rep, 'VSTP_FEED').status, 'PASS');
  assert.equal(check(rep, 'INTERLOCK').status, 'PASS');
  assert.equal(r.srv.connections.length, 2, 'a refused subscription is specific to the topic: the next one still runs');
  assert.match(r.text(), /FAIL\s+TRUST_FEED\s+NOT AUTHORISED/);
  noSecrets(r.text() + r.filesText());
});

test('subscribed but silent: WARN (inconclusive), naming the flag to lengthen it — not a failure', async () => {
  const r = await rig({ extraDeps: WINDOWS });
  const code = await run(r.opts, r.deps);
  assert.equal(code, 0, r.text());
  const rep = r.readReport();
  assert.equal(check(rep, 'TRUST_FEED').status, 'WARN');
  assert.match(check(rep, 'TRUST_FEED').message, /e\.g\. --trust-minutes 10$/);
  assert.equal(check(rep, 'VSTP_FEED').status, 'WARN');
  assert.match(check(rep, 'VSTP_FEED').message, /\(VSTP is sparse\)\. Run it again.*--vstp-minutes 60$/);
  assert.equal(rep.facts.trustMessages, 0);
});

test('--only trust: one connection, one feed verdict', async () => {
  const r = await rig({ extraDeps: WINDOWS, extraOpts: { only: 'trust' } });
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe(1);
  r.srv.publish(TRUST, trustFrame(movement()));
  const code = await p;
  assert.equal(code, 0);
  const rep = r.readReport();
  assert.deepEqual(rep.checks.map(c => c.id), ['TRUST_FEED', 'INTERLOCK']);
  assert.equal(r.srv.connections.length, 1);
});

test('a refused login on the first connection: FAIL, and the second is skipped (it would fail the same way)', async () => {
  const r = await rig({ pass: 'wrong-password', extraDeps: WINDOWS });
  const code = await run(r.opts, r.deps);
  assert.equal(code, 1);
  const rep = r.readReport();
  assert.equal(check(rep, 'TRUST_FEED').status, 'FAIL');
  assert.match(check(rep, 'TRUST_FEED').message, /could not connect, so TRUST was not tested: NROD refused the login/);
  assert.equal(check(rep, 'VSTP_FEED').status, 'WARN');
  assert.match(check(rep, 'VSTP_FEED').message, /^not checked: the first connection could not be opened \(auth\)/);
  assert.equal(r.srv.connections.length, 1, 'NROD was not asked twice with a login it had just refused');
  const all = r.text() + r.filesText();
  assert.ok(!all.includes(LOGIN));
  assert.ok(!all.includes('wrong-password'));
});

test('the crossing service goes stale during TRUST: the interlock aborts, VSTP is never opened, exit non-zero', async () => {
  const mk = healthyBody();
  const r = await rig({ healthBody: n => { const b = mk(); if (n > 4) b.td.staleSecs = 120; return b; }, extraDeps: { windowsMs: { trust: 30000, vstp: 30000 } } });
  const t0 = Date.now();
  const code = await run(r.opts, r.deps);
  assert.ok(Date.now() - t0 < 6000, `aborted promptly (took ${Date.now() - t0} ms)`);
  assert.equal(code, 1);
  const rep = r.readReport();
  assert.equal(check(rep, 'INTERLOCK').status, 'FAIL');
  assert.equal(rep.facts.interlock.tripped.rule, 'td-stale');
  assert.equal(check(rep, 'TRUST_FEED').status, 'WARN');
  assert.match(check(rep, 'TRUST_FEED').message, /by the safety check \(td-stale\), before any message arrived: inconclusive/);
  assert.equal(check(rep, 'VSTP_FEED').status, 'WARN');
  assert.match(check(rep, 'VSTP_FEED').message, /^not checked: stopped by the safety check before it began/);
  assert.equal(r.srv.connections.length, 1);
  assert.equal(r.srv.framesOf('DISCONNECT').length, 1);
  assert.match(r.text(), /INTERLOCK TRIPPED - stopping now: the crossing service has had no TD message for 120s/);
});

test('the crossing service looks unwell AFTER the first connection closes: the second is not opened', async () => {
  const mk = healthyBody();
  let r;
  const body = () => { const b = mk(); if (r && r.srv.framesOf('DISCONNECT').length >= 1) b.td.connected = false; return b; };
  r = await rig({ healthBody: body, extraDeps: WINDOWS });
  const code = await run(r.opts, r.deps);
  assert.equal(code, 1, 'a crossing service that looks unwell after we leave is never an exit 0');
  const rep = r.readReport();
  assert.equal(r.srv.connections.length, 1, 'VSTP was never opened');
  assert.match(check(rep, 'VSTP_FEED').message, /^not checked: (the crossing service looked disturbed after the previous connection closed|stopped by the safety check before it began)/);
  assert.equal(check(rep, 'INTERLOCK').status, 'FAIL');
  assert.match(r.text(), /It still looks unwell after we disconnected.*tell us BEFORE restarting anything/);
});

test('/health unreachable at the start: refuses, opens NO connection, still writes a report', async () => {
  const r = await rig({ healthUp: false, extraDeps: WINDOWS });
  const code = await run(r.opts, r.deps);
  assert.equal(code, 1);
  assert.equal(r.srv.connections.length, 0);
  assert.match(r.text(), /NOT STARTING\.[\s\S]*Could not read the crossing service.s health check at http:\/\/127\.0\.0\.1:\d+\/health \(ECONNREFUSED\)/);
  assert.deepEqual(r.readReport().checks.map(c => c.id), ['INTERLOCK']);
});

test('Ctrl-C during TRUST: that window is cut short (but its data is kept), VSTP is skipped, the report is written', async () => {
  const r = await rig({ extraDeps: { windowsMs: { trust: 30000, vstp: 30000 } } });
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe(1);
  r.srv.publish(TRUST, trustFrame(movement()));
  await new Promise(res => setTimeout(res, 150));
  r.signals.emit('SIGINT');
  const code = await p;
  assert.equal(code, 0);
  const rep = r.readReport();
  assert.equal(check(rep, 'TRUST_FEED').status, 'PASS');
  assert.match(check(rep, 'TRUST_FEED').message, /Cut short after .* by SIGINT\.$/);
  assert.match(check(rep, 'VSTP_FEED').message, /^not checked: stopped by SIGINT before it began/);
  assert.equal(r.srv.connections.length, 1);
  assert.equal(r.srv.framesOf('DISCONNECT').length, 1);
  assert.equal(r.signals.listenerCount('SIGINT'), 0);
});

test('--no-interlock: warns loudly, records it, does not poll', async () => {
  const r = await rig({ extraDeps: WINDOWS, extraOpts: { interlock: false, only: 'trust' } });
  const p = run(r.opts, r.deps);
  await r.srv.waitForSubscribe(1);
  r.srv.publish(TRUST, trustFrame(movement()));
  const code = await p;
  assert.equal(code, 0);
  assert.equal(r.health.requests, 0, 'feeds-check needs no machine facts, so a disabled interlock means no /health calls at all');
  assert.match(r.text(), /THE SAFETY INTERLOCK IS OFF/);
  assert.match(r.text(), /WARN\s+INTERLOCK\s+DISABLED by --no-interlock/);
  assert.ok(r.readReport().notes.some(n => /THE SAFETY INTERLOCK IS OFF/.test(n)));
});

test('credentials and out-folder problems are refused up front (exit 2) before any connection', async () => {
  const r = await rig({ extraDeps: WINDOWS });
  assert.equal(await run({ ...r.opts, envFile: '/nonexistent/.env' }, r.deps), 2);
  assert.match(r.err.join(''), /Cannot read the credentials file/);
  const blocker = path.join(r.dir, 'a-file');
  fs.writeFileSync(blocker, 'x');
  assert.equal(await run({ ...r.opts, outDir: path.join(blocker, 'out') }, r.deps), 2);
  assert.match(r.err.join(''), /Cannot write the report to/);
  assert.equal(r.srv.connections.length, 0);
});
