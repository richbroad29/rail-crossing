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

console.log();
if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
else { console.log(`All ${pass} tests passed.`); }
