'use strict';

// The verdict pieces both scripts share: the INTERLOCK check and the advice printed after a run.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { round1, clock, interlockCheck, afterRunAdvice } = require('../lib/verdicts');

const il = (over = {}) => ({ enabled: true, mode: 'td', pollIntervalSecs: 15, polls: 12, failedPolls: 1, maxGapSecs: 15.2, tripped: null, ...over });
const tripped = { rule: 'td-stale', message: 'no TD message for 120s', at: '2026-11-02T10:31:07.000Z' };
const unwell = { disturbed: true, rule: 'td-disconnected', message: 'the crossing service reports its own TD connection is down' };
const healthy = { disturbed: false, rule: null, message: null };

test('helpers: one-decimal rounding and the UTC clock', () => {
  assert.equal(round1(1.25), 1.3);
  assert.equal(round1(60.04), 60);
  assert.equal(clock('2026-11-02T10:31:07.000Z'), '10:31:07 UTC');
  assert.equal(clock(undefined), 'an unknown time');
});

test('interlockCheck: disabled is a WARN, a trip is a FAIL, a clean watch is a PASS', () => {
  assert.equal(interlockCheck({ interlock: il({ enabled: false }), settle: null }).status, 'WARN');
  const t = interlockCheck({ interlock: il({ tripped }), settle: healthy });
  assert.equal(t.status, 'FAIL');
  assert.match(t.message, /TRIPPED at 10:31:07 UTC \(td-stale\): no TD message for 120s/);
  const ok = interlockCheck({ interlock: il(), settle: healthy });
  assert.equal(ok.status, 'PASS');
  assert.match(ok.message, /watched on the health td signal every 15 s: 12 checks \(1 failed\), longest gap 15\.2 s, none tripped; and still healthy after we disconnected/);
  assert.ok(!/still healthy/.test(interlockCheck({ interlock: il(), settle: null }).message), 'no claim about afterwards if nobody looked');
  assert.match(interlockCheck({ interlock: il({ mode: 'log' }), settle: null }).message, /LA-log signal/);
});

test('interlockCheck: unwell right after we leave is a FAIL (never an exit 0), and says what to do', () => {
  const c = interlockCheck({ interlock: il(), settle: unwell });
  assert.equal(c.status, 'FAIL');
  assert.match(c.message, /after we disconnected it looked disturbed \(td-disconnected\).*Check it before doing anything else$/);
});

test('interlockCheck: the data carries the look after we left, and anything extra for the JSON', () => {
  const c = interlockCheck({ interlock: il(), settle: healthy, extra: { afterEachConnection: { trust: healthy } } });
  assert.deepEqual(c.data.afterWeLeft, healthy);
  assert.deepEqual(c.data.afterEachConnection, { trust: healthy });
  assert.equal(c.data.polls, 12);
});

test('afterRunAdvice: silence when all is well', () => {
  assert.deepEqual(afterRunAdvice({ tripped: null, settle: healthy, healthUrl: 'http://x/health' }), []);
  assert.deepEqual(afterRunAdvice({ tripped: null, settle: null, healthUrl: 'http://x/health' }), []);
});

test('afterRunAdvice: tripped, and recovered once we left', () => {
  const lines = afterRunAdvice({ tripped, settle: healthy, healthUrl: 'http://x/health' });
  assert.equal(lines[0], '');
  assert.match(lines[1], /^STOPPED: the crossing service looked disturbed \(td-stale\)\. The connection was closed at once\.$/);
  assert.equal(lines[2], 'A moment after we disconnected, the crossing service looked healthy again.');
  assert.equal(lines.length, 3);
});

test('afterRunAdvice: still unwell after we left — the plain-words next step, and never "restart it"', () => {
  for (const [t, s] of [[tripped, unwell], [tripped, null], [null, unwell]]) {
    const text = afterRunAdvice({ tripped: t, settle: s, healthUrl: 'http://127.0.0.1:3000/health' }).join('\n');
    assert.match(text, /It still looks unwell after we disconnected\./);
    assert.match(text, /reconnects by itself within about 5 minutes/);
    assert.match(text, /curl -s http:\/\/127\.0\.0\.1:3000\/health/);
    assert.match(text, /tell us BEFORE restarting anything/);
  }
  assert.match(afterRunAdvice({ tripped: null, settle: unwell, healthUrl: 'u' })[1], /^After we disconnected, the crossing service looks disturbed \(td-disconnected\): the crossing service reports its own TD connection is down\.$/);
});
