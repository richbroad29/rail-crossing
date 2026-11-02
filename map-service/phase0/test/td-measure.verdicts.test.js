'use strict';

// td-measure's verdicts, from synthetic observations — every branch, no sockets. The rule being
// tested throughout: a verdict may only claim what the run actually measured.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildChecks, parseCli, HELP } = require('../bin/td-measure');
const stomp = require('../lib/stomp');

const MIN = 60 * 1000;
const err = (kind, extra = {}) => new stomp.StompError({ kind, phase: 'connect', topic: null, code: null, serverMessage: null, serverDetail: null, message: `a ${kind} problem`, ...extra });

const base = (over = {}) => ({
  connectError: null,
  connectMs: 120,
  ranMs: 60 * MIN, plannedMs: 60 * MIN,
  outcome: { endedBy: 'duration', detail: null, frames: 5000, firstFrameAfterMs: 800, close: { how: 'receipt' }, closedInfo: null },
  interlock: { enabled: true, mode: 'td', pollIntervalSecs: 15, polls: 240, failedPolls: 0, maxGapSecs: 15.3, tripped: null },
  settle: { disturbed: false, rule: null, message: null },
  tdSummary: {
    frames: 5000, events: 15000, areas: 250, distinctDescriptions: 4000, cclassEvents: 9000,
    rates: { eventsPerSecMean: 4.17, framesPerSecMean: 1.39, bodyMBPerHour: 38.2 },
    peakBucket: { startedAt: '2026-11-02T10:12:00.000Z', seconds: 60, eventsPerSec: 9.5, events: 570, frames: 190 },
    peakSecond: { at: '2026-11-02T10:12:31.000Z', events: 31, frames: 10 }
  },
  growth: { enough: true, edgesAtThird: 100, edgesAtTwoThirds: 140, edgesAtEnd: 141, lastThirdGrowthPct: 0.7, stillGrowing: false },
  mem: { peakRssMB: 120, availableForVerdictMB: 520, cpu: { percentOfOneCoreMean: 3.2 } },
  ctx: { host: undefined, port: undefined, envFile: '/x/.env' },
  ...over
});
const withOutcome = o => base({ outcome: { ...base().outcome, ...o } });
const by = (checks, id) => checks.find(c => c.id === id);
const sc = r => by(buildChecks(r), 'SECOND_CONNECTION');

test('a clean full run: PASS / PASS / INFO / PASS, in a stable order', () => {
  const checks = buildChecks(base());
  assert.deepEqual(checks.map(c => c.id), ['SECOND_CONNECTION', 'INTERLOCK', 'TD_VOLUME', 'MEMORY_FIT']);
  assert.deepEqual(checks.map(c => c.status), ['PASS', 'PASS', 'INFO', 'PASS']);
  assert.match(checks[0].message, /connected in 120 ms, first TD message after 0\.8 s, 5000 messages over 1h 00m 00s, and the crossing service was undisturbed \(240 health checks, none tripped\)/);
  assert.match(checks[1].message, /watched on the health td signal every 15 s: 240 checks \(0 failed\), longest gap 15\.3 s, none tripped; and still healthy after we disconnected/);
});

// ---- SECOND_CONNECTION ---------------------------------------------------------------------------

test('SECOND_CONNECTION: could not connect — FAIL, in the words of lib/stomp.explain', () => {
  const auth = sc(base({ connectError: err('auth', { serverMessage: 'User name [***] or password is invalid.' }), outcome: null }));
  assert.equal(auth.status, 'FAIL');
  assert.match(auth.message, /could not open the second connection: NROD refused the login/);
  assert.match(auth.message, /NR_FEED_USER and NR_FEED_PASS in \/x\/\.env/);
  assert.match(sc(base({ connectError: err('network', { code: 'ECONNREFUSED' }), outcome: null })).message, /Could not reach NROD.*ECONNREFUSED/);
  assert.match(sc(base({ connectError: err('timeout'), outcome: null })).message, /Timed out talking to NROD/);
});

test('SECOND_CONNECTION: stopped while connecting — FAIL if the interlock did it, WARN if the operator did', () => {
  const tripped = { rule: 'td-disconnected', message: 'the crossing service reports its own TD connection is down', at: '2026-11-02T10:00:05.000Z' };
  const a = sc(base({ connectError: err('aborted'), outcome: null, interlock: { ...base().interlock, tripped } }));
  assert.equal(a.status, 'FAIL');
  assert.match(a.message, /still connecting.*td-disconnected/);
  const b = sc(base({ connectError: err('aborted'), outcome: null }));
  assert.equal(b.status, 'WARN');
  assert.match(b.message, /nothing can be concluded/);
});

test('SECOND_CONNECTION: the interlock tripping mid-run is a FAIL naming the rule and the time', () => {
  const tripped = { rule: 'td-stale', message: 'the crossing service has had no TD message for 120s (limit 60s)', at: '2026-11-02T10:31:07.000Z' };
  const c = sc(base({ ranMs: 31 * MIN, outcome: { ...base().outcome, endedBy: 'interlock' }, interlock: { ...base().interlock, tripped } }));
  assert.equal(c.status, 'FAIL');
  assert.match(c.message, /looked disturbed at 10:31:07 UTC \(td-stale\)/);
  assert.match(c.message, /closed at once/);
  assert.equal(c.data.interlockTripped, 'td-stale');
});

test('SECOND_CONNECTION: "no message within 60 s" is only claimed when we waited 60 s', () => {
  const none = { firstFrameAfterMs: null, frames: 0 };
  assert.equal(sc(withOutcome(none)).status, 'FAIL');
  assert.match(sc(withOutcome(none)).message, /no TD message arrived within 60 s.*never quiet/);
  const short = sc({ ...withOutcome(none), ranMs: 20 * 1000 });
  assert.equal(short.status, 'WARN', 'a 20 s run proves nothing about 60 s');
  assert.match(short.message, /inside the 60 s allowed/);
  // The first message at exactly 60 s is fine; at 60.1 s it is not.
  assert.equal(sc(withOutcome({ firstFrameAfterMs: 60000 })).status, 'PASS');
  const late = sc(withOutcome({ firstFrameAfterMs: 60100 }));
  assert.equal(late.status, 'FAIL');
  assert.match(late.message, /first TD message took 60\.1 s \(limit 60 s\)/);
});

test('SECOND_CONNECTION: being dropped before any message is a FAIL whatever the clock says', () => {
  const closedInfo = { unexpected: true, error: err('not-authorised', { topic: '/topic/TD_ALL_SIG_AREA', serverMessage: 'not authorized to read' }) };
  const c = sc({ ...withOutcome({ endedBy: 'closed', firstFrameAfterMs: null, frames: 0, detail: closedInfo }), ranMs: 2000 });
  assert.equal(c.status, 'FAIL');
  assert.match(c.message, /dropped before any TD message arrived: This login is not allowed to read \/topic\/TD_ALL_SIG_AREA/);
});

test('SECOND_CONNECTION: ending early after good data is a WARN that says why (never a PASS)', () => {
  const dropInfo = { unexpected: true, error: err('server-closed', { message: 'the connection ended' }) };
  const cases = [
    [{ endedBy: 'closed', detail: dropInfo }, /dropped after .*NROD closed the connection without saying why/],
    [{ endedBy: 'silent', detail: { silentForMs: 300000 } }, /no message arrived for 5m 00s/],
    [{ endedBy: 'guard', detail: { rule: 'memory-floor', message: 'available memory fell to 120 MB' } }, /memory-floor guard \(available memory fell to 120 MB\); the connection itself was fine/],
    [{ endedBy: 'signal', detail: { type: 'signal', name: 'SIGINT' } }, /stopped early \(SIGINT\) after .* of 1h 00m 00s/],
    [{ endedBy: 'error', detail: { message: 'sampler broke' } }, /internal error \(sampler broke\)/]
  ];
  for (const [o, re] of cases) {
    const c = sc({ ...withOutcome(o), ranMs: 20 * MIN });
    assert.equal(c.status, 'WARN', o.endedBy);
    assert.match(c.message, re, o.endedBy);
  }
});

test('SECOND_CONNECTION: with the interlock off, even a perfect run cannot PASS — "without disturbing" is unverified', () => {
  const r = base({ interlock: { enabled: false, tripped: null } , settle: null });
  const c = sc(r);
  assert.equal(c.status, 'WARN');
  assert.match(c.message, /crossing service was not watched \(--no-interlock\).*unverified/);
  const il = by(buildChecks(r), 'INTERLOCK');
  assert.equal(il.status, 'WARN');
  assert.match(il.message, /DISABLED by --no-interlock.*NOT watched/);
});

test('a crossing service that looks unwell AFTER we leave: SECOND_CONNECTION is inconclusive (WARN), the safety check FAILS', () => {
  const settle = { disturbed: true, rule: 'td-disconnected', message: 'the crossing service reports its own TD connection is down' };
  const checks = buildChecks(base({ settle }));
  assert.equal(by(checks, 'SECOND_CONNECTION').status, 'WARN');
  assert.match(by(checks, 'SECOND_CONNECTION').message, /after we disconnected the crossing service looked disturbed \(td-disconnected\)/);
  const il = by(checks, 'INTERLOCK');
  assert.equal(il.status, 'FAIL', 'non-zero exit: it may be coincidence, but it must not read as a pass');
  assert.match(il.message, /after we disconnected it looked disturbed \(td-disconnected\).*Check it before doing anything else/);
});

test('INTERLOCK: a trip is a FAIL with the rule; the log-signal wording is used when that was the signal', () => {
  const tripped = { rule: 'log-silent', message: 'the LA log has not grown for 16 minutes', at: '2026-11-02T10:31:07.000Z' };
  const il = by(buildChecks(base({ interlock: { ...base().interlock, tripped } })), 'INTERLOCK');
  assert.equal(il.status, 'FAIL');
  assert.match(il.message, /TRIPPED at 10:31:07 UTC \(log-silent\)/);
  const ok = by(buildChecks(base({ interlock: { ...base().interlock, mode: 'log' }, settle: null })), 'INTERLOCK');
  assert.match(ok.message, /LA-log signal/);
});

// ---- TD_VOLUME and MEMORY_FIT ----------------------------------------------------------------------

test('TD_VOLUME: INFO with the headline rates, peak and CPU', () => {
  const v = by(buildChecks(base()), 'TD_VOLUME');
  assert.equal(v.status, 'INFO');
  assert.match(v.message, /4\.17 events\/s mean \(1\.39 messages\/s\), peak minute 9\.5\/s at 10:12:00 UTC, busiest second 31; 250 areas, 4000 distinct descriptions; 38\.2 MB\/h of message bodies, CPU 3\.2% of one core/);
});

test('TD_VOLUME / MEMORY_FIT: no data means "not measured" (WARN), never a made-up figure', () => {
  for (const r of [base({ tdSummary: { frames: 0 } }), base({ tdSummary: null, outcome: null, connectError: err('network') })]) {
    const checks = buildChecks(r);
    assert.equal(by(checks, 'TD_VOLUME').status, 'WARN');
    assert.match(by(checks, 'TD_VOLUME').message, /nothing to measure/);
    assert.equal(by(checks, 'MEMORY_FIT').status, 'WARN');
    assert.match(by(checks, 'MEMORY_FIT').message, /not measured/);
  }
});

test('MEMORY_FIT: the thresholds apply to available - peak RSS (300 PASS, 150 WARN, below FAIL)', () => {
  const fit = (avail, peak) => by(buildChecks(base({ mem: { peakRssMB: peak, availableForVerdictMB: avail, cpu: { percentOfOneCoreMean: 1 } } })), 'MEMORY_FIT');
  assert.equal(fit(450, 150).status, 'PASS');
  assert.equal(fit(449, 150).status, 'WARN');
  assert.equal(fit(300, 150).status, 'WARN');
  assert.equal(fit(299, 150).status, 'FAIL');
  assert.match(fit(299, 150).message, /use a second machine/);
});

test('MEMORY_FIT: a short run cannot PASS, and a graph still growing is called a floor', () => {
  const short = by(buildChecks(base({ ranMs: 5 * MIN, plannedMs: 5 * MIN })), 'MEMORY_FIT');
  assert.equal(short.status, 'WARN');
  assert.match(short.message, /only 5 min were measured/);
  const growing = by(buildChecks(base({ growth: { enough: true, stillGrowing: true, lastThirdGrowthPct: 8.4 } })), 'MEMORY_FIT');
  assert.equal(growing.status, 'PASS');
  assert.match(growing.message, /still growing at the end: \+8\.4% over the final third, so treat the peak as a floor/);
  const guarded = by(buildChecks(base({ outcome: { ...base().outcome, endedBy: 'guard', detail: { rule: 'memory-floor', message: 'x' } }, mem: { peakRssMB: 200, availableForVerdictMB: 300, cpu: { percentOfOneCoreMean: 1 } } })), 'MEMORY_FIT');
  assert.equal(guarded.status, 'FAIL');
  assert.match(guarded.message, /stopped early by the memory-floor guard/);
});

test('MEMORY_FIT: unknown availability (no /proc) is "could not judge", not a verdict', () => {
  const m = by(buildChecks(base({ mem: { peakRssMB: 100, availableForVerdictMB: null, cpu: { percentOfOneCoreMean: 1 } } })), 'MEMORY_FIT');
  assert.equal(m.status, 'WARN');
  assert.match(m.message, /could not judge/);
});

// ---- the command line ------------------------------------------------------------------------------

test('parseCli: defaults, --help, and every --minutes edge', () => {
  const d = parseCli([]);
  assert.equal(d.help, false);
  assert.equal(d.options.minutes, 60);
  assert.equal(d.options.interlock, true);
  assert.equal(parseCli(['--help']).help, true);
  assert.equal(parseCli(['--minutes', '1']).options.minutes, 1);
  assert.equal(parseCli(['--minutes', '240']).options.minutes, 240);
  for (const bad of ['0', '241', 'x']) assert.throws(() => parseCli(['--minutes', bad]), /--minutes must be a whole number from 1 to 240/);
  assert.equal(parseCli(['--no-interlock']).options.interlock, false);
});

test('--help names the exact command to run, every option, and what the safety check does', () => {
  assert.match(HELP, /nice -n 19 node --max-old-space-size=256 bin\/td-measure\.js/);
  for (const flag of ['--minutes', '--env', '--health-url', '--td-log-dir', '--out', '--no-interlock', '--debug', '--help', '--stomp-host', '--stomp-port']) {
    assert.ok(HELP.includes(flag), flag);
  }
  assert.match(HELP, /disconnects at once/);
  assert.match(HELP, /04:00 London/);
  assert.match(HELP, /DANGEROUS/);
});
