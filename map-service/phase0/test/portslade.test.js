'use strict';

// PORTSLADE_KNOWN_ANSWER: the PASS case, each WARN case (berths outside the known chains, no rows and why),
// Southwick as an independent test of the reading, and the notes that print every row.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analysePortslade, judgePortslade, describePortslade, KNOWN_BERTHS } = require('../lib/portslade');
const { smartRow } = require('./smart-check-helpers');

// SMART row as readSmart keeps it for area LA: { compact, raw }.
function kept(td, stanox, event, from, to, rawExtra = {}) {
  return {
    compact: { td, stanox, event, from, to },
    raw: smartRow({ TD: td, STANOX: stanox, EVENT: event, FROMBERTH: from, TOBERTH: to, ...rawExtra })
  };
}

// CORPUS: PLD is STANOX 87101, SWK 87102, FSG 87103, AGT 87104, HOV 87105, SSE 87106.
const STANOX = { PLD: ['87101'], SWK: ['87102'], FSG: ['87103'], AGT: ['87104'], HOV: ['87105'], SSE: ['87106'] };
const corpus = (over = {}) => ({ stanoxesForCrs: crs => ({ ...STANOX, ...over })[crs] || [] });
const SWK_ANCHORS = [{ td: 'LA', berth: '0006', crs: 'SWK', lat: 50.83, lon: -0.24, n: 2 }];

const GOOD_ROWS = [
  kept('LA', '87101', 'A', '0006', '0004', { PLATFORM: '1', BERTHOFFSET: '-10', STANME: 'PORTSLADE' }),
  kept('LA', '87101', 'B', '0004', '0002', { PLATFORM: '1', BERTHOFFSET: '5', STANME: 'PORTSLADE' }),
  kept('LA', '87101', 'C', '0001', '0003', { STANME: 'PORTSLADE' }),
  kept('LA', '87102', 'A', '0008', '0006', { STANME: 'SOUTHWICK' }),
  kept('LA', '87106', 'A', '0098', '0096', { STANME: 'SHOREHAM' })                      // other stations may use any berth
];

test('PASS: Portslade has rows in LA, every berth is on the known chains, Southwick is at 0006', () => {
  const r = analysePortslade({ rawKept: GOOD_ROWS, corpus: corpus(), anchorTable: SWK_ANCHORS });
  assert.equal(r.stations.PLD.rows, 3);
  assert.deepEqual(r.stations.PLD.berths, ['0001', '0002', '0003', '0004', '0006']);
  assert.deepEqual(r.stations.PLD.unexpected, []);
  assert.equal(r.stations.SWK.rows, 1);
  assert.equal(r.stations.SSE.rows, 1);
  assert.equal(r.stations.FSG.rows, 0);
  assert.equal(r.southwick.outcome, 'confirmed');

  const v = judgePortslade(r);
  assert.equal(v.status, 'PASS');
  assert.equal(v.message, 'Portslade (PLD) has 3 SMART rows in LA, and every berth they mention is on the known chains (0001, 0002, 0003, 0004, 0006). Southwick (SWK) arrives into berth 0006 as expected.');
});

test('WARN: Portslade mentions a berth outside the known chains, and the message names it', () => {
  const rows = [...GOOD_ROWS, kept('LA', '87101', 'D', '0102', '0104', { STANME: 'PORTSLADE' })];
  const r = analysePortslade({ rawKept: rows, corpus: corpus(), anchorTable: SWK_ANCHORS });
  assert.deepEqual(r.stations.PLD.unexpected, ['0102', '0104']);
  const v = judgePortslade(r);
  assert.equal(v.status, 'WARN');
  assert.match(v.message, /^Portslade \(PLD\) has 4 SMART rows in LA, but they mention berths outside the known chains: 0102, 0104 \(all its berths: 0001, 0002, 0003, 0004, 0006, 0102, 0104\)\./);
});

test('WARN: CORPUS gives PLD no STANOX; SMART rows named PORTSLADE are pointed out when there are some', () => {
  const r = analysePortslade({ rawKept: GOOD_ROWS, corpus: corpus({ PLD: [] }), anchorTable: SWK_ANCHORS });
  const v = judgePortslade(r);
  assert.equal(v.status, 'WARN');
  assert.match(v.message, /^No SMART rows in area LA for Portslade \(PLD\): CORPUS gives PLD no STANOX; rows in LA with a station name like PORTSLADE do exist under STANOX 87101 \(3\)\./);

  // ... and with no such rows either, it says only what is true.
  const bare = judgePortslade(analysePortslade({ rawKept: GOOD_ROWS.filter(x => x.compact.stanox !== '87101'), corpus: corpus({ PLD: [] }), anchorTable: SWK_ANCHORS }));
  assert.equal(bare.status, 'WARN');
  assert.match(bare.message, /^No SMART rows in area LA for Portslade \(PLD\): CORPUS gives PLD no STANOX\. Southwick/);
});

test('WARN: no rows for PLD because SMART has none under CORPUS\'s STANOX in LA, and rows in another area do not count', () => {
  // PLD's STANOX has a row, but in area SX: it must be ignored even though it is handed in with the LA rows.
  const rows = [kept('SX', '87101', 'A', '0006', '0004', { STANME: 'PORTSLADE' }), kept('LA', '87102', 'A', '0008', '0006')];
  const r = analysePortslade({ rawKept: rows, corpus: corpus(), anchorTable: SWK_ANCHORS });
  assert.equal(r.stations.PLD.rows, 0);
  const v = judgePortslade(r);
  assert.equal(v.status, 'WARN');
  assert.match(v.message, /CORPUS gives PLD STANOX 87101 but SMART has no rows for it in area LA\./);
  assert.deepEqual(r.stations.PLD.nameMatches, []);
});

test('WARN: a STANOX mismatch is told apart from "no rows" by the station name in SMART', () => {
  // CORPUS says PLD is 87101, but SMART's Portslade rows are under STANOX 99999.
  const rows = [
    kept('LA', '99999', 'A', '0006', '0004', { STANME: 'PORTSLADE' }),
    kept('LA', '99999', 'B', '0004', '0002', { STANME: 'Portslade Jn' }),
    kept('LA', '87102', 'A', '0008', '0006', { STANME: 'SOUTHWICK' })
  ];
  const r = analysePortslade({ rawKept: rows, corpus: corpus(), anchorTable: SWK_ANCHORS });
  assert.deepEqual(r.stations.PLD.nameMatches, [{ stanox: '99999', rows: 2 }]);
  const v = judgePortslade(r);
  assert.equal(v.status, 'WARN');
  assert.match(v.message, /rows in LA with a station name like PORTSLADE do exist under STANOX 99999 \(2\)/);
});

// ---- Southwick: the independent test of the reading ----------------------------------------------------
//
// Southwick sits inside LA berth 0006. Under our reading an arrival is at its TOBERTH, so: WARN if Southwick
// has arrival rows (A or C) in LA and none ends at 0006; say so plainly, without changing the status, if it
// has no LA rows at all (or no arrival rows). Up and down are never mapped to east and west.

// A Portslade row that passes the Portslade half of the verdict, so the Southwick half shows on its own.
const PLD_OK = [kept('LA', '87101', 'A', '0006', '0004', { STANME: 'PORTSLADE' })];
const PLD_FINE = 'Portslade (PLD) has 1 SMART rows in LA, and every berth they mention is on the known chains (0004, 0006).';
const swkRows = triples => triples.map(([event, from, to]) => kept('LA', '87102', event, from, to, { STANME: 'SOUTHWICK' }));
function judgeWith(swk, { corpusOver, extra = [], anchorTable = [] } = {}) {
  const r = analysePortslade({ rawKept: [...PLD_OK, ...extra, ...swk], corpus: corpus(corpusOver), anchorTable });
  return { r, v: judgePortslade(r) };
}

test('Southwick CASE 1, anchors 0006: confirmed, and the status stays PASS', () => {
  const { r, v } = judgeWith(swkRows([['A', '0008', '0006'], ['B', '0006', '0004']]));
  assert.equal(r.southwick.outcome, 'confirmed');
  assert.deepEqual(r.southwick.arrivalTo, ['0006']);
  assert.deepEqual(r.southwick.departureFrom, ['0006']);
  assert.equal(v.status, 'PASS');
  assert.equal(v.message, `${PLD_FINE} Southwick (SWK) arrives into berth 0006 as expected.`);

  // a confirmed Southwick does not rescue a Portslade WARN
  const bad = judgeWith(swkRows([['A', '0008', '0006']]), { extra: [kept('LA', '87101', 'B', '0102', '0104', { STANME: 'PORTSLADE' })] });
  assert.equal(bad.v.status, 'WARN');
  assert.match(bad.v.message, /outside the known chains: 0102, 0104.*Southwick \(SWK\) arrives into berth 0006 as expected\.$/);
});

test('Southwick CASE 2, anchors elsewhere: WARN, naming the berths it does use, though Portslade alone is fine', () => {
  // Arrivals end at 0008 (A) and 0002 (C). A departure does leave from 0006, but that does not rescue the arrivals.
  const { r, v } = judgeWith(swkRows([['A', '0010', '0008'], ['C', '0004', '0002'], ['B', '0006', '0004']]));
  assert.equal(r.southwick.outcome, 'contradicted');
  assert.deepEqual(r.southwick.arrivalTo, ['0002', '0008']);
  assert.deepEqual(r.southwick.departureFrom, ['0006']);
  assert.equal(r.southwick.arrivalRows, 2);
  assert.equal(r.southwick.departureRows, 1);
  assert.equal(v.status, 'WARN');
  assert.equal(v.message, `${PLD_FINE} Southwick (SWK) is known to sit in berth 0006, but none of its 2 arrival rows in LA ends there (arrivals end at 0002, 0008; departures leave from 0006).`);
});

test('Southwick CASE 3, absent: no LA rows at all leaves the status as it was, and the message says so plainly', () => {
  const { r, v } = judgeWith([]);
  assert.equal(r.southwick.outcome, 'absent');
  assert.equal(r.southwick.rows, 0);
  assert.equal(v.status, 'PASS', 'Portslade is fine and Southwick has nothing to contradict');
  assert.equal(v.message, `${PLD_FINE} Southwick (SWK) has no SMART rows in area LA, so berth 0006 could not be checked (it may simply have none).`);

  // a Portslade WARN stays a WARN, with the Southwick sentence beside it
  const bad = judgeWith([], { extra: [kept('LA', '87101', 'B', '0102', '0104', { STANME: 'PORTSLADE' })] });
  assert.equal(bad.v.status, 'WARN');
  assert.match(bad.v.message, /outside the known chains: 0102, 0104.*Southwick \(SWK\) has no SMART rows in area LA/);
});

test('Southwick absent: rows in another area do not count, and the two ways of "no rows" are told apart', () => {
  const elsewhere = judgeWith([kept('SX', '87102', 'A', '0008', '0006', { STANME: 'SOUTHWICK' })]);
  assert.equal(elsewhere.r.southwick.outcome, 'absent');
  assert.equal(elsewhere.v.status, 'PASS');

  const noStanox = judgeWith([], { corpusOver: { SWK: [] } });
  assert.equal(noStanox.r.southwick.outcome, 'absent');
  assert.equal(noStanox.v.status, 'PASS');
  assert.match(noStanox.v.message, /Southwick \(SWK\) could not be checked against berth 0006: CORPUS gives SWK no STANOX, so no SMART rows could be found for it\.$/);

  // CORPUS and SMART disagree about Southwick's STANOX: the rows named SOUTHWICK are pointed out
  const mismatch = judgeWith([kept('LA', '99999', 'A', '0008', '0006', { STANME: 'SOUTHWICK' }), kept('LA', '99999', 'B', '0006', '0004', { STANME: 'Southwick Jn' })]);
  assert.equal(mismatch.r.southwick.outcome, 'absent');
  assert.deepEqual(mismatch.r.southwick.nameMatches, [{ stanox: '99999', rows: 2 }]);
  assert.equal(mismatch.v.status, 'PASS', 'still unchanged: the rows are under a STANOX CORPUS does not give Southwick');
  assert.match(mismatch.v.message, /\(it may simply have none\)\. Rows in LA with a station name like SOUTHWICK do exist under STANOX 99999 \(2\)\.$/);
});

test('Southwick: direction is not assumed to mean east or west, so an arrival counts whichever of A and C it is', () => {
  const onlyDown = judgeWith(swkRows([['A', '0010', '0008'], ['C', '0008', '0006']]));
  assert.equal(onlyDown.r.southwick.outcome, 'confirmed', 'the down arrival (C) ends at 0006, the up one does not');
  assert.equal(onlyDown.v.status, 'PASS');
  const onlyUp = judgeWith(swkRows([['A', '0008', '0006'], ['C', '0004', '0002']]));
  assert.equal(onlyUp.r.southwick.outcome, 'confirmed', 'the up arrival (A) ends at 0006, the down one does not');
  assert.equal(onlyUp.v.status, 'PASS');
  const neither = judgeWith(swkRows([['A', '0010', '0008'], ['C', '0004', '0002']]));
  assert.equal(neither.r.southwick.outcome, 'contradicted');
  assert.equal(neither.v.status, 'WARN');
  assert.match(neither.v.message, /none of its 2 arrival rows in LA ends there \(arrivals end at 0002, 0008\)\.$/);
});

test('Southwick: rows that are not arrivals cannot confirm or contradict it', () => {
  // only departures: the arrival test cannot be made; the status is unchanged
  const departures = judgeWith(swkRows([['B', '0006', '0004'], ['D', '0007', '']]));
  assert.equal(departures.r.southwick.outcome, 'no-arrivals');
  assert.equal(departures.r.southwick.arrivalRows, 0);
  assert.equal(departures.v.status, 'PASS');
  assert.equal(departures.v.message, `${PLD_FINE} Southwick (SWK) has 2 SMART rows in LA but no arrival rows (EVENT A or C), so the arrival check against berth 0006 could not be made (its departures leave from 0006, 0007).`);
  // a row whose EVENT is neither an arrival nor a departure: also no arrivals
  const odd = judgeWith(swkRows([['X', '0008', '0006']]));
  assert.equal(odd.r.southwick.outcome, 'no-arrivals');
  assert.equal(odd.v.status, 'PASS');
  assert.match(odd.v.message, /Southwick \(SWK\) has 1 SMART row in LA but no arrival rows \(EVENT A or C\), so the arrival check against berth 0006 could not be made\.$/);
});

test('Southwick: one arrival row, and arrivals that name no TOBERTH, read properly', () => {
  const one = judgeWith(swkRows([['A', '0010', '0008']]));
  assert.match(one.v.message, /but its only arrival row in LA does not end there \(arrivals end at 0008\)\.$/);
  const blank = judgeWith(swkRows([['A', '0010', ''], ['C', '0004', '']]));
  assert.equal(blank.r.southwick.outcome, 'contradicted');
  assert.deepEqual(blank.r.southwick.arrivalTo, []);
  assert.match(blank.v.message, /none of its 2 arrival rows in LA ends there \(its arrivals name no TOBERTH\)\.$/);
});

test('Southwick: the answer comes from its own rows, not from the anchor table', () => {
  const rows = swkRows([['A', '0008', '0006']]);
  // a table that says Southwick anchors something else (or nothing) cannot change a confirmed result ...
  assert.equal(judgeWith(rows, { anchorTable: [] }).r.southwick.outcome, 'confirmed');
  assert.equal(judgeWith(rows, { anchorTable: [{ td: 'LA', berth: '0008', crs: 'SWK', lat: 0, lon: 0, n: 1 }] }).r.southwick.outcome, 'confirmed');
  // ... and a table that says Southwick anchors 0006 cannot rescue a contradicted one
  const wrong = judgeWith(swkRows([['A', '0010', '0008']]), { anchorTable: [{ td: 'LA', berth: '0006', crs: 'SWK', lat: 0, lon: 0, n: 1 }] });
  assert.equal(wrong.r.southwick.outcome, 'contradicted');
  assert.equal(wrong.v.status, 'WARN');
  // the table's own view is still reported, including a berth Southwick lost a conflict for
  const lost = judgeWith(rows, { anchorTable: [{ td: 'LA', berth: '0006', crs: 'PLD', lat: 0, lon: 0, n: 3, claims: { PLD: 2, SWK: 1 }, maxKm: 1.4 }] });
  assert.deepEqual(lost.r.southwick.claimedBerths, ['0006']);
});

test('the notes print every row of every station, marking berths off the known chains', () => {
  const rows = [...GOOD_ROWS, kept('LA', '87101', 'D', '0102', '0002', { STANME: 'PORTSLADE', COMMENT: 'a {comment}', STEPTYPE: 'D', FROMLINE: '1', TOLINE: '2' })];
  const text = describePortslade(analysePortslade({ rawKept: rows, corpus: corpus(), anchorTable: SWK_ANCHORS })).join('\n');
  assert.match(text, /^Portslade known answer \(area LA\).*east 0016 > 0014.*west T682 > T677/);
  assert.match(text, /PLD Portslade: STANOX 87101; 4 rows in LA; berths: 0001, 0002, 0003, 0004, 0006, 0102; outside the chains: 0102/);
  assert.match(text, /PLD {2}0006 > 0004 {2}A \(arrive up\) {2}offset -10s {2}platform 1 /);
  assert.match(text, /PLD {2}0102\? > 0002 {2}D \(depart down\).*line 1>2 {2}steptype D.*comment "a \{comment\}"/);
  assert.match(text, /FSG Fishersgate: STANOX 87103; 0 rows in LA; berths: -/);
  assert.match(text, /Southwick: expected berth 0006\. Rows in LA: 1 \(1 arrival, 0 departure\); arrivals end at 0006; departures leave from -\. Result: CONFIRMED \(an arrival row ends at 0006\)\./);
  assert.match(text, /Southwick in the anchor table: SWK claims LA berths 0006\./);
});

test('the notes say which way the Southwick test went, in each outcome', () => {
  const notes = swk => describePortslade(analysePortslade({ rawKept: [...PLD_OK, ...swk], corpus: corpus(), anchorTable: [] })).join('\n');
  assert.match(notes(swkRows([['A', '0010', '0008'], ['B', '0006', '0004']])),
    /Southwick: expected berth 0006\. Rows in LA: 2 \(1 arrival, 1 departure\); arrivals end at 0008; departures leave from 0006\. Result: CONTRADICTED \(arrival rows exist and none ends at 0006\)\./);
  assert.match(notes(swkRows([['B', '0006', '0004']])), /Result: not testable \(no arrival rows\)\./);
  assert.match(notes([]), /Rows in LA: 0 \(0 arrival, 0 departure\); arrivals end at -; departures leave from -\. Result: not testable \(no SMART rows for Southwick in LA\)\./);
});

test('the known chains are exactly the ones this project verified', () => {
  assert.deepEqual([...KNOWN_BERTHS].sort(), ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0010', '0012', '0014', '0016', 'T677', 'T682']);
});
