'use strict';

// The pure analyses, each against a constructed dataset whose answer is known in advance.
// All STANOXes, berths and the stations AAA / BBB / EDB are invented for the planted answers; the
// coordinates of SWK, PLD, HOV, FSG are the real ones from the national table.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  analyseSemantics, judgeSemantics, analyseStationResolution, judgeStationResolution,
  analyseAnchors, describeAnchors, analyseSussex, describeSussex
} = require('../lib/smart-analysis');
const { haversineKm } = require('../lib/geo');
const { stationMap } = require('./smart-check-helpers');

const row = (td, stanox, event, from, to) => ({ td, stanox, event, from, to });

// ---- SMART_SEMANTICS --------------------------------------------------------------------------------

// Four groups with both an arrival and a departure, three of which follow our reading.
//   G1  stanox 1, up:   arrive 0008>0006, depart 0006>0004   arrival TO = departure FROM = 0006       ours exact
//   G2  stanox 2, up:   arrive 0014>0012, depart 0012>0010   0012                                      ours exact
//   G3  stanox 3, down: arrive 0003>0005, depart 0005>0007   0005                                      ours exact
//   G4  stanox 4, up:   arrive 0040>0042, depart 0044>0040   TO 0042 vs FROM 0044: no match, but
//                       arrival FROM 0040 = departure TO 0040: the REVERSED reading matches
// so ours = 3/4 = 75% exactly and reversed = 1/4 = 25%. Noise that must not form a testable group:
// an arrival-only group, a departure-only group, an unrecognised EVENT, and a row with no STANOX.
const PLANTED = [
  row('LA', '1', 'A', '0008', '0006'), row('LA', '1', 'B', '0006', '0004'),
  row('LA', '2', 'A', '0014', '0012'), row('LA', '2', 'B', '0012', '0010'),
  row('LA', '3', 'C', '0003', '0005'), row('LA', '3', 'D', '0005', '0007'),
  row('LA', '4', 'A', '0040', '0042'), row('LA', '4', 'B', '0044', '0040'),
  row('LA', '5', 'A', '0050', '0052'),                    // arrivals only
  row('LA', '6', 'D', '0060', '0062'),                    // departures only
  row('LA', '7', 'X', '0070', '0072'),                    // not a documented EVENT
  row('LA', '', 'A', '0080', '0082')                      // no STANOX
];

test('SEMANTICS: 3 of 4 consistent groups is exactly 75%, and the reversed reading is lower (25%)', () => {
  const r = analyseSemantics(PLANTED);
  assert.equal(r.groups, 4);
  assert.deepEqual(r.ours, { exact: 3, adjacent: 0, none: 1 });
  assert.deepEqual(r.reversed, { exact: 1, adjacent: 0, none: 3 });
  assert.equal(r.pct.oursExact, 75);
  assert.equal(r.pct.reversedExact, 25);
  assert.deepEqual(r.cross, { 'exact/none': 3, 'none/exact': 1 });
  assert.equal(r.arrivalOnly, 1);
  assert.equal(r.departureOnly, 1);
  assert.equal(r.groupsTotal, 6);
  assert.deepEqual(r.ignored, { unrecognisedEvent: 1, missingAreaOrStanox: 1 });
  assert.equal(r.byDirection.up.groups, 3);
  assert.equal(r.byDirection.down.groups, 1);
  assert.deepEqual(r.byDirection.down.ours, { exact: 1, adjacent: 0, none: 0 });
  assert.equal(r.areas.biggest[0].td, 'LA');
  assert.equal(r.areas.biggest[0].oursExactPct, 75);

  const v = judgeSemantics(r);
  assert.equal(v.status, 'PASS');
  assert.match(v.message, /holds exactly for 75% of 4 station\/direction groups \(a further 0% are one SMART step apart\); the reversed reading holds for 25%\./);
  assert.equal(v.thresholds.firstPass, true);
});

test('SEMANTICS: the verdict depends on the rule, so swapping the reading flips the answer', () => {
  // The same data with arrival and departure swapped in meaning: EVENT A<->B and C<->D. Under our
  // rule an "arrival" at TO and a "departure" at FROM now disagree wherever they used to agree.
  const flip = { A: 'B', B: 'A', C: 'D', D: 'C' };
  const swapped = PLANTED.map(r => ({ ...r, event: flip[r.event] || r.event }));
  const r = analyseSemantics(swapped);
  assert.ok(r.pct.oursExact < 75, `ours should drop, got ${r.pct.oursExact}`);
  assert.ok(r.pct.reversedExact > 25, `reversed should rise, got ${r.pct.reversedExact}`);
  assert.notEqual(judgeSemantics(r).status, 'PASS');
});

test('SEMANTICS: one SMART step apart is "adjacent", in either direction, and only when not exact', () => {
  // arrival TO 0003, departure FROM 0005; a SMART step links them. A second group links them the other way.
  const adj = analyseSemantics([
    row('LA', '1', 'A', '0001', '0003'), row('LA', '1', 'B', '0005', '0007'),
    row('LA', '9', 'A', '0003', '0005'),                                      // the step 0003>0005, from another station
    row('LA', '2', 'A', '0011', '0013'), row('LA', '2', 'B', '0015', '0017'),
    row('LA', '8', 'A', '0015', '0013')                                       // the step 0015>0013: the other way round
  ]);
  assert.equal(adj.groups, 2);
  assert.deepEqual(adj.ours, { exact: 0, adjacent: 2, none: 0 });
  assert.equal(adj.pct.oursAdjacent, 100);

  // A step in a DIFFERENT area does not link berths that merely share names.
  const otherArea = analyseSemantics([
    row('LA', '1', 'A', '0001', '0003'), row('LA', '1', 'B', '0005', '0007'),
    row('SX', '9', 'A', '0003', '0005')
  ]);
  assert.deepEqual(otherArea.ours, { exact: 0, adjacent: 0, none: 1 });

  // Exact wins over adjacent: a group that is both is counted once, as exact.
  const both = analyseSemantics([
    row('LA', '1', 'A', '0001', '0003'), row('LA', '1', 'B', '0003', '0005'),
    row('LA', '9', 'A', '0003', '0005')
  ]);
  assert.deepEqual(both.ours, { exact: 1, adjacent: 0, none: 0 });
});

test('SEMANTICS: blank berths never match each other', () => {
  const r = analyseSemantics([row('LA', '1', 'A', '0001', ''), row('LA', '1', 'B', '', '0009')]);
  assert.equal(r.groups, 1);
  assert.deepEqual(r.ours, { exact: 0, adjacent: 0, none: 1 });
  assert.deepEqual(r.reversed, { exact: 0, adjacent: 0, none: 1 });
  assert.equal(r.withoutBerthData, 1);
});

test('SEMANTICS: groups are per area, per STANOX and per direction', () => {
  // Same STANOX and berths, but the arrival is up and the departure is down: not one group, so nothing to test.
  const r = analyseSemantics([row('LA', '1', 'A', '0001', '0003'), row('LA', '1', 'D', '0003', '0005')]);
  assert.equal(r.groups, 0);
  assert.equal(r.groupsTotal, 2);
  // Same, but two areas: also separate.
  const r2 = analyseSemantics([row('LA', '1', 'A', '0001', '0003'), row('SX', '1', 'B', '0003', '0005')]);
  assert.equal(r2.groups, 0);
});

test('SEMANTICS: "some arrival" and "some departure" - a multi-platform station only needs one shared berth', () => {
  const r = analyseSemantics([
    row('LA', '1', 'A', '0001', '0011'), row('LA', '1', 'A', '0002', '0012'),
    row('LA', '1', 'B', '0012', '0021'), row('LA', '1', 'B', '0013', '0022')
  ]);
  assert.deepEqual(r.ours, { exact: 1, adjacent: 0, none: 0 });
});

function fakeSemantics(groups, oursExact, oursAdjacent, reversedExact) {
  return {
    groups,
    ours: { exact: oursExact, adjacent: oursAdjacent, none: groups - oursExact - oursAdjacent },
    reversed: { exact: reversedExact, adjacent: 0, none: groups - reversedExact },
    pct: { oursExact: Math.round(oursExact / groups * 1000) / 10, oursAdjacent: Math.round(oursAdjacent / groups * 1000) / 10, reversedExact: Math.round(reversedExact / groups * 1000) / 10 }
  };
}

test('SEMANTICS thresholds: PASS >= 60% and 20 points clear; WARN 30-60% or too close to reversed; FAIL under 30%', () => {
  const status = (g, o, a, r) => judgeSemantics(fakeSemantics(g, o, a, r)).status;
  assert.equal(status(100, 60, 0, 40), 'PASS', '60% and exactly 20 points clear is a PASS');
  assert.equal(status(100, 60, 0, 41), 'WARN', '21 points short of... 19 points clear is not clear');
  assert.equal(status(100, 59, 0, 0), 'WARN', '59% is below the PASS line');
  assert.equal(status(100, 30, 0, 0), 'WARN', '30% is the bottom of WARN');
  assert.equal(status(100, 29, 0, 0), 'FAIL');
  assert.equal(status(100, 100, 0, 0), 'PASS');
  assert.equal(status(100, 0, 0, 0), 'FAIL');
  // 3 of 5 = 60% exactly, 1 of 5 = 20%: PASS. 599 of 1000 prints as 59.9 and is WARN; the rounding of
  // the shown number must never decide the verdict.
  assert.equal(status(5, 3, 0, 1), 'PASS');
  assert.equal(status(10000, 5996, 0, 0), 'WARN', '59.96% prints as 60.0 but is below 60');
  assert.match(judgeSemantics(fakeSemantics(100, 70, 0, 60)).message, /nearly as good, so the data cannot tell them apart/);
});

test('SEMANTICS: nothing to test is a FAIL that says what EVENT values there were', () => {
  const r = analyseSemantics([row('LA', '1', 'A', '1', '2'), row('LA', '2', 'C', '3', '4')]);
  const v = judgeSemantics(r, { events: { A: 1, C: 1 } });
  assert.equal(v.status, 'FAIL');
  assert.match(v.message, /No station\/direction group has both an arrival and a departure row.*EVENT values seen: \{"A":1,"C":1\}/);
});

// ---- STATION_RESOLUTION -----------------------------------------------------------------------------

const STATIONS = stationMap({
  PLD: { name: 'Portslade', lat: 50.836044, lon: -0.204898 },
  SWK: { name: 'Southwick', lat: 50.832471, lon: -0.237142 },
  HOV: { name: 'Hove', lat: 50.835206, lon: -0.17018 },
  FSG: { name: 'Fishersgate', lat: 50.834469, lon: -0.219161 },
  AAA: { name: 'Alpha', lat: 50.84, lon: -0.2 },
  BBB: { name: 'Beta', lat: 50.85, lon: -0.2 },
  EDB: { name: 'Edinburgh', lat: 55.952, lon: -3.189 }
});

const CORPUS = (() => {
  const crs = { 1: ['PLD'], 2: ['SWK'], 3: ['EDB'], 4: ['HOV'], 5: ['QQQ'], 7: ['AAA', 'BBB'], 20: ['ZZZ'], 21: ['YYY'], 22: ['XXX'], 23: ['WWW'], 24: ['AAA', 'VVV'] };
  const known = new Set([...Object.keys(crs), '6']);                 // 6 is a junction: in CORPUS, no CRS
  return { crsForStanox: s => crs[s] || [], hasStanox: s => known.has(s) };
})();

test('RESOLUTION: planted counts, the unresolved list ordered by rows, and a FAIL at 60%', () => {
  const stanoxInfo = new Map([
    ['1', { rows: 10, name: 'PORTSLADE' }], ['2', { rows: 8, name: 'SOUTHWICK' }],
    ['6', { rows: 5, name: 'HOVE JN' }],                              // a junction: not a station
    ['99', { rows: 3, name: 'NOT IN CORPUS' }],                       // not in CORPUS at all
    ['20', { rows: 20, name: 'ZED STATION' }], ['21', { rows: 2, name: 'WHY STATION' }],
    ['24', { rows: 1, name: 'TWO CRS' }]                              // two CRS, one of them in the table
  ]);
  const r = analyseStationResolution({ stanoxInfo, corpus: CORPUS, stations: STATIONS, topN: 20 });
  assert.equal(r.stanoxes, 7);
  assert.equal(r.stationStanoxes, 5);          // 1, 2, 20, 21, 24
  assert.equal(r.nonStations, 2);              // 6 and 99
  assert.equal(r.notInCorpus, 1);              // 99
  assert.equal(r.resolved, 3);                 // 1, 2, 24
  assert.equal(r.severalCrs, 1);
  assert.equal(r.unresolved, 2);
  assert.deepEqual(r.unresolvedTop, [
    { stanox: '20', name: 'ZED STATION', crs: 'ZZZ', rows: 20 },
    { stanox: '21', name: 'WHY STATION', crs: 'YYY', rows: 2 }
  ]);
  assert.equal(r.resolvedPct, 60);
  assert.equal(r.rowsWithStanox, 49);
  assert.equal(r.rowsAtResolvedStations, 19);

  const v = judgeStationResolution(r);
  assert.equal(v.status, 'FAIL');
  assert.match(v.message, /^7 SMART timing points \(STANOX\): 5 are stations \(have a CRS in CORPUS\), 3 of those \(60\.0%\) have coordinates in the station table; unresolved: 2\. 1 STANOX is not in CORPUS at all\.$/);
});

test('RESOLUTION: the unresolved list is capped at the top N by rows', () => {
  const stanoxInfo = new Map([['20', { rows: 5, name: 'A' }], ['21', { rows: 9, name: 'B' }], ['22', { rows: 7, name: 'C' }], ['23', { rows: 9, name: 'D' }]]);
  const r = analyseStationResolution({ stanoxInfo, corpus: CORPUS, stations: STATIONS, topN: 3 });
  assert.deepEqual(r.unresolvedTop.map(u => u.stanox), ['21', '23', '22'], 'by rows, ties by STANOX');
  assert.equal(r.unresolved, 4);
});

test('RESOLUTION thresholds: PASS >= 90%, WARN 75-90%, FAIL below, decided on exact counts', () => {
  const mk = (resolved, total) => ({ stanoxes: total, stationStanoxes: total, resolved, unresolved: total - resolved, notInCorpus: 0 });
  assert.equal(judgeStationResolution(mk(90, 100)).status, 'PASS');
  assert.equal(judgeStationResolution(mk(89, 100)).status, 'WARN');
  assert.equal(judgeStationResolution(mk(75, 100)).status, 'WARN');
  assert.equal(judgeStationResolution(mk(74, 100)).status, 'FAIL');
  assert.equal(judgeStationResolution(mk(8996, 10000)).status, 'WARN', '89.96% prints as 90.0 but is below 90');
  assert.equal(judgeStationResolution(mk(10, 10)).status, 'PASS');
  const none = judgeStationResolution({ stanoxes: 12, stationStanoxes: 0, resolved: 0, unresolved: 0, notInCorpus: 12 });
  assert.equal(none.status, 'FAIL');
  assert.match(none.message, /None of the 12 SMART timing points/);
});

test('RESOLUTION: when the verdict is poor and the two files write STANOX at different widths, the message says so', () => {
  const poor = { stanoxes: 100, stationStanoxes: 100, resolved: 10, unresolved: 90, notInCorpus: 0 };
  const ctx = { smartStanoxLengths: { 5: 990, 0: 10 }, corpusStanoxLengths: { 6: 800, 5: 3 } };
  const v = judgeStationResolution(poor, ctx);
  assert.equal(v.status, 'FAIL');
  assert.match(v.message, / SMART STANOX are mostly 5 characters long but CORPUS's are 6: the two files may format the code differently\.$/);
  // a blank width (0) is never "the" width; equal widths say nothing; a PASS says nothing
  assert.ok(!/format the code/.test(judgeStationResolution(poor, { smartStanoxLengths: { 5: 9 }, corpusStanoxLengths: { 5: 9, 0: 99 } }).message));
  assert.ok(!/format the code/.test(judgeStationResolution({ ...poor, resolved: 100, unresolved: 0 }, ctx).message));
  assert.ok(!/format the code/.test(judgeStationResolution(poor).message), 'no context given');
  const none = judgeStationResolution({ stanoxes: 5, stationStanoxes: 0, resolved: 0, unresolved: 0, notInCorpus: 5 }, ctx);
  assert.match(none.message, /None of the 5 SMART timing points.*SMART STANOX are mostly 5 characters long but CORPUS's are 6/);
});

// ---- ANCHORS ----------------------------------------------------------------------------------------

// Rows, and what each must do (CRS per STANOX is in CORPUS above: 1 PLD, 2 SWK, 3 EDB, 4 HOV, 5 QQQ (not
// in the station table), 6 a junction, 7 two CRS AAA+BBB):
//   an arrival anchors its TO berth and hints its FROM; a departure anchors FROM and hints TO.
const ANCHOR_ROWS = [
  row('LA', '1', 'A', '0006', '0004'),     // anchor 0004@PLD, hint 0006@PLD
  row('LA', '1', 'B', '0004', '0002'),     // anchor 0004@PLD again (n=2), hint 0002@PLD
  row('LA', '2', 'A', '0010', '0008'),     // anchor 0008@SWK, hint 0010@SWK
  row('LA', '3', 'A', '0098', '0100'),     // anchor 0100@EDB (a bogus claim from far away), hint 0098@EDB
  row('LA', '1', 'A', '0099', '0100'),     // anchor 0100@PLD: 0100 is now a conflict, PLD vs EDB (~600 km)
  row('LA', '1', 'A', '0198', '0200'),     // anchor 0200@PLD, hint 0198@PLD
  row('LA', '4', 'B', '0200', '0202'),     // anchor 0200@HOV: a conflict PLD vs HOV (~2.4 km), not suspicious
  row('LA', '2', 'D', '0006', '0004'),     // anchor 0006@SWK (so 0006 stops being a hint); hint 0004@SWK dropped, 0004 is anchored
  row('LA', '6', 'A', '0300', '0302'),     // a junction: counted, anchors nothing
  row('LA', '5', 'A', '0500', '0502'),     // a station the table cannot place: counted, anchors nothing
  row('LA', '1', 'X', '0001', '0002'),     // not a timing event
  row('SX', '2', 'A', 'S1', 'S2'),         // another area: anchor S2@SWK, hint S1@SWK
  row('LA', '', 'A', '0600', '0602'),      // no STANOX
  row('LA', '1', 'A', '', '0400'),         // an interpose-like arrival with no FROM: anchors 0400, hints nothing
  row('LA', '7', 'A', '0700', '0702')      // STANOX with two CRS: both claim 0702 (and hint 0700)
];

test('ANCHORS: planted table, hints, conflicts, winners and row accounting', () => {
  const a = analyseAnchors(ANCHOR_ROWS, { crsForStanox: CORPUS.crsForStanox, stations: STATIONS });
  const key = e => `${e.td}/${e.berth}`;

  assert.deepEqual(a.table.map(e => `${key(e)}@${e.crs}`), [
    'LA/0004@PLD', 'LA/0006@SWK', 'LA/0008@SWK', 'LA/0100@EDB', 'LA/0200@HOV', 'LA/0400@PLD', 'LA/0702@AAA', 'SX/S2@SWK'
  ]);
  assert.equal(a.table[0].n, 2, '0004 was claimed twice by PLD');
  assert.deepEqual(a.table[0].lat, STATIONS.get('PLD').lat);

  // 0006 is anchored at SWK, so it is not also a hint; 0004 likewise.
  assert.deepEqual(a.hintTable.map(e => `${key(e)}@${e.crs}`), [
    'LA/0002@PLD', 'LA/0010@SWK', 'LA/0098@EDB', 'LA/0099@PLD', 'LA/0198@PLD', 'LA/0202@HOV', 'LA/0700@AAA', 'SX/S1@SWK'
  ]);

  assert.deepEqual(a.totals, { anchors: 8, hints: 8, conflicts: 3, suspicious: 1, areas: 2, suspiciousKm: 5 });
  assert.deepEqual(a.perArea, {
    LA: { anchors: 7, hints: 7, conflicts: 3, suspicious: 1 },
    SX: { anchors: 1, hints: 1, conflicts: 0, suspicious: 0 }
  });
  assert.deepEqual(a.rowCounts, { anchoring: 11, atNonStation: 1, atUnplaceableStation: 1, notTimingEvent: 1, missingAreaOrStanox: 1 });
  assert.equal(Object.values(a.rowCounts).reduce((x, y) => x + y, 0), ANCHOR_ROWS.length, 'every row is accounted for exactly once');

  // the >5 km conflict, with the real distance between its claimants
  const far = haversineKm(STATIONS.get('EDB'), STATIONS.get('PLD'));
  assert.ok(far > 500);
  assert.equal(a.suspiciousTop.length, 1);
  assert.deepEqual(a.suspiciousTop[0], {
    td: 'LA', berth: '0100', maxKm: Math.round(far * 100) / 100,
    claimants: [{ crs: 'EDB', name: 'Edinburgh', n: 1 }, { crs: 'PLD', name: 'Portslade', n: 1 }]
  });
  const e0100 = a.table.find(e => e.berth === '0100');
  assert.equal(e0100.suspicious, true);
  assert.deepEqual(e0100.claims, { EDB: 1, PLD: 1 });

  // the near conflict is a conflict but is not suspicious, and the tie goes to the first CRS alphabetically
  const near = a.table.find(e => e.berth === '0200');
  assert.equal(near.crs, 'HOV');
  assert.equal(near.suspicious, undefined);
  assert.equal(near.maxKm, Math.round(haversineKm(STATIONS.get('PLD'), STATIONS.get('HOV')) * 100) / 100);
  assert.ok(near.maxKm > 2 && near.maxKm < 3);
  assert.equal(a.conflictsNearest.length, 2);

  // an unconflicted anchor carries no conflict fields
  assert.equal(a.table[0].claims, undefined);
  assert.equal(a.table[0].maxKm, undefined);

  assert.match(describeAnchors(a), /^8 berths in 2 TD areas are anchored at a station; 8 more are only next to a station step \(hints\); 3 are claimed by more than one station, 1 of those more than 5 km apart \(suspicious\)\.$/);
});

test('ANCHORS: the suspicious threshold is a parameter, and "more than" means strictly more', () => {
  // The three conflicts are ~602 km (0100), ~2.4 km (0200) and ~1.1 km (0702) apart.
  const lenient = analyseAnchors(ANCHOR_ROWS, { crsForStanox: CORPUS.crsForStanox, stations: STATIONS, suspiciousKm: 1 });
  assert.equal(lenient.totals.suspicious, 3, 'with a 1 km limit all three are suspicious');
  const strict = analyseAnchors(ANCHOR_ROWS, { crsForStanox: CORPUS.crsForStanox, stations: STATIONS, suspiciousKm: 1000 });
  assert.equal(strict.totals.suspicious, 0, 'with a 1000 km limit none is');
  const limit = haversineKm(STATIONS.get('PLD'), STATIONS.get('HOV'));
  const exactly = analyseAnchors(ANCHOR_ROWS, { crsForStanox: CORPUS.crsForStanox, stations: STATIONS, suspiciousKm: limit });
  assert.equal(exactly.table.find(e => e.berth === '0200').suspicious, undefined, 'a conflict at exactly the limit is not suspicious');
});

test('ANCHORS: a berth only ever hinted stays a hint; a berth anchored anywhere is not', () => {
  const a = analyseAnchors([
    row('LA', '1', 'A', 'H1', 'P1'),          // hint H1, anchor P1
    row('LA', '2', 'B', 'H1', 'X9')           // anchor H1 @SWK: H1 stops being a hint
  ], { crsForStanox: CORPUS.crsForStanox, stations: STATIONS });
  assert.deepEqual(a.table.map(e => e.berth), ['H1', 'P1']);
  assert.deepEqual(a.hintTable.map(e => e.berth), ['X9']);
});

test('ANCHORS: no rows at stations gives empty tables, not an error', () => {
  const a = analyseAnchors([row('LA', '6', 'A', '1', '2')], { crsForStanox: CORPUS.crsForStanox, stations: STATIONS });
  assert.deepEqual(a.table, []);
  assert.equal(a.totals.anchors, 0);
  assert.match(describeAnchors(a), /^0 berths in 0 TD areas are anchored at a station; 0 more are only next to a station step \(hints\); 0 are claimed by more than one station\.$/);
});

// ---- SUSSEX -----------------------------------------------------------------------------------------

test('SUSSEX: anchored berths inside the box by area, and which stations in the box have none', () => {
  const a = analyseAnchors(ANCHOR_ROWS, { crsForStanox: CORPUS.crsForStanox, stations: STATIONS });
  const s = analyseSussex(a.table, STATIONS);
  // Winners inside the box: 0004 PLD, 0006 SWK, 0008 SWK, 0200 HOV, 0400 PLD, 0702 AAA (LA: 6) and SX/S2 SWK.
  // 0100's winner is EDB, far outside the box, so it is not counted.
  assert.equal(s.anchored, 7);
  assert.deepEqual(s.byArea, { LA: 6, SX: 1 });
  assert.equal(s.conflicts, 2, '0200 and 0702 are conflicts inside the box; 0100 is outside');
  // In the box: SWK PLD HOV FSG AAA BBB (EDB is not). Anchored winners: PLD SWK HOV AAA. BBB lost its
  // tie and FSG was never mentioned.
  assert.equal(s.stationsInBox, 6);
  assert.equal(s.stationsAnchored, 4);
  assert.deepEqual(s.stationsWithoutAnchor.map(x => x.crs), ['BBB', 'FSG']);
  assert.match(describeSussex(s), /^7 anchored berths at 4 of the 6 stations in the Sussex box, by TD area: LA 6, SX 1\.$/);
});

test('SUSSEX: the box edges are inclusive and a table with nothing inside says so', () => {
  const edge = [{ td: 'LA', berth: '1', crs: 'AAA', lat: 50.72, lon: -0.96, n: 1 }, { td: 'LA', berth: '2', crs: 'BBB', lat: 50.7199, lon: 0, n: 1 }];
  assert.equal(analyseSussex(edge, STATIONS).anchored, 1);
  assert.match(describeSussex(analyseSussex([], STATIONS)), /^0 anchored berths at 0 of the 6 stations in the Sussex box, by TD area: \(none\)\.$/);
});
