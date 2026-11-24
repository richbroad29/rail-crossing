'use strict';
// Berth-first run-through (design §5.5): a train booked to stop that the berths show running through is timed as
// not stopping. Real cases, Portslade eastbound, with the committed routes file's learned thresholds:
//   A. 1N43, 18 Nov: booked at Shoreham, Southwick and Portslade; ran through all three (42 s in Shoreham's 0010,
//      45 s in Southwick's 0006). Today's rule closes at its 0006 strike + 100 s = 17:32:15, after it crossed at
//      17:32:02. With the rule it is not calling at Southwick from the moment it leaves 0010: closes 0008 + 55 s.
//   B. the same train stopping as booked (145 s in 0010): unchanged, 0006 + 100 s.
//   C. 1N43, 9 Nov: stopped at Shoreham (122 s in 0010) but ran through Southwick (46 s in 0006): the station's own
//      berth shows it when it leaves 0006, and the close comes at once instead of after the crossing.
// usage: node test/berth-runthrough.test.js
const fs = require('fs');
const path = require('path');

const RealDate = Date; let NOW = 0;
class FakeDate extends RealDate { constructor(...a) { if (a.length === 0) super(NOW); else super(...a); } static now() { return NOW; } }
global.Date = FakeDate;
const quiet = fn => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return fn(); } finally { console.warn = w; console.log = l; } };

const { BerthFirstEngine } = quiet(() => require('../src/berth-first/engine'));
const cfgDir = path.join(__dirname, '..', 'config', 'crossings');
const def = JSON.parse(fs.readFileSync(path.join(cfgDir, 'portslade.json'), 'utf8'));
const routes = JSON.parse(fs.readFileSync(path.join(cfgDir, 'portslade.routes.json'), 'utf8'));

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n          got:      ${a}\n          expected: ${e}`); fail++; }
}

const hms = ms => new RealDate(ms).toISOString().slice(11, 19);
const at = s => RealDate.parse(`2026-11-18T${s}Z`);
// One run of 1N43 east: [from, to, 'HH:MM:SS'] steps, fed one at a time; returns what the engine said after each.
function run(steps) {
  NOW = at(steps[0][2]) - 60e3;
  const e = quiet(() => new BerthFirstEngine('portslade', JSON.parse(JSON.stringify(def)), routes));
  quiet(() => e.updateScheduleTrains([{ uid: 'G88658', headcode: '1N43', category: 'XX', operator: 'SN', trainType: 'passenger', direction: 'east',
    estimatedCrossingMins: 17 * 60 + 28.4, source: 'cif', legIndex: 0, legCount: 1, callsAtStation: true, callsAtApproach: true,
    runsAsRequired: false, daysPattern: '1111100', origin: 'SOTON', destination: 'BRGHTN' }]));
  const out = {};
  for (const [from, to, t] of steps) {
    NOW = at(t);
    quiet(() => { e.recordTdEvent({ headcode: '1N43', ts: new RealDate(NOW).toISOString(), area: 'LA', event: 'CA', from, to }); e._recompute(); });
    const m = (e.timing._bfMerged || []).find(x => x.headcode === '1N43');
    const api = quiet(() => e.getApiState(10));
    const p = api.upcomingClosures.find(c => c.trains.some(x => x.headcode === '1N43'));
    out[`${from}>${to}`] = { cls: m ? e.timing._classOf(m) : null, close: p && p.closeConfirmed ? hms(RealDate.parse(p.start)) : null,
      ranThrough: (m && m.ranThrough) || [], state: api.state };
  }
  return out;
}

console.log('A. 1N43 18 Nov: ran through Shoreham, Southwick and Portslade');
{
  const r = run([['0020', '0018', '17:26:13'], ['0018', '0016', '17:27:05'], ['0016', '0014', '17:27:41'], ['0014', '0012', '17:28:29'],
    ['0012', '0010', '17:29:03'], ['0010', '0008', '17:29:45'], ['0008', '0006', '17:30:35'], ['0006', '0004', '17:31:20'], ['0004', '0002', '17:32:02']]);
  check('booked at Southwick: stoppingLocal while in 0010', r['0012>0010'].cls, 'stoppingLocal');
  check('left 0010 after 42 s: not calling at Southwick', [r['0010>0008'].cls, r['0010>0008'].ranThrough], ['stopping', ['STHWICK']]);
  check('closes at its 0008 strike + 55 s = 17:30:40, not 0006 + 100 s = 17:32:15', r['0008>0006'].close, '17:30:40');
  check('BARRIERS DOWN before it crosses (17:32:02)', r['0006>0004'].state, 'CLOSED');
}

console.log('\nB. the same train stopping as booked');
{
  const r = run([['0014', '0012', '17:28:29'], ['0012', '0010', '17:29:03'], ['0010', '0008', '17:31:28'], ['0008', '0006', '17:32:41'], ['0006', '0004', '17:35:15']]);
  check('145 s in 0010: still stoppingLocal', [r['0010>0008'].cls, r['0010>0008'].ranThrough], ['stoppingLocal', []]);
  check('closes at its 0006 strike + 100 s = 17:34:21', r['0008>0006'].close, '17:34:21');
  check('160 s in 0006 is a stop, not a run-through', r['0006>0004'].ranThrough, []);
}

console.log('\nC. 1N43 9 Nov (times moved to 18 Nov): stopped at Shoreham, ran through Southwick');
{
  const r = run([['0014', '0012', '17:24:54'], ['0012', '0010', '17:25:30'], ['0010', '0008', '17:27:32'], ['0008', '0006', '17:28:42'], ['0006', '0004', '17:29:28'], ['0004', '0002', '17:30:13']]);
  check('122 s in 0010 (a Shoreham stop): stoppingLocal', r['0010>0008'].cls, 'stoppingLocal');
  check('...so the close waits for 0006 + 100 s = 17:30:22', r['0008>0006'].close, '17:30:22');
  check('left 0006 after 46 s: not calling at Southwick, barrier down at once', [r['0006>0004'].cls, r['0006>0004'].ranThrough, r['0006>0004'].state], ['stopping', ['STHWICK'], 'CLOSED']);
}

global.Date = RealDate;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
