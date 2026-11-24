'use strict';
// Berth-first: a strike or clear step belongs to the tracked train that made it.
//
// The copied timing files a train's berth strikes and its clear step under its HEADCODE. Two trains can carry one
// headcode: a stale label left in a berth by the signaller steps on with the next train, or a real second working.
// The second then reads the first one's strike — a confirmed close minutes in the past — and its closure, merged
// with the next train's, holds BARRIERS DOWN until that train has gone.
//
//   A. 19 Nov (LA's own log, test/fixtures/berth-first/duplicate-1H15-2026-11-19.jsonl): the real 1H15 crosses at
//      08:45:32 (barrier up 08:46:12). A 1H15 label interposed in 0042 at 08:29:19 steps 0042>0040 at 08:46:06 with
//      the train that was really 1H17. It read 1H15's 0008 strike (08:42:26 + 20 s = a close at 08:42:46), joined
//      1N09's closure, and the page showed BARRIERS DOWN from 08:46:12 to 08:59:15, with 1N09 still at Lancing.
//      (Seen first in step 5's outage sweep, 19 Nov 08:50:45-08:51:45.)
//   B. A train whose tracked entry was lost before it crossed (cancelled, then written again in the next berth after
//      the hand-over window) still has its strike: the re-written description is the same train. Unchanged.
//   C. Two trains with one headcode on the approach at once: the second stepping into the first one's anchor berth
//      does not move the first one's close.
// usage: node test/berth-duplicate.test.js
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
const at = s => RealDate.parse(`2026-11-19T${s}Z`);
const TT = {
  '1H15': { uid: 'G88051', headcode: '1H15', direction: 'east', estimatedCrossingMins: 527.95, callsAtStation: true, callsAtApproach: false, origin: 'LTLHMPT', destination: 'VICTRIC' },
  '1N09': { uid: 'G88565', headcode: '1N09', direction: 'east', estimatedCrossingMins: 538.4, callsAtStation: true, callsAtApproach: true, origin: 'SOTON', destination: 'BRGHTN' },
  '1H17': { uid: 'G26393', headcode: '1H17', direction: 'east', estimatedCrossingMins: 557.95, callsAtStation: true, callsAtApproach: false, origin: 'LTLHMPT', destination: 'VICTRIC' }
};

// A started engine with a healthy feed (heartbeats every 30 s) and these timetable entries.
function engineAt(start, entries) {
  NOW = start;
  const e = quiet(() => new BerthFirstEngine('portslade', JSON.parse(JSON.stringify(def)), routes));
  quiet(() => e.restoreFromLog([]));
  let last = NOW - 30e3;
  e.beat = () => { const end = NOW; while (last + 30e3 <= end) { last += 30e3; NOW = last; for (const a of routes.areas) e.recordTdHeartbeat({ area: a, ts: new RealDate(last).toISOString(), event: 'CT' }); } NOW = end; };
  e.beat();
  quiet(() => e.updateScheduleTrains(entries.map(t => ({ category: 'XX', operator: 'SN', trainType: 'passenger', source: 'cif',
    legIndex: 0, legCount: 1, runsAsRequired: false, daysPattern: '1111100', ...t }))));
  return e;
}
const feed = (e, x) => quiet(() => e.recordTdEvent({ headcode: x.desc, ts: x.ts, area: x.area || 'LA', event: x.event, from: x.from || null, to: x.to || null }));
const page = e => { quiet(() => e._recompute()); return quiet(() => e.getApiState(10)); };
const closureOf = (api, hc) => (api.upcomingClosures || []).find(c => c.trains.some(t => t.headcode === hc));

console.log('A. 19 Nov: a stale 1H15 label steps in after the real 1H15 has crossed');
{
  const ev = fs.readFileSync(path.join(__dirname, 'fixtures', 'berth-first', 'duplicate-1H15-2026-11-19.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l)).filter(x => x.ts);
  const e = engineAt(at('08:09:00'), Object.values(TT));
  let i = 0;
  const closed = [], seen = {};
  for (let t = at('08:09:30'); t <= at('08:53:00'); t += 1000) {
    NOW = t; e.beat();
    while (i < ev.length && RealDate.parse(ev[i].ts) <= t) feed(e, ev[i++]);
    const api = page(e);
    if (api.state === 'CLOSED') closed.push(t);
    if (t === at('08:45:40') || t === at('08:46:06')) {
      const c = closureOf(api, '1H15');
      seen[hms(t)] = c ? `${hms(RealDate.parse(c.start))}-${hms(RealDate.parse(c.end))}` : null;
    }
    if (t === at('08:46:06')) {
      // The train that stepped into 0040 is tracked as its own entry with the label 1H15.
      const v = e.view.find(x => x.label === '1H15' && x.berth === 'LA:0040');
      const m = v && (e.timing._bfMerged || []).find(x => x.bfId === v.id);
      seen.dupTracked = !!v;
      seen.dupStruck = m ? !!e.timing._freshStrike(m, new Date(t), '0008') : null;
      seen.dupClose = m ? e.timing._computeCloseTime(m, new Date(t)).getTime() >= t : null;
    }
  }
  const spans = []; for (const t of closed) { const s = spans[spans.length - 1]; if (s && t - s[1] === 1000) s[1] = t; else spans.push([t, t]); }
  check('the real 1H15 closure, 08:43:21 to 08:46:12, is the same when the label steps in', [seen['08:45:40'], seen['08:46:06']], ['08:43:21-08:46:12', '08:43:21-08:46:12']);
  check('BARRIERS DOWN for it alone (the end is exclusive), and not again before 08:53', spans.map(([a, b]) => `${hms(a)}-${hms(b)}`), ['08:43:21-08:46:11']);
  check('the label in 0040 is tracked as a train of its own', seen.dupTracked, true);
  check("it has not struck 0008 (that was the real 1H15)", seen.dupStruck, false);
  check('its close is not in the past', seen.dupClose, true);
}

console.log("\nB. a train lost before it crossed, written again: the re-written description keeps the strike");
{
  // 1H15 (stopping: Portslade, not Southwick) strikes its anchor 0008 at 08:42:26. The describer then loses it:
  // cancelled from 0008 at 08:43:30, written into 0006 twenty seconds later (outside the hand-over window, so a new
  // tracked entry), stepping 0006>0004 at 08:44:33 and across at 08:45:32.
  const e = engineAt(at('08:36:00'), [TT['1H15']]);
  const steps = [['CA', '0018', '0016', '08:35:37'], ['CA', '0016', '0014', '08:37:55'], ['CA', '0014', '0012', '08:39:12'],
    ['CA', '0012', '0010', '08:39:49'], ['CA', '0010', '0008', '08:42:26'], ['CB', '0008', null, '08:43:30'],
    ['CC', null, '0006', '08:43:50'], ['CA', '0006', '0004', '08:44:33'], ['CA', '0004', '0002', '08:45:32']];
  const out = {};
  for (const [event, from, to, s] of steps) {
    NOW = at(s); e.beat();
    feed(e, { desc: '1H15', ts: new RealDate(NOW).toISOString(), event, from, to });
    const api = page(e);
    const c = closureOf(api, '1H15');
    out[s] = c ? `${c.closeConfirmed ? 'confirmed ' : ''}${hms(RealDate.parse(c.start))}` : null;
  }
  check('struck 0008 at 08:42:26: closes 0008 + 55 s', out['08:42:26'], 'confirmed 08:43:21');
  check('re-written in 0006, stepping on: still 08:43:21', out['08:44:33'], 'confirmed 08:43:21');
}

console.log('\nC. two trains with one headcode on the approach at once');
{
  // A (1H15) strikes 0008 at 08:42:26 and is in 0004 at 08:44:33. B, a second 1H15 behind it, steps into 0008 at
  // 08:44:50. A has not crossed: its 0008 strike is still its own. (Which of the two the timetable's 1H15 is, and so
  // its class, is link.js's question, not this one.)
  const e = engineAt(at('08:36:00'), [TT['1H15']]);
  const strikeOf = (berthNow, now) => {
    const v = e.view.find(x => x.berth === `LA:${berthNow}`);
    const m = v && (e.timing._bfMerged || []).find(x => x.bfId === v.id);
    const s = m && e.timing._freshStrike(m, new Date(now), '0008');
    return s ? hms(s.ts) : null;
  };
  const steps = [['A', '0018', '0016', '08:35:37'], ['A', '0016', '0014', '08:37:55'], ['A', '0014', '0012', '08:39:12'],
    ['A', '0012', '0010', '08:39:49'], ['B', '0018', '0016', '08:40:30'], ['A', '0010', '0008', '08:42:26'],
    ['B', '0016', '0014', '08:42:40'], ['A', '0008', '0006', '08:43:41'], ['B', '0014', '0012', '08:43:50'],
    ['A', '0006', '0004', '08:44:33'], ['B', '0012', '0010', '08:44:35'], ['B', '0010', '0008', '08:44:50']];
  const out = {};
  for (const [who, from, to, s] of steps) {
    NOW = at(s); e.beat();
    feed(e, { desc: '1H15', ts: new RealDate(NOW).toISOString(), event: 'CA', from, to });
    const api = page(e);
    const c = closureOf(api, '1H15');
    out[`${who}${s}`] = c ? `${c.closeConfirmed ? 'confirmed ' : ''}${hms(RealDate.parse(c.start))}` : null;
    if (s === '08:44:50') out.strikes = [strikeOf('0004', NOW), strikeOf('0008', NOW)];
  }
  check('A in 0004: closes at its 0008 strike + 55 s', out['A08:44:33'], 'confirmed 08:43:21');
  check("B steps into 0008: A's 0008 strike is still 08:42:26, B's is 08:44:50", out.strikes, ['08:42:26', '08:44:50']);
}

console.log("\nD. 21 Nov: a train that has crossed does not take a new entry by an old name");
{
  // 1N34 stood in Brighton's F661; the signaller wrote 1S18 (the next departure) over it for 15 s. Its tracked train
  // carries both names. Once it had crossed (13:20:16) and the board had dropped 1N34, the linker gave it the board's
  // 1S18 by that old name, and 1S18 took 1N34's 0003 strike: BARRIERS DOWN from 13:22 for a train still in Brighton.
  const at21 = s => RealDate.parse(`2026-11-21T${s}Z`);
  const ev = fs.readFileSync(path.join(__dirname, 'fixtures', 'berth-first', 'old-name-1N34-1S18-2026-11-21.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l)).filter(x => x.ts);
  const board = (hc, best, dest) => ({ origin: 'Brighton', destination: dest, operator: 'SN', scheduledTime: best, bestTime: best, direction: 'west',
    delayMins: 0, isUncertain: false, timeSource: 'forecast', etaText: '', headcode: hc, uid: null, trainType: 'passenger', source: 'ldbsv', dedupKey: `${best}|${dest}` });
  const e = engineAt(at21('12:54:00'), [
    { uid: 'G26694', headcode: '1N34', direction: 'west', estimatedCrossingMins: 799.3, callsAtStation: true, callsAtApproach: true, origin: 'BRGHTN', destination: 'BOGNORR', daysPattern: '0000010' },
    { uid: 'G26986', headcode: '1S18', direction: 'west', estimatedCrossingMins: 814.6, callsAtStation: true, callsAtApproach: true, origin: 'BRGHTN', destination: 'BOGNORR', daysPattern: '0000010' },
    { uid: 'G88619', headcode: '1N27', direction: 'east', estimatedCrossingMins: 808.4, callsAtStation: true, callsAtApproach: true, origin: 'BOGNORR', destination: 'BRGHTN', daysPattern: '0000010' }]);
  const n27 = { ...board('1N27', '2026-11-21T13:27:00.000Z', 'Brighton'), origin: 'Bognor Regis', direction: 'east' };
  const boards = [[at21('12:55:00'), [board('1N34', '2026-11-21T13:20:00.000Z', 'Bognor Regis'), n27, board('1S18', '2026-11-21T13:36:00.000Z', 'Bognor Regis')]],
    [at21('13:21:00'), [n27, board('1S18', '2026-11-21T13:36:00.000Z', 'Bognor Regis')]],
    [at21('13:26:30'), [board('1S18', '2026-11-21T13:36:00.000Z', 'Bognor Regis')]]];
  let i = 0, bi = 0;
  const closed = [];
  let crossedLinks = null;
  for (let t = at21('12:55:00'); t <= at21('13:37:00'); t += 1000) {
    NOW = t; e.beat();
    while (bi < boards.length && boards[bi][0] <= t) quiet(() => e.updateLdbTrains(boards[bi++][1]));
    while (i < ev.length && RealDate.parse(ev[i].ts) <= t) feed(e, ev[i++]);
    const api = page(e);
    if (api.state === 'CLOSED') closed.push(t);
    if (t === at21('13:22:30')) {
      const v = e.view.find(x => x.state === 'crossed' && (x.headcodes || []).includes('1N34'));
      crossedLinks = v ? [...e.links.entries()].filter(([, l]) => l.id === v.id).map(([r]) => r.headcode) : null;
    }
  }
  const spans = []; for (const t of closed) { const s = spans[spans.length - 1]; if (s && t - s[1] === 1000) s[1] = t; else spans.push([t, t]); }
  check('1N34 (crossed 13:20:16) carries no entry but its own after crossing', crossedLinks, ['1N34']);
  check('BARRIERS DOWN for 1N34 (0003 13:17:59 + 61 s), 1N27 (0006 13:22:01 + 100 s) and 1S18 (0003 13:33:27 + 61 s) only',
    spans.map(([a, b]) => `${hms(a)}-${hms(b)}`), ['13:19:00-13:20:34', '13:23:41-13:26:04', '13:34:28-13:36:33']);
}

console.log("\nE. 19 Nov: a step credited to a same-named copy is still the train's own");
{
  // A 3S93 label was written into Portslade's platform 0005 at 12:12:55 and never moved. The train running as 3S93
  // stepped into 0005 at 12:33:58 and crossed 0005>0007 at 12:36:02, but the tracker moved the older 3S93 entry and
  // left the train standing in 0005 without its clear step: its closure was held open into 2Y29's, BARRIERS DOWN
  // through the real gap 12:36:20-12:37:56. A train that has not moved since a step made OUT OF ITS OWN BERTH made it.
  const at19 = s => RealDate.parse(`2026-11-19T${s}Z`);
  const ev = fs.readFileSync(path.join(__dirname, 'fixtures', 'berth-first', 'copy-3S93-2026-11-19.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l)).filter(x => x.ts);
  const e = engineAt(at19('12:09:00'), [
    { uid: 'G25658', headcode: '3S93', direction: 'east', estimatedCrossingMins: 482, callsAtStation: false, callsAtApproach: false, legIndex: 0, legCount: 2, trainType: 'test', category: 'DD', runsAsRequired: true, origin: 'HORSHUS', destination: 'HORSHUS' },
    { uid: 'G25658', headcode: '3S93', direction: 'west', estimatedCrossingMins: 759.95, callsAtStation: false, callsAtApproach: false, legIndex: 1, legCount: 2, trainType: 'test', category: 'DD', runsAsRequired: true, origin: 'HORSHUS', destination: 'HORSHUS' },
    { uid: 'G26994', headcode: '1S30', direction: 'west', estimatedCrossingMins: 754.6, callsAtStation: true, callsAtApproach: true, origin: 'BRGHTN', destination: 'PSEA' },
    { uid: 'G27952', headcode: '2Y29', direction: 'east', estimatedCrossingMins: 763.5, callsAtStation: true, callsAtApproach: true, origin: 'CHCHSTR', destination: 'BRGHTN' }]);
  let i = 0; const st = {};
  for (let t = at19('12:09:30'); t <= at19('12:44:00'); t += 1000) {
    NOW = t; e.beat();
    while (i < ev.length && RealDate.parse(ev[i].ts) <= t) feed(e, ev[i++]);
    st[hms(t)] = page(e).state;
  }
  const between = (a, b) => Object.entries(st).filter(([k]) => k >= a && k <= b).map(([, v]) => v);
  check('BARRIERS DOWN as it crosses (12:36:00)', st['12:36:00'], 'CLOSED');
  check('not DOWN while the barrier is up between the two (12:36:25-12:37:50)', between('12:36:25', '12:37:50').includes('CLOSED'), false);
  check("BARRIERS DOWN for 2Y29 (0006 12:36:16 + 100 s)", st['12:38:00'], 'CLOSED');
}

console.log('\nF. 13 Nov: a train timed from the berths alone keeps its closure until its barrier is up');
{
  // 5E13 (ECS) with no timetable or board entry linked: berth-first times it from the berths. It crossed at 10:19:52;
  // the barrier comes up 40 s after an eastbound passenger/ECS clear step (openLagSecs.east.passenger), 10:20:32. Its
  // closure used to vanish at the clear step, because only APPROACHING trains were timed from the berths; a linked
  // train keeps its entry while CROSSED. 14 days (10-23 Nov): 1.2 min a day of barrier down with the page OPEN.
  const at13 = s => RealDate.parse(`2026-11-13T${s}Z`);
  const ev = fs.readFileSync(path.join(__dirname, 'fixtures', 'berth-first', 'crossed-5E13-2026-11-13.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l)).filter(x => x.ts);
  const e = engineAt(at13('09:59:00'), []);
  let i = 0; const st = {}; let source = null;
  for (let t = at13('09:59:30'); t <= at13('10:22:00'); t += 1000) {
    NOW = t; e.beat();
    while (i < ev.length && RealDate.parse(ev[i].ts) <= t) feed(e, ev[i++]);
    const api = page(e); st[hms(t)] = api.state;
    if (t === at13('10:19:00')) { const c = closureOf(api, '5E13'); source = c ? c.trains.find(x => x.headcode === '5E13').source : null; }
  }
  check('timed from the berths alone', source, 'berth');
  check('BARRIERS DOWN as it crosses (10:19:50)', st['10:19:50'], 'CLOSED');
  check('still DOWN after its clear step, until the barrier is up (10:20:00, 10:20:30)', [st['10:20:00'], st['10:20:30']], ['CLOSED', 'CLOSED']);
  check('clear once the barrier is up (10:20:34)', st['10:20:34'] !== 'CLOSED', true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
