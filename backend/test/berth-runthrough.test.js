'use strict';
// Berth-first run-through (design §5.5): a train booked to stop that the berths show running through is timed as
// not stopping. Real cases, Portslade eastbound, with the committed routes file's learned thresholds:
//   A. 1N43, 18 Nov: booked at Shoreham, Southwick and Portslade; ran through all three (42 s in Shoreham's 0010,
//      45 s in Southwick's 0006). Today's rule closes at its 0006 strike + 100 s = 17:32:15, after it crossed at
//      17:32:02. With the rule it is not calling at Southwick from the moment it leaves 0010: closes 0008 + 55 s.
//   B. the same train stopping as booked (145 s in 0010): unchanged, 0006 + 100 s.
//   C. 1N43, 9 Nov: stopped at Shoreham (122 s in 0010) but ran through Southwick (46 s in 0006): the station's own
//      berth shows it when it leaves 0006, and the close comes at once instead of after the crossing.
//   D. 1H34 west, 18 Nov: booked at Portslade, 32 min late, ran through it (28 s in 0005, the clear-step berth, so
//      the berths cannot show it in time). Today's rule closes at 0003 + 61 s = 15:58:20, 6 s before it crossed. With
//      Darwin's cancelled Portslade stop (the board's cancelled services) it is fast: 0001 + 2 s, floored at 10 s = 15:56:39.
//   E. the cancellation must be this train's: another UID changes nothing.
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

// Step 5: a healthy feed. The engine publishes only once it has replayed its logged hour (empty here: a cold start)
// and heard every area of its routes; the heartbeats then come every 30 s, as the real feed's do.
function healthyFeed(e) {
  quiet(() => e.restoreFromLog([]));
  let last = NOW - 30e3;
  const beat = () => { const end = NOW; while (last + 30e3 <= end) { last += 30e3; NOW = last; for (const a of routes.areas) e.recordTdHeartbeat({ area: a, ts: new RealDate(last).toISOString(), event: 'CT' }); } NOW = end; };
  beat();
  return beat;
}
const hms = ms => new RealDate(ms).toISOString().slice(11, 19);
const at = s => RealDate.parse(`2026-11-18T${s}Z`);
const N43 = { uid: 'G88658', headcode: '1N43', direction: 'east', estimatedCrossingMins: 17 * 60 + 28.4, callsAtStation: true, callsAtApproach: true, origin: 'SOTON', destination: 'BRGHTN' };
// One run of a train: [from, to, 'HH:MM:SS'] steps, fed one at a time; returns what the engine said after each.
// `cancelled`: the board's cancelled services, given before the first step (as engines.ldb gives them each poll).
function run(steps, tt = N43, cancelled = null) {
  NOW = at(steps[0][2]) - 60e3;
  const e = quiet(() => new BerthFirstEngine('portslade', JSON.parse(JSON.stringify(def)), routes));
  if (cancelled) e.updateLdbCancelled(cancelled);
  const beat = healthyFeed(e);
  quiet(() => e.updateScheduleTrains([{ category: 'XX', operator: 'SN', trainType: 'passenger', source: 'cif', legIndex: 0, legCount: 1,
    runsAsRequired: false, daysPattern: '1111100', ...tt }]));
  const hc = tt.headcode, out = {};
  for (const [from, to, t] of steps) {
    NOW = at(t);
    beat();
    quiet(() => { e.recordTdEvent({ headcode: hc, ts: new RealDate(NOW).toISOString(), area: 'LA', event: 'CA', from, to }); e._recompute(); });
    const m = (e.timing._bfMerged || []).find(x => x.headcode === hc);
    const api = quiet(() => e.getApiState(10));
    const p = api.upcomingClosures.find(c => c.trains.some(x => x.headcode === hc));
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

console.log('\nD. 1H34 west 18 Nov: booked at Portslade, ran through it; Darwin had cancelled the stop');
const H34 = { uid: 'G26423', headcode: '1H34', direction: 'west', estimatedCrossingMins: 15 * 60 + 26.5, callsAtStation: true, callsAtApproach: false, origin: 'VICTRIC', destination: 'LTLHMPT' };
const H34steps = [['T682', 'T677', '15:54:15'], ['T677', '0001', '15:56:29'], ['0001', '0003', '15:57:19'], ['0003', '0005', '15:57:58'], ['0005', '0007', '15:58:26']];
const cancel = uid => [{ uid, rid: '202611187126423', trainid: '1H34', sta: '2026-11-18T15:26:00', std: '2026-11-18T15:26:30', isCancelled: true, operatorCode: 'SN' }];
{
  const r = run(H34steps, H34);
  check('no cancellation: stopping, closes 0003 + 61 s = 15:58:20, 6 s before it crossed', [r['0001>0003'].cls, r['0003>0005'].close], ['stopping', '15:58:20']);
  const c = run(H34steps, H34, cancel('G26423'));
  check('Portslade stop cancelled: fast from the start', [c['T677>0001'].cls, c['T677>0001'].ranThrough], ['fast', ['PSLDAWH']]);
  check('closes at 0001 + 2 s, floored at 10 s after the strike (minAfterStrikeSecs) = 15:56:39', c['T677>0001'].close, '15:56:39');
  check('BARRIERS DOWN well before it crosses (15:58:26)', c['0003>0005'].state, 'CLOSED');
}

console.log('\nE. a cancellation for another train');
{
  const c = run(H34steps, H34, cancel('G99999'));
  check('another UID: still stopping, closes 15:58:20', [c['0001>0003'].cls, c['0003>0005'].close], ['stopping', '15:58:20']);
}

global.Date = RealDate;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
