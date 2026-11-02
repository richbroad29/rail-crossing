'use strict';

// The safety interlock. Every rule is tested on its boundary (the value that trips and the one
// either side of it), because "disturbed if staleSecs > 60" is exactly the kind of line a one-
// character slip turns into a rule that never fires.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const il = require('../lib/interlock');
const { DEFAULTS, preflight, decide, createInterlock, LOUD_WARNING } = il;

const MIN = 60 * 1000;
// November is GMT: London == UTC.
const DAY = Date.parse('2026-11-02T10:00:00Z');   // 10:00 London
const NIGHT = Date.parse('2026-11-02T02:00:00Z'); // 02:00 London
const URL = 'http://127.0.0.1:3000/health';

const td = (over = {}) => ({
  started: true, connected: true, lastMessageAt: '2026-11-02T09:59:58.000Z', staleSecs: 2, stale: false,
  messagesReceived: 120, forcedReconnects: 0, lastForcedReconnectAt: null, ...over
});
const healthTd = (tdOver, bodyOver) => ({ ok: true, body: { status: 'ok', uptime: 5000, crossings: 1, memory: '66MB', time: '2026-11-02T10:00:00Z', td: td(tdOver), ...bodyOver } });
// An older back end: the same body with no td block at all.
const healthOld = (bodyOver) => ({ ok: true, body: { status: 'ok', uptime: 5000, crossings: 1, memory: '66MB', time: '2026-11-02T10:00:00Z', ...bodyOver } });
const down = (error = 'ECONNREFUSED') => ({ ok: false, error });
const logObs = (at, over = {}) => ({ file: '/x/td-2026-11-02.jsonl', exists: true, size: 1000, mtimeMs: at - 2 * MIN, ...over });
const obs = (at, health, log) => (log ? { at, health, log } : { at, health });
const plan = (over = {}) => ({ healthUrl: URL, tdLogDir: '/x', plannedRunMs: 60 * MIN, ...over });

const startTd = (tdOver) => {
  const r = preflight(obs(DAY, healthTd(tdOver)), DEFAULTS, plan());
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.state;
};
const startLog = (at = DAY, logOver, runMin = 30) => {
  const r = preflight(obs(at, healthOld(), logObs(at, logOver)), DEFAULTS, plan({ plannedRunMs: runMin * MIN }));
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.state;
};

// ---- preflight: the td signal -------------------------------------------------------------------

test('preflight: a healthy td block starts the run on the td signal and records the baseline', () => {
  const r = preflight(obs(DAY, healthTd({ forcedReconnects: 3 })), DEFAULTS, plan());
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'td');
  assert.equal(r.state.baseline.forcedReconnects, 3);
});

test('preflight: /health unreachable at start refuses, says why, and says how to check', () => {
  const r = preflight(obs(DAY, down('ECONNREFUSED')), DEFAULTS, plan());
  assert.equal(r.ok, false);
  assert.equal(r.rule, 'health-unreachable');
  assert.match(r.message, /ECONNREFUSED/);
  assert.match(r.message, /will not start/);
  assert.match(r.message, /curl -s http:\/\/127\.0\.0\.1:3000\/health/);
  assert.match(r.message, /--no-interlock/);
});

test('preflight: refuses to start while the crossing service is ALREADY unwell', () => {
  for (const [label, over, expect] of [
    ['disconnected', { connected: false }, /td\.connected is false/],
    ['never started', { started: false, connected: false, staleSecs: null }, /td\.started is false/],
    ['stale', { staleSecs: 61 }, /61s/],
    ['td block lacks the fields we judge by', { connected: undefined, staleSecs: undefined }, /usable td\.connected/],
    ['staleSecs null while connected', { staleSecs: null }, /usable td\.connected/]
  ]) {
    const r = preflight(obs(DAY, healthTd(over)), DEFAULTS, plan());
    assert.equal(r.ok, false, label);
    assert.equal(r.rule, 'already-disturbed', label);
    assert.match(r.message, expect, label);
  }
});

test('preflight: staleSecs exactly at the limit is still fine (> 60 trips, 60 does not)', () => {
  assert.equal(preflight(obs(DAY, healthTd({ staleSecs: 60 })), DEFAULTS, plan()).ok, true);
  assert.equal(preflight(obs(DAY, healthTd({ staleSecs: 61 })), DEFAULTS, plan()).ok, false);
});

test('preflight: an empty td object is a back end we do not understand, not "no td block"', () => {
  const r = preflight(obs(DAY, { ok: true, body: { uptime: 1, td: {} } }), DEFAULTS, plan());
  assert.equal(r.ok, false);
  assert.equal(r.rule, 'already-disturbed');
});

test('preflight: a td that is not an object counts as absent, and falls back to the log', () => {
  for (const bad of ['nope', [], null, 7]) {
    const r = preflight(obs(DAY, { ok: true, body: { uptime: 1, td: bad } }, logObs(DAY)), DEFAULTS, plan({ plannedRunMs: 10 * MIN }));
    assert.equal(r.ok, true, JSON.stringify(bad));
    assert.equal(r.mode, 'log', JSON.stringify(bad));
  }
});

// ---- preflight: the log fallback ----------------------------------------------------------------

test('preflight: no td block, daytime, log growing -> starts on the log signal, and says so', () => {
  const r = preflight(obs(DAY, healthOld(), logObs(DAY)), DEFAULTS, plan({ plannedRunMs: 30 * MIN }));
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'log');
  assert.match(r.note, /watching its LA log/);
  assert.equal(r.state.log.lastSize, 1000);
  assert.equal(r.state.log.lastGrowthAt, DAY - 2 * MIN);
});

test('preflight: no td block at night refuses (LA is legitimately silent for hours overnight)', () => {
  const r = preflight(obs(NIGHT, healthOld(), logObs(NIGHT)), DEFAULTS, plan({ plannedRunMs: 10 * MIN }));
  assert.equal(r.ok, false);
  assert.equal(r.rule, 'fallback-window');
  assert.match(r.message, /06:00 and 23:00/);
  assert.match(r.message, /02:00:00 in London/);
  assert.match(r.message, /--no-interlock/);
});

test('preflight: the 06:00 and 23:00 edges are London time, in GMT', () => {
  const at = iso => Date.parse(iso);
  const ok = (t, runMin) => preflight(obs(t, healthOld(), logObs(t)), DEFAULTS, plan({ plannedRunMs: runMin * MIN })).ok;
  assert.equal(ok(at('2026-11-02T05:59:00Z'), 5), false, '05:59 is before 06:00');
  assert.equal(ok(at('2026-11-02T06:00:00Z'), 5), true, '06:00 exactly is in');
  assert.equal(ok(at('2026-11-02T22:50:00Z'), 5), true, 'ends 22:57 incl. margin: in');
  assert.equal(ok(at('2026-11-02T22:50:00Z'), 10), false, 'would end after 23:00 incl. margin: out');
  assert.equal(ok(at('2026-11-02T23:00:00Z'), 1), false, '23:00 exactly is out');
});

test('preflight: the same edges move by an hour in BST — it is London time, not UTC', () => {
  const at = iso => Date.parse(iso);
  const ok = (t, runMin) => preflight(obs(t, healthOld(), logObs(t)), DEFAULTS, plan({ plannedRunMs: runMin * MIN })).ok;
  // 2026-07-01: London = UTC+1.
  assert.equal(ok(at('2026-07-01T04:59:00Z'), 5), false, '05:59 London');
  assert.equal(ok(at('2026-07-01T05:00:00Z'), 5), true, '06:00 London');
  assert.equal(ok(at('2026-07-01T21:30:00Z'), 20), true, '22:30 London, ends 22:52 + margin');
  assert.equal(ok(at('2026-07-01T21:30:00Z'), 60), false, '22:30 London, would run past 23:00');
  // 22:30 UTC is 23:30 London: a UTC-based check would call it in-window.
  assert.equal(ok(at('2026-07-01T22:30:00Z'), 5), false, '23:30 London');
});

test('preflight: a run that would cross London midnight is refused even though BOTH ends are inside the hours', () => {
  // feeds-check adds two windows (up to 8 h), so this is reachable. Start 22:50 GMT, planned 7 h 20 min
  // plus the 2 min margin: it ends at 06:12 NEXT DAY — inside 06:00-23:00 on its own, so the
  // same-day rule is the only thing that can refuse it (an earlier version of this test ended at
  // 05:52, where the window check refused it for a different reason and hid a missing date check).
  const t = Date.parse('2026-11-02T22:50:00Z');
  const r = preflight(obs(t, healthOld(), logObs(t)), DEFAULTS, plan({ plannedRunMs: (7 * 60 + 20) * MIN }));
  assert.equal(r.ok, false);
  assert.equal(r.rule, 'fallback-window');
  assert.match(r.message, /22:50:00 in London.*06:12:00/);
  // The same length of run starting at 06:30 and ending the same day is fine (no date change).
  const morning = Date.parse('2026-11-02T06:30:00Z');
  assert.equal(preflight(obs(morning, healthOld(), logObs(morning)), DEFAULTS, plan({ plannedRunMs: (7 * 60 + 20) * MIN })).ok, true);
});

test('preflight: the log fallback needs today\'s file, readable, and grown in the last 15 minutes', () => {
  const run = log => preflight(obs(DAY, healthOld(), log), DEFAULTS, plan({ plannedRunMs: 10 * MIN }));
  assert.equal(run({ file: '/x/td-2026-11-02.jsonl', exists: false }).rule, 'log-missing');
  assert.equal(run({ file: '/x/y', error: 'EACCES' }).rule, 'log-unobservable');
  assert.match(run({ file: '/x/y', error: 'EACCES' }).message, /EACCES/);
  assert.equal(preflight(obs(DAY, healthOld()), DEFAULTS, plan()).rule, 'log-unobservable', 'no log observation at all');
  const quiet = run(logObs(DAY, { mtimeMs: DAY - 16 * MIN }));
  assert.equal(quiet.rule, 'log-not-growing');
  assert.match(quiet.message, /16 minutes ago/);
  assert.equal(run(logObs(DAY, { mtimeMs: DAY - 15 * MIN })).ok, true, 'exactly 15 minutes is still fine');
  assert.equal(run(logObs(DAY, { mtimeMs: DAY - 15 * MIN - 1 })).ok, false, 'a millisecond more is not');
});

test('preflight: every refusal has a one-line `short` that stands alone in the paste-back summary', () => {
  const run = o => preflight(o, DEFAULTS, plan({ plannedRunMs: 10 * MIN }));
  const refusals = [
    run(obs(DAY, down('ECONNREFUSED'))),
    run(obs(DAY, healthTd({ connected: false }))),
    run(obs(NIGHT, healthOld(), logObs(NIGHT))),
    run(obs(DAY, healthOld(), { file: '/x/td-2026-11-02.jsonl', exists: false })),
    run(obs(DAY, healthOld(), { file: '/x', error: 'EACCES' })),
    run(obs(DAY, healthOld(), logObs(DAY, { mtimeMs: DAY - 20 * MIN })))
  ];
  assert.deepEqual(refusals.map(r => r.rule), ['health-unreachable', 'already-disturbed', 'fallback-window', 'log-missing', 'log-unobservable', 'log-not-growing']);
  for (const r of refusals) {
    assert.equal(r.ok, false);
    assert.ok(typeof r.short === 'string' && r.short.length > 20, r.rule);
    assert.ok(!/\n/.test(r.short), `${r.rule}: short must be one line`);
    assert.ok(r.message.includes('\n'), `${r.rule}: the full message is the multi-line explanation`);
  }
  assert.match(refusals[0].short, /127\.0\.0\.1:3000\/health.*ECONNREFUSED/);
  assert.match(refusals[1].short, /td\.connected is false/);
});

// ---- decide: the td rules -----------------------------------------------------------------------

test('decide: a healthy poll changes nothing, and never mutates the state it was given', () => {
  const state = startTd();
  const before = structuredClone(state);
  const r = decide(state, obs(DAY + 15000, healthTd({ staleSecs: 3, messagesReceived: 999 }, { uptime: 5015 })), DEFAULTS);
  assert.equal(r.verdict.disturbed, false);
  assert.equal(r.state.polls, state.polls + 1);
  assert.deepEqual(state, before);
});

test('decide: td.connected === false trips td-disconnected', () => {
  const r = decide(startTd(), obs(DAY + 15000, healthTd({ connected: false })), DEFAULTS);
  assert.equal(r.verdict.disturbed, true);
  assert.equal(r.verdict.rule, 'td-disconnected');
  assert.match(r.verdict.message, /td\.connected is false/);
});

test('decide: td.staleSecs > 60 trips td-stale; 60 does not', () => {
  assert.equal(decide(startTd(), obs(DAY, healthTd({ staleSecs: 60 })), DEFAULTS).verdict.disturbed, false);
  const r = decide(startTd(), obs(DAY, healthTd({ staleSecs: 61 })), DEFAULTS);
  assert.equal(r.verdict.rule, 'td-stale');
  assert.match(r.verdict.message, /61s \(limit 60s\)/);
});

test('decide: td.forcedReconnects increasing since the start trips td-forced-reconnect', () => {
  const state = startTd({ forcedReconnects: 2 });
  assert.equal(decide(state, obs(DAY, healthTd({ forcedReconnects: 2 })), DEFAULTS).verdict.disturbed, false, 'unchanged');
  const r = decide(state, obs(DAY, healthTd({ forcedReconnects: 3 })), DEFAULTS);
  assert.equal(r.verdict.rule, 'td-forced-reconnect');
  assert.match(r.verdict.message, /from 2 to 3/);
});

test('decide: forcedReconnects going DOWN means the service restarted — it must not read as "fine"', () => {
  const r = decide(startTd({ forcedReconnects: 2 }), obs(DAY, healthTd({ forcedReconnects: 0 })), DEFAULTS);
  assert.equal(r.verdict.rule, 'service-restarted');
});

test('decide: uptime going backwards means a restart, whatever else /health says', () => {
  const state = startTd();   // uptime 5000
  const r = decide(state, obs(DAY, healthTd({}, { uptime: 12 })), DEFAULTS);
  assert.equal(r.verdict.rule, 'service-restarted');
  assert.match(r.verdict.message, /5000s to 12s/);
  // Sub-second jitter in a float uptime is not a restart.
  assert.equal(decide(state, obs(DAY, healthTd({}, { uptime: 4999.6 })), DEFAULTS).verdict.disturbed, false);
  assert.equal(decide(state, obs(DAY, healthTd({}, { uptime: 4998.9 })), DEFAULTS).verdict.rule, 'service-restarted');
});

test('decide: a td block that vanishes mid-run trips, rather than silently switching signal', () => {
  const r = decide(startTd(), obs(DAY, healthOld({ uptime: 5100 }), logObs(DAY)), DEFAULTS);
  assert.equal(r.verdict.rule, 'td-block-missing');
});

test('decide: td.started false, and a td block we cannot read, both trip', () => {
  assert.equal(decide(startTd(), obs(DAY, healthTd({ started: false, connected: false })), DEFAULTS).verdict.rule, 'td-not-started');
  assert.equal(decide(startTd(), obs(DAY, healthTd({ staleSecs: 'lots' })), DEFAULTS).verdict.rule, 'td-unreadable');
});

test('decide: rules are reported in order of usefulness (disconnected before stale)', () => {
  const r = decide(startTd(), obs(DAY, healthTd({ connected: false, staleSecs: 500 })), DEFAULTS);
  assert.equal(r.verdict.rule, 'td-disconnected');
});

// ---- decide: unreachable --------------------------------------------------------------------------

test('decide: /health unreachable aborts on the 3rd consecutive failure, not before', () => {
  let s = startTd();
  let r = decide(s, obs(DAY, down('timeout')), DEFAULTS);
  assert.equal(r.verdict.disturbed, false);
  assert.match(r.verdict.note, /1 of 3/);
  r = decide(r.state, obs(DAY, down('timeout')), DEFAULTS);
  assert.equal(r.verdict.disturbed, false);
  assert.match(r.verdict.note, /2 of 3/);
  r = decide(r.state, obs(DAY, down('ECONNREFUSED')), DEFAULTS);
  assert.equal(r.verdict.disturbed, true);
  assert.equal(r.verdict.rule, 'health-unreachable');
  assert.match(r.verdict.message, /3 times running.*ECONNREFUSED/);
});

test('decide: a successful poll resets the unreachable count (fail, fail, ok, fail, fail is fine)', () => {
  let r = { state: startTd() };
  for (const h of [down(), down(), healthTd(), down(), down()]) {
    r = decide(r.state, obs(DAY, h), DEFAULTS);
    assert.equal(r.verdict.disturbed, false);
  }
  r = decide(r.state, obs(DAY, down()), DEFAULTS);
  assert.equal(r.verdict.rule, 'health-unreachable');
});

// ---- decide: the log fallback ---------------------------------------------------------------------

test('decide (log): growth resets the quiet timer; 15 minutes of nothing is fine, a bit more trips', () => {
  let s = startLog();                                   // lastGrowthAt = DAY - 2min, size 1000
  let r = decide(s, obs(DAY + 5 * MIN, healthOld(), logObs(DAY + 5 * MIN, { size: 1500 })), DEFAULTS);
  assert.equal(r.verdict.disturbed, false);
  assert.equal(r.state.log.lastGrowthAt, DAY + 5 * MIN);
  // 15 minutes after the last growth: fine. One millisecond more: tripped.
  const at15 = DAY + 5 * MIN + 15 * MIN;
  assert.equal(decide(r.state, obs(at15, healthOld(), logObs(at15, { size: 1500 })), DEFAULTS).verdict.disturbed, false);
  const over = decide(r.state, obs(at15 + 1, healthOld(), logObs(at15, { size: 1500 })), DEFAULTS);
  assert.equal(over.verdict.rule, 'log-silent');
  assert.match(over.verdict.message, /LA log has not grown for 15 minutes/);
});

test('decide (log): a vanished or truncated file is not growth', () => {
  const s = startLog();   // size 1000, last growth DAY - 2min
  const gone = decide(s, obs(DAY + 16 * MIN, healthOld(), { file: '/x', exists: false }), DEFAULTS);
  assert.equal(gone.verdict.rule, 'log-silent');
  assert.match(gone.verdict.message, /file does not exist/);
  // Truncated to 10 bytes: rebased, but the timer is NOT reset by it.
  const trunc = decide(s, obs(DAY + 5 * MIN, healthOld(), logObs(DAY, { size: 10 })), DEFAULTS);
  assert.equal(trunc.verdict.disturbed, false);
  assert.equal(trunc.state.log.lastSize, 10);
  assert.equal(trunc.state.log.lastGrowthAt, s.log.lastGrowthAt);
  // ...and growth from the new, smaller size counts again.
  const regrow = decide(trunc.state, obs(DAY + 6 * MIN, healthOld(), logObs(DAY, { size: 11 })), DEFAULTS);
  assert.equal(regrow.state.log.lastGrowthAt, DAY + 6 * MIN);
});

test('decide (log): leaving the 06:00-23:00 window mid-run stops the run (it cannot be watched any more)', () => {
  // Started at 22:20 for 10 minutes — comfortably accepted — then still running at 23:00.
  const s = startLog(Date.parse('2026-11-02T22:20:00Z'), {}, 10);
  const justIn = Date.parse('2026-11-02T22:59:59Z');
  assert.equal(decide(s, obs(justIn, healthOld(), logObs(justIn, { size: 2000 })), DEFAULTS).verdict.disturbed, false);
  const out = Date.parse('2026-11-02T23:00:00Z');
  const r = decide(s, obs(out, healthOld(), logObs(out, { size: 2000 })), DEFAULTS);
  assert.equal(r.verdict.rule, 'fallback-window-ended');
  assert.match(r.verdict.message, /23:00:00 in London|now 23:00:00/);
});

test('decide (log): an unreadable log trips (the interlock will not guess)', () => {
  const r = decide(startLog(), obs(DAY, healthOld(), { file: '/x', error: 'EIO' }), DEFAULTS);
  assert.equal(r.verdict.rule, 'log-unobservable');
  assert.equal(decide(startLog(), obs(DAY, healthOld()), DEFAULTS).verdict.rule, 'log-unobservable');
});

test('decide (log): unreachable and restart rules apply on this signal too', () => {
  let r = { state: startLog() };
  for (let i = 0; i < 2; i++) r = decide(r.state, obs(DAY, down()), DEFAULTS);
  assert.equal(decide(r.state, obs(DAY, down()), DEFAULTS).verdict.rule, 'health-unreachable');
  assert.equal(decide(startLog(), obs(DAY, healthOld({ uptime: 3 }), logObs(DAY, { size: 2000 })), DEFAULTS).verdict.rule, 'service-restarted');
});

test('decide: a state that did not come from preflight fails closed', () => {
  const r = decide({ mode: 'mystery', polls: 0, unreachable: 0 }, obs(DAY, healthTd()), DEFAULTS);
  assert.equal(r.verdict.disturbed, true);
  assert.equal(r.verdict.rule, 'interlock-error');
});

// ---- the shell ------------------------------------------------------------------------------------

function harness({ responses = [], statResult, disabled = false, now = DAY, config } = {}) {
  const h = { now, trips: [], logs: [], fetches: 0, stats: 0, timers: [], sleeps: [] };
  const queue = responses.slice();
  const deps = {
    fetchHealth: async () => {
      h.fetches++;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next() : next;
    },
    statFile: async () => { h.stats++; if (statResult instanceof Error) throw statResult; return statResult === undefined ? { size: 1000, mtimeMs: h.now - MIN } : statResult; },
    now: () => h.now,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false, unref() { this.unreffed = true; } }; h.timers.push(t); return t; },
    clearTimer: t => { t.cleared = true; },
    sleep: async ms => { h.sleeps.push(ms); }
  };
  h.interlock = createInterlock({
    healthUrl: URL, tdLogDir: '/var/td', disabled, deps, config,
    onTrip: v => h.trips.push(v), log: m => h.logs.push(m)
  });
  // Run the next scheduled poll, advancing the clock by its interval.
  h.fire = async () => {
    const t = h.timers.filter(x => !x.cleared).pop();
    assert.ok(t, 'a poll should be scheduled');
    h.timers.splice(h.timers.indexOf(t), 1);
    h.now += t.ms;
    await t.fn();
  };
  h.pending = () => h.timers.filter(x => !x.cleared).length;
  return h;
}

test('shell: polls every 15 s, does not stack polls, and unrefs its timer', async () => {
  const h = harness({ responses: [healthTd()] });
  const pre = await h.interlock.preflight({ plannedRunMs: 60 * MIN });
  assert.equal(pre.ok, true);
  assert.equal(h.pending(), 0, 'preflight alone schedules nothing');
  h.interlock.start();
  h.interlock.start();                                  // idempotent
  assert.equal(h.pending(), 1);
  assert.equal(h.timers[0].ms, 15000);
  assert.equal(h.timers[0].unreffed, true, 'the poll timer must never keep the process alive');
  await h.fire(); await h.fire();
  assert.equal(h.fetches, 3);                           // preflight + 2 polls
  assert.equal(h.pending(), 1);
  const s = h.interlock.stop();
  assert.equal(h.pending(), 0);
  assert.equal(s.polls, 3);
  assert.equal(s.maxGapSecs, 15);
  assert.equal(s.tripped, null);
});

test('shell: a trip calls onTrip exactly once, resolves whenTripped, and stops polling', async () => {
  const h = harness({ responses: [healthTd(), healthTd(), healthTd({ staleSecs: 120 })] });
  await h.interlock.preflight({ plannedRunMs: 60 * MIN });
  h.interlock.start();
  await h.fire();
  assert.equal(h.trips.length, 0);
  await h.fire();
  assert.equal(h.trips.length, 1);
  assert.equal(h.trips[0].rule, 'td-stale');
  assert.equal(h.pending(), 0, 'no further poll after a trip');
  const v = await h.interlock.whenTripped;
  assert.equal(v.rule, 'td-stale');
  assert.equal(v.observation.td.staleSecs, 120);
  assert.equal(h.interlock.getTripped().rule, 'td-stale');
});

test('shell: an unreachable /health at start refuses, and start() then does nothing', async () => {
  const h = harness({ responses: [down('ECONNREFUSED')] });
  const pre = await h.interlock.preflight({ plannedRunMs: 60 * MIN });
  assert.equal(pre.ok, false);
  assert.equal(pre.rule, 'health-unreachable');
  h.interlock.start();
  assert.equal(h.pending(), 0);
});

test('shell: 3 failed polls in a row abort, with the operator told about the first two', async () => {
  const h = harness({ responses: [healthTd(), down('timeout')] });
  await h.interlock.preflight({ plannedRunMs: 60 * MIN });
  h.interlock.start();
  await h.fire(); await h.fire();
  assert.equal(h.trips.length, 0);
  assert.equal(h.logs.length, 2);
  assert.match(h.logs[0], /1 of 3/);
  await h.fire();
  assert.equal(h.trips.length, 1);
  assert.equal(h.trips[0].rule, 'health-unreachable');
  assert.equal(h.interlock.summary().failedPolls, 3);
});

test('shell: the log is only read when /health has no td block', async () => {
  const withTd = harness({ responses: [healthTd()] });
  await withTd.interlock.preflight({ plannedRunMs: 60 * MIN });
  withTd.interlock.start(); await withTd.fire();
  assert.equal(withTd.stats, 0, 'td signal in use: the log is left alone');

  const old = harness({ responses: [healthOld()], statResult: { size: 1000, mtimeMs: DAY - MIN } });
  const pre = await old.interlock.preflight({ plannedRunMs: 10 * MIN });
  assert.equal(pre.ok, true);
  assert.equal(pre.mode, 'log');
  old.interlock.start(); await old.fire();
  assert.equal(old.stats, 2, 'log signal in use: stat at preflight and at the poll');
});

test('shell: the log file name is today\'s London date', async () => {
  const seen = [];
  const h = harness({ responses: [healthOld()] });
  const il2 = createInterlock({
    healthUrl: URL, tdLogDir: '/var/td',
    deps: { ...{ fetchHealth: async () => healthOld(), now: () => Date.parse('2026-07-01T23:30:00Z'), statFile: async f => { seen.push(f); return { size: 1, mtimeMs: Date.parse('2026-07-01T23:29:00Z') }; } } }
  });
  // 23:30Z on 1 July is 00:30 on 2 July in London: the file is the 2nd's. (Refused for being
  // outside 06:00-23:00 — but it must have looked in the right place before saying so.)
  const pre = await il2.preflight({ plannedRunMs: MIN });
  assert.equal(pre.ok, false);
  assert.deepEqual(seen, ['/var/td/td-2026-07-02.jsonl']);
  void h;
});

test('shell: --no-interlock bypasses everything, loudly', async () => {
  const h = harness({ responses: [down()], disabled: true });
  const pre = await h.interlock.preflight({ plannedRunMs: 60 * MIN });
  assert.equal(pre.ok, true);
  assert.equal(pre.mode, 'off');
  assert.equal(pre.disabled, true);
  assert.equal(pre.message, LOUD_WARNING);
  assert.match(LOUD_WARNING, /NOT stop/);
  h.interlock.start();
  assert.equal(h.pending(), 0);
  assert.equal(h.fetches, 0, 'a disabled interlock does not even look');
  assert.equal(await h.interlock.settleCheck({ settleMs: 0 }), null);
  assert.equal(h.interlock.summary().enabled, false);
  // The box is rectangular.
  const widths = new Set(LOUD_WARNING.split('\n').map(l => l.length));
  assert.equal(widths.size, 1);
});

test('shell: a fetch that throws, or a stat that throws, is an observation, never a crash', async () => {
  const h = harness({ responses: [healthTd(), new Error('boom')] });
  await h.interlock.preflight({ plannedRunMs: 60 * MIN });
  h.interlock.start();
  await h.fire();
  assert.equal(h.trips.length, 0);
  assert.match(h.logs[0], /boom/);

  const old = harness({ responses: [healthOld()], statResult: Object.assign(new Error('x'), { code: 'EACCES' }) });
  const pre = await old.interlock.preflight({ plannedRunMs: 10 * MIN });
  assert.equal(pre.ok, false);
  assert.equal(pre.rule, 'log-unobservable');
  assert.match(pre.message, /EACCES/);
});

test('shell: settleCheck is strict — one failed fetch after we leave counts, and a healthy one clears', async () => {
  const h = harness({ responses: [healthTd(), down('ECONNREFUSED')] });
  await h.interlock.preflight({ plannedRunMs: 60 * MIN });
  const bad = await h.interlock.settleCheck({ settleMs: 3000 });
  assert.deepEqual(h.sleeps, [3000]);
  assert.equal(bad.disturbed, true);
  assert.equal(bad.rule, 'health-unreachable');
  assert.equal(bad.observation.reachable, false);

  const ok = harness({ responses: [healthTd(), healthTd({ staleSecs: 1 }, { uptime: 5030 })] });
  await ok.interlock.preflight({ plannedRunMs: 60 * MIN });
  const good = await ok.interlock.settleCheck({ settleMs: 0 });
  assert.equal(good.disturbed, false);
  assert.equal(good.observation.td.staleSecs, 1);
});

test('shell: the summary records enough to prove coverage (polls, longest gap, first and last look)', async () => {
  const h = harness({ responses: [healthTd({ messagesReceived: 10 }), healthTd({ messagesReceived: 20 }, { uptime: 5015 })] });
  await h.interlock.preflight({ plannedRunMs: 60 * MIN });
  h.interlock.start();
  await h.fire();
  const s = h.interlock.stop();
  assert.equal(s.enabled, true);
  assert.equal(s.mode, 'td');
  assert.equal(s.pollIntervalSecs, 15);
  assert.equal(s.first.td.messagesReceived, 10);
  assert.equal(s.last.td.messagesReceived, 20);
  assert.equal(s.last.uptimeSecs, 5015);
});
