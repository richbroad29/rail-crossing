'use strict';

// Placement: the berth graph, SMART anchors under the arrival=TOBERTH / departure=FROMBERTH reading,
// interpolation, learned-edge rules, persistence, and the reference loaders it stands on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BerthGraph } = require('../src/berth-graph');
const R = require('../src/reference');
const { FIX, REAL, haveReal, smartRows, LINE, tmpDir, rmrf, gzFile } = require('./helpers');
const { haversineKm } = require('../src/geo');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

// A chain 0001 -> 0002 -> 0003 -> 0004 -> 0005 -> 0006, Alpha at 0001, Bravo at 0005.
function chain() {
  const g = new BerthGraph();
  g.loadSmart(smartRows([
    ['LA', '0000', '0001', '111', 'A'],        // arrival at Alpha: the station is at TOBERTH 0001; 0000 is only a hint
    ['LA', '0001', '0002', '', 'X'], ['LA', '0002', '0003', '', 'X'], ['LA', '0003', '0004', '', 'X'],
    ['LA', '0004', '0005', '222', 'A'],        // arrival at Bravo: TOBERTH 0005
    ['LA', '0005', '0006', '', 'X']
  ]), LINE.resolve);
  return g;
}
const pos = (g, a, b) => g.position(g.lookup(a, b));

test('an ARRIVAL anchors the step\'s TOBERTH and only hints at its FROMBERTH', () => {
  const g = chain();
  const at = pos(g, 'LA', '0001');
  assert.deepEqual([at.pl, at.lat, at.lon, at.station], ['s', 51.0, -1.0, 'Alpha']);
  const hint = pos(g, 'LA', '0000');
  assert.equal(hint.pl, 'a', 'next to a station, not at it');
  assert.equal(hint.lat, 51.0);
});

test('a DEPARTURE anchors the step\'s FROMBERTH and only hints at its TOBERTH', () => {
  const g = new BerthGraph();
  g.loadSmart(smartRows([['LA', '0010', '0011', '222', 'B']]), LINE.resolve);
  assert.equal(pos(g, 'LA', '0010').pl, 's');
  assert.equal(pos(g, 'LA', '0010').station, 'Bravo');
  assert.equal(pos(g, 'LA', '0011').pl, 'a');
  // Direction letters C / D read the same way as A / B.
  const h = new BerthGraph();
  h.loadSmart(smartRows([['LA', '0010', '0011', '111', 'C'], ['LA', '0020', '0021', '222', 'D']]), LINE.resolve);
  assert.equal(pos(h, 'LA', '0011').pl, 's');
  assert.equal(pos(h, 'LA', '0020').pl, 's');
});

test('unanchored berths sit between the nearest anchors, in proportion to hop counts', () => {
  const g = chain();
  const mid = pos(g, 'LA', '0003');           // 2 hops from Alpha, 2 from Bravo
  assert.equal(mid.pl, 'i');
  assert.deepEqual(mid.between, ['Alpha', 'Bravo']);
  near(mid.lat, 51.0); near(mid.lon, -0.8);
  const q = pos(g, 'LA', '0002');             // 1 hop from Alpha, 3 from Bravo: a quarter of the way
  near(q.lon, -0.9);
  const q3 = pos(g, 'LA', '0004');            // 3 hops from Alpha, 1 from Bravo
  near(q3.lon, -0.7);
});

test('one anchor on one side only -> approx, at that station', () => {
  const g = chain();
  const beyond = pos(g, 'LA', '0006');
  assert.equal(beyond.pl, 'a');
  assert.equal(beyond.station, 'Bravo');
});

test('both anchors the SAME station (a loop) is not interpolated', () => {
  const g = new BerthGraph();
  g.loadSmart(smartRows([
    ['LA', '0000', '0001', '111', 'A'], ['LA', '0001', '0002', '', 'X'], ['LA', '0002', '0003', '', 'X'], ['LA', '0003', '0004', '111', 'A']
  ]), LINE.resolve);
  const p = pos(g, 'LA', '0002');
  assert.equal(p.pl, 'a');
  assert.equal(p.station, 'Alpha');
});

test('an unknown berth is unplaceable (null), never guessed', () => {
  const g = chain();
  assert.equal(g.position(g.keyId('LA', '9999')), null);
  assert.equal(g.position(-1), null);
});

test('a berth claimed by two stations goes to the one named most often (not averaged)', () => {
  const g = new BerthGraph();
  g.loadSmart(smartRows([
    ['LA', '0000', '0001', '111', 'A'], ['LA', '0000', '0001', '111', 'A'], ['LA', '0000', '0001', '222', 'A']
  ]), LINE.resolve);
  const p = pos(g, 'LA', '0001');
  assert.equal(p.station, 'Alpha');
  assert.equal(p.lon, -1.0);
});

test('LEARNED edges are usable only after 2 sightings; SMART edges at once', () => {
  const g = chain();
  const a = g.lookup('LA', '0001'), n = g.keyId('LA', 'NEW1');
  assert.equal(g.observeEdge(a, n), false);
  assert.equal(g.position(n), null, 'seen once: not yet usable, so not placeable');
  assert.equal(g.observeEdge(a, n), true, 'the second sighting makes the edge usable');
  const p = g.position(n);
  assert.equal(p.pl, 'a');
  assert.equal(p.station, 'Alpha');
  // SMART edges needed no sightings.
  assert.equal(pos(g, 'LA', '0003').pl, 'i');
});

test('the graph version moves only when a position could change', () => {
  const g = chain();
  const v = g.version;
  const a = g.lookup('LA', '0001'), n = g.keyId('LA', 'NEW2');
  g.observeEdge(a, n);
  assert.equal(g.version, v, 'a first sighting changes no position');
  g.observeEdge(a, n);
  assert.equal(g.version, v + 1);
});

test('persistence: the learned graph round-trips; SMART edges are rebuilt, not saved', () => {
  const dir = tmpDir();
  try {
    const g = chain();
    const a = g.lookup('LA', '0001'), n = g.keyId('LA', 'NEW3');
    g.observeEdge(a, n); g.observeEdge(a, n); g.observeEdge(a, n);
    const file = path.join(dir, 'state', 'g.json');
    assert.equal(g.saveLearned(file), true);
    assert.equal(fs.existsSync(file + '.tmp'), false, 'atomic: no temp file left');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(doc.edges, [['LA:0001', 'LA:NEW3', 3]]);
    assert.equal(g.saveLearned(file), false, 'nothing changed: nothing written');

    const h = new BerthGraph();
    assert.equal(h.loadLearnedFile(file), 1);
    h.loadSmart(smartRows([['LA', '0000', '0001', '111', 'A']]), LINE.resolve);
    const p = h.position(h.lookup('LA', 'NEW3'));
    assert.equal(p.station, 'Alpha');
  } finally { rmrf(dir); }
});

test('persistence: a corrupt, wrong-version or hostile file is refused without throwing', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'g.json');
    const g = new BerthGraph();
    assert.equal(g.loadLearnedFile(path.join(dir, 'missing.json')), 0);
    fs.writeFileSync(f, '{not json');
    assert.equal(g.loadLearnedFile(f), -1);
    fs.writeFileSync(f, JSON.stringify({ version: 99, edges: [] }));
    assert.equal(g.loadLearnedFile(f), 0);
    fs.writeFileSync(f, JSON.stringify({ version: 1, edges: [['LA:0001', 'LA:0002', 2], ['bad', 'LA:0002', 1], [1, 2, 3], ['LA:0001', 'LA:0001', 5], ['LA:0003', 'LA:0004', -1], null, ['LA:' + 'X'.repeat(40), 'LA:0002', 1]] }));
    assert.equal(g.loadLearnedFile(f), 1, 'only the one valid edge');
  } finally { rmrf(dir); }
});

test('a save that cannot be written (full or unwritable disk) returns false and does not throw', () => {
  const dir = tmpDir();
  try {
    const g = chain();
    g.observeEdge(g.lookup('LA', '0001'), g.keyId('LA', 'Q1'));
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'a file where a folder should be');
    assert.equal(g.saveLearned(path.join(blocker, 'x', 'g.json')), false);
    assert.ok(g.lastSaveError);
    assert.equal(g.learnedDirty, true, 'still dirty: it will be retried');
  } finally { rmrf(dir); }
});

test('the berth key table is bounded', () => {
  const g = new BerthGraph({ maxKeys: 5 });
  for (let i = 0; i < 20; i++) g.keyId('LA', String(i));
  assert.equal(g.keyOf.length, 5);
  assert.equal(g.keyId('LA', 'zzzz'), -1);
  assert.ok(g.keyOverflow > 0);
});

test('the edge store is bounded, grows past its first allocation, and drops new edges (counted) rather than failing', () => {
  const g = new BerthGraph({ maxLearnedEdges: 6000 });
  const a = g.keyId('LA', 'HUB');
  let stored = 0;
  for (let i = 0; i < 9000; i++) { const b = g.keyId('LB', 'N' + i); if (g.observeEdge(a, b) !== undefined && g.edgesFrom(a).length > stored) stored = g.edgesFrom(a).length; }
  assert.equal(stored, 6000, 'grew beyond the initial 4096 slots, then stopped at the cap');
  assert.equal(g.edgeOverflow, 3000);
  assert.equal(g.stats().edges, 6000);
  const known = g.lookup('LB', 'N5');
  assert.deepEqual(g.edgesFrom(a)[5], [known, 1, false], 'edges already stored still count sightings');
  assert.equal(g.observeEdge(a, known), true, 'and still become usable');
});

test('reloading SMART replaces its edges and anchors but keeps everything learned live', () => {
  const g = chain();
  const a = g.lookup('LA', '0001'), n = g.keyId('LA', 'LIVE');
  g.observeEdge(a, n); g.observeEdge(a, n);
  assert.equal(pos(g, 'LA', '0003').pl, 'i');
  // A new SMART that no longer has the middle of the chain, and moves Alpha's station key.
  g.loadSmart(smartRows([['LA', '0000', '0001', '111', 'A'], ['LA', '0004', '0005', '222', 'A']]), LINE.resolve);
  assert.equal(pos(g, 'LA', '0003'), null, 'the old SMART edges are gone');
  assert.equal(pos(g, 'LA', 'LIVE').pl, 'a', 'the learned edge survived and is usable');
  assert.equal(g.learnedEdges, 1);
  assert.equal(g.stats().anchored, 2);
});

// ---- reference loaders ----------------------------------------------------------------------------------------

test('cleanName: admin markers stripped, upper case title-cased, mixed case left alone', () => {
  assert.equal(R.cleanName('VICTORIA (C) (TPS INDIC. ONLY)'), 'Victoria');
  assert.equal(R.cleanName('LONDON VICTORIA'), 'London Victoria');
  assert.equal(R.cleanName('STOKE-ON-TRENT'), 'Stoke-On-Trent');
  assert.equal(R.cleanName('Already Mixed'), 'Already Mixed');
  assert.equal(R.cleanName(null), '');
});

test('NaPTAN: only ACTIVE rail stations (RLY, 9100<TIPLOC>), suffix stripped, junk coordinates skipped', async () => {
  const dir = tmpDir();
  try {
    const csv = 'ATCOCode,CommonName,Longitude,Latitude,StopType,Status\n'
      + '9100PSLDAWH,Portslade Rail Station,-0.20533,50.83568,RLY,active\n'
      + '9100ABRCYNN,Abercynon North Rail Station,-3.32,51.64,RLY,inactive\n'
      + '9100BOGUS,Bogus Rail Station,500,500,RLY,active\n'
      + '9100PLAT1,Platform 1,-0.1,50.8,RPL,active\n'
      + '490000001X,A Bus Stop,-0.1,50.8,BCT,active\n'
      + '"9100QUOTED","Quoted, Comma Rail Station",-1.5,52.5,RLY,active\n';
    const f = path.join(dir, 'n.csv');
    fs.writeFileSync(f, csv);
    const n = await R.loadNaptan(f);
    assert.deepEqual([...n.byTiploc.keys()].sort(), ['PSLDAWH', 'QUOTED']);
    assert.equal(n.byTiploc.get('PSLDAWH').name, 'Portslade');
    assert.equal(n.byTiploc.get('QUOTED').name, 'Quoted, Comma');
    assert.equal(n.bad, 1);
    // The same file gzipped reads identically.
    const gz = gzFile(dir, 'n.csv.gz', csv);
    assert.equal((await R.loadNaptan(gz)).byTiploc.size, 2);
    // A file that is not NaPTAN fails with a sentence.
    fs.writeFileSync(f, 'a,b\n1,2\n');
    await assert.rejects(R.loadNaptan(f), /does not look like a NaPTAN/);
  } finally { rmrf(dir); }
});

test('SMART: bad rows skipped and counted, braces inside text do not confuse the scanner', async () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 's.json');
    fs.writeFileSync(f, '{"BERTHDATA":[{"TD":"LA","FROMBERTH":"0001","TOBERTH":"0002","STANOX":"87986","EVENT":"a","COMMENT":"has } and { in it"},'
      + '{"TD":"","FROMBERTH":"0001","TOBERTH":"0002"},{"TD":"LA","FROMBERTH":"","TOBERTH":""},{"TD":"LB","FROMBERTH":"0003","TOBERTH":"0004","STANOX":87,"EVENT":"C"}]}');
    const s = await R.loadSmart(f);
    assert.equal(s.rows, 2);
    assert.equal(s.skipped, 2);
    assert.deepEqual(s.event, ['A', 'C'], 'EVENT upper-cased');
    assert.equal(s.stanox[1], '00087', 'a numeric STANOX gets its leading zeros back');
  } finally { rmrf(dir); }
});

test('STANOX resolver: NaPTAN by TIPLOC first, the CRS table as fallback, deterministic', async () => {
  const corpus = {
    byTiploc: new Map([['AAAXX', { stanox: '10001', crs: 'AAA', name: 'Aaa' }], ['AAAYY', { stanox: '10001', crs: '', name: 'Aaa Yard' }],
      ['NOPE', { stanox: '10002', crs: 'ZZZ', name: 'Zed' }], ['NOWHERE', { stanox: '10003', crs: '', name: 'X' }]]),
    stanoxTiplocs: new Map([['10001', ['AAAYY', 'AAAXX']], ['10002', ['NOPE']], ['10003', ['NOWHERE']]]), crsTiplocs: new Map()
  };
  const naptan = { byTiploc: new Map([['AAAXX', { name: 'Aaa Town', lat: 51.5, lon: -1.5 }], ['AAAYY', { name: 'Wrong', lat: 52, lon: -2 }]]) };
  const stations = { byCrs: new Map([['ZZZ', { name: 'Zed Central', lat: 53.0, lon: -2.5 }]]) };
  const resolve = R.makeStanoxResolver({ corpus, naptan, stations });
  assert.deepEqual([resolve('10001').key, resolve('10001').lat], ['AAAXX', 51.5], 'the TIPLOC that carries a CRS wins, whatever the file order');
  assert.deepEqual([resolve('10002').name, resolve('10002').lat], ['Zed Central', 53.0], 'no NaPTAN row: CRS table');
  assert.equal(resolve('10003'), null);
  assert.equal(resolve('99999'), null);
});

test('the fixture extract places Portslade at LA 0002/0005, Southwick at LA 0006, Fishersgate at 0004, and 0003 between Aldrington and Portslade', async () => {
  const [smart, corpus, naptan] = await Promise.all([R.loadSmart(path.join(FIX, 'smart-fixture.json')), R.loadCorpus(path.join(FIX, 'corpus-fixture.json')), R.loadNaptan(path.join(FIX, 'naptan-fixture.csv'))]);
  const g = new BerthGraph();
  g.loadSmart(smart, R.makeStanoxResolver({ corpus, naptan, stations: null }));
  const pld = pos(g, 'LA', '0002'), pld2 = pos(g, 'LA', '0005'), swk = pos(g, 'LA', '0006');
  assert.deepEqual([pld.pl, pld.station], ['s', 'Portslade']);
  assert.deepEqual([pld2.pl, pld2.station], ['s', 'Portslade']);
  assert.deepEqual([swk.pl, swk.station], ['s', 'Southwick']);
  near(pld.lat, 50.83568251454, 1e-6); near(pld.lon, -0.20533641991, 1e-6);   // NaPTAN 9100PSLDAWH
  near(swk.lat, 50.83251623943, 1e-6); near(swk.lon, -0.23596179586, 1e-6);   // NaPTAN 9100STHWICK
  const fish = pos(g, 'LA', '0004');                                           // SMART: an arrival and a departure at STANOX 87987
  assert.deepEqual([fish.pl, fish.station], ['s', 'Fishersgate']);
  const ald = pos(g, 'LA', '0001');
  assert.equal(ald.station, 'Aldrington');
  const between = pos(g, 'LA', '0003');                                        // 0001 -> 0003 -> 0005: one hop from each side
  assert.equal(between.pl, 'i');
  assert.deepEqual(between.between, ['Aldrington', 'Portslade']);
  near(between.lat, (ald.lat + pld2.lat) / 2, 1e-9);
  near(between.lon, (ald.lon + pld2.lon) / 2, 1e-9);
});

test('REAL SMART/CORPUS/NaPTAN: Portslade and Southwick land in LA as known (skipped without the reference files)', { skip: !haveReal }, async () => {
  const [smart, corpus, naptan] = await Promise.all([
    R.loadSmart(path.join(REAL, 'smart-latest.json.gz')), R.loadCorpus(path.join(REAL, 'corpus-latest.json.gz')), R.loadNaptan(path.join(REAL, 'naptan-rail.csv'))]);
  const stations = R.loadStationsFile(path.join(__dirname, '..', 'data', 'stations.json'));
  const g = new BerthGraph();
  const st = g.loadSmart(smart, R.makeStanoxResolver({ corpus, naptan, stations }));
  assert.ok(smart.rows > 30000 && st.anchored > 7000, `anchored ${st.anchored}`);
  const swk = pos(g, 'LA', '0006');
  assert.equal(swk.pl, 's');
  assert.equal(swk.station, 'Southwick');
  for (const b of ['0002', '0005']) assert.equal(pos(g, 'LA', b).station, 'Portslade');
  assert.deepEqual(pos(g, 'LA', '0003').between, ['Aldrington', 'Portslade']);
  assert.ok(haversineKm(pos(g, 'LA', '0004'), swk) < 3, 'Fishersgate (0004) is within 3 km of Southwick');
});
