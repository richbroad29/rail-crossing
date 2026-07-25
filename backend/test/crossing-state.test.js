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

// ===========================================================================
// TD-triggered close + direction-aware hold + gated CLOSED state
// (Changes 1–5b). _computeClosures now emits period.start (CONFIRMED close,
// drives CLOSED) and period.predictedStart (PREDICTED close, drives the
// countdown / CLOSING_SOON). Deterministic: explicit `now`, strikes injected.
// ===========================================================================
console.log('\nTD-triggered close + direction-aware hold + gated state\n');

// closeTrigger + mergeOppositeMaxGapSecs + td.approach berths. No openLagSecs, so
// _anchorEndToClearStep leaves the end at the raw predicted open (deterministic).
const closeCfg = {
  name: 'Close Test', road: 'Test Rd',
  td: {
    eastbound: { approach: { from: '0006', to: '0004' }, clear: { from: '0004', to: '0002' } },
    westbound: { approach: { from: '0003', to: '0005' }, clear: { from: '0005', to: '0007' } }
  },
  timing: {
    closeBefore: { east: 1.5, west: 2.5 },
    openAfter: { east: 0.5, west: 0.5 },
    consecutiveWindow: 1.5,
    closeTrigger: {
      east: { freightSecs: 100, stoppingSecs: 100, otherSecs: 80, predictedLeadSecs: 180, safetyNetSecs: 210 },
      west: { stoppingDepartureLeadSecs: 45, stoppingMinAfterStrikeSecs: 10, otherSecs: 20, safetyNetSecs: 90 }
    },
    mergeOppositeMaxGapSecs: 20
  }
};
// Directional grouping WITHOUT closeTrigger: close = bestTime − closeBefore (east 90s,
// west 150s), open = bestTime + 30s — clean gap arithmetic for the merge tests.
const mergeCfg = {
  name: 'Merge Test', road: 'Test Rd',
  timing: {
    closeBefore: { east: 1.5, west: 2.5 },
    openAfter: { east: 0.5, west: 0.5 },
    consecutiveWindow: 1.5,
    mergeOppositeMaxGapSecs: 20
  }
};
// Neither trigger present → legacy consecutiveWindow grouping, close = bestTime − closeBefore.
const legacyCfg = {
  name: 'Legacy Test', road: 'Test Rd',
  timing: {
    closeBefore: { east: 1.5, west: 2.5 },
    openAfter: { east: 0.5, west: 0.5 },
    consecutiveWindow: 1.5
  }
};

// Merged-train shape with a settable source (ldb ⇒ stopping) and scheduledTime.
function mkT(o) {
  return {
    direction: o.dir, trainType: o.type || 'passenger', headcode: o.headcode || 'XXXX',
    bestTime: new Date(o.bestTimeMs),
    scheduledTime: new Date(o.schedMs != null ? o.schedMs : o.bestTimeMs),
    origin: 'A', destination: 'B', operator: 'ZZ',
    etaText: 'x', confidence: 'high', source: o.source || 'ldb'
  };
}
const iso = (ms) => new Date(ms).toISOString();
// close a single train and return its one period (predictedStart / start / end).
function periodFor(cfg, train, nowMs, strikes = []) {
  const state = new CrossingState('t', cfg);
  for (const s of strikes) state.closeStrikeSeen.set(s.hc, { ts: s.ts, direction: s.dir });
  return state._computeClosures([train], new Date(nowMs))[0];
}

// ---- Change 2: predicted close time (period.predictedStart) --------------
console.log('  -- predicted close (strike-anchored / prediction) --');

// C1: East stopping passenger, 0006 struck → strike + 100s, overriding a LATER bestTime.
{
  const p = periodFor(closeCfg,
    mkT({ dir: 'east', headcode: '1A01', bestTimeMs: BASE + 300000, source: 'ldb' }),
    BASE + 40000, [{ hc: '1A01', ts: BASE, dir: 'east' }]);
  check('east stopping (struck): predictedStart = strike + 100s', p.predictedStart, iso(BASE + 100000));
  check('east stopping (struck): start == predictedStart (gated onset == prediction)', p.start, iso(BASE + 100000));
}
// C1b: same strike overrides an EARLIER bestTime baseline too.
{
  const p = periodFor(closeCfg,
    mkT({ dir: 'east', headcode: '1A01', bestTimeMs: BASE - 100000, source: 'ldb' }),
    BASE + 40000, [{ hc: '1A01', ts: BASE, dir: 'east' }]);
  check('east stopping (struck): strike overrides an earlier bestTime', p.predictedStart, iso(BASE + 100000));
}
// C2: East freight → strike+100; East non-stopping (cif) → strike+80; East ECS → strike+80.
{
  const f = periodFor(closeCfg, mkT({ dir: 'east', headcode: '6O99', type: 'freight', bestTimeMs: BASE + 300000 }),
    BASE + 10000, [{ hc: '6O99', ts: BASE, dir: 'east' }]);
  check('east freight (struck): strike + 100s', f.predictedStart, iso(BASE + 100000));
  const ns = periodFor(closeCfg, mkT({ dir: 'east', headcode: '1A02', type: 'passenger', source: 'cif', bestTimeMs: BASE + 300000 }),
    BASE + 10000, [{ hc: '1A02', ts: BASE, dir: 'east' }]);
  check('east non-stopping cif passenger (struck): strike + 80s', ns.predictedStart, iso(BASE + 80000));
  const ecs = periodFor(closeCfg, mkT({ dir: 'east', headcode: '5A05', type: 'ecs', bestTimeMs: BASE + 300000 }),
    BASE + 10000, [{ hc: '5A05', ts: BASE, dir: 'east' }]);
  check('east ECS (struck): strike + 80s (other bucket)', ecs.predictedStart, iso(BASE + 80000));
}
// C3: East, no strike → predicted = bestTime − predictedLeadSecs (180s); confirmed = bestTime − safetyNet (210s).
//     (Supersedes Change-2's original closeBefore baseline per the Change-5 correction.)
{
  const p = periodFor(closeCfg, mkT({ dir: 'east', headcode: '1A03', bestTimeMs: BASE }), BASE - 300000);
  check('east (no strike): predictedStart = bestTime − 180s', p.predictedStart, iso(BASE - 180000));
  check('east (no strike): start = bestTime − 210s (safety-net backstop)', p.start, iso(BASE - 210000));
}
// C4: West stopping, struck → max(strike+10, dep−45).
{
  const a = periodFor(closeCfg, mkT({ dir: 'west', headcode: '2W20', source: 'ldb', bestTimeMs: BASE }),
    BASE + 5000, [{ hc: '2W20', ts: BASE, dir: 'west' }]);
  check('west stopping (struck, strike+10 later): close = strike + 10s', a.predictedStart, iso(BASE + 10000));
  const b = periodFor(closeCfg, mkT({ dir: 'west', headcode: '2W21', source: 'ldb', bestTimeMs: BASE + 200000 }),
    BASE + 5000, [{ hc: '2W21', ts: BASE, dir: 'west' }]);
  check('west stopping (struck, dep−45 later): close = departure − 45s', b.predictedStart, iso(BASE + 155000));
}
// C5: West stopping, no strike → predicted = departure − 45s; confirmed = bestTime − 90s.
{
  const p = periodFor(closeCfg, mkT({ dir: 'west', headcode: '2W22', source: 'ldb', bestTimeMs: BASE }), BASE - 300000);
  check('west stopping (no strike): predictedStart = departure − 45s', p.predictedStart, iso(BASE - 45000));
  check('west stopping (no strike): start = bestTime − 90s (safety-net backstop)', p.start, iso(BASE - 90000));
}
// C6: West freight / non-stopping → strike+20; no strike → bestTime − closeBefore.west (150s).
{
  const f = periodFor(closeCfg, mkT({ dir: 'west', headcode: '6O80', type: 'freight', bestTimeMs: BASE + 300000 }),
    BASE + 5000, [{ hc: '6O80', ts: BASE, dir: 'west' }]);
  check('west freight (struck): strike + 20s', f.predictedStart, iso(BASE + 20000));
  const fn = periodFor(closeCfg, mkT({ dir: 'west', headcode: '6O81', type: 'freight', bestTimeMs: BASE }), BASE - 300000);
  check('west freight (no strike): predictedStart = bestTime − closeBefore.west (150s)', fn.predictedStart, iso(BASE - 150000));
  const ns = periodFor(closeCfg, mkT({ dir: 'west', headcode: '2W23', type: 'passenger', source: 'cif', bestTimeMs: BASE + 300000 }),
    BASE + 5000, [{ hc: '2W23', ts: BASE, dir: 'west' }]);
  check('west non-stopping cif passenger (struck): strike + 20s (other bucket)', ns.predictedStart, iso(BASE + 20000));
}
// C7: Strike older than the TTL → ignored (baseline used); prune removes it.
{
  const staleTs = BASE - 25 * 60000;                       // 25 min ago (> 20 min TTL)
  const state = new CrossingState('t', closeCfg);
  state.closeStrikeSeen.set('1A04', { ts: staleTs, direction: 'east' });
  const p = state._computeClosures([mkT({ dir: 'east', headcode: '1A04', bestTimeMs: BASE })], new Date(BASE))[0];
  check('stale strike (> TTL) ignored → east baseline (bestTime − 180s)', p.predictedStart, iso(BASE - 180000));
  state._pruneCloseStrikes(BASE);
  check('prune removes the stale strike', state.closeStrikeSeen.has('1A04'), false);
}
// C8: closeTrigger absent → close = bestTime − closeBefore (unchanged); start == predictedStart.
{
  const p = periodFor(legacyCfg, mkT({ dir: 'east', headcode: '1A05', bestTimeMs: BASE }), BASE - 300000);
  check('no closeTrigger: predictedStart = bestTime − closeBefore.east (90s)', p.predictedStart, iso(BASE - 90000));
  check('no closeTrigger: start == predictedStart', p.start, p.predictedStart);
}

// ---- Change 1: recordTdCloseStrike berth matching -------------------------
console.log('  -- recordTdCloseStrike berth match --');
{
  const state = new CrossingState('t', closeCfg);
  state.recordTdCloseStrike({ headcode: '1A06', to: '0006', from: '0002', ts: iso(BASE) });
  const e = state.closeStrikeSeen.get('1A06');
  check('entering 0006 records an EAST strike', e ? e.direction : null, 'east');
  check('strike ts parsed from event', e ? e.ts : null, BASE);
  state.recordTdCloseStrike({ headcode: '2W24', to: '0003', from: '0001', ts: iso(BASE) });
  const w = state.closeStrikeSeen.get('2W24');
  check('entering 0003 records a WEST strike', w ? w.direction : null, 'west');
  state.recordTdCloseStrike({ headcode: '9Z99', to: '9999', from: '0000', ts: iso(BASE) });
  check('entering a non-approach berth is ignored', state.closeStrikeSeen.has('9Z99'), false);
}

// ---- Change 3: direction-aware hold / merge -------------------------------
console.log('  -- direction-aware merge --');
// M9: two SAME-direction trains, small positive gap → split (two periods).
{
  const state = new CrossingState('t', mergeCfg);
  const ps = state._computeClosures([
    mkT({ dir: 'east', headcode: '1A01', bestTimeMs: BASE }),
    mkT({ dir: 'east', headcode: '1A02', bestTimeMs: BASE + 150000 })   // gap +30s
  ], new Date(BASE));
  check('same-direction small positive gap → two periods (split)', ps.length, 2);
}
// M10: two OPPOSITE-direction trains — merge iff gap ≤ 20s.
{
  const state = new CrossingState('t', mergeCfg);
  const merged = state._computeClosures([
    mkT({ dir: 'east', headcode: '1A01', bestTimeMs: BASE }),
    mkT({ dir: 'west', headcode: '2W20', bestTimeMs: BASE + 200000 })   // gap = 20s
  ], new Date(BASE));
  check('opposite gap = 20s → one period (merged)', merged.length, 1);
  const split = state._computeClosures([
    mkT({ dir: 'east', headcode: '1A01', bestTimeMs: BASE }),
    mkT({ dir: 'west', headcode: '2W20', bestTimeMs: BASE + 220000 })   // gap = 40s
  ], new Date(BASE));
  check('opposite gap = 40s → two periods (split)', split.length, 2);
}
// M11: W,E,W each opposite-adjacent ≤20 → one; W,E,E → the E,E boundary splits → two.
{
  const state = new CrossingState('t', mergeCfg);
  const wew = state._computeClosures([
    mkT({ dir: 'west', headcode: '2W20', bestTimeMs: BASE }),
    mkT({ dir: 'east', headcode: '1A01', bestTimeMs: BASE + 120000 }),
    mkT({ dir: 'west', headcode: '2W21', bestTimeMs: BASE + 300000 })
  ], new Date(BASE));
  check('W,E,W opposite-adjacent ≤20s → one merged period', wew.length, 1);
  check('W,E,W merged period spans three trains', wew[0].trainCount, 3);
  const wee = state._computeClosures([
    mkT({ dir: 'west', headcode: '2W20', bestTimeMs: BASE }),
    mkT({ dir: 'east', headcode: '1A01', bestTimeMs: BASE + 120000 }),
    mkT({ dir: 'east', headcode: '1A02', bestTimeMs: BASE + 300000 })
  ], new Date(BASE));
  check('W,E,E → E,E boundary (same dir) splits → two periods', wee.length, 2);
}
// M12: same-direction TRUE overlap (prev open after next close) → merged (physical fallback).
{
  const state = new CrossingState('t', mergeCfg);
  const ps = state._computeClosures([
    mkT({ dir: 'east', headcode: '1A01', bestTimeMs: BASE }),
    mkT({ dir: 'east', headcode: '1A02', bestTimeMs: BASE + 60000 })    // gap −60s (overlap)
  ], new Date(BASE));
  check('same-direction true overlap → one period (merged)', ps.length, 1);
  check('same-direction overlap: two trains', ps[0].trainCount, 2);
}
// M13: mergeOppositeMaxGapSecs absent → legacy consecutiveWindow grouping unchanged
//      (same-dir pair merges under legacy where directional would split).
{
  const state = new CrossingState('t', legacyCfg);
  const ps = state._computeClosures([
    mkT({ dir: 'east', headcode: '1A01', bestTimeMs: BASE }),
    mkT({ dir: 'east', headcode: '1A02', bestTimeMs: BASE + 120000 })   // within consecutiveWindow
  ], new Date(BASE));
  check('no merge config → legacy consecutiveWindow merges same-dir pair (one period)', ps.length, 1);
}

// ---- Change 5b: gated CLOSED state (_deriveState) -------------------------
console.log('  -- gated state (confirmed start / predicted countdown) --');
// Period shape: not struck → start ≤ predictedStart; struck → equal.
{
  const notStruck = periodFor(closeCfg, mkT({ dir: 'east', headcode: '1A07', bestTimeMs: BASE }), BASE - 400000);
  checkTruthy('not struck: start ≤ predictedStart (backstop earlier/safer)',
    new Date(notStruck.start).getTime() <= new Date(notStruck.predictedStart).getTime());
  check('not struck: start strictly earlier than predictedStart', notStruck.start !== notStruck.predictedStart, true);
  const struck = periodFor(closeCfg, mkT({ dir: 'east', headcode: '1A07', bestTimeMs: BASE, source: 'ldb' }),
    BASE - 180000, [{ hc: '1A07', ts: BASE - 280000, dir: 'east' }]);
  check('struck: start == predictedStart', struck.start, struck.predictedStart);
  check('struck: onset = strike + 100s', struck.start, iso(BASE - 180000));
}
// Late train, strike not yet in: countdown region shows CLOSING_SOON, NOT CLOSED, until
// the backstop; then CLOSED at the safety net (no-strike east period: start −210, pred −180).
{
  const state = new CrossingState('t', closeCfg);
  state.closurePeriods = state._computeClosures([mkT({ dir: 'east', headcode: '1A08', bestTimeMs: BASE })], new Date(BASE - 400000));
  check('no strike: CLOSING_SOON before the backstop (not CLOSED)', state._deriveState(new Date(BASE - 250000)), 'CLOSING_SOON');
  check('no strike: OPEN well before the predicted close', state._deriveState(new Date(BASE - 600000)), 'OPEN');
  check('no strike: CLOSED at the safety-net backstop (bestTime − 210s)', state._deriveState(new Date(BASE - 210000)), 'CLOSED');
  check('no strike: still CLOSING_SOON just before the backstop', state._deriveState(new Date(BASE - 220000)), 'CLOSING_SOON');
}
// With a normal strike: CLOSED at strike + 100s; the backstop (−210) never triggers.
{
  const state = new CrossingState('t', closeCfg);
  const t = mkT({ dir: 'east', headcode: '1A08', bestTimeMs: BASE, source: 'ldb' });
  state.closeStrikeSeen.set('1A08', { ts: BASE - 280000, direction: 'east' });
  state.closurePeriods = state._computeClosures([t], new Date(BASE - 180000));
  check('struck: NOT CLOSED at −200s (before strike onset, though past −210 backstop)',
    state._deriveState(new Date(BASE - 200000)), 'CLOSING_SOON');
  check('struck: CLOSED at strike + 100s (−180s)', state._deriveState(new Date(BASE - 180000)), 'CLOSED');
}
// West stopping gate: the flip to CLOSED is driven by start (backstop/strike), NOT the
// dep−45 prediction. Not struck → start (−90) earlier than predicted (−45); struck → equal.
{
  const ns = periodFor(closeCfg, mkT({ dir: 'west', headcode: '2W25', source: 'ldb', bestTimeMs: BASE }), BASE - 300000);
  check('west stopping (no strike): start = bestTime − 90s (not the dep−45 prediction)', ns.start, iso(BASE - 90000));
  check('west stopping (no strike): predictedStart = dep − 45s', ns.predictedStart, iso(BASE - 45000));
  const st = periodFor(closeCfg, mkT({ dir: 'west', headcode: '2W25', source: 'ldb', bestTimeMs: BASE }),
    BASE - 45000, [{ hc: '2W25', ts: BASE - 120000, dir: 'west' }]);
  check('west stopping (struck): start == predictedStart == dep − 45s', st.start, iso(BASE - 45000));
}
// Live not scheduled: a late bestTime with an on-time scheduledTime closes off bestTime.
{
  const p = periodFor(closeCfg,
    mkT({ dir: 'east', headcode: '1A10', bestTimeMs: BASE + 600000, schedMs: BASE }), BASE);
  check('close computed off LIVE bestTime, not scheduledTime', p.predictedStart, iso(BASE + 420000));
}

// ---- Clear-step-aware merge key (_openPred) ------------------------------
// Regression for the live 2026-07-25 19:08 incident: 1S27 (east) physically cleared
// the crossing at 19:07:39, but its LDB arrival estimate kept drifting later, so its
// bestTime-based openPred (19:10:30) dragged the following westbound 2Y62 into the
// same period — the app showed one continuous 4m40s closure across a gap where the
// barrier had really lifted (2m03s of false barriers-down).
console.log('  -- clear-step-aware merge key --');

const mergeClearCfg = {
  ...closeCfg,
  timing: { ...closeCfg.timing, openLagSecs: { east: { passenger: 45, freight: 70 }, west: { passenger: 18, freight: 30 } } }
};

{
  // BASE = the moment 1S27 cleared. Offsets are the real ones from the incident.
  const clearTs = BASE;
  const state = new CrossingState('t', mergeClearCfg);
  state.closeStrikeSeen.set('1S27', { ts: clearTs - 212000, direction: 'east' }); // 0006 at 19:04:07
  state.clearStepSeen.set('1S27', { ts: clearTs, direction: 'east' });            // 0004→0002 19:07:39
  const east = mkT({ dir: 'east', headcode: '1S27', bestTimeMs: clearTs + 141000 }); // stale 19:10:00
  const west = mkT({ dir: 'west', headcode: '2Y62', bestTimeMs: clearTs + 186000 }); // 19:10:45
  const periods = state._computeClosures([east, west], new Date(clearTs + 46000));   // now = 19:08:25

  check('cleared train no longer merges the follower: 2 periods, not 1', periods.length, 2);
  check('period 1 (1S27) ends at its clear step + 45s', periods[0].end, iso(clearTs + 45000));
  check('period 1 holds only the cleared train', periods[0].trains.map(t => t.headcode).join(), '1S27');
  check('period 2 (2Y62) starts on its own dep − 45s', periods[1].predictedStart, iso(clearTs + 141000));

  // The same inputs WITHOUT a recorded clear step must still merge — proving the split
  // above comes from the clear step, not from some unrelated change to the gap maths.
  const naive = new CrossingState('t', mergeClearCfg);
  naive.closeStrikeSeen.set('1S27', { ts: clearTs - 212000, direction: 'east' });
  const merged = naive._computeClosures([east, west], new Date(clearTs + 46000));
  check('same inputs with no clear step recorded: still one merged period', merged.length, 1);
}

{
  // Safety property: an INTERMEDIATE train's clear step must never shorten a period.
  // Both trains cleared, but the period must run to the LATER of the two ends.
  const clearTs = BASE;
  const state = new CrossingState('t', mergeClearCfg);
  state.clearStepSeen.set('1A20', { ts: clearTs, direction: 'east' });
  state.clearStepSeen.set('1A21', { ts: clearTs + 90000, direction: 'east' });
  const a = mkT({ dir: 'east', headcode: '1A20', bestTimeMs: clearTs + 5000 });
  const b = mkT({ dir: 'east', headcode: '1A21', bestTimeMs: clearTs + 10000 });
  const periods = state._computeClosures([a, b], new Date(clearTs + 95000));
  check('merged period ends on the LAST train\'s clear step, not the first',
    periods[periods.length - 1].end, iso(clearTs + 90000 + 45000));
}

// ---- CIF calling-pattern classification (_isStopping) --------------------
// A CIF-sourced passenger service beyond the ~2h LDB window used to be treated as
// non-stopping simply because it wasn't on the board. schedule-parser now supplies
// callsAtStation, so it can be classified from the schedule instead.
console.log('  -- CIF calling-pattern classification --');

{
  const cif = (o) => ({ ...mkT({ ...o, source: 'cif' }), callsAtStation: o.callsAtStation });

  // East: a CIF passenger that CALLS gets stoppingSecs (100), not otherSecs (80).
  const calls = periodFor(closeCfg, cif({ dir: 'east', headcode: '1C01', bestTimeMs: BASE, callsAtStation: true }),
    BASE - 300000, [{ hc: '1C01', ts: BASE - 300000, dir: 'east' }]);
  check('east CIF caller: struck close = strike + stoppingSecs(100)', calls.predictedStart, iso(BASE - 200000));

  const passes = periodFor(closeCfg, cif({ dir: 'east', headcode: '1C02', bestTimeMs: BASE, callsAtStation: false }),
    BASE - 300000, [{ hc: '1C02', ts: BASE - 300000, dir: 'east' }]);
  check('east CIF non-caller: struck close = strike + otherSecs(80)', passes.predictedStart, iso(BASE - 220000));

  const unknown = periodFor(closeCfg, cif({ dir: 'east', headcode: '1C03', bestTimeMs: BASE, callsAtStation: null }),
    BASE - 300000, [{ hc: '1C03', ts: BASE - 300000, dir: 'east' }]);
  check('east CIF unknown: falls back to otherSecs(80), the old conservative answer',
    unknown.predictedStart, iso(BASE - 220000));

  // West: a CIF caller must NOT enter the dep−45 branch — its bestTime is an
  // interpolated crossing time, not a departure. Expect the closeBefore baseline (2.5 min).
  const w = periodFor(closeCfg, cif({ dir: 'west', headcode: '1C04', bestTimeMs: BASE, callsAtStation: true }), BASE - 300000);
  check('west CIF caller: stays on the closeBefore baseline, NOT dep − 45s',
    w.predictedStart, iso(BASE - 150000));

  // ...while an LDB westbound stopper is unaffected.
  const wl = periodFor(closeCfg, mkT({ dir: 'west', headcode: '2W30', bestTimeMs: BASE, source: 'ldb' }), BASE - 300000);
  check('west LDB stopper: still dep − 45s', wl.predictedStart, iso(BASE - 45000));
}

// ---- CLOSING_SOON window matches the frontend ----------------------------
// The frontend derives its own state and flips to CLOSING SOON at 90 s. This state
// field only feeds the state log, so it must agree with what the user actually saw.
console.log('  -- CLOSING_SOON window --');

{
  const state = new CrossingState('t', closeCfg);
  // Struck east stopper: predicted close == confirmed close == strike + 100s.
  const strike = BASE - 100000;                       // close lands exactly at BASE
  state.closeStrikeSeen.set('1A30', { ts: strike, direction: 'east' });
  const t = mkT({ dir: 'east', headcode: '1A30', bestTimeMs: BASE + 180000 });
  state.closurePeriods = state._computeClosures([t], new Date(BASE - 120000));

  check('OPEN at 100s before the predicted close', state._deriveState(new Date(BASE - 100000)), 'OPEN');
  check('CLOSING_SOON at exactly 90s before', state._deriveState(new Date(BASE - 90000)), 'CLOSING_SOON');
  check('CLOSING_SOON at 30s before', state._deriveState(new Date(BASE - 30000)), 'CLOSING_SOON');
  check('CLOSED once the close time is reached', state._deriveState(new Date(BASE)), 'CLOSED');
}

console.log();
if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
else { console.log(`All ${pass} tests passed.`); }
