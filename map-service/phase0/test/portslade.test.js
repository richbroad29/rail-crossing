'use strict';

// PORTSLADE_KNOWN_ANSWER: the PASS case, each WARN case (berths outside the known chains, no rows and why),
// and the notes that print every row.

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
  assert.equal(r.southwick.ok, true);

  const v = judgePortslade(r);
  assert.equal(v.status, 'PASS');
  assert.equal(v.message, 'Portslade (PLD) has 3 SMART rows in LA, and every berth they mention is on the known chains (0001, 0002, 0003, 0004, 0006). Southwick (SWK) anchors berth 0006 as expected.');
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

test('Southwick not at 0006 is reported in the message but does not change a PASS (the rule is about Portslade)', () => {
  const wrong = analysePortslade({ rawKept: GOOD_ROWS, corpus: corpus(), anchorTable: [{ td: 'LA', berth: '0008', crs: 'SWK', lat: 0, lon: 0, n: 1 }] });
  assert.equal(wrong.southwick.ok, false);
  const v = judgePortslade(wrong);
  assert.equal(v.status, 'PASS');
  assert.match(v.message, /Southwick \(SWK\) is NOT anchored at 0006 \(it anchors: 0008\)\.$/);

  const none = judgePortslade(analysePortslade({ rawKept: GOOD_ROWS, corpus: corpus(), anchorTable: [] }));
  assert.match(none.message, /it anchors: nothing in LA\)/);
});

test('Southwick counts as claiming 0006 even when it lost a conflict for it', () => {
  const r = analysePortslade({
    rawKept: GOOD_ROWS, corpus: corpus(),
    anchorTable: [{ td: 'LA', berth: '0006', crs: 'PLD', lat: 0, lon: 0, n: 3, claims: { PLD: 2, SWK: 1 }, maxKm: 1.4 }]
  });
  assert.equal(r.southwick.ok, true);
});

test('the notes print every row of every station, marking berths off the known chains', () => {
  const rows = [...GOOD_ROWS, kept('LA', '87101', 'D', '0102', '0002', { STANME: 'PORTSLADE', COMMENT: 'a {comment}', STEPTYPE: 'D', FROMLINE: '1', TOLINE: '2' })];
  const text = describePortslade(analysePortslade({ rawKept: rows, corpus: corpus(), anchorTable: SWK_ANCHORS })).join('\n');
  assert.match(text, /^Portslade known answer \(area LA\).*east 0016 > 0014.*west T682 > T677/);
  assert.match(text, /PLD Portslade: STANOX 87101; 4 rows in LA; berths: 0001, 0002, 0003, 0004, 0006, 0102; outside the chains: 0102/);
  assert.match(text, /PLD {2}0006 > 0004 {2}A \(arrive up\) {2}offset -10s {2}platform 1 /);
  assert.match(text, /PLD {2}0102\? > 0002 {2}D \(depart down\).*line 1>2 {2}steptype D.*comment "a \{comment\}"/);
  assert.match(text, /FSG Fishersgate: STANOX 87103; 0 rows in LA; berths: -/);
  assert.match(text, /Southwick: expected berth 0006; SWK claims in LA: 0006 - as expected/);
});

test('the known chains are exactly the ones this project verified', () => {
  assert.deepEqual([...KNOWN_BERTHS].sort(), ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0010', '0012', '0014', '0016', 'T677', 'T682']);
});
