'use strict';

// tools/learn-routes.js against a made-up railway with a planted answer (berth-first-v1-plan §4).
// Nothing here comes from a real log: every route, junction, platform, two-trains-in-one-berth and
// overtake below was put there on purpose, so the tool must find exactly these and nothing else.
//
//   Area BB ── BB:0116 … BB:0108 ──hand-over──▶ AA:0010 → AA:0008 → AA:0006 → AA:0004 ═clear═▶ AA:0002   ("up")
//   (trains handed into BB from ZZ, 37 min out)              │            ▲
//                                                             └→ AA:0090   │  1 in 5 leave here: junction 0008
//   Platform AA:P001 → AA:0012 ──────────────────────────────────────────┘  starting trains, 5 min dwell
//   Platform AA:P002 → AA:0012 (10 trains pull in behind a P001 train)      one-per-berth exempt at 0012
//   Platform AA:P009 → AA:0001 → AA:0003 ═clear═▶ AA:0005 → terminus AA:T900 ("down", starting trains)
//   AA:T900 → AA:0006 (5 trains turn back, re-described, and cross again)
//
// Day 1 has the national log (both areas, ZZ's cancels, heartbeats). Day 2 has only AA's own log, so
// the hand-overs into AA:0010 look like interposes and must be recognised by berth.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { learn } = require('../tools/learn-routes');
const { RouteTracker, countSameSteps, chooseSameBerths } = require('../tools/lib/route-tracker');
const { loadCif, link } = require('../tools/lib/cif-link');
const { clearVsBarrier, unexplained } = require('../tools/learn-routes');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n          got:      ${a}\n          expected: ${e}`); fail++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-routes-'));
const dirs = { tdAllDir: path.join(tmp, 'td-all'), sclassDir: path.join(tmp, 'sclass'), tdDir: path.join(tmp, 'td') };
const configDir = path.join(tmp, 'crossings');
for (const d of [...Object.values(dirs), configDir]) fs.mkdirSync(d);
fs.writeFileSync(path.join(configDir, 'syn.seed.json'), JSON.stringify({
  area: 'AA',
  directions: { up: { clear: { from: '0004', to: '0002' } }, down: { clear: { from: '0003', to: '0005' } } },
  schedule: { station: 'STN', before: { up: ['FAR'], down: ['NEAR'] } }
}));

const M = 60e3;
// --- day 1: national log
const d1 = [];
const all = (t, type, area, from, to, descr) => d1.push({ t, type, area, from, to, descr });
const D1 = Date.parse('2026-11-20T08:00:00Z');
for (let i = 0; i < 40; i++) {
  const t0 = D1 + i * 10 * M;
  const diverge = i % 5 === 0;
  const hc = diverge ? `5D${String(i).padStart(2, '0')}` : `1U${String(i).padStart(2, '0')}`;
  // through train: handed into BB from ZZ 37 min before the crossing, into AA at +30
  all(t0, 'CC', 'BB', null, '0116', hc); all(t0, 'CB', 'ZZ', '0999', null, hc);
  all(t0 + 8 * M, 'CA', 'BB', '0116', '0114', hc); all(t0 + 16 * M, 'CA', 'BB', '0114', '0112', hc);
  all(t0 + 24 * M, 'CA', 'BB', '0112', '0110', hc); all(t0 + 27 * M, 'CA', 'BB', '0110', '0108', hc);
  all(t0 + 30 * M, 'CC', 'AA', null, '0010', hc); all(t0 + 30 * M, 'CB', 'BB', '0108', null, hc);
  all(t0 + 32 * M, 'CA', 'AA', '0010', '0008', hc);
  if (diverge) { all(t0 + 33 * M, 'CA', 'AA', '0008', '0090', hc); all(t0 + 35 * M, 'CB', 'AA', '0090', null, hc); }
  else {
    all(t0 + 34 * M, 'CA', 'AA', '0008', '0006', hc); all(t0 + 36 * M, 'CA', 'AA', '0006', '0004', hc);
    all(t0 + 37 * M, 'CA', 'AA', '0004', '0002', hc); all(t0 + 38 * M, 'CB', 'AA', '0002', null, hc);
  }
  // starting train at P001
  const sp = `2P${String(i).padStart(2, '0')}`;
  all(t0 + 3 * M, 'CC', 'AA', null, 'P001', sp);
  all(t0 + 8 * M, 'CA', 'AA', 'P001', '0012', sp); all(t0 + 9 * M, 'CA', 'AA', '0012', '0006', sp);
  all(t0 + 9.5 * M, 'CA', 'AA', '0006', '0004', sp); all(t0 + 10 * M, 'CA', 'AA', '0004', '0002', sp);
  all(t0 + 10.5 * M, 'CB', 'AA', '0002', null, sp);
  // a second starter pulls into 0012 behind it, 1 cycle in 4
  if (i % 4 === 1) {
    const q = `2Q${String(i).padStart(2, '0')}`;
    all(t0 + 6 * M, 'CC', 'AA', null, 'P002', q);
    all(t0 + 8.5 * M, 'CA', 'AA', 'P002', '0012', q); all(t0 + 10.5 * M, 'CA', 'AA', '0012', '0006', q);
    all(t0 + 11 * M, 'CA', 'AA', '0006', '0004', q); all(t0 + 11.5 * M, 'CA', 'AA', '0004', '0002', q);
    all(t0 + 12 * M, 'CB', 'AA', '0002', null, q);
  }
  // down: starting trains at P009
  const dn = `1D${String(i).padStart(2, '0')}`;
  all(t0, 'CC', 'AA', null, 'P009', dn);
  all(t0 + 5 * M, 'CA', 'AA', 'P009', '0001', dn); all(t0 + 6 * M, 'CA', 'AA', '0001', '0003', dn);
  all(t0 + 7 * M, 'CA', 'AA', '0003', '0005', dn); all(t0 + 8 * M, 'CB', 'AA', '0005', null, dn);
}
// the planted overtake: 6X21 enters AA:0010 before 1U21, waits in 0008, and 1U21 passes it there
{
  const t0 = D1 + 21 * 10 * M;
  all(t0 + 25 * M, 'CC', 'AA', null, '0010', '6X21'); all(t0 + 25 * M, 'CB', 'BB', '0208', null, '6X21');
  all(t0 + 26 * M, 'CA', 'AA', '0010', '0008', '6X21');
  all(t0 + 40 * M, 'CA', 'AA', '0008', '0006', '6X21'); all(t0 + 41 * M, 'CA', 'AA', '0006', '0004', '6X21');
  all(t0 + 43 * M, 'CA', 'AA', '0004', '0002', '6X21'); all(t0 + 44 * M, 'CB', 'AA', '0002', null, '6X21');
}
// 5 turnbacks: down from P009 over the crossing to terminus AA:T900, re-described there, back up via
// AA:0006. Their up route starts at T900, not at their earlier crossing.
for (let j = 0; j < 5; j++) {
  const t0 = D1 + (40 + j) * 10 * M, dn = `1T0${j}`, up = `2T0${j}`;
  all(t0, 'CC', 'AA', null, 'P009', dn); all(t0 + 1 * M, 'CA', 'AA', 'P009', '0001', dn);
  all(t0 + 2 * M, 'CA', 'AA', '0001', '0003', dn); all(t0 + 3 * M, 'CA', 'AA', '0003', '0005', dn);
  all(t0 + 4 * M, 'CA', 'AA', '0005', 'T900', dn); all(t0 + 6 * M, 'CC', 'AA', null, 'T900', up);
  all(t0 + 7 * M, 'CA', 'AA', 'T900', '0006', up); all(t0 + 7.5 * M, 'CA', 'AA', '0006', '0004', up);
  all(t0 + 8.5 * M, 'CA', 'AA', '0004', '0002', up); all(t0 + 9 * M, 'CB', 'AA', '0002', null, up);
}
// heartbeats every 30 s for AA and BB, 07:00-15:30
for (let t = Date.parse('2026-11-20T07:00:00Z'); t < Date.parse('2026-11-20T15:30:00Z'); t += 30e3) { all(t, 'CT', 'AA'); all(t, 'CT', 'BB'); }
d1.sort((a, b) => a.t - b.t);
fs.writeFileSync(path.join(dirs.tdAllDir, 'td-all-2026-11-20.jsonl'), d1.map(e => JSON.stringify(e.type === 'CT'
  ? { rx: new Date(e.t + 300).toISOString(), type: 'CT_MSG', msg_type: 'CT', area_id: e.area, time: String(e.t), report_time: '0000' }
  : { rx: new Date(e.t + 300).toISOString(), type: `${e.type}_MSG`, msg_type: e.type, area_id: e.area, time: String(e.t), ...(e.from ? { from: e.from } : {}), ...(e.to ? { to: e.to } : {}), descr: e.descr })).join('\n') + '\n');

// --- day 2: only AA's own log (gzipped, as rotated logs are), labels as the old listener wrote them
const d2 = [];
const D2 = Date.parse('2026-11-21T08:00:00Z');
const own = (t, from, to, descr) => d2.push({ ts: new Date(t).toISOString(), area: 'AA', event: from && to ? 'CA' : (from ? 'CC' : 'CB'), desc: descr, from: from || null, to: to || null });
for (let i = 0; i < 10; i++) {
  const t0 = D2 + i * 10 * M, hc = i % 5 === 0 ? `5E${i}` : `1V${i}`;
  own(t0 + 30 * M, null, '0010', hc); own(t0 + 32 * M, '0010', '0008', hc);
  if (i % 5 === 0) { own(t0 + 33 * M, '0008', '0090', hc); own(t0 + 35 * M, '0090', null, hc); }
  else { own(t0 + 34 * M, '0008', '0006', hc); own(t0 + 36 * M, '0006', '0004', hc); own(t0 + 37 * M, '0004', '0002', hc); own(t0 + 38 * M, '0002', null, hc); }
  const sp = `2R${i}`;
  own(t0 + 3 * M, null, 'P001', sp); own(t0 + 8 * M, 'P001', '0012', sp); own(t0 + 9 * M, '0012', '0006', sp);
  own(t0 + 9.5 * M, '0006', '0004', sp); own(t0 + 10 * M, '0004', '0002', sp); own(t0 + 10.5 * M, '0002', null, sp);
}
d2.sort((a, b) => a.ts.localeCompare(b.ts));
fs.writeFileSync(path.join(dirs.sclassDir, 'cclass-AA-2026-11-21.jsonl.gz'), zlib.gzipSync(d2.map(e => JSON.stringify(e)).join('\n') + '\n'));

(async () => {
  console.log('\n-- tracker: field-based kinds and hand-over pairing');
  {
    const runs = [];
    const tr = new RouteTracker({ clears: [{ dir: 'up', area: 'AA', from: '0004', to: '0002' }], onRun: r => runs.push(r) });
    const t = 1e12;
    // a cancel and an interpose in the same second, different areas, same description = a step
    tr.processDay([
      { t, area: 'BB', kind: 'interpose', to: '0001', descr: '1A01', seq: 0 },
      { t: t + 1000, area: 'AA', kind: 'interpose', to: '0004', descr: '1A01', seq: 1 },
      { t: t + 1000, area: 'BB', kind: 'cancel', from: '0001', descr: '1A01', seq: 2 },
      { t: t + 2000, area: 'AA', kind: 'step', from: '0004', to: '0002', descr: '1A01', seq: 3 }
    ]);
    check('hand-over CC+CB in one second moves the train (cancel half arriving second)', runs.length && runs[0].entry.path.map(p => p[0]), ['BB:0001', 'AA:0004', 'AA:0002']);
    check('...and is counted as a hand-over', tr.stats.handovers, 1);
    // the same step reported by two areas (TB 0682→0677 with LA T682→T677, 20 Nov): one train, one berth.
    // Which berths are shared is learned first over all the steps (countSameSteps/chooseSameBerths).
    const trip = (t0, hc, s0, lag) => [
      { t: t0, area: 'XX', kind: 'interpose', to: 'F663', descr: hc, seq: s0 },
      { t: t0 + 1000, area: 'XX', kind: 'step', from: 'F663', to: '0673', descr: hc, seq: s0 + 1 },
      { t: t0 + 30000, area: 'XX', kind: 'step', from: '0673', to: '0682', descr: hc, seq: s0 + 2 },
      { t: t0 + 31000, area: 'XX', kind: 'step', from: '0682', to: '0677', descr: hc, seq: s0 + 3 },
      { t: t0 + 31000 + lag, area: 'AA', kind: 'step', from: 'T682', to: 'T677', descr: hc, seq: s0 + 4 },
      { t: t0 + 90000, area: 'XX', kind: 'step', from: '0677', to: 'N001', descr: hc, seq: s0 + 5 },
      { t: t0 + 90000, area: 'AA', kind: 'step', from: 'T677', to: '0001', descr: hc, seq: s0 + 6 },
      { t: t0 + 120000, area: 'AA', kind: 'step', from: '0001', to: '0003', descr: hc, seq: s0 + 7 },
      { t: t0 + 150000, area: 'AA', kind: 'step', from: '0003', to: '0005', descr: hc, seq: s0 + 8 },
      { t: t0 + 160000, area: 'AA', kind: 'cancel', from: '0005', descr: hc, seq: s0 + 9 }
    ];
    // Nine trains; on three of them AA reports its step a second EARLY, in the same second as XX's
    // previous step (0673→0682), so that pairing turns up too and must lose.
    let ev3 = [];
    for (let k = 0; k < 9; k++) ev3 = ev3.concat(trip(t + k * 600e3, `2S0${k}`, k * 10, k % 3 === 1 ? -1000 : 0));
    ev3.sort((a, b) => a.t - b.t || a.seq - b.seq);
    const same = chooseSameBerths(countSameSteps(ev3));
    check('shared berths learned from the steps, not fooled by the early reports',
      same.map(x => x.berths.slice().sort().join('=')).sort(), ['AA:0001=XX:N001', 'AA:T677=XX:0677', 'AA:T682=XX:0682']);
    const runs3 = [];
    const tr3 = new RouteTracker({ clears: [{ dir: 'west', area: 'AA', from: '0003', to: '0005' }], sameBerths: same.map(x => x.berths), onRun: r => runs3.push(r) });
    tr3.processDay(ev3);
    check('every train tracked from its platform to the crossing as one train, named by the crossing\'s area',
      [runs3.length, ...new Set(runs3.map(r => r.entry.path.map(p => p[0]).join(' ')))], [9, 'XX:F663 XX:0673 AA:T682 AA:T677 AA:0001 AA:0003 AA:0005']);
    check('...the other area\'s report of each shared step is an echo, never a new train', [tr3.stats.echoes, tr3.stats.stepFromEmpty], [18, 0]);
    check('...and the equivalences are recorded', tr3.equivalences(), [['AA:0001', ['XX:N001']], ['AA:T677', ['XX:0677']], ['AA:T682', ['XX:0682']]]);
    // three steps in one second, the shared berth's other report arriving FIRST (1H18 20 Nov 11:22:04)
    const runs5 = [];
    const tr5 = new RouteTracker({ clears: [{ dir: 'west', area: 'AA', from: '0003', to: '0005' }], sameBerths: same.map(x => x.berths), onRun: r => runs5.push(r) });
    tr5.processDay([
      { t, area: 'XX', kind: 'interpose', to: '0673', descr: '1H18', seq: 0 },
      { t: t + 5000, area: 'AA', kind: 'step', from: 'T682', to: 'T677', descr: '1H18', seq: 1 },
      { t: t + 5000, area: 'XX', kind: 'step', from: '0673', to: '0682', descr: '1H18', seq: 2 },
      { t: t + 5000, area: 'XX', kind: 'step', from: '0682', to: '0677', descr: '1H18', seq: 3 },
      { t: t + 9000, area: 'AA', kind: 'step', from: 'T677', to: '0001', descr: '1H18', seq: 4 },
      { t: t + 9000, area: 'XX', kind: 'step', from: '0677', to: 'N001', descr: '1H18', seq: 5 },
      { t: t + 12000, area: 'AA', kind: 'step', from: '0001', to: '0003', descr: '1H18', seq: 6 },
      { t: t + 15000, area: 'AA', kind: 'step', from: '0003', to: '0005', descr: '1H18', seq: 7 }
    ]);
    check('three steps in one second, echo reported first: still one train, no duplicate',
      [runs5.length, runs5[0] && runs5[0].entry.path.map(p => p[0]).join(' '), tr5.stats.stepFromEmpty], [1, 'XX:0673 AA:T682 AA:T677 AA:0001 AA:0003 AA:0005', 0]);
    // a hand-over pair split across two seconds starts a second copy; the copies meet in the next
    // shared berth and become one (1C04 23 Jun: LA CC A001 06:17:57, CB AM12 :58; BM had it from H987)
    const runs6 = [];
    const tr6 = new RouteTracker({ clears: [{ dir: 'down', area: 'BM', from: 'A005', to: 'A007' }], preferArea: 'BM', sameBerths: [['BM:A003', 'LA:A003'], ['BM:A005', 'LA:A005'], ['BM:A007', 'LA:A007']], onRun: r => runs6.push(r) });
    tr6.processDay([
      { t, area: 'BM', kind: 'interpose', to: 'H987', descr: '1C04', seq: 0 },
      { t: t + 1000, area: 'LA', kind: 'interpose', to: 'AM12', descr: '1C04', seq: 1 },
      { t: t + 60e3, area: 'BM', kind: 'step', from: 'H987', to: 'A001', descr: '1C04', seq: 2 },
      { t: t + 60e3, area: 'LA', kind: 'interpose', to: 'A001', descr: '1C04', seq: 3 },
      { t: t + 61e3, area: 'LA', kind: 'cancel', from: 'AM12', descr: '1C04', seq: 4 },
      { t: t + 90e3, area: 'BM', kind: 'step', from: 'A001', to: 'A003', descr: '1C04', seq: 5 },
      { t: t + 90e3, area: 'LA', kind: 'step', from: 'A001', to: 'A003', descr: '1C04', seq: 6 },
      { t: t + 120e3, area: 'BM', kind: 'step', from: 'A003', to: 'A005', descr: '1C04', seq: 7 },
      { t: t + 121e3, area: 'LA', kind: 'step', from: 'A003', to: 'A005', descr: '1C04', seq: 8 },
      { t: t + 150e3, area: 'BM', kind: 'step', from: 'A005', to: 'A007', descr: '1C04', seq: 9 },
      { t: t + 150e3, area: 'LA', kind: 'step', from: 'A005', to: 'A007', descr: '1C04', seq: 10 }
    ]);
    check('two copies of one train meet in a shared berth and become one, keeping the longer history',
      [runs6.length, runs6[0] && runs6[0].entry.path.map(p => p[0]).join(' '), tr6.stats.duplicates], [1, 'BM:H987 BM:A001 BM:A003 BM:A005 BM:A007', 1]);
    // a train making two steps in one second, every time: a tie on votes. Matching berth numbers settle
    // it the right way; with no such clue nothing is joined.
    const two = (t0, hc, s0, aFrom, aTo) => [
      { t: t0, area: 'XX', kind: 'step', from: '0673', to: '0682', descr: hc, seq: s0 },
      { t: t0, area: 'XX', kind: 'step', from: '0682', to: '0677', descr: hc, seq: s0 + 1 },
      { t: t0, area: 'AA', kind: 'step', from: aFrom, to: aTo, descr: hc, seq: s0 + 2 }
    ];
    let ev4 = [], ev4b = [];
    for (let k = 0; k < 6; k++) { ev4 = ev4.concat(two(t + k * 60e3, `1A0${k}`, k * 3, 'T682', 'T677')); ev4b = ev4b.concat(two(t + k * 60e3, `1A0${k}`, k * 3, 'Q100', 'Q200')); }
    check('a tie on votes, berth numbers alike (T682/0682): joined the right way', chooseSameBerths(countSameSteps(ev4)).map(x => x.berths.slice().sort().join('=')), ['AA:T677=XX:0677', 'AA:T682=XX:0682']);
    check('a tie on votes, no clue in the numbers: nothing joined', chooseSameBerths(countSameSteps(ev4b)), []);
    // two trains in one berth: the step out takes the one there longest unless a label matches
    const tr2 = new RouteTracker({ clears: [] });
    tr2.processDay([
      { t, area: 'AA', kind: 'interpose', to: 'P1', descr: 'AAAA', seq: 0 },
      { t: t + 1000, area: 'AA', kind: 'step', from: 'P1', to: 'B1', descr: 'AAAA', seq: 1 },
      { t: t + 2000, area: 'AA', kind: 'interpose', to: 'P2', descr: 'BBBB', seq: 2 },
      { t: t + 3000, area: 'AA', kind: 'step', from: 'P2', to: 'B1', descr: 'BBBB', seq: 3 },
      { t: t + 4000, area: 'AA', kind: 'step', from: 'B1', to: 'B2', descr: 'BBBB', seq: 4 }
    ]);
    const inB1 = (tr2.occ.get('AA:B1') || []).map(e => e.descr), inB2 = (tr2.occ.get('AA:B2') || []).map(e => e.descr);
    check('a second train in a berth keeps the first (exempt berth, §5.2)', [inB1, inB2], [['AAAA'], ['BBBB']]);
  }

  console.log('\n-- learn(): the planted railway');
  const out = await learn({ id: 'syn', from: '2026-11-20', to: '2026-11-21', configDir, dirs });
  const up = out.directions.up, down = out.directions.down;
  check('areas: BB added (hands trains in 7 min out), ZZ not (37 min out)', out.areas, ['AA', 'BB']);
  check('BB was read on the national-log day only', [out.areaSources.BB.daysRead, out.areaSources.BB.missingDays], [1, 1]);
  check('AA:0010 recognised as a fringe berth', out.fringeBerths.includes('AA:0010'), true);
  check('up: trains crossed (32 through + 8 day-2 through + 40 + 10 P001 + 10 P002 + 6X21 + 5 turnbacks)', up.runs.n, 32 + 8 + 50 + 10 + 1 + 5);
  const byStart = Object.fromEntries(up.routes.map(r => [r.berths[0], r]));
  check('up routes: from BB:0116, platforms AA:P001 and AA:P002, and the terminus AA:T900', Object.keys(byStart).sort(), ['AA:P001', 'AA:P002', 'AA:T900', 'BB:0116']);
  check('turnbacks start where they were re-described, 1 min before leaving', [byStart['AA:T900'] && byStart['AA:T900'].startedAs, byStart['AA:T900'] && byStart['AA:T900'].berths],
    [{ turnback: 5 }, ['AA:T900', 'AA:0006', 'AA:0004', 'AA:0002']]);
  check('through route berths, outermost first', byStart['BB:0116'].berths, ['BB:0116', 'BB:0114', 'BB:0112', 'BB:0110', 'BB:0108', 'AA:0010', 'AA:0008', 'AA:0006', 'AA:0004', 'AA:0002']);
  check('through route: 32 trains, started by hand-over from ZZ', [byStart['BB:0116'].trains, byStart['BB:0116'].startedAs], [32, { handover: 32 }]);
  check('through route horizon 37 min, 100% >= 25', [byStart['BB:0116'].horizonMins.p50, byStart['BB:0116'].horizonMins.atLeast25pct], [37, 100]);
  check('last junction: certain from AA:0006, trains leave at AA:0008', [byStart['BB:0116'].lastJunction.certainFrom, byStart['BB:0116'].lastJunction.divergeAt], ['AA:0006', 'AA:0008']);
  check('AA:0008 is shared: 8 + 2 trains left to AA:0090', up.berths['AA:0008'].fate.leftTo, { 'AA:0090': 10 });
  check('platform route: certain from its platform', [byStart['AA:P001'].lastJunction.certainFrom, byStart['AA:P001'].lastJunction.divergeAt], ['AA:P001', null]);
  check('P001: 50 trains, departure to crossing 2 min', [byStart['AA:P001'].trains, byStart['AA:P001'].startingPlatform.minsFromDeparture.p50], [50, 2]);
  const sp = Object.fromEntries(up.startingPlatforms.map(p => [p.berth, p]));
  check('starting platforms: P001 described 5 min before leaving', sp['AA:P001'] && sp['AA:P001'].describedBeforeDepartureMins.p50, 5);
  check('day 2 through trains: seen from AA:0010 only, as hand-overs we could not see', up.startsPartWayIn.map(s => [s.berth, s.trains, s.startedAs]), [['AA:0010', 8, { handoverInferred: 8 }]]);
  const t6 = up.berths['AA:0006'].timeInBerth.passengerUnlinked;
  check('time in AA:0006, passenger trains with no timetable link: 40 through at 120 s, 60 starters + 5 turnbacks at 30 s', [t6.n, t6.p10, t6.p90], [105, 30, 120]);
  check('one train per berth: exempt at AA:0012 (10 pull-ins of 60 steps)', [up.berths['AA:0012'].onePerBerth.value, up.berths['AA:0012'].onePerBerth.trainsInBehind, up.berths['AA:0012'].onePerBerth.stepsInto], ['exempt', 10, 60]);
  check('one train per berth: exempt at AA:0008 (the planted overtake)', [up.berths['AA:0008'].onePerBerth.value, up.berths['AA:0008'].onePerBerth.trainsInBehind], ['exempt', 1]);
  check('one train per berth: holds at AA:0006 and AA:0004', [up.berths['AA:0006'].onePerBerth.value, up.berths['AA:0004'].onePerBerth.value], ['holds', 'holds']);
  const ot = up.overtaking.sameTrack;
  check('overtaking: exactly the planted one, on the same track (inside AA:0008), none on other tracks',
    [ot.count, ot.examples[0] && ot.examples[0].overtook, ot.examples[0] && ot.examples[0].overtaken, ot.examples[0] && ot.examples[0].lastAheadAt, up.overtaking.differentTracks.count],
    [1, '1U21', '6X21', 'AA:0008', 0]);
  check('down: one route, from platform AA:P009', down.routes.map(r => r.berths), [['AA:P009', 'AA:0001', 'AA:0003', 'AA:0005']]);
  check('down: departure to crossing 2 min, nothing leaves the route', [down.routes[0].startingPlatform.minsFromDeparture.p50, down.routes[0].lastJunction.divergeAt], [2, null]);
  check('feed health: heartbeat 30 s, threshold 120 s (floor), marked GUESS (1 day)', [out.feedHealth.AA.heartbeatSecs.p50, out.feedHealth.AA.maxSilenceSecs, /GUESS/.test(out.feedHealth.AA.basis)], [30, 120, true]);
  check('every figure has its dates: through route', [byStart['BB:0116'].from, byStart['BB:0116'].to], ['2026-11-20', '2026-11-20']);

  console.log('\n-- truth: clear steps against barrier closures');
  {
    const runs = [{ t: 1000e3, day: 'd' }, { t: 2000e3, day: 'd' }, { t: 5000e3, day: 'd' }];
    const barrier = { days: ['d'], closures: [{ start: 900e3, end: 1015e3 }, { start: 1900e3, end: 2100e3 }, { start: 3000e3, end: 3100e3 }] };
    const v = clearVsBarrier(runs, barrier);
    check('2 of 3 clear steps inside a closure', [v.clearStepsWhileBarrierDown.count, v.clearStepsWhileBarrierDown.of], [2, 3]);
    check('raise 15 s after the last train (within 60 s only)', v.clearStepToRaiseStartSecs.p50, 15);
    check('one closure with no clear step', unexplained(runs, barrier).withNoClearStep, 1);
  }

  console.log('\n-- timetable link');
  {
    const lines = [
      { JsonTimetableV1: { Metadata: { type: 'full', sequence: 1 } } },
      { JsonScheduleV1: { CIF_train_uid: 'A00001', CIF_stp_indicator: 'P', schedule_start_date: '2026-07-01', schedule_end_date: '2026-12-31', schedule_days_runs: '1111111', transaction_type: 'Create',
        schedule_segment: { signalling_id: '1U05', CIF_train_category: 'OO', schedule_location: [{ tiploc_code: 'FAR', departure: '0800' }, { tiploc_code: 'STN', arrival: '0839', departure: '0840' }, { tiploc_code: 'END', arrival: '0850' }] } } },
      { JsonScheduleV1: { CIF_train_uid: 'A00001', CIF_stp_indicator: 'C', schedule_start_date: '2026-11-21', schedule_end_date: '2026-11-21', schedule_days_runs: '1111111', transaction_type: 'Create', schedule_segment: {} } },
      { JsonScheduleV1: { CIF_train_uid: 'B00002', CIF_stp_indicator: 'P', schedule_start_date: '2026-07-01', schedule_end_date: '2026-12-31', schedule_days_runs: '1111111', transaction_type: 'Create',
        schedule_segment: { signalling_id: '1U05', CIF_train_category: 'OO', schedule_location: [{ tiploc_code: 'NEAR', departure: '0830' }, { tiploc_code: 'STN', pass: '0845' }] } } }
    ];
    const f = path.join(tmp, 'cif.json.gz');
    fs.writeFileSync(f, zlib.gzipSync(lines.map(l => JSON.stringify(l)).join('\n') + '\n'));
    const cif = await loadCif(f, { point: { station: 'STN' }, before: { up: ['FAR'], down: ['NEAR'] } });
    const a = link(cif, { descr: '1U05', dir: 'up', t: Date.parse('2026-11-20T08:42:00Z') });
    check('links to the up schedule, 2 min late', [a && a.sched.uid, a && a.lateSecs], ['A00001', 120]);
    check('a cancelled day does not link (and the down train is the wrong direction)', link(cif, { descr: '1U05', dir: 'up', t: Date.parse('2026-11-21T08:42:00Z') }), null);
    const b = link(cif, { descr: '1U05', dir: 'down', t: Date.parse('2026-11-20T08:46:00Z') });
    check('down train links to its own schedule', b && b.sched.uid, 'B00002');
    const s = link(cif, { descr: '1U05', dir: 'up', t: Date.parse('2026-07-15T07:41:00Z') });
    check('summer: booked 08:40 London is 07:40 UTC (BST)', s && s.lateSecs, 60);
  }

  console.log('\nRun-through: an earlier berth that already shows it (design §5.5)');
  {
    // Planted: route F > S > A > K (K holds the station, threshold 100 s). 40 booked stoppers stop (150 s in K) and
    // stop at S too (140 s); 12 run through K (50 s), of which 10 also run through S (45 s) and 2 stop at S (140 s).
    // A takes 60 s for everyone, so it separates nothing. F is each run's first berth, never timed.
    const T0 = Date.parse('2026-11-20T08:00:00Z');
    const mk = (n, sSecs, kSecs) => { const t0 = T0 + n * 3600e3; const seg = [['X:F', t0], ['X:S', t0 + 30e3], ['X:A', t0 + 30e3 + sSecs * 1e3], ['X:K', t0 + 30e3 + sSecs * 1e3 + 60e3]];
      const tIn = seg[3][1]; return { secs: kSecs, tIn, run: { seg, t: tIn + kSecs * 1e3, descr: '1X' + String(n).padStart(2, '0') } }; };
    const stoppers = [];
    for (let i = 0; i < 40; i++) stoppers.push(mk(i, 140 + (i % 5), 150));
    for (let i = 0; i < 10; i++) stoppers.push(mk(40 + i, 45 + (i % 3), 50));
    for (let i = 0; i < 2; i++) stoppers.push(mk(50 + i, 140, 50));
    const { earlySignalFor } = require('../tools/learn-routes');
    const e = earlySignalFor('X:K', stoppers, 100);
    check('the earlier berth is S (A separates nothing, F is never timed)', e.berth, 'X:S');
    check('its threshold sits in the gap: slowest run-through caught 47 s, quickest stopper 140 s', e.thresholdSecs, 94);
    check('caught 10 of 12 run-throughs, no stopper switched', [e.caught.count, e.caught.of, e.falseSwitches.count], [10, 12, 0]);
    check('warning from leaving S: 60 s in A + 50 s in K', e.caught.medianSecsToClear, 110);
    check('too few run-throughs: no signal', earlySignalFor('X:K', stoppers.slice(0, 45), 100).berth, null);
    // A berth further out (F2, before S) that warns sooner: all 12 run-throughs 40 s, stoppers 120 s except 3 at
    // 70-74 s. Its best cut catches 12 and switches none (threshold midway 40..70 = 55): net 12 beats S's 10, so F2
    // wins here — the outer berth is right when it is as clean. Then make it switch 3 stoppers (30-34 s): S wins.
    const withF2 = stoppers.map((x, i) => { const seg = [['X:F', x.run.seg[0][1] - 90e3], ['X:F2', x.run.seg[0][1] - 60e3], ...x.run.seg.slice(1)];
      seg[2] = ['X:S', x.run.seg[0][1]];
      const f2 = i < 40 ? (i < 3 ? 70 + 2 * i : 120) : 40;
      seg[1] = ['X:F2', seg[2][1] - f2 * 1e3];
      return { ...x, run: { ...x.run, seg } }; });
    const e2 = earlySignalFor('X:K', withF2, 100);
    check('an outer berth that is just as clean and catches more wins', [e2.berth, e2.thresholdSecs, e2.falseSwitches.count], ['X:F2', 55, 0]);
    const withF2b = withF2.map((x, i) => { if (i >= 3) return x; const seg = x.run.seg.map(y => [...y]); seg[1] = ['X:F2', seg[2][1] - (30 + 2 * i) * 1e3]; return { ...x, run: { ...x.run, seg } }; });
    const e3 = earlySignalFor('X:K', withF2b, 100);
    check('...but not when it switches stoppers: the cleaner nearer berth wins', [e3.berth, e3.candidates.length], ['X:S', 2]);
    check('...and the outer one is listed with what it would get wrong', e3.candidates.find(c => c.startsWith('X:F2')), 'X:F2 <80s caught 12/12 false 3/40');
  }

  if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true }); else console.log("kept", tmp);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
