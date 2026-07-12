'use strict';

// Fix 1 — late-running train re-attachment in CrossingState._mergeTrains.
//
// A CIF freight whose *scheduled* crossing time has passed must NOT show a
// stale/expired prediction (or vanish). When TD has sighted the headcode, its
// crossing is re-projected forward from the sighting and floored to the future;
// when there is no sighting, the genuinely-absent train is correctly dropped.
//
// _scheduleTimeToDate is stubbed per-test so the assertions are deterministic
// and independent of the wall clock / timezone.

const CrossingState = require('../src/crossing-state');

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

const WEST_LEAD_SECS = 112;
const cfg = {
  name: 'Test Crossing', road: 'Test Rd',
  timing: {
    closeBefore: { east: 1.5, west: 2.5 },
    openAfter: { east: 0.5, west: 0.5 },
    consecutiveWindow: 1.5,
    areaEntryLeadSecs: { east: 150, west: WEST_LEAD_SECS }
  }
};

function lateFreight() {
  return {
    uid: 'T00001', headcode: '6O99', direction: 'west', trainType: 'freight',
    estimatedCrossingMins: 0, origin: 'EASTLEIGH', destination: 'VICTORIA', operator: 'ZZ'
  };
}

console.log('\nFix 1 — late-running freight re-attachment\n');

// Scheduled crossing 15 min in the past, no LDB coverage.
const now = Date.now();

// (a) No TD sighting → genuinely-absent train is dropped (TD-lock rationale).
{
  const state = new CrossingState('test', cfg);
  state._scheduleTimeToDate = () => new Date(now - 15 * 60000);
  state.scheduleTrains = [lateFreight()];
  const merged = state._mergeTrains();
  check('late freight WITHOUT a sighting is dropped', merged.some(m => m.headcode === '6O99'), false);
}

// (b) With a TD sighting (entered LA area just now) → reappears, future bestTime.
{
  const state = new CrossingState('test', cfg);
  state._scheduleTimeToDate = () => new Date(now - 15 * 60000);
  state.scheduleTrains = [lateFreight()];
  state.recordTdSighting('6O99', new Date(now)); // sighting == now

  const merged = state._mergeTrains();
  const t = merged.find(m => m.headcode === '6O99');
  checkTruthy('late freight WITH a sighting reappears in the merged list', t);
  check('bestTime is in the future', !!t && t.bestTime.getTime() > now, true);
  // Projected from sighting: now + west lead (112s), above the now+epsilon floor.
  check('bestTime == sighting + west area-entry lead',
    t ? t.bestTime.getTime() : null, now + WEST_LEAD_SECS * 1000);
  check('flagged low confidence', t ? t.confidence : null, 'low');
  check('scheduledTime preserved (stale schedule time, not the projection)',
    t ? t.scheduledTime.getTime() : null, now - 15 * 60000);
  check('tdSeen flag set', t ? t.tdSeen : null, true);
}

// (c) Sighted but crossed long ago (now well past projected + grace) → dropped.
{
  const state = new CrossingState('test', cfg);
  state._scheduleTimeToDate = () => new Date(now - 60 * 60000);
  state.scheduleTrains = [lateFreight()];
  state.recordTdSighting('6O99', new Date(now - 30 * 60000)); // sighted 30 min ago
  const merged = state._mergeTrains();
  check('sighted train that crossed long ago is dropped', merged.some(m => m.headcode === '6O99'), false);
}

// ---------------------------------------------------------------------------
// TD-triggered open — clear-step anchor (CrossingState._anchorEndToClearStep)
//
// A closure's END is anchored to the FINAL train's TD crossing CLEAR step + a
// per-direction/class lag (timing.openLagSecs), overriding the bestTime+openAfter
// fallback. _computeClosures takes an explicit `now` so these are clock-independent.
// ---------------------------------------------------------------------------
console.log('\nTD-triggered open — clear-step anchor\n');

const BASE = 1700000000000; // fixed epoch ms for deterministic assertions

const anchorCfg = {
  name: 'Anchor Test', road: 'Test Rd',
  td: {
    eastbound: { clear: { from: '0004', to: '0002' } },
    westbound: { clear: { from: '0005', to: '0007' } }
  },
  timing: {
    closeBefore: { east: 1.5, west: 2.5 },
    openAfter: { east: 0.5, west: 0.5 },
    consecutiveWindow: 1.5,
    areaEntryLeadSecs: { east: 150, west: 112 },
    openLagSecs: {
      east: { passenger: 45, freight: 70 },
      west: { passenger: 18, freight: 30 }
    }
  }
};

// Minimal merged-train shape as _computeClosures consumes (bestTime a Date).
function mkTrain(o) {
  return {
    direction: o.dir, trainType: o.type || 'passenger', headcode: o.headcode,
    bestTime: new Date(o.bestTimeMs),
    scheduledTime: new Date(o.bestTimeMs),
    origin: 'A', destination: 'B', operator: 'ZZ',
    etaText: 'x', confidence: 'high', source: 'ldb'
  };
}

// (a) Sighted passenger EAST that has cleared → end = clearStep + 45s (overrides
//     the later bestTime fallback, proving the anchor takes precedence).
{
  const state = new CrossingState('t', anchorCfg);
  const stepTs = BASE - 5000;
  const t = mkTrain({ dir: 'east', headcode: '1A01', bestTimeMs: BASE + 60000 });
  state.tdSeenToday.set('1A01', new Date(stepTs));
  state.clearStepSeen.set('1A01', { ts: stepTs, direction: 'east' });
  const periods = state._computeClosures([t], new Date(BASE));
  check('east passenger: end = clearStep + 45s',
    periods[0].end, new Date(stepTs + 45000).toISOString());
}

// (b) Sighted passenger WEST that has cleared → end = clearStep + 18s.
{
  const state = new CrossingState('t', anchorCfg);
  const stepTs = BASE - 3000;
  const t = mkTrain({ dir: 'west', headcode: '2W20', bestTimeMs: BASE + 60000 });
  state.tdSeenToday.set('2W20', new Date(stepTs));
  state.clearStepSeen.set('2W20', { ts: stepTs, direction: 'west' });
  const periods = state._computeClosures([t], new Date(BASE));
  check('west passenger: end = clearStep + 18s',
    periods[0].end, new Date(stepTs + 18000).toISOString());
}

// (c) Freight EAST → end = clearStep + 70s.
{
  const state = new CrossingState('t', anchorCfg);
  const stepTs = BASE;
  const t = mkTrain({ dir: 'east', type: 'freight', headcode: '6O99', bestTimeMs: BASE + 60000 });
  state.tdSeenToday.set('6O99', new Date(stepTs));
  state.clearStepSeen.set('6O99', { ts: stepTs, direction: 'east' });
  const periods = state._computeClosures([t], new Date(BASE));
  check('freight east: end = clearStep + 70s',
    periods[0].end, new Date(stepTs + 70000).toISOString());
}

// (d) ECS is treated as passenger (east → +45s, NOT a freight lag).
{
  const state = new CrossingState('t', anchorCfg);
  const stepTs = BASE;
  const t = mkTrain({ dir: 'east', type: 'ecs', headcode: '5A05', bestTimeMs: BASE + 60000 });
  state.tdSeenToday.set('5A05', new Date(stepTs));
  state.clearStepSeen.set('5A05', { ts: stepTs, direction: 'east' });
  const periods = state._computeClosures([t], new Date(BASE));
  check('ECS east: treated as passenger (clearStep + 45s)',
    periods[0].end, new Date(stepTs + 45000).toISOString());
}

// (e) Merged two-train closure: end keyed to the SECOND train's clear step; the
//     first (intermediate) train's clear step must NOT shorten the period.
{
  const state = new CrossingState('t', anchorCfg);
  const a = mkTrain({ dir: 'east', headcode: '1A01', bestTimeMs: BASE + 60000 });
  const b = mkTrain({ dir: 'east', headcode: '1A02', bestTimeMs: BASE + 90000 }); // 30s later → merges
  state.tdSeenToday.set('1A01', new Date(BASE));
  state.tdSeenToday.set('1A02', new Date(BASE));
  state.clearStepSeen.set('1A01', { ts: BASE + 50000, direction: 'east' }); // intermediate — ignored
  state.clearStepSeen.set('1A02', { ts: BASE + 80000, direction: 'east' }); // final — governs end
  const periods = state._computeClosures([a, b], new Date(BASE));
  check('merged closure: collapses to one period', periods.length, 1);
  check('merged closure: two trains', periods[0].trainCount, 2);
  check('merged closure: end = 2nd train clearStep + 45s (intermediate ignored)',
    periods[0].end, new Date(BASE + 80000 + 45000).toISOString());
}

// (f) Un-sighted train (no TD sighting, no clear step) → unchanged fallback,
//     end = bestTime + openAfter (0.5 min).
{
  const state = new CrossingState('t', anchorCfg);
  const t = mkTrain({ dir: 'east', headcode: '1A09', bestTimeMs: BASE + 60000 });
  const periods = state._computeClosures([t], new Date(BASE));
  check('unsighted train: end = bestTime + openAfter fallback',
    periods[0].end, new Date(BASE + 60000 + 30000).toISOString());
}

// (g) Late-running: clear step arrives AFTER the bestTime-predicted end → end
//     is extended to clearStep + lag (the whole point of the feature).
{
  const state = new CrossingState('t', anchorCfg);
  const stepTs = BASE + 120000;              // train ran ~2 min late
  const t = mkTrain({ dir: 'east', headcode: '1A11', bestTimeMs: BASE }); // fallback end = BASE + 30s
  state.tdSeenToday.set('1A11', new Date(BASE - 60000));
  state.clearStepSeen.set('1A11', { ts: stepTs, direction: 'east' });
  const periods = state._computeClosures([t], new Date(stepTs));
  check('late clear step: end = clearStep + 45s',
    periods[0].end, new Date(stepTs + 45000).toISOString());
  checkTruthy('late clear step: end extended past the bestTime + openAfter fallback',
    new Date(periods[0].end).getTime() > BASE + 30000);
}

// (h) Sighted but NOT yet cleared, with a stale bestTime end already in the past:
//     the closure is held open (never opens before the train clears).
{
  const state = new CrossingState('t', anchorCfg);
  const t = mkTrain({ dir: 'east', headcode: '1A13', bestTimeMs: BASE - 120000 }); // fallback end in the past
  state.tdSeenToday.set('1A13', new Date(BASE - 90000)); // sighted, no clear step
  const periods = state._computeClosures([t], new Date(BASE));
  const endMs = new Date(periods[0].end).getTime();
  checkTruthy('sighted-not-cleared: closure held into the future (not opened)', endMs > BASE);
  checkTruthy('sighted-not-cleared: end held past the stale bestTime fallback',
    endMs > (BASE - 120000 + 30000));
}

// (i) A clear step older than the TTL (e.g. a headcode reused later in the day)
//     is ignored — it must not resurrect a stale, long-past crossing.
{
  const state = new CrossingState('t', anchorCfg);
  const staleTs = BASE - 25 * 60000;         // 25 min ago (> 20 min TTL)
  const t = mkTrain({ dir: 'east', headcode: '1A01', bestTimeMs: BASE + 60000 });
  state.tdSeenToday.set('1A01', new Date(staleTs));
  state.clearStepSeen.set('1A01', { ts: staleTs, direction: 'east' });
  const periods = state._computeClosures([t], new Date(BASE));
  check('stale clear step (> TTL) ignored → bestTime fallback',
    periods[0].end, new Date(BASE + 60000 + 30000).toISOString());
}

console.log();
if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
else { console.log(`All ${pass} tests passed.`); }
