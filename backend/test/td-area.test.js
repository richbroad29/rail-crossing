'use strict';

// TD events reach a crossing only from its own describer area (CrossingState.recordTdEvent).
//
// Berth codes repeat across areas — 0006 is Portslade's eastbound approach berth in LA and
// also a berth in most other areas. Before this guard, index.js fed every TD sighting to every
// crossing, so with a second area live a train stepping into ITS 0006 would have been taken as
// a Portslade approach strike and anchored a real closure (multi-crossing-readiness.md,
// blocker 2). Uses the real Portslade config so the berths are the live ones.

const CrossingState = require('../src/crossing-state');
require('../src/logger').logHeld = function () {};
const crossings = require('../src/crossing-definitions').loadCrossings();

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

const cfg = crossings.portslade;
const ts = new Date().toISOString();
// An eastbound approach-berth strike and an eastbound clear step, as td-listener emits them.
const strike = area => ({ headcode: '1H23', ts, area, event: 'CA', from: '0008', to: '0006' });
const clear  = area => ({ headcode: '1H23', ts, area, event: 'CA', from: '0004', to: '0002' });

// What each event leaves behind: first sighting, live position, close strike, clear step.
function footprint(s) {
  return [s.tdSeenToday.size, s.liveTrains.size, s.closeStrikeSeen.size, s.clearStepSeen.size].join(',');
}

console.log('\nTD events are filtered by describer area\n');

check('Portslade is configured for area LA', cfg.td.area, 'LA');

// Control: prove the harness can see the hazard. Calling the recorders directly — what
// index.js did before — takes a BM strike on 0006 as a Portslade approach strike.
{
  const s = new CrossingState('portslade', cfg);
  const e = strike('BM');
  s.recordTdSighting(e.headcode, e.ts); s.recordTdBerth(e); s.recordTdClearStep(e); s.recordTdCloseStrike(e);
  s.recordTdClearStep(clear('BM'));
  check('control: unfiltered recorders take a BM 0006 strike + clear step', footprint(s), '1,1,1,1');
}

// The fix: the same two events from BM leave no trace at all.
{
  const s = new CrossingState('portslade', cfg);
  check('BM strike refused', s.recordTdEvent(strike('BM')), false);
  check('BM clear step refused', s.recordTdEvent(clear('BM')), false);
  check('BM events leave nothing behind', footprint(s), '0,0,0,0');
}

// And from LA they are taken exactly as before.
{
  const s = new CrossingState('portslade', cfg);
  check('LA strike taken', s.recordTdEvent(strike('LA')), true);
  check('LA clear step taken', s.recordTdEvent(clear('LA')), true);
  check('LA events recorded as before', footprint(s), '1,1,1,1');
}

// An event with no area is never assumed to be ours.
{
  const s = new CrossingState('portslade', cfg);
  check('area-less event refused', s.recordTdEvent(strike(undefined)), false);
  check('area-less event leaves nothing', footprint(s), '0,0,0,0');
}

// A crossing with no TD area configured accepts nothing, rather than everything.
{
  const s = new CrossingState('nowhere', { ...cfg, td: { ...cfg.td, area: undefined } });
  check('no configured area: ownsTdArea(LA) is false', s.ownsTdArea('LA'), false);
  check('no configured area: LA strike refused', s.recordTdEvent(strike('LA')), false);
  check('no configured area: nothing recorded', footprint(s), '0,0,0,0');
}

// Two crossings in different areas, fed the same stream the way index.js does: each keeps
// only its own train, even though both trains use berth 0006.
{
  const la = new CrossingState('portslade', cfg);
  const bm = new CrossingState('elsewhere', { ...cfg, td: { ...cfg.td, area: 'BM' } });
  const stream = [
    { headcode: '1H23', ts, area: 'LA', event: 'CA', from: '0008', to: '0006' },
    { headcode: '2N77', ts, area: 'BM', event: 'CA', from: '0008', to: '0006' }
  ];
  for (const e of stream) for (const st of [la, bm]) st.recordTdEvent(e);
  check('LA crossing sees only 1H23', [...la.liveTrains.keys()].join(','), '1H23');
  check('BM crossing sees only 2N77', [...bm.liveTrains.keys()].join(','), '2N77');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
setImmediate(() => process.exit(fail ? 1 : 0));
