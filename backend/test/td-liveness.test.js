'use strict';

// Register #21 — the TD feed stopped on 2026-09-22 and nothing noticed for FOUR AND A HALF
// DAYS. The journal is unambiguous about how:
//
//   22:28:08  TD STOMP error: connection timed out
//   22:28:08  TD subscribe failed: connection timed out
//   (no TD line again, ever — while log rotation at 03:00 and the schedule load at 04:00
//    carried on normally, and /health went on saying "ok")
//
// Closures are anchored to berth strikes, so for those days the app lost the thing that makes
// it accurate at all. That is goal 1, the top priority in CLAUDE.md.
//
// This file is the first test of td-listener.js. It had none, which is part of how this
// happened: every recovery path in it was unexercised.

const listener = require('../src/td-listener');

// No socket in a unit test. The stub records attempts and never calls back, which also
// happens to be the 2026-09-22 failure mode — a connect that neither succeeds nor fails.
const attempts = [];
listener._setStompitForTest({ connect: (opts, cb) => { attempts.push(Date.now()); } });

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS  ${label}`); pass++; }
  else {
    console.log(`  FAIL  ${label}`);
    console.log(`          got:      ${actual}`);
    console.log(`          expected: ${expected}`);
    fail++;
  }
}
function checkTruthy(label, actual) {
  if (actual) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label} (got: ${actual})`); fail++; }
}

const { STALE_MS } = listener._constantsForTest;
const NOW = Date.now();
// Quietly swallow the watchdog's own console.error during the assertions below.
function muted(fn) {
  const real = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = real; }
}

console.log('\nRegister #21 — TD feed liveness watchdog\n');

console.log('  -- the threshold itself --');
{
  // Not a round number picked by feel. The subscription is the whole national feed, and over
  // 2,261 five-minute summary windows from 2026-10-20 the quietest was 97 messages — about one
  // every three seconds at 02:00. Five minutes of TOTAL silence is far outside that.
  check('STALE_MS is 5 minutes', STALE_MS, 5 * 60 * 1000);
  checkTruthy('…and is comfortably longer than the quietest observed gap (~3s)',
    STALE_MS > 60 * 1000);
}

console.log('\n  -- before the feed has started, the watchdog must stay quiet --');
{
  listener._setFeedStateForTest({ lastMessageAt: null, feedStartedAt: null,
    currentClient: null, reconnectPending: false, forcedReconnects: 0 });
  check('not started: no reconnect is forced', muted(() => listener._checkFeedLiveness(NOW)), false);
  const h = listener.feedHealth(NOW);
  check('not started: health says so', h.started, false);
  check('not started: staleSecs is null, not 0', h.staleSecs, null);
  check('not started: status input `stale` is false', h.stale, false);
}

console.log('\n  -- a live feed is left alone --');
{
  listener._setFeedStateForTest({ lastMessageAt: NOW - 30000, feedStartedAt: NOW - 3600000,
    currentClient: {}, reconnectPending: false, forcedReconnects: 0 });
  check('30s since the last message: no reconnect',
    muted(() => listener._checkFeedLiveness(NOW)), false);
  const h = listener.feedHealth(NOW);
  check('…health reports the real age', h.staleSecs, 30);
  check('…and does not call it stale', h.stale, false);
  check('…and reports the connection', h.connected, true);
}

console.log('\n  -- the boundary --');
{
  listener._setFeedStateForTest({ lastMessageAt: NOW - STALE_MS, feedStartedAt: NOW - 3600000,
    currentClient: {}, reconnectPending: false, forcedReconnects: 0 });
  check('exactly at the threshold: not yet stale',
    muted(() => listener._checkFeedLiveness(NOW)), false);
  listener._setFeedStateForTest({ lastMessageAt: NOW - STALE_MS - 1000, feedStartedAt: NOW - 3600000,
    currentClient: {}, reconnectPending: false, forcedReconnects: 0 });
  check('one second past it: reconnect forced',
    muted(() => listener._checkFeedLiveness(NOW)), true);
}

console.log('\n  -- THE 2026-09-22 CASE: silent for days, process healthy --');
{
  const FOUR_AND_A_HALF_DAYS = 4.5 * 24 * 3600 * 1000;
  listener._setFeedStateForTest({
    lastMessageAt: NOW - FOUR_AND_A_HALF_DAYS, feedStartedAt: NOW - FOUR_AND_A_HALF_DAYS - 3600000,
    currentClient: {}, reconnectPending: false, forcedReconnects: 0 });
  const h = listener.feedHealth(NOW);
  check('health now reports it as stale', h.stale, true);
  check('…with the age that was previously unbounded', h.staleSecs, Math.round(FOUR_AND_A_HALF_DAYS / 1000));
  check('the watchdog forces a reconnect', muted(() => listener._checkFeedLiveness(NOW)), true);
  const after = listener.feedHealth(NOW);
  check('…the dead client is dropped', after.connected, false);
  check('…and it is counted, so a flapping feed is visible', after.forcedReconnects, 1);
}

console.log('\n  -- a forced reconnect must not re-fire every tick while it reconnects --');
{
  listener._setFeedStateForTest({ lastMessageAt: NOW - STALE_MS - 1000, feedStartedAt: NOW - 3600000,
    currentClient: {}, reconnectPending: false, forcedReconnects: 0 });
  check('first tick forces it', muted(() => listener._checkFeedLiveness(NOW)), true);
  // The clock is reset on firing, so the next tick a minute later sees a fresh feed.
  check('the tick a minute later does not force another',
    muted(() => listener._checkFeedLiveness(NOW + 60000)), false);
  check('…and only one was counted', listener.feedHealth(NOW).forcedReconnects, 1);
  // …but a feed that never comes back must fire again once the threshold passes afresh.
  check('a feed still dead after another full threshold fires again',
    muted(() => listener._checkFeedLiveness(NOW + STALE_MS + 2000)), true);
  check('…and that one is counted too', listener.feedHealth(NOW).forcedReconnects, 2);
}

console.log('\n  -- a hung reconnect must not be able to wedge the watchdog --');
{
  // The 2026-09-22 failure mode: something scheduled a reconnect that never completed. If a
  // pending reconnect could block the watchdog, the outage would survive it.
  listener._setFeedStateForTest({ lastMessageAt: NOW - STALE_MS - 1000, feedStartedAt: NOW - 3600000,
    currentClient: {}, reconnectPending: true, forcedReconnects: 0 });
  check('a reconnect already pending does not stop the watchdog',
    muted(() => listener._checkFeedLiveness(NOW)), true);
}

console.log('\n  -- the watchdog actually asks for a reconnect --');
{
  const before = attempts.length;
  listener._setFeedStateForTest({ lastMessageAt: NOW - STALE_MS - 1000, feedStartedAt: NOW - 3600000,
    currentClient: {}, reconnectPending: false, forcedReconnects: 0 });
  muted(() => listener._checkFeedLiveness(NOW));
  // scheduleReconnect(0) defers by a tick, so let the timer run.
  const done = () => {
    checkTruthy('a connect attempt was made after the watchdog fired', attempts.length > before);
    console.log();
    if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
    console.log(`All ${pass} tests passed.`);
    // Exit explicitly. The retry chain under test is designed to keep trying forever, so its
    // pending timer would otherwise hold the process open — which is the correct production
    // behaviour and the reason this cannot just fall off the end.
    process.exit(0);
  };
  setTimeout(done, 20);
}
