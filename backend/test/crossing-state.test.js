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
// Strikes are keyed headcode|berth. Default to the direction's single approach berth
// (0006 east / 0003 west) so the legacy-shaped tests read the same as before.
function setStrike(state, hc, ts, dir, berth) {
  const b = berth || (dir === 'east' ? '0006' : '0003');
  state.closeStrikeSeen.set(`${hc}|${b}`, { ts, direction: dir, headcode: hc, berth: b });
}
// close a single train and return its one period (predictedStart / start / end).
function periodFor(cfg, train, nowMs, strikes = []) {
  const state = new CrossingState('t', cfg);
  for (const s of strikes) setStrike(state, s.hc, s.ts, s.dir, s.berth);
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
  setStrike(state, '1A04', staleTs, 'east');
  const p = state._computeClosures([mkT({ dir: 'east', headcode: '1A04', bestTimeMs: BASE })], new Date(BASE))[0];
  check('stale strike (> TTL) ignored → east baseline (bestTime − 180s)', p.predictedStart, iso(BASE - 180000));
  state._pruneCloseStrikes(BASE);
  check('prune removes the stale strike', state.closeStrikeSeen.has('1A04|0006'), false);
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
  const e = state.closeStrikeSeen.get('1A06|0006');
  check('entering 0006 records an EAST strike', e ? e.direction : null, 'east');
  check('strike ts parsed from event', e ? e.ts : null, BASE);
  state.recordTdCloseStrike({ headcode: '2W24', to: '0003', from: '0001', ts: iso(BASE) });
  const w = state.closeStrikeSeen.get('2W24|0003');
  check('entering 0003 records a WEST strike', w ? w.direction : null, 'west');
  state.recordTdCloseStrike({ headcode: '9Z99', to: '9999', from: '0000', ts: iso(BASE) });
  check('entering a non-approach berth is ignored', state.closeStrikeSeen.has('9Z99|9999'), false);
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
  setStrike(state, '1A08', BASE - 280000, 'east');
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
  setStrike(state, '1S27', clearTs - 212000, 'east'); // 0006 at 19:04:07
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
  setStrike(naive, '1S27', clearTs - 212000, 'east');
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
  setStrike(state, '1A30', strike, 'east');
  const t = mkT({ dir: 'east', headcode: '1A30', bestTimeMs: BASE + 180000 });
  state.closurePeriods = state._computeClosures([t], new Date(BASE - 120000));

  check('OPEN at 100s before the predicted close', state._deriveState(new Date(BASE - 100000)), 'OPEN');
  check('CLOSING_SOON at exactly 90s before', state._deriveState(new Date(BASE - 90000)), 'CLOSING_SOON');
  check('CLOSING_SOON at 30s before', state._deriveState(new Date(BASE - 30000)), 'CLOSING_SOON');
  check('CLOSED once the close time is reached', state._deriveState(new Date(BASE)), 'CLOSED');
}

// ---- Per-class eastbound close anchors -----------------------------------
// Approach berth 0006 contains Southwick, so its strike means two different things
// depending on whether the service calls there. Each class anchors to its own berth.
console.log('  -- per-class eastbound anchors --');

const classCfg = {
  name: 'Class Test', road: 'Test Rd',
  td: {
    eastbound: {
      approach: { from: '0006', to: '0004' },
      clear: { from: '0004', to: '0002' },
      approachChain: ['0016', '0014', '0012', '0010', '0008', '0006', '0004']
    },
    westbound: {
      approach: { from: '0003', to: '0005' },
      clear: { from: '0005', to: '0007' },
      approachChain: ['T682', 'T677', '0001', '0003', '0005']
    }
  },
  timing: {
    closeBefore: { east: 1.5, west: 2.5 },
    openAfter: { east: 0.5, west: 0.5 },
    consecutiveWindow: 1.5,
    closeTrigger: {
      east: {
        classes: {
          stopping:      { berth: '0008', offsetSecs: 40 },
          stoppingLocal: { berth: '0006', offsetSecs: 100 },
          fast:          { berth: '0008', offsetSecs: 20 },
          ecs:           { berth: '0008', offsetSecs: 85 },
          freight:       { berth: '0006', offsetSecs: 20 }
        },
        predictedLeadSecs: 180,
        safetyNetSecs: 145,
        confirmedMayFollowPredicted: true   // as production: "Soon" is live eastbound
      },
      west: { stoppingDepartureLeadSecs: 45, stoppingMinAfterStrikeSecs: 10, otherSecs: 20, safetyNetSecs: 90 }
    },
    mergeOppositeMaxGapSecs: 20
  }
};

// class determination
{
  const st = new CrossingState('t', classCfg);
  const cls = (o) => st._eastClass({ ...mkT({ dir: 'east', ...o }), callsAtApproach: o.callsAtApproach });
  check('freight → freight class', cls({ headcode: '6O68', type: 'freight' }), 'freight');
  check('5xxx ECS → ecs class', cls({ headcode: '5T91', type: 'ecs' }), 'ecs');
  check('LDB stopper NOT calling Southwick → stopping (class A)',
    cls({ headcode: '1H67', bestTimeMs: BASE, callsAtApproach: false }), 'stopping');
  check('LDB stopper calling Southwick → stoppingLocal (class B)',
    cls({ headcode: '1N61', bestTimeMs: BASE, callsAtApproach: true }), 'stoppingLocal');
  check('unknown Southwick answer → stoppingLocal (the calibrated rule)',
    cls({ headcode: '1N99', bestTimeMs: BASE, callsAtApproach: null }), 'stoppingLocal');
  const cifPass = { ...mkT({ dir: 'east', headcode: '1Z01', bestTimeMs: BASE, source: 'cif' }), callsAtStation: false };
  check('non-caller passenger → fast', st._eastClass(cifPass), 'fast');
}

// Southwick answer resolved from the CIF schedule by UID, for an LDB-sourced train
{
  const st = new CrossingState('t', classCfg);
  st.scheduleTrains = [{ uid: 'W12345', headcode: '1H67', callsAtApproach: false, callsAtStation: true }];
  const t = { ...mkT({ dir: 'east', headcode: '1H67', bestTimeMs: BASE }), uid: 'W12345' };
  check('LDB train inherits the Southwick answer from CIF by UID', st._eastClass(t), 'stopping');
}

// each class anchors to its own berth + offset
{
  const anchored = (o, strikes) => {
    const st = new CrossingState('t', classCfg);
    for (const s of strikes) setStrike(st, o.headcode, s.ts, 'east', s.berth);
    const t = { ...mkT({ dir: 'east', ...o }), callsAtApproach: o.callsAtApproach };
    return st._computeClosures([t], new Date(BASE - 300000))[0];
  };
  check('class A: 0008 strike + 40s',
    anchored({ headcode: '1H67', bestTimeMs: BASE, callsAtApproach: false },
      [{ ts: BASE - 240000, berth: '0008' }]).predictedStart, iso(BASE - 200000));
  check('class B: 0006 strike + 100s (unchanged)',
    anchored({ headcode: '1N61', bestTimeMs: BASE, callsAtApproach: true },
      [{ ts: BASE - 240000, berth: '0006' }]).predictedStart, iso(BASE - 140000));
  check('freight: 0006 strike + 20s (NOT the fast-passenger rule)',
    anchored({ headcode: '6O68', type: 'freight', bestTimeMs: BASE },
      [{ ts: BASE - 240000, berth: '0006' }]).predictedStart, iso(BASE - 220000));
  check('ecs: 0008 strike + 85s',
    anchored({ headcode: '5T91', type: 'ecs', bestTimeMs: BASE },
      [{ ts: BASE - 240000, berth: '0008' }]).predictedStart, iso(BASE - 155000));

  // A class-A train striking 0006 must NOT re-anchor — 0006 is not its berth. This is
  // what caused the CLOSED → CLOSING_SOON → CLOSED flicker on every 1H service.
  check('class A ignores a 0006 strike (wrong berth for its class)',
    anchored({ headcode: '1H67', bestTimeMs: BASE, callsAtApproach: false },
      [{ ts: BASE - 100000, berth: '0006' }]).predictedStart, iso(BASE - 180000));
}

// ---- Position-gated backstop ---------------------------------------------
console.log('  -- position-gated backstop --');
{
  const withPos = (berth) => {
    const st = new CrossingState('t', classCfg);
    const t = { ...mkT({ dir: 'east', headcode: '1H67', bestTimeMs: BASE }), callsAtApproach: false };
    if (berth) st.liveTrains.set('1H67', { berth, lastSeen: BASE - 200000 });
    return st._computeClosures([t], new Date(BASE - 200000))[0];
  };
  check('no live position: backstop applies (bestTime − 145s)', withPos(null).start, iso(BASE - 145000));
  // Upstream: the gated close is HELD into the near future, never pulled earlier. It must
  // be strictly LATER than the ungated backstop, otherwise the gate would make CLOSED fire
  // sooner for a train we can see has not arrived — which is what it did on first write.
  const up = withPos('0012');
  check('upstream, backstop still future: gated close = the backstop, never earlier',
    up.start, iso(BASE - 145000));
  check('upstream close is NOT pulled back to the pre-strike prediction',
    Date.parse(up.start) > BASE - 180000, true);

  // Once the backstop time itself has passed, the hold has to bind — otherwise a train
  // we can see is still four berths away would show CLOSED off a drifting bestTime.
  const late = (berth, nowMs) => {
    const st = new CrossingState('t', classCfg);
    const t = { ...mkT({ dir: 'east', headcode: '1H67', bestTimeMs: BASE }), callsAtApproach: false };
    if (berth) st.liveTrains.set('1H67', { berth, lastSeen: nowMs });
    return st._computeClosures([t], new Date(nowMs))[0];
  };
  const held = late('0012', BASE - 100000);          // past bestTime−145s, still at 0012
  check('upstream past the backstop time: close held to now + 30s (not CLOSED)',
    held.start, iso(BASE - 100000 + 30000));
  check('...so the period is still in the future — no CLOSED', Date.parse(held.start) > BASE - 100000, true);
  const free = late('0006', BASE - 100000);          // same instant, but past the anchor
  check('past the anchor at the same instant: backstop applies and CLOSED is allowed',
    Date.parse(free.start) <= BASE - 100000, true);
  check('at the anchor berth (0008) with no strike: backstop applies', withPos('0008').start, iso(BASE - 145000));
  check('past the anchor (0006) with no strike: backstop applies', withPos('0006').start, iso(BASE - 145000));
  check('elsewhere in the TD area (not on the chain): backstop applies', withPos('A012').start, iso(BASE - 145000));
}

// ---- Regression: the 2026-07-24 21:42 false CLOSED (1H67) -----------------
// Real timings: 0008 in 20:42:04, 0006 in 20:43:22, crossed 20:44:58, bestTime 20:46:00.
// Old behaviour: backstop (bestTime−210 = 20:42:30) fired CLOSED while the train was
// still in 0008; the 0006 strike then pushed the close out to 20:45:02 — four seconds
// AFTER it had already crossed the road — un-CLOSING and re-CLOSING the app.
console.log('  -- 1H67 regression (2026-07-24) --');
{
  const T = (hhmmss) => Date.parse(`2026-07-24T${hhmmss}Z`);
  const st = new CrossingState('t', classCfg);
  const t = { ...mkT({ dir: 'east', headcode: '1H67', bestTimeMs: T('20:46:00') }), callsAtApproach: false };

  // 20:42:03 — one second before reaching 0008, TD shows it in 0010.
  st.liveTrains.set('1H67', { berth: '0010', lastSeen: T('20:42:03') });
  let p = st._computeClosures([t], new Date(T('20:42:03')))[0];
  check('at 20:42:03 (in 0010): NOT closed — backstop held off by position',
    new Date(p.start) <= new Date(T('20:42:03')), false);

  // 20:42:04 — strikes 0008, its anchor.
  st.recordTdBerth({ headcode: '1H67', to: '0008', from: '0010', ts: new Date(T('20:42:04')).toISOString() });
  setStrike(st, '1H67', T('20:42:04'), 'east', '0008');
  p = st._computeClosures([t], new Date(T('20:42:04')))[0];
  check('0008 strike anchors the close to 20:42:44 (strike + 40s)', p.predictedStart, iso(T('20:42:44')));
  check('confirmed == predicted once struck', p.start, p.predictedStart);

  // 20:43:22 — strikes 0006. Must NOT move anything for this class.
  st.recordTdBerth({ headcode: '1H67', to: '0006', from: '0008', ts: new Date(T('20:43:22')).toISOString() });
  setStrike(st, '1H67', T('20:43:22'), 'east', '0006');
  const p2 = st._computeClosures([t], new Date(T('20:43:22')))[0];
  check('0006 strike does not move the close (no flicker)', p2.predictedStart, iso(T('20:42:44')));
  check('close now precedes the real crossing (20:44:58) by 134s',
    Math.round((T('20:44:58') - Date.parse(p2.predictedStart)) / 1000), 134);
}

// ---- Last-known train cache (feedback picker anchors) --------------------
// An LDB board lists only services still to call, so once a train departs it matches
// nothing but its CIF entry — and CIF entries carry no schedArr/schedDep/liveArr/liveDep
// at all. An OPEN tap is attributed to a just-cleared train by definition, so all four
// calibration anchors were being lost for exactly the events that need them.
//
// _mergeTrains reads the real clock (unlike _computeClosures, which takes an explicit
// `now`), so these are built around Date.now() rather than the fixed BASE epoch.
const NOW = Date.now();
const iso2 = (ms) => new Date(ms).toISOString();
const ldbTrain = (o) => ({
  origin: 'A', destination: 'B', operator: 'ZZ',
  scheduledTime: iso2(o.bestMs), bestTime: iso2(o.bestMs),
  direction: o.dir, delayMins: 0, isUncertain: false, etaText: 'On time',
  headcode: o.hc, uid: o.uid || null, trainType: 'passenger', source: 'ldbsv',
  schedArr: o.schedArr || '21:17', schedDep: o.schedDep || '21:18',
  liveArr: o.liveArr === undefined ? '21:18' : o.liveArr,
  liveDep: o.liveDep === undefined ? '21:19' : o.liveDep,
  dedupKey: 'x'
});

// ---- Feedback picker keeps its time anchors after departure ---------------
console.log('  -- picker anchors survive departure --');
{
  const state = new CrossingState('t', classCfg);
  state.ldbTrains = [ldbTrain({ hc: '1H69', dir: 'east', bestMs: NOW + 60000,
    schedArr: '21:17', schedDep: '21:18', liveArr: '21:19', liveDep: '21:20' })];
  state._mergeTrains();                                   // board still lists it: cached
  state.recordTdBerth({ headcode: '1H69', to: '0002', from: '0004', ts: iso2(NOW) });
  state.ldbTrains = [];                                   // departed: off the board
  const live = state.getLiveTrains(NOW + 1000).find(t => t.headcode === '1H69');
  check('departed train still resolves', !!live, true);
  check('schedArr survives the departure', live ? live.schedArr : null, '21:17');
  check('schedDep survives the departure', live ? live.schedDep : null, '21:18');
  check('liveArr survives the departure', live ? live.liveArr : null, '21:19');
  check('liveDep survives the departure', live ? live.liveDep : null, '21:20');
  check('direction still resolved (not "unknown")', live ? live.direction : null, 'east');
  check('stopping stays true rather than degrading to "unknown"', live ? live.stopping : null, true);

  // The real-world shape: Darwin KEEPS the departed service on the board and blanks the
  // estimates rather than dropping the row, so the live match still wins the record
  // lookup while holding nothing. Observed 2026-07-26 on 1N34.
  const st2 = new CrossingState('t', classCfg);
  st2.ldbTrains = [ldbTrain({ hc: '1N34', dir: 'west', bestMs: NOW + 60000,
    schedArr: '21:09', schedDep: '21:09', liveArr: '21:11', liveDep: '21:12' })];
  st2._mergeTrains();
  st2.recordTdBerth({ headcode: '1N34', to: '0007', from: '0005', ts: iso2(NOW) });
  // same row, estimates blanked as it arrives then departs
  st2.ldbTrains = [ldbTrain({ hc: '1N34', dir: 'west', bestMs: NOW + 60000,
    schedArr: '21:09', schedDep: '21:09', liveArr: null, liveDep: null })];
  st2._mergeTrains();
  const l2 = st2.getLiveTrains(NOW + 2000).find(t => t.headcode === '1N34');
  check('board blanks liveArr but keeps the row: last value retained', l2 ? l2.liveArr : null, '21:11');
  check('board blanks liveDep but keeps the row: last value retained', l2 ? l2.liveDep : null, '21:12');
  check('scheduled times unaffected', l2 ? l2.schedArr : null, '21:09');

  // A headcode reused much later in the day must not resolve to this morning's working.
  state.knownTrains.get('1H69').sourceSeenMs = NOW - 60 * 60000;
  state._mergeTrains();
  check('cache entry expires after its TTL', state.knownTrains.has('1H69'), false);
}

// ---- closeConfirmed / state derivation / west invariant ------------------
console.log('  -- closeConfirmed + state + west invariant --');

{
  // closeConfirmed reflects the train that SETS the gating close, not just any strike.
  const st = new CrossingState('t', classCfg);
  const t = { ...mkT({ dir: 'east', headcode: '1H67', bestTimeMs: BASE }), callsAtApproach: false };
  let p = st._computeClosures([t], new Date(BASE - 300000))[0];
  check('unstruck period: closeConfirmed false', p.closeConfirmed, false);

  setStrike(st, '1H67', BASE - 240000, 'east', '0008');
  p = st._computeClosures([t], new Date(BASE - 200000))[0];
  check('struck at its anchor: closeConfirmed true', p.closeConfirmed, true);
  check('...and start == predictedStart', p.start, p.predictedStart);

  // A strike on the WRONG berth for the class must not claim confirmation.
  const st2 = new CrossingState('t', classCfg);
  setStrike(st2, '1H67', BASE - 100000, 'east', '0006');   // class A anchors on 0008
  const p2 = st2._computeClosures([t], new Date(BASE - 90000))[0];
  check('strike on a berth this class does not anchor to: closeConfirmed false',
    p2.closeConfirmed, false);
}

{
  // _deriveState must not skip a period whose predicted close has passed but whose
  // gating start has not — the window that exists because safetyNet < predictedLead.
  const st = new CrossingState('t', classCfg);
  const t = { ...mkT({ dir: 'east', headcode: '1H67', bestTimeMs: BASE }), callsAtApproach: false };
  st.closurePeriods = st._computeClosures([t], new Date(BASE - 300000));
  const pred = Date.parse(st.closurePeriods[0].predictedStart);   // BASE − 180s
  const start = Date.parse(st.closurePeriods[0].start);           // BASE − 145s
  check('the gap under test exists (start after predictedStart)', start > pred, true);
  check('before the predicted close: CLOSING_SOON', st._deriveState(new Date(pred - 30000)), 'CLOSING_SOON');
  check('predicted passed, gate not reached: still CLOSING_SOON (was OPEN)',
    st._deriveState(new Date(pred + 10000)), 'CLOSING_SOON');
  check('gate reached: CLOSED', st._deriveState(new Date(start + 1000)), 'CLOSED');
}

{
  // The API's state must reflect request time, not the last recompute.
  const st = new CrossingState('t', classCfg);
  const t = { ...mkT({ dir: 'east', headcode: '1H67', bestTimeMs: Date.now() + 600000 }), callsAtApproach: false };
  st.ldbTrains = [];
  st.closurePeriods = st._computeClosures([t], new Date());
  st.state = 'CLOSED';                                     // deliberately stale
  check('getApiState derives state fresh rather than serving the stored value',
    st.getApiState().state === 'CLOSED', false);
}

{
  // West: the gated close must never sit later than the prediction it backs up.
  const wCfg = JSON.parse(JSON.stringify(classCfg));
  const nonStop = mkT({ dir: 'west', headcode: '6O99', type: 'freight', bestTimeMs: BASE, source: 'cif' });
  const stW = new CrossingState('t', wCfg);
  const pw = stW._computeClosures([nonStop], new Date(BASE - 400000))[0];
  check('west non-stopping: gated close clamped to the prediction, not 60s later',
    pw.start, pw.predictedStart);
  check('...which is bestTime − closeBefore.west (150s)', pw.predictedStart, iso(BASE - 150000));

  // ...and a west stopper is untouched: its backstop is already earlier.
  const stopW = mkT({ dir: 'west', headcode: '2W30', bestTimeMs: BASE, source: 'ldb' });
  const ps = new CrossingState('t', wCfg)._computeClosures([stopW], new Date(BASE - 400000))[0];
  check('west stopper: still gated at bestTime − 90s (no regression)', ps.start, iso(BASE - 90000));
  check('west stopper: prediction still departure − 45s', ps.predictedStart, iso(BASE - 45000));
}

// ---- Berth projection: sharpening prediction ------------------------------
// The prediction engine IS the close/open logic, fed a projected anchor time when the
// real one hasn't happened yet. Measured transits are the only stored input, so
// recalibrating an offset moves the projection with it — no regeneration.
console.log('  -- berth projection --');

const projCfg = JSON.parse(JSON.stringify(classCfg));
projCfg.timing.openLagSecs = { east: { passenger: 45, freight: 70 }, west: { passenger: 18, freight: 30 } };
projCfg.transits = {
  east: {
    stopping:      { '0010>0008': { secs: 157, sdSecs: 23, n: 2229 },
                     '0010>XING': { secs: 355, sdSecs: 36, n: 2229 },
                     '0008>XING': { secs: 189, sdSecs: 28, n: 2235 } },
    stoppingLocal: { '0008>0006': { secs: 71, sdSecs: 14, n: 4553 } }
  }
};
const NOW2 = Date.now();
const eastT = (o) => ({ ...mkT({ dir: 'east', headcode: o.hc, bestTimeMs: o.bestMs }),
                        callsAtApproach: o.fsg === undefined ? false : o.fsg });

{
  const st = new CrossingState('t', projCfg);
  const t = eastT({ hc: '1H67', bestMs: NOW2 + 400000 });
  st.recordTdBerth({ headcode: '1H67', to: '0010', from: '0012', ts: new Date(NOW2).toISOString() });

  // 0010 → 0008 is 157s, and class A closes at 0008 + 40 ⇒ close ≈ now + 197s
  const p = st._computeClosures([t], new Date(NOW2 + 1000))[0];
  check('close projected from the current berth, not bestTime',
    Math.round((Date.parse(p.predictedStart) - NOW2) / 1000), 197);

  // ...and it is the CLOSE LOGIC being projected: change the offset, the projection moves
  const cfg2 = JSON.parse(JSON.stringify(projCfg));
  cfg2.timing.closeTrigger.east.classes.stopping.offsetSecs = 90;   // 40 -> 90
  const st2 = new CrossingState('t', cfg2);
  st2.recordTdBerth({ headcode: '1H67', to: '0010', from: '0012', ts: new Date(NOW2).toISOString() });
  const p2 = st2._computeClosures([eastT({ hc: '1H67', bestMs: NOW2 + 400000 })], new Date(NOW2 + 1000))[0];
  check('recalibrating the offset moves the projection with it (no regeneration)',
    Math.round((Date.parse(p2.predictedStart) - NOW2) / 1000), 247);
}

{
  // A real strike must beat a projection, and must collapse it to the exact value.
  const st = new CrossingState('t', projCfg);
  const t = eastT({ hc: '1H67', bestMs: NOW2 + 400000 });
  st.recordTdBerth({ headcode: '1H67', to: '0010', from: '0012', ts: new Date(NOW2).toISOString() });
  setStrike(st, '1H67', NOW2 + 150000, 'east', '0008');
  const p = st._computeClosures([t], new Date(NOW2 + 151000))[0];
  check('a real strike overrides the projection', p.predictedStart, iso(NOW2 + 190000));
  check('...and the close is then confirmed', p.closeConfirmed, true);
}

{
  // A projection is an estimate, never confirmation: it must not gate CLOSED.
  const st = new CrossingState('t', projCfg);
  const t = eastT({ hc: '1H67', bestMs: NOW2 + 400000 });
  st.recordTdBerth({ headcode: '1H67', to: '0010', from: '0012', ts: new Date(NOW2).toISOString() });
  const p = st._computeClosures([t], new Date(NOW2 + 1000))[0];
  check('projected close does NOT mark the period confirmed', p.closeConfirmed, false);
  check('projected close does NOT become the CLOSED gate', p.start === p.predictedStart, false);
}

{
  // No live position, or no transit sample: fall back to the bestTime prediction exactly
  // as before, so a crossing without a table is unaffected.
  const st = new CrossingState('t', projCfg);
  const t = eastT({ hc: '1H67', bestMs: NOW2 + 400000 });
  const p = st._computeClosures([t], new Date(NOW2))[0];
  check('no live position: falls back to bestTime − predictedLeadSecs',
    Math.round((Date.parse(p.predictedStart) - NOW2) / 1000), 220);

  const bare = new CrossingState('t', classCfg);      // no transits at all
  bare.recordTdBerth({ headcode: '1H67', to: '0010', from: '0012', ts: new Date(NOW2).toISOString() });
  const pb = bare._computeClosures([eastT({ hc: '1H67', bestMs: NOW2 + 400000 })], new Date(NOW2))[0];
  check('no transit table: unchanged behaviour',
    Math.round((Date.parse(pb.predictedStart) - NOW2) / 1000), 220);
}

{
  // OPEN: reopen projected from the current berth instead of the now+60 placeholder that
  // trailed the clock and made the countdown run backwards.
  const st = new CrossingState('t', projCfg);
  const t = eastT({ hc: '1H67', bestMs: NOW2 - 60000 });      // bestTime already passed
  st.tdSeenToday.set('1H67', new Date(NOW2));
  st.recordTdBerth({ headcode: '1H67', to: '0010', from: '0012', ts: new Date(NOW2).toISOString() });
  const p = st._computeClosures([t], new Date(NOW2 + 1000))[0];
  // 0010 → XING 355s, east passenger open lag 45s ⇒ reopen ≈ now + 400s
  check('reopen projected from the berth (not now + 60s)',
    Math.round((Date.parse(p.end) - NOW2) / 1000), 400);

  // and it must never land in the past while the train demonstrably hasn't cleared
  const late = st._computeClosures([t], new Date(NOW2 + 600000))[0];
  check('a stale projection is floored into the future, never expiring the closure',
    Date.parse(late.end) > NOW2 + 600000, true);
}

// ---- CIF merge: berth projection replaces the area-entry stopgap ----------
console.log('  -- CIF projection replaces areaEntryLeadSecs --');
{
  const cfg2 = JSON.parse(JSON.stringify(projCfg));
  const mk2 = () => ({ uid: 'C1', headcode: '1N63', direction: 'east', trainType: 'passenger',
    estimatedCrossingMins: 0, origin: 'A', destination: 'B', operator: 'ZZ',
    callsAtStation: true, callsAtApproach: false, source: 'schedule' });
  const T = Date.now();

  // Sighted entering area LA 20 min ago. The old rule projects sighting + 150s and drops
  // the train 3 min after that — i.e. ~15 min before it actually crosses. Measured over
  // 10 days this fires for 95% of eastbound trains.
  const stale = new CrossingState('t', cfg2);
  stale._scheduleTimeToDate = () => new Date(T - 10 * 60000);
  stale.scheduleTrains = [mk2()];
  stale.recordTdSighting('1N63', new Date(T - 20 * 60000));
  check('old path: a long-sighted train is dropped even though it is still coming',
    stale._mergeTrains().some(m => m.headcode === '1N63'), false);

  // Same train, but TD has it on our chain at 0010.
  const seen = new CrossingState('t', cfg2);
  seen._scheduleTimeToDate = () => new Date(T - 10 * 60000);
  seen.scheduleTrains = [mk2()];
  seen.recordTdSighting('1N63', new Date(T - 20 * 60000));
  seen.recordTdBerth({ headcode: '1N63', to: '0010', from: '0012', ts: new Date(T).toISOString() });
  const m = seen._mergeTrains().find(x => x.headcode === '1N63');
  check('berth projection keeps a train we can actually see', !!m, true);
  check('...with bestTime measured from the berth (0010 → crossing = 355s)',
    m ? Math.round((m.bestTime.getTime() - T) / 1000) : null, 355);
  check('...and labelled as a position estimate', m ? m.etaText : null, 'Live (berth)');
}

// ---- Restart artefact: seed the first-sighting map --------------------------
// tdSeenToday is memory-only, so a restart stamps every train then in area LA with a
// "first sighting" at boot; any whose scheduled crossing has passed is re-projected as
// imminent. Observed 2026-07-26 21:42:13 — two CIF services that never ran were merged
// into a real closure and held BARRIERS DOWN for 5m31s.
console.log('  -- restart: seeded sightings --');
{
  const T = Date.now();
  const ghost = () => ({ uid: 'G1', headcode: '1H90', direction: 'west', trainType: 'passenger',
    estimatedCrossingMins: 0, origin: 'A', destination: 'B', operator: 'ZZ' });

  // Cold restart: the train ran an hour ago, but its only sighting is stamped now.
  const cold = new CrossingState('t', cfg);
  cold._scheduleTimeToDate = () => new Date(T - 60 * 60000);
  cold.scheduleTrains = [ghost()];
  cold.recordTdSighting('1H90', new Date(T));            // bogus "first" sighting at boot
  const m = cold._mergeTrains().find(x => x.headcode === '1H90');
  check('cold restart resurrects a train that ran an hour ago', !!m, true);
  check('...and floors it into the near future', m ? m.bestTime.getTime() > T : null, true);

  // Seeded from the day's log first: the real first sighting is an hour old, so the
  // existing grace rules retire it exactly as they would have without the restart.
  const seeded = new CrossingState('t', cfg);
  seeded._scheduleTimeToDate = () => new Date(T - 60 * 60000);
  seeded.scheduleTrains = [ghost()];
  seeded.seedSightings([{ headcode: '1H90', ts: new Date(T - 65 * 60000).toISOString() }]);
  seeded.recordTdSighting('1H90', new Date(T));          // later step must not overwrite
  check('seeded: the real first sighting is kept',
    seeded.tdSeenToday.get('1H90').getTime(), T - 65 * 60000);
  check('seeded: the ghost is retired, not resurrected',
    seeded._mergeTrains().some(x => x.headcode === '1H90'), false);

  // A genuinely late train sighted just now is still re-projected — the Fix-1 behaviour
  // this must not break.
  const late = new CrossingState('t', cfg);
  late._scheduleTimeToDate = () => new Date(T - 15 * 60000);
  late.scheduleTrains = [{ ...ghost(), headcode: '6O99', trainType: 'freight' }];
  late.seedSightings([{ headcode: '6O99', ts: new Date(T).toISOString() }]);
  check('a genuinely late train, first seen now, is still kept',
    late._mergeTrains().some(x => x.headcode === '6O99'), true);

  check('seeding is idempotent', seeded.seedSightings([{ headcode: '1H90', ts: new Date(T).toISOString() }]), 0);
}

// ---- _classOf: one definition of the class discriminator -------------------------------
// It used to be inlined in _transit while _closeAnchor called _eastClass — two copies that
// could drift. These assert they agree, and that the live feed reports the same label the
// prediction used (the whole point of surfacing it for calibration).
console.log('  -- _classOf single source of truth --');
{
  const st = new CrossingState('t', classCfg);
  const mk = (o) => ({ direction: o.dir, headcode: o.hc, trainType: o.type || 'passenger',
                       callsAtStation: o.station, callsAtApproach: o.approach,
                       source: o.source, bestTime: new Date(BASE + 300000) });

  check('east, calls Portslade + Southwick => stoppingLocal', st._classOf(mk({dir:'east',hc:'1N01',station:true,approach:true})), 'stoppingLocal');
  check('east, calls Portslade not Southwick => stopping',    st._classOf(mk({dir:'east',hc:'1H01',station:true,approach:false})), 'stopping');
  check('east, calls neither => fast',                        st._classOf(mk({dir:'east',hc:'1A01',station:false,approach:false})), 'fast');
  check('east freight => freight',                            st._classOf(mk({dir:'east',hc:'6V01',type:'freight'})), 'freight');
  check('east ecs => ecs',                                    st._classOf(mk({dir:'east',hc:'5E01',type:'ecs'})), 'ecs');
  check('west, calls Portslade => stopping',                  st._classOf(mk({dir:'west',hc:'1N02',station:true})), 'stopping');
  check('west, does not call => fast',                        st._classOf(mk({dir:'west',hc:'1A02',station:false})), 'fast');
  check('west freight => freight',                            st._classOf(mk({dir:'west',hc:'6V02',type:'freight'})), 'freight');
  // An unknown Southwick answer must fall to stoppingLocal — the one east anchor with field
  // calibration behind it — not to a bare 'stopping'.
  check('east, Southwick unknown => stoppingLocal (calibrated anchor)', st._classOf(mk({dir:'east',hc:'1H03',station:true,approach:null})), 'stoppingLocal');

  // _closeAnchor must resolve via the SAME label, so a class change moves the anchor with it.
  const anchorFor = (t) => { const a = st._closeAnchor(t); return a ? a.berth + '+' + a.offsetSecs : null; };
  check('_closeAnchor agrees with _classOf (stoppingLocal -> 0006+100)', anchorFor(mk({dir:'east',hc:'1N01',station:true,approach:true})), '0006+100');
  check('_closeAnchor agrees with _classOf (stopping -> 0008+40)',       anchorFor(mk({dir:'east',hc:'1H01',station:true,approach:false})), '0008+40');
  check('_closeAnchor agrees with _classOf (fast -> 0008+20)',           anchorFor(mk({dir:'east',hc:'1A01',station:false,approach:false})), '0008+20');
  // West has no `classes` block, so per-class anchors stay off — switching the lookup to
  // _classOf must not have turned them on.
  check('west still has no per-class anchor (config has no west.classes)', anchorFor(mk({dir:'west',hc:'1N02',station:true})), null);

  // The live feed must report the same label, so an observation is filed under the class the
  // prediction actually used.
  const live = new CrossingState('t', classCfg);
  live.ldbTrains = [mk({dir:'east',hc:'1H01',station:true,approach:false,source:'ldb'})];
  live.recordTdBerth({ headcode:'1H01', to:'0008', from:'0010', ts: iso(BASE), event:'CA' });
  const row = live.getLiveTrains(BASE + 1000).find(x => x.headcode === '1H01');
  checkTruthy('live feed exposes a row for the train', !!row);
  check('live trainClass matches _classOf', row ? row.trainClass : null, st._classOf(mk({dir:'east',hc:'1H01',station:true,approach:false,source:'ldb'})));
  check('live callsAtStation passed through', row ? row.callsAtStation : 'missing', true);
  check('live callsAtApproach passed through', row ? row.callsAtApproach : 'missing', false);
  // Unknown direction must yield null, never a guessed class.
  const unk = new CrossingState('t', classCfg);
  unk.recordTdBerth({ headcode:'9Z99', to:'0008', from:'0010', ts: iso(BASE), event:'CA' });
  const urow = unk.getLiveTrains(BASE + 1000).find(x => x.headcode === '9Z99');
  check('unmatched train => trainClass null', urow ? urow.trainClass : 'missing', null);
}

// ---- Register #13: a berth step on the approach chain refreshes the prediction ---------
// The projection is computed FROM liveTrains, so a step along the chain has just made a
// sharper estimate available. Before this, the new position waited for the next LDB poll.
// Recomputes are coalesced to one per tick, so each case awaits a macrotask.
console.log('  -- #13 recompute on berth steps (coalesced) --');
{
  const tick = () => new Promise(r => setImmediate(r));
  // Count recomputes without changing behaviour.
  function spy(state) {
    const real = state._recompute.bind(state);
    state._recomputes = 0;
    state._recompute = () => { state._recomputes++; return real(); };
    return state;
  }

  (async () => {
    // 1. on-chain step marks dirty, and exactly once per tick
    const a = spy(new CrossingState('t', classCfg));
    a.recordTdBerth({ headcode: '1A01', to: '0008', from: '0010', ts: iso(BASE), event: 'CA' });
    check('on-chain step does not recompute synchronously', a._recomputes, 0);
    await tick();
    check('on-chain step recomputes after one tick', a._recomputes, 1);

    // 2. off-chain step must not recompute — _chainIndex cannot use it
    const b = spy(new CrossingState('t', classCfg));
    b.recordTdBerth({ headcode: '9Z99', to: '9999', from: '9998', ts: iso(BASE), event: 'CA' });
    await tick();
    check('off-chain step does not recompute', b._recomputes, 0);
    checkTruthy('off-chain step still lands in the live map', b.liveTrains.has('9Z99'));

    // 3. a whole STOMP frame's worth of synchronous events collapses into ONE recompute.
    //    This is the property that makes a 13 ms recompute affordable on the TD hot path.
    const c = spy(new CrossingState('t', classCfg));
    for (let i = 0; i < 10; i++) {
      c.recordTdSighting(`1A0${i}`, new Date(BASE));
      c.recordTdBerth({ headcode: `1A0${i}`, to: '0008', from: '0010', ts: iso(BASE), event: 'CA' });
      c.recordTdCloseStrike({ headcode: `1A0${i}`, to: '0006', from: '0008', ts: iso(BASE) });
    }
    check('30 synchronous recorder calls in one tick => 1 recompute', c._recomputes, 0);
    await tick();
    check('…and exactly 1 after the tick', c._recomputes, 1);

    // 4. The user-facing symptom, end to end: a berth step must reach closurePeriods with
    //    no LDB poll. projCfg has a measured 0010>0008 transit of 157s and the east stopping
    //    class closes at 0008+40s, so a train seen at 0010 NOW should predict a close at
    //    now+197s. Without the fix closurePeriods would still hold the bestTime fallback
    //    (bestTime − predictedLeadSecs 180 = now+220s), which is what makes the two
    //    distinguishable — this asserts the projection actually got through, not just that
    //    a number changed.
    const d = new CrossingState('t', projCfg);
    const stepAt = Date.now();
    d.ldbTrains = [eastT({ hc: '1H67', bestMs: stepAt + 400000 })];
    d.recordTdBerth({ headcode: '1H67', to: '0010', from: '0012', ts: new Date(stepAt).toISOString() });
    await tick();
    const got = d.closurePeriods[0] && Math.round((Date.parse(d.closurePeriods[0].predictedStart) - stepAt) / 1000);
    checkTruthy('a berth step alone produces a closure period', !!d.closurePeriods[0]);
    checkTruthy(`berth step reaches the prediction without an LDB poll (projected +197s, got +${got}s)`,
      got !== null && Math.abs(got - 197) <= 2);
    checkTruthy('…and it is the projection, not the bestTime fallback (+220s)', got !== null && Math.abs(got - 220) > 2);

    console.log();
    if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
    else { console.log(`All ${pass} tests passed.`); }
  })();
}
