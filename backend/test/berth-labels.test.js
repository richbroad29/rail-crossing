'use strict';
// Berth-first: a label that is not a headcode becomes a train once it makes 2 steps in a row along the approach chain.
//   A. 3W93, 16 Nov (real steps): ran Hove -> Portslade's platform under "-LB-" (T682>T677 02:15:51, T677>0001 02:17:33,
//      0001>0003 02:18:26, 0003>0005 02:19:27), renamed 3W93 by an interpose at 02:20:19, crossed 0005>0007 02:20:37.
//      Before: no train until the rename, BARRIERS DOWN after 02:20:19 (a miss). Now: a train from 02:17:33.
//   B. -T3A, 22 Nov (real): stepped T677>0001 at 02:14:37 and sat there until 04:36. One step: never a train.
//   C. a reminder interposed into a berth and never moving: never a train (decision 1).
// usage: node test/berth-labels.test.js
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
const at = s => RealDate.parse(`2026-11-16T${s}Z`);
const hms = ms => new RealDate(ms).toISOString().slice(11, 19);

// Step 5: a healthy feed. The engine publishes only once it has replayed its logged hour (empty here: a cold start)
// and heard every area of its routes; the heartbeats then come every 30 s, as the real feed's do.
function healthyFeed(e) {
  quiet(() => e.restoreFromLog([]));
  let last = NOW - 30e3;
  const beat = () => { const end = NOW; while (last + 30e3 <= end) { last += 30e3; NOW = last; for (const a of routes.areas) e.recordTdHeartbeat({ area: a, ts: new RealDate(last).toISOString(), event: 'CT' }); } NOW = end; };
  beat();
  return beat;
}
// Feed [event, label, from, to, 'HH:MM:SS'] in order; after each, what the engine shows.
function run(events) {
  NOW = at(events[0][4]) - 60e3;
  const e = quiet(() => new BerthFirstEngine('portslade', JSON.parse(JSON.stringify(def)), routes));
  quiet(() => e.updateScheduleTrains([]));
  const beat = healthyFeed(e);
  const out = [];
  for (const [event, headcode, from, to, t] of events) {
    NOW = at(t);
    beat();
    quiet(() => { e.recordTdEvent({ headcode, ts: new RealDate(NOW).toISOString(), area: 'LA', event, from, to }); e._recompute(); });
    const api = quiet(() => e.getApiState(10));
    const trains = api.berthFirst.trains.filter(x => x.state === 'approaching');
    const p = api.upcomingClosures[0];
    out.push({ at: t, trains: trains.map(x => `${x.label}${x.unidentified ? '?' : ''}@${x.berth}`), close: p && p.closeConfirmed ? hms(RealDate.parse(p.start)) : null, state: api.state });
  }
  return out;
}

console.log('A. 3W93 16 Nov: in under "-LB-", renamed in the platform berth');
{
  const r = run([['CA', '-LB-', 'T682', 'T677', '02:15:51'], ['CA', '-LB-', 'T677', '0001', '02:17:33'], ['CA', '-LB-', '0001', '0003', '02:18:26'],
    ['CA', '-LB-', '0003', '0005', '02:19:27'], ['CC', '3W93', null, '0005', '02:20:19'], ['CA', '3W93', '0005', '0007', '02:20:37']]);
  check('one step: not a train yet', r[0].trains, []);
  check('two steps along the approach: an unidentified train', r[1].trains, ['-LB-?@LA:0001']);
  check('BARRIERS DOWN by its next step (02:18:26), over 2 min before it crosses', r[2].state, 'CLOSED');
  check('renamed in the platform: still the same train, now 3W93', r[4].trains, ['3W93@LA:0005']);
}

console.log('\nB. -T3A 22 Nov: one step, then sat for two hours');
{
  const r = run([['CC', '-T3A', null, 'T677', '02:10:02'], ['CA', '-T3A', 'T677', '0001', '02:14:37']]);
  check('never a train', [r[1].trains, r[1].state], [[], 'OPEN']);
}

console.log('\nC. a reminder interposed and never moving');
{
  const r = run([['CC', '-LB-', null, '0003', '01:00:00'], ['CC', '****', null, '0005', '01:00:30']]);
  check('never a train', [r[0].trains, r[1].trains, r[1].state], [[], [], 'OPEN']);
}

global.Date = RealDate;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
