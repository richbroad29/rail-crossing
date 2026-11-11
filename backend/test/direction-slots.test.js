'use strict';

// Direction slots are named by the crossing, not the code (2026-11-12).
//
// A crossing's definition names its two directions (`directions`: Portslade east, west) and keys
// every per-direction block by those names; the code never names a slot. These tests hold that:
//   1. the loader refuses a definition whose slots and blocks disagree;
//   2. Portslade's definition with its slots RENAMED (east -> up, west -> down) gives the same
//      board times, the same timetable crossings and the same closures as the original, names
//      mapped — the engine does not care what a crossing calls its directions;
//   3. a control: the same comparison does see a real change, so its zero means something.

const { definitionProblems, loadCrossings } = require('../src/crossing-definitions');
const { makeDirectionResolver, oppositeOf } = require('../src/direction');
const { parseRdmJson } = require('../src/ldb-poller');
const { analyseRoute, estimateCrossingTime } = require('../src/schedule-parser');
const CrossingState = require('../src/crossing-state');
require('../src/logger').logHeld = function () {};

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n          got:      ${actual}\n          expected: ${expected}`); fail++; }
}

const MAP = { east: 'up', west: 'down' };
const BACK = { up: 'east', down: 'west' };
// Rename every object key and every string value that is exactly a slot name, at any depth.
const renamed = (o, map) => Array.isArray(o) ? o.map(x => renamed(x, map))
  : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [map[k] || k, renamed(v, map)]))
  : typeof o === 'string' && map[o] ? map[o] : o;
const viaJson = o => JSON.parse(JSON.stringify(o));

const PLD = loadCrossings().portslade;
const UPDOWN = renamed(viaJson(PLD), MAP);

// ---- 1. the loader --------------------------------------------------------------------------
console.log('\nDefinition checks\n');
check('Portslade is a valid definition', definitionProblems(PLD).length, 0);
check('...and so is Portslade with its slots renamed up/down', definitionProblems(UPDOWN).length, 0);
check('the slots are the keys of directions, in order', Object.keys(UPDOWN.directions).join(','), 'up,down');
check('opposite is derived, not configured', oppositeOf(UPDOWN.directions, 'up'), 'down');
{
  const bad = (mutate) => { const d = viaJson(PLD); mutate(d); return definitionProblems(d); };
  check('three slots refused', bad(d => { d.directions.north = { boardTime: 'arrival' }; }).length, 1);
  check('a td block under the old name (eastbound) refused',
    bad(d => { d.td.eastbound = d.td.east; delete d.td.east; })[0], 'td.eastbound is not a direction slot (east, west)');
  check('a missing boardTime refused', bad(d => { delete d.directions.west.boardTime; }).length, 1);
  check('an unknown classRule refused', bad(d => { d.td.east.classRule = 'southwick'; }).length, 1);
  check('timetable sides keyed by something else refused',
    bad(d => { d.schedule.tiplocsBefore = { a: [], b: [] }; }).length, 1);
  check('a timing point on both sides refused',
    bad(d => { d.schedule.tiplocsBefore.west.push('LNCG'); })[0], 'schedule.tiplocsBefore: LNCG is on both sides');
  check('interpolation under the old name refused',
    bad(d => { d.schedule.interpolation.westbound = d.schedule.interpolation.west; }).length, 1);
  check('a timing block under another name refused',
    bad(d => { d.timing.openLagSecs.up = d.timing.openLagSecs.east; })[0], 'timing.openLagSecs.up is not a direction slot (east, west)');
  check('a website block under another name refused',
    bad(d => { d.presentation.directions.north = {}; }).length, 1);
}

// ---- 2a. departure board: the board time each direction reads -------------------------------
console.log('\nBoard times, renamed slots\n');
const svc = (dest) => ({
  trainid: '1A01', uid: 'X00001',
  sta: '2026-08-14T17:28:00', eta: '2026-08-14T17:30:00', ata: null,
  std: '2026-08-14T17:29:00', etd: '2026-08-14T17:31:30', atd: null,
  origin: [{ locationName: 'Somewhere' }], destination: [{ locationName: dest }], operator: 'SN'
});
for (const [dest, slot, read] of [['Littlehampton', 'west', 'departure'], ['Brighton', 'east', 'arrival']]) {
  const [a] = parseRdmJson({ trainServices: [svc(dest)] }, makeDirectionResolver(PLD.directions));
  const [b] = parseRdmJson({ trainServices: [svc(dest)] }, makeDirectionResolver(UPDOWN.directions));
  check(`to ${dest}: ${slot}, renamed ${MAP[slot]}`, `${a.direction}/${b.direction}`, `${slot}/${MAP[slot]}`);
  check(`  ...both read the ${read}`, `${a.bestTime}|${b.bestTime}`,
    // Board times are London wall-clock (BST in August), so 17:31:30 is 16:31:30Z.
    read === 'departure' ? '2026-08-14T16:31:30.000Z|2026-08-14T16:31:30.000Z' : '2026-08-14T16:30:00.000Z|2026-08-14T16:30:00.000Z');
}
{
  const [u] = parseRdmJson({ trainServices: [svc('Nowhere Junction')] }, makeDirectionResolver(UPDOWN.directions));
  check('unknown direction reads the arrival, whatever the slots are called', `${u.direction}|${u.bestTime}`,
    'unknown|2026-08-14T16:30:00.000Z');
}

// ---- 2b. timetable: which way, and when ----------------------------------------------------
console.log('\nTimetable crossings, renamed slots\n');
const routes = {
  eastbound: [{ tiploc_code: 'SHRHMBS', departure: '1000' }, { tiploc_code: 'HOVE', arrival: '1010' }],
  westbound: [{ tiploc_code: 'HOVE', departure: '1100' }, { tiploc_code: 'SHRHMBS', arrival: '1110' }],
  'out-and-back': [{ tiploc_code: 'SHRHMBS', pass: '1200' }, { tiploc_code: 'HOVE', pass: '1210' },
                   { tiploc_code: 'HOVE', pass: '1230' }, { tiploc_code: 'SHRHMBS', pass: '1240' }]
};
const legs = (locs, sched, back) => (analyseRoute(locs, sched).legs || [])
  .map(l => `${back[l.direction] || l.direction} ${l.from.tiploc}>${l.to.tiploc} @${estimateCrossingTime(l, sched.interpolation)}`).join(', ');
for (const [name, locs] of Object.entries(routes)) {
  const a = legs(locs, PLD.schedule, {});
  check(`${name}: ${a}`, legs(locs, UPDOWN.schedule, BACK), a);
}

// ---- 2c. the engine: closures, classes, triggers -------------------------------------------
console.log('\nClosures, renamed slots\n');
const T = Date.UTC(2026, 10, 10, 9, 0, 0);
const at = s => new Date(T + s * 1000);
const trains = () => [
  { headcode: '1N01', direction: 'east', bestTime: at(300), callsAtStation: true, callsAtApproach: true },
  { headcode: '1H01', direction: 'east', bestTime: at(600), callsAtStation: true, callsAtApproach: false },
  { headcode: '1W01', direction: 'west', bestTime: at(420), callsAtStation: true },
  { headcode: '6O01', direction: 'west', bestTime: at(900), trainType: 'freight', source: 'cif' },
  { headcode: '5A01', direction: 'east', bestTime: at(1300), trainType: 'ecs', source: 'cif' }
].map(t => ({ trainType: 'passenger', source: 'ldb', origin: 'A', destination: 'B', operator: 'ZZ', etaText: 'x',
  confidence: 'high', scheduledTime: t.bestTime, ...t }));
const steps = [
  ['1N01', -200, '0010', '0008'], ['1N01', -40, '0008', '0006'],
  ['1W01', -120, 'T677', '0001'], ['1W01', -20, '0001', '0003'],
  ['2X99', -300, '0004', '0002'], ['2X99', -280, '0002', 'T686']
];
function run(def, transits, nameMap) {
  const st = new CrossingState('portslade', { ...viaJson(def), transits: viaJson(transits) });
  for (const [hc, s, from, to] of steps) st.recordTdEvent({ headcode: hc, ts: at(s).toISOString(), area: 'LA', event: 'CA', from, to });
  const ts = trains().map(t => ({ ...t, direction: nameMap[t.direction] || t.direction }));
  return {
    closures: viaJson(st._computeClosures(ts, at(0))),
    classes: ts.map(t => `${t.headcode}:${st._classOf(t)}`).join(' '),
    triggers: viaJson(st.getTriggers())
  };
}
const TRANSITS = require('../data/transits.json').portslade;
const A = run(PLD, TRANSITS, {});
const B = run(UPDOWN, renamed(viaJson(TRANSITS), MAP), MAP);
check('the scenario is not empty: closures computed', A.closures.length > 0, true);
check('  ...and it exercises every rule', A.classes, '1N01:stoppingLocal 1H01:stopping 1W01:stopping 6O01:freight 5A01:ecs');
check('same classes', B.classes, A.classes);
check('same closures, names mapped', JSON.stringify(renamed(B.closures, BACK)), JSON.stringify(A.closures));
check('same close/open triggers, names mapped', JSON.stringify(renamed(B.triggers, BACK)), JSON.stringify(A.triggers));

// ---- 3. control ----------------------------------------------------------------------------
console.log('\nControl\n');
{
  const swapped = viaJson(UPDOWN); swapped.td.up.classRule = 'stopping';
  const C = run(swapped, renamed(viaJson(TRANSITS), MAP), MAP);
  check('the comparison sees a real change (up sorted by the stopping rule)',
    JSON.stringify(renamed(C.closures, BACK)) === JSON.stringify(A.closures), false);
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nAll ${pass} tests passed.`);
process.exit(fail ? 1 : 0);
