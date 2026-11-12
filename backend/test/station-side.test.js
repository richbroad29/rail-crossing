'use strict';
// schedule.stationSide (bug e, 2026-11-12): a train that starts or terminates at the crossing's own
// station, crossing on its way, has no timing point on that side and used to be dropped.
const { analyseRoute, estimateCrossingTime } = require('../src/schedule-parser');
const def = require('../src/crossing-definitions').loadCrossings().portslade;
const sched = def.schedule;
let pass = 0, fail = 0;
const check = (label, got, want) => {
  if (got === want) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n          got:      ${got}\n          expected: ${want}`); fail++; }
};
const L = (tiploc, arr, dep, pas) => ({ tiploc_code: tiploc, arrival: arr || undefined, departure: dep || undefined, pass: pas || undefined });
const legs = locs => {
  const r = analyseRoute(locs, sched);
  if (!r.traverses) return 'none';
  return r.legs.map(l => `${l.direction} ${l.from.tiploc}>${l.to.tiploc} @${estimateCrossingTime(l, sched.interpolation)}`).join(', ');
};
const m = hhmm => +hhmm.slice(0, 2) * 60 + +hhmm.slice(2);

check('Portslade definition says stationSide west', sched.stationSide, 'west');
check('starts at Portslade, goes west: crosses, at its departure time',
  legs([L('PSLDAWH', null, '1000'), L('FSHRSGT', '1002', '1002H'), L('SHRHMBS', '1006', '1007'), L('WORTHNG', '1015')]),
  `west PSLDAWH>FSHRSGT @${m('1000')}`);
check('arrives from the west, terminates at Portslade: crosses, at its arrival time',
  legs([L('WORTHNG', null, '1000'), L('SHRHMBS', '1008', '1009'), L('STHWICK', '1012', '1012H'), L('PSLDAWH', '1016')]),
  `east STHWICK>PSLDAWH @${m('1016')}`);
check('starts at Portslade, goes east: does not cross',
  legs([L('PSLDAWH', null, '1000'), L('ALDTON', '1002', '1002H'), L('HOVE', '1005')]), 'none');
check('arrives from the east, terminates at Portslade: does not cross',
  legs([L('BRGHTN', null, '1000'), L('HOVE', '1004', '1005'), L('PSLDAWH', '1008')]), 'none');
// The station is consulted only when the lists alone find nothing: a through train is unchanged.
const through = [L('BRGHTN', null, '1000'), L('HOVE', '1004', '1005'), L('PSLDAWH', '1008', '1008H'),
  L('FSHRSGT', '1010', '1010H'), L('SHRHMBS', '1014', '1015')];
const without = { ...sched }; delete without.stationSide;
const r1 = analyseRoute(through, sched).legs.map(l => `${l.from.tiploc}>${l.to.tiploc}@${estimateCrossingTime(l, sched.interpolation)}`).join();
const r2 = analyseRoute(through, without).legs.map(l => `${l.from.tiploc}>${l.to.tiploc}@${estimateCrossingTime(l, without.interpolation)}`).join();
check('a through train calling at Portslade is untouched', r1, r2);
check('...and still brackets on HOVE', r1.startsWith('HOVE>'), true);
check('without stationSide the starter is still dropped (the old behaviour)',
  analyseRoute([L('PSLDAWH', null, '1000'), L('FSHRSGT', '1002'), L('SHRHMBS', '1006')], without).traverses, false);
const problems = require('../src/crossing-definitions').definitionProblems({ ...def, schedule: { ...sched, stationSide: 'north' } });
check('a stationSide that is not a slot is a definition problem', problems.some(p => /stationSide/.test(p)), true);

console.log();
if (fail) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`All ${pass} tests passed.`);
