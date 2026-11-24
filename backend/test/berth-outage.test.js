'use strict';
// Berth-first v1 step 5: feed outage and restart (docs/berth-first-design.md §5.11, §5.12, D7, D23).
//   A. FeedHealth: an area is out when silent past its limit; a silence that ends is a blind span; a restart whose
//      downtime is that long is one too.
//   B. Outage, on a real train (1N43 east, 18 Nov): BARRIERS DOWN is published; TB goes silent; after 120 s the
//      engine publishes no closure, the message, and says why; the shadow log records it.
//   C. Recovery: a settling time, and a train placed before the gap is not timed until it moves again.
//   D. Restart: the logged last hour replayed into a new engine puts the train back where it was, and BARRIERS DOWN
//      comes back with it; before the replay, the timetable and the feed, it publishes "unavailable", never an empty list.
//   E. The log reader: an area's own log, the national log for an area without one (found by bisection), the
//      window's edges, received order kept within an area, and when the feed was last heard.
//   F. td-listener: a crossing area's heartbeat is emitted; another area's is not.
//   G. engines.js: heartbeats and the restore reach a shadow; the shadow log line carries `unavailable`.
// usage: node test/berth-outage.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const RealDate = Date; let NOW = 0;
class FakeDate extends RealDate { constructor(...a) { if (a.length === 0) super(NOW); else super(...a); } static now() { return NOW; } }
global.Date = FakeDate;
const quiet = fn => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return fn(); } finally { console.warn = w; console.log = l; } };

require('../src/logger').logHeld = function () {};
const { BerthFirstEngine } = quiet(() => require('../src/berth-first/engine'));
const { FeedHealth, OUTAGE_MESSAGE } = require('../src/berth-first/feed-health');
const { readRecentBerthEvents } = require('../src/berth-first/restart-log');
const cfgDir = path.join(__dirname, '..', 'config', 'crossings');
const def = JSON.parse(fs.readFileSync(path.join(cfgDir, 'portslade.json'), 'utf8'));
const routes = JSON.parse(fs.readFileSync(path.join(cfgDir, 'portslade.routes.json'), 'utf8'));

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n          got:      ${a}\n          expected: ${e}`); fail++; }
}
const at = s => RealDate.parse(`2026-11-18T${s}Z`);
const iso = ms => new RealDate(ms).toISOString();

console.log('A. FeedHealth');
{
  const h = new FeedHealth(['LA', 'TB'], { LA: { maxSilenceSecs: 120 }, TB: { maxSilenceSecs: 120 } }, at('10:00:00'));
  check('nothing heard yet, inside the limit: starting', h.problem(at('10:00:20')).reason, 'starting');
  check('nothing heard from TB for 121 s since the start: feed', h.problem(at('10:02:01')), { reason: 'feed', areas: ['LA', 'TB'], since: at('10:00:00') });
  for (let t = at('10:00:30'); t <= at('10:05:00'); t += 30e3) { h.heard('LA', t - 800, t); h.heard('TB', t - 700, t); }
  check('heartbeats every 30 s: fine', h.problem(at('10:05:10')), null);
  check('TB silent 120 s: still fine (the limit is "more than")', h.problem(at('10:07:00')), null);
  h.heard('LA', at('10:07:00'), at('10:07:00'));
  check('TB silent 121 s: out, since its last heartbeat', h.problem(at('10:07:01')), { reason: 'feed', areas: ['TB'], since: at('10:05:00') });
  check('  ...status names it', [h.status(at('10:07:01')).out, h.status(at('10:07:01')).areas.TB.silentSecs], [['TB'], 121]);
  check('no blind span while it lasts', h.lastRecovery(), null);
  h.heard('TB', at('10:15:00') - 700, at('10:15:00'));
  check('TB back after 10 min: a blind span from its last heartbeat to now', [h.lastRecovery().area, h.lastRecovery().fromWall, h.lastRecovery().toWall], ['TB', at('10:05:00'), at('10:15:00')]);
  check('an entry that last moved in TB before the gap: placed before it', h.placedBeforeBlind('TB', at('10:04:10')), true);
  check('one that moved after: not', h.placedBeforeBlind('TB', at('10:15:01')), false);
  check('LA was heard throughout: its entries are not affected', h.placedBeforeBlind('LA', at('10:04:10')), false);

  const r1 = new FeedHealth(['LA'], { LA: { maxSilenceSecs: 120 } }, at('11:00:00'));
  r1.markRestart(at('10:59:50'));
  r1.heard('LA', at('11:00:05'), at('11:00:05'));
  check('restart, feed last heard 15 s before: no blind span', r1.lastRecovery(), null);
  const r2 = new FeedHealth(['LA'], { LA: { maxSilenceSecs: 120 } }, at('11:00:00'));
  r2.markRestart(at('10:50:00'));
  r2.heard('LA', at('11:00:05'), at('11:00:05'));
  check('restart, feed last heard 10 min before: a blind span over the downtime', [r2.lastRecovery().fromWall, r2.lastRecovery().toWall], [at('10:50:00'), at('11:00:05')]);
  const d = new FeedHealth(['XX'], {}, at('12:00:00'));
  check('an area with no measured limit gets 120 s, and says so', d.status(at('12:00:00')).areas.XX.limit, 'default');
}

// 1N43 east, 18 Nov 2026 (the run-through test's case A): through Shoreham, Southwick and Portslade.
const N43 = { uid: 'G88658', headcode: '1N43', direction: 'east', estimatedCrossingMins: 17 * 60 + 28.4, callsAtStation: true, callsAtApproach: true,
  origin: 'SOTON', destination: 'BRGHTN', category: 'XX', operator: 'SN', trainType: 'passenger', source: 'cif', legIndex: 0, legCount: 1, runsAsRequired: false, daysPattern: '1111100' };
const STEPS = [['0020', '0018', '17:26:13'], ['0018', '0016', '17:27:05'], ['0016', '0014', '17:27:41'], ['0014', '0012', '17:28:29'],
  ['0012', '0010', '17:29:03'], ['0010', '0008', '17:29:45'], ['0008', '0006', '17:30:35'], ['0006', '0004', '17:31:20'], ['0004', '0002', '17:32:02']];
const stepEvt = ([from, to, t]) => ({ headcode: '1N43', ts: iso(at(t)), area: 'LA', event: 'CA', from, to });

// A driven engine: heartbeats every 30 s per area unless that area is cut, steps at their times.
function driver({ restore = true, cut = null } = {}) {
  const e = quiet(() => new BerthFirstEngine('portslade', JSON.parse(JSON.stringify(def)), routes));
  if (restore) quiet(() => e.restoreFromLog([]));
  quiet(() => e.updateScheduleTrains([{ ...N43 }]));
  let beat = NOW - (NOW % 30e3);
  const to = ms => {
    while (beat + 30e3 <= ms) {
      beat += 30e3; NOW = beat;
      for (const a of routes.areas) if (!(cut && cut.areas.includes(a) && beat >= cut.from && beat < cut.to)) e.recordTdHeartbeat({ area: a, ts: iso(beat - 700), event: 'CT' });
    }
    NOW = ms;
  };
  const step = s => { to(at(s[2])); quiet(() => { e.recordTdEvent(stepEvt(s)); e._recompute(); }); };
  const api = () => quiet(() => { e._recompute(); return e.getApiState(10); });
  return { e, to, step, api };
}
const closedFor = api => { const p = api.upcomingClosures.find(c => c.trains.some(x => x.headcode === '1N43')); return p && p.closeConfirmed ? p.start.slice(11, 19) : null; };

console.log('\nB. Outage: TB silent past its limit');
{
  NOW = at('17:20:00');
  const d = driver({ cut: { areas: ['TB'], from: at('17:30:40'), to: at('17:45:00') } });
  d.to(at('17:21:00'));
  check('started, replayed, timetable in, both areas heard: available', d.api().unavailable, undefined);
  for (const s of STEPS.slice(0, 8)) d.step(s);
  const a1 = d.api();
  check('17:31:20 (TB last heard 17:30:30, 50 s ago): BARRIERS DOWN from 17:30:40', [a1.state, closedFor(a1)], ['CLOSED', '17:30:40']);
  d.to(at('17:32:31'));
  const a2 = d.api();
  check('17:32:31, TB silent 121 s: no closure, no countdown, no forecast', [a2.state, a2.upcomingClosures.length, a2.nextClosure, a2.nextCloseTime, a2.berthFirst.forecast.length], ['UNAVAILABLE', 0, null, null, 0]);
  check('  ...the agreed message (D23)', a2.unavailable.message, 'Network Rail data is currently unavailable, so we can\'t predict closures. We\'re working to get this fixed.');
  check('  ...why, which area, since when', [a2.unavailable.reason, a2.unavailable.areas, a2.unavailable.since], ['feed', ['TB'], iso(at('17:30:30'))]);
  check('  ...and /health says the same', [d.e.feedHealth().available, d.e.feedHealth().reason, d.e.feedHealth().areas.TB.out, d.e.feedHealth().areas.LA.out], [false, 'feed', true, false]);
  check('  ...shadow detail too', d.e.shadowDetail().unavailable, 'feed');
  check('the message is one constant', OUTAGE_MESSAGE, a2.unavailable.message);
}

console.log('\nC. Recovery: a settling time; a train placed before the gap counts again only once it moves');
{
  NOW = at('17:20:00');
  // LA (the train's own area) cut from 17:29:50 to 17:40:10: the train was last placed in 0010 (17:29:03).
  const d = driver({ cut: { areas: ['LA'], from: at('17:29:50'), to: at('17:40:10') } });
  d.to(at('17:21:00'));
  for (const s of STEPS.slice(0, 5)) d.step(s);
  check('before the cut: 1N43 approaching in 0010', d.api().berthFirst.trains.map(x => `${x.label}@${x.berth}:${x.state}`), ['1N43@LA:0010:approaching']);
  d.to(at('17:40:30'));
  const a1 = d.api();
  check('LA back at 17:40:30 after 11 min: still unavailable, settling', [a1.unavailable.reason, a1.upcomingClosures.length], ['recovering', 0]);
  d.to(at('17:42:31'));
  const a2 = d.api();
  check('120 s later: predicting again', a2.unavailable, undefined);
  check('  ...1N43, last placed before the gap, is not timed or listed', [a2.upcomingClosures.length, a2.berthFirst.trains.length], [0, 0]);
  check('  ...its view state says why', d.e.view.map(v => `${v.label}:${v.state}`), ['1N43:unconfirmed']);
  // Suppose it had been held at a signal and now moves on: its own step out of 0010 picks it up again.
  quiet(() => { d.e.recordTdEvent({ ...stepEvt(['0010', '0008', '17:42:40']) }); });
  d.to(at('17:42:40'));
  const a3 = d.api();
  check('it steps 0010>0008 at 17:42:40: approaching again, timed', a3.berthFirst.trains.map(x => `${x.label}@${x.berth}:${x.state}`), ['1N43@LA:0008:approaching']);
}

console.log('\nD. Restart: the logged hour replayed puts the train back');
{
  NOW = at('17:20:00');
  const ref = driver();
  ref.to(at('17:21:00'));
  for (const s of STEPS.slice(0, 7)) ref.step(s);
  ref.to(at('17:31:00'));
  const r = ref.api();
  check('uninterrupted, 17:31:00: BARRIERS DOWN from 17:30:40, 1N43 in 0006', [r.state, closedFor(r), r.berthFirst.trains.map(x => x.berth)], ['CLOSED', '17:30:40', ['LA:0006']]);

  // A new process at 17:31:00; the old one last heard the feed at 17:30:52.
  NOW = at('17:31:00');
  const e = quiet(() => new BerthFirstEngine('portslade', JSON.parse(JSON.stringify(def)), routes));
  const a0 = quiet(() => e.getApiState(10));
  check('fresh: unavailable, starting — waiting for the replay, the timetable and the feed', [a0.state, a0.unavailable.reason, a0.unavailable.waiting], ['UNAVAILABLE', 'starting', ['restore', 'timetable', 'feed']]);
  const got = quiet(() => e.restoreFromLog(STEPS.slice(0, 7).map(stepEvt), { lastRxMs: at('17:30:52'), sources: { LA: 'own log', TB: 'own log' } }));
  check('replayed 7 events', got.events, 7);
  check('  ...still waiting for the timetable and the feed', quiet(() => e.getApiState(10)).unavailable.waiting, ['timetable', 'feed']);
  NOW = at('17:31:20');
  quiet(() => e.updateScheduleTrains([{ ...N43 }]));
  for (const a of routes.areas) e.recordTdHeartbeat({ area: a, ts: iso(NOW - 600), event: 'CT' });
  const a1 = quiet(() => { e._recompute(); return e.getApiState(10); });
  check('timetable in and both areas heard 28 s after the old process: predicting', a1.unavailable, undefined);
  check('  ...1N43 back in 0006, BARRIERS DOWN from 17:30:40 as before', [a1.state, closedFor(a1), a1.berthFirst.trains.map(x => `${x.label}@${x.berth}:${x.state}`)], ['CLOSED', '17:30:40', ['1N43@LA:0006:approaching']]);
  check('  ...no blind span (downtime 28 s < 120 s)', e.health.lastRecovery(), null);
  quiet(() => e.recordTdEvent(stepEvt(STEPS[7])));
  NOW = at('17:31:21');
  const a2 = quiet(() => { e._recompute(); return e.getApiState(10); });
  check('its next live step moves it on, as in the uninterrupted engine', a2.berthFirst.trains.map(x => x.berth), ['LA:0004']);

  // The same log, but the new process starts 10 min after the old one last heard the feed (17:30:40).
  NOW = at('17:41:00');
  const e2 = quiet(() => new BerthFirstEngine('portslade', JSON.parse(JSON.stringify(def)), routes));
  quiet(() => e2.restoreFromLog(STEPS.slice(0, 7).map(stepEvt), { lastRxMs: at('17:30:40') }));
  quiet(() => e2.updateScheduleTrains([{ ...N43 }]));
  NOW = at('17:41:20');
  for (const a of routes.areas) e2.recordTdHeartbeat({ area: a, ts: iso(NOW), event: 'CT' });
  const b = quiet(() => { e2._recompute(); return e2.getApiState(10); });
  check('downtime of 10 min: a gap — recovering, then 1N43 unconfirmed until it moves', [b.unavailable && b.unavailable.reason, e2.view.map(v => v.state)], ['recovering', ['unconfirmed']]);
}

console.log('\nE. The log reader');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-restart-'));
  const w = (rel, lines) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), lines.map(x => JSON.stringify(x)).join('\n') + '\n'); };
  const own = (ts, desc, from, to, event = 'CA', area = 'LA') => ({ ts, area, event, desc, from, to, trust_uid: null });
  // LA own log for 18 Nov and the day before; two events stamped a second out of order stay as received.
  w('td/td-2026-11-17.jsonl', [own('2026-11-17T23:00:00.000Z', '1A01', '0001', '0003')]);
  w('td/td-2026-11-18.jsonl', [own('2026-11-18T08:00:00.000Z', '1X00', '0020', '0018'), own('2026-11-18T16:20:00.000Z', '1N40', '0020', '0018'),
    own('2026-11-18T17:00:05.000Z', '1N43', '0203', '0024'), own('2026-11-18T17:00:04.000Z', '1N43', '0026', '0203'),
    own('2026-11-18T17:20:00.000Z', '-LB-', null, '0005', 'CC'), own('2026-11-18T17:30:00.000Z', '1N44', '0010', '0008'), own('2026-11-18T17:40:00.000Z', '1N45', '0010', '0008')]);
  // TB has no own log: the national log, big enough to need the bisection (~40,000 lines of other areas around it).
  const nat = [];
  for (let t = at('15:00:00'); t < at('17:35:00'); t += 250) nat.push({ rx: iso(t + 900), type: 'CA_MSG', msg_type: 'CA', area_id: 'G1', time: String(t), from: 'N175', to: 'N171', descr: '1S98' });
  nat.push({ rx: iso(at('16:29:00')), type: 'CA_MSG', msg_type: 'CA', area_id: 'TB', time: String(at('16:28:59')), from: '0682', to: '0677', descr: '1H00' });
  nat.push({ rx: iso(at('17:10:01')), type: 'CA_MSG', msg_type: 'CA', area_id: 'TB', time: String(at('17:10:00')), from: '0682', to: '0677', descr: '1H01' });
  nat.push({ rx: iso(at('17:10:31')), type: 'CT_MSG', msg_type: 'CT', area_id: 'TB', time: String(at('17:10:30')), report_time: '1710' });
  nat.push({ rx: iso(at('17:12:01')), type: 'CC_MSG', msg_type: 'CC', area_id: 'TB', time: String(at('17:12:00')), to: 'F661', descr: '1H02' });
  nat.sort((a, b) => RealDate.parse(a.rx) - RealDate.parse(b.rx));
  w('td-all/td-all-2026-11-18.jsonl', nat);
  const r = readRecentBerthEvents({ areas: ['LA', 'TB'], toMs: at('17:31:00'), root });
  check('sources: LA its own log, TB the national log', r.sources, { LA: 'own log', TB: 'national log' });
  check('the last hour only, oldest first, received order kept within LA (1N43 17:00:05 before 17:00:04)',
    r.events.map(e => `${e.ts.slice(11, 19)} ${e.area} ${e.event} ${e.headcode}`),
    ['17:00:05 LA CA 1N43', '17:00:04 LA CA 1N43', '17:10:00 TB CA 1H01', '17:12:00 TB CC 1H02', '17:20:00 LA CC -LB-', '17:30:00 LA CA 1N44']);
  check('  ...in the shape td-listener emits', r.events[2], { headcode: '1H01', ts: iso(at('17:10:00')), area: 'TB', event: 'CA', from: '0682', to: '0677' });
  check('the feed was last heard at the national log\'s last line before the restart', iso(r.lastRxMs), iso(at('17:30:59.900')));
  const r2 = readRecentBerthEvents({ areas: ['LA', 'TB'], toMs: at('17:45:00'), root });
  check('  ...and at its very last line for a restart after the file ends', iso(r2.lastRxMs), iso(at('17:34:59.750') + 900));
  check('a later restart sees the later events too', r2.events.map(e => e.headcode).slice(-1), ['1N45']);
  // An own log that begins after the window's start, with no log for the day before: not trusted, national instead.
  fs.unlinkSync(path.join(root, 'td/td-2026-11-17.jsonl'));
  w('td/td-2026-11-18.jsonl', [own('2026-11-18T17:20:00.000Z', '1N44', '0012', '0010')]);
  const r3 = readRecentBerthEvents({ areas: ['LA'], toMs: at('17:31:00'), root });
  check('LA\'s own log begins 17:20 with no day before: read from the national log', r3.sources, { LA: 'national log' });
  // Over midnight, the day before gzipped by the rotation: skipped, and said so.
  const r4 = readRecentBerthEvents({ areas: ['TB'], toMs: RealDate.parse('2026-11-19T00:20:00Z'), root });
  check('over midnight: today missing, yesterday plain — the yesterday part is read', [r4.events.length, r4.notes], [0, ['national log 2026-11-19: missing']]);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\nF. td-listener: heartbeats');
{
  const L = quiet(() => require('../src/td-listener'));
  L._setLogFilesForTest({ td: () => path.join(os.tmpdir(), 'bf-hb-td.jsonl'), tdAll: () => path.join(os.tmpdir(), 'bf-hb-all.jsonl') });
  L._setCrossingAreasForTest(['LA', 'TB']);
  const got = [];
  L.on('heartbeat', hb => got.push(hb));
  quiet(() => L._processMessageForTest(JSON.stringify([{ CT_MSG: { msg_type: 'CT', area_id: 'TB', time: String(at('17:00:00')), report_time: '1700' } },
    { CT_MSG: { msg_type: 'CT', area_id: 'G1', time: String(at('17:00:00')), report_time: '1700' } }])));
  check('a crossing area\'s CT is emitted with the feed\'s time; another area\'s is not', got, [{ area: 'TB', event: 'CT', ts: iso(at('17:00:00')) }]);
}

console.log('\nG. engines.js');
{
  const { CrossingEngines } = require('../src/engines');
  const logged = [];
  NOW = at('17:00:00');
  const eng = quiet(() => new CrossingEngines({ portslade: { ...JSON.parse(JSON.stringify(def)), shadowEngine: 'berth-first' } }, { portslade: routes }, { log: (cat, d) => logged.push([cat, d]) }));
  const sh = eng.shadows.portslade;
  let read = 0;
  quiet(() => eng.restoreFromLogs(({ areas }) => { read++; return { events: [stepEvt(STEPS[0])], sources: Object.fromEntries(areas.map(a => [a, 'own log'])), lastRxMs: at('16:59:58'), fromMs: 0, toMs: 0, notes: [] }; }));
  check('the shadow is restored from the log, the classic serving engine is not asked', [read, sh.rebuilt.events, typeof eng.serving.portslade.restoreFromLog], [1, 1, 'undefined']);
  quiet(() => eng.forShadows('sighting seed', s => s.seedSightings([])));
  eng.heartbeat({ area: 'TB', ts: iso(at('17:00:00')), event: 'CT' });
  check('a heartbeat reaches the shadow', sh.health.status(at('17:00:00')).areas.TB.heard, true);
  quiet(() => eng.logClosureChanges());
  const line = logged.find(([c, d]) => c === 'closures' && d.role === 'shadow');
  check('the shadow log line says it is unavailable, and why', [line[1].state, line[1].unavailable.reason], ['UNAVAILABLE', 'starting']);
  check('/health lists the shadow\'s feed state', Object.keys(eng.feedHealth().portslade), ['shadow']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
