'use strict';
// Plain-English descriptions, station ranking/search, label decluttering.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const D = require('../describe.js');
const S = require('../stations.js');
const DC = require('../declutter.js');
const real = require(path.join(__dirname, '../../map-service/data/stations.json')).stations;

test('describePlace in words, for names and for {crs,name} objects', () => {
  assert.equal(D.describePlace({ kind: 'station', station: { crs: 'BTN', name: 'Brighton' } }), 'At Brighton station');
  assert.equal(D.describePlace({ kind: 'station', station: 'HOVE' }), 'At Hove station');
  assert.equal(D.describePlace({ kind: 'between', between: [{ name: 'Hove' }, { name: 'Portslade' }] }), 'Between Hove and Portslade');
  assert.equal(D.describePlace({ kind: 'between', between: ['A', 'B'] }), 'Between A and B');
  assert.equal(D.describePlace({ kind: 'near', station: { name: 'Worthing' } }), 'Near Worthing');
  assert.equal(D.describePlace({ kind: 'between' }), 'Somewhere on the line');
  assert.equal(D.describePlace(null), 'Position unknown');
  assert.equal(D.describePlace({ kind: 'station' }), 'At a station');
});

test('estimate notes explain themselves without jargon, and exact positions have none', () => {
  assert.match(D.estimateNote('i'), /estimated/);
  assert.match(D.estimateNote('a'), /rough/);
  assert.equal(D.estimateNote('s'), null);
  assert.equal(D.estimateNote(undefined), null);
});

test('currentCall finds the stop the train is at or heading for', () => {
  const calls = [{ name: 'Brighton' }, { name: 'HOVE' }, { name: 'Shoreham-By-Sea' }];
  assert.deepEqual(D.currentCall(calls, { kind: 'station', station: { name: 'Hove' } }), { index: 1, here: true });
  assert.deepEqual(D.currentCall(calls, { kind: 'between', between: [{ name: 'Brighton' }, { name: 'Hove' }] }), { index: 1, here: false, from: 0 });
  assert.equal(D.currentCall(calls, { kind: 'station', station: { name: 'Elsewhere' } }), null);
  assert.equal(D.currentCall([], { kind: 'station', station: 'x' }), null);
  assert.equal(D.currentCall(calls, null), null);
});

test('callTime picks the useful time and says what it means', () => {
  assert.deepEqual(D.callTime({ arr: '10:00', dep: '10:02' }), { text: '10:00 / 10:02', label: 'arrives 10:00, leaves 10:02' });
  assert.equal(D.callTime({ dep: '09:30' }).text, '09:30');
  assert.equal(D.callTime({ arr: '11:15' }).text, '11:15');
  const p = D.callTime({ pass: '10:30' });
  assert.equal(p.passing, true);
  assert.match(p.label, /without stopping/);
  assert.equal(D.callTime({}).text, '');
});

test('every named major station exists in the real station data', () => {
  const names = new Set(Object.values(real).map((s) => s.name));
  const missing = S.TIER1.concat(S.TIER2).filter((n) => !names.has(n));
  assert.deepEqual(missing, [], 'misspelt or absent: ' + missing.join(', '));
});

test('tiers: majors first, and tier 1 never has a later name zoom than tier 3', () => {
  assert.equal(S.tierOf({ name: 'London Waterloo' }), 1);
  assert.equal(S.tierOf({ name: 'Haywards Heath' }), 2);
  assert.equal(S.tierOf({ name: 'Southwick' }), 3);
  assert.equal(S.tierOf(null), 3);
  assert.equal(S.tierOf({ name: 'constructor' }), 3);
  assert.ok(S.nameMinZoom({ name: 'Brighton' }) < S.nameMinZoom({ name: 'Hove' }));
  assert.ok(S.nameMinZoom({ name: 'Hove' }) < S.nameMinZoom({ name: 'Southwick' }));
  assert.ok(S.dotMinZoom({ name: 'Brighton' }) <= S.nameMinZoom({ name: 'Brighton' }));
});

const LIST = Object.keys(real).map((crs) => ({ crs, name: real[crs].name, lat: real[crs].lat, lon: real[crs].lon }));
test('station search: CRS, prefix, word start, ranking', () => {
  assert.equal(S.searchStations(LIST, 'btn')[0].name, 'Brighton');
  assert.equal(S.searchStations(LIST, 'BRIGHTON')[0].crs, 'BTN');
  assert.equal(S.searchStations(LIST, 'bright')[0].crs, 'BTN');
  const hits = S.searchStations(LIST, 'victoria', 5).map((s) => s.name);
  assert.ok(hits.includes('London Victoria'), 'matches a word inside the name: ' + hits);
  assert.equal(S.searchStations(LIST, 'st pancras')[0].crs, 'STP');
  assert.deepEqual(S.searchStations(LIST, ''), []);
  assert.deepEqual(S.searchStations(LIST, 'zzzzqqq'), []);
  assert.equal(S.searchStations(LIST, 'a', 3).length <= 3, true);
  assert.equal(S.searchStations(LIST, 'kings cross')[0].crs, 'KGX', 'apostrophes and spacing do not matter');
});

test('train search is a case-insensitive headcode prefix', () => {
  const t = [{ id: 1, hc: '1H15' }, { id: 2, hc: '1H20' }, { id: 3, hc: '2A12' }];
  assert.deepEqual(S.searchTrains(t, '1h').map((x) => x.id), [1, 2]);
  assert.deepEqual(S.searchTrains(t, '2A12').map((x) => x.id), [3]);
  assert.deepEqual(S.searchTrains(t, 'zz'), []);
  assert.deepEqual(S.searchTrains(t, ''), []);
  assert.equal(S.searchTrains(t, '1', 1).length, 1);
});

test('declutter keeps the highest priority and drops overlaps', () => {
  const kept = DC.place([
    { x: 0, y: 0, w: 50, h: 12, prio: 1, ref: 'low' },
    { x: 20, y: 2, w: 50, h: 12, prio: 5, ref: 'high' },
    { x: 200, y: 0, w: 50, h: 12, prio: 0, ref: 'far' }
  ]);
  assert.deepEqual(kept, ['high', 'far']);
});

test('declutter: touching boxes survive, padding is respected, grid cells do not hide clashes', () => {
  assert.deepEqual(DC.place([{ x: 0, y: 0, w: 10, h: 10, prio: 2, ref: 'a' }, { x: 12, y: 0, w: 10, h: 10, prio: 1, ref: 'b' }], 0), ['a', 'b']);
  assert.deepEqual(DC.place([{ x: 0, y: 0, w: 10, h: 10, prio: 2, ref: 'a' }, { x: 11, y: 0, w: 10, h: 10, prio: 1, ref: 'b' }], 3), ['a']);
  // Two boxes either side of a 96 px cell boundary that overlap each other.
  assert.deepEqual(DC.place([{ x: 90, y: 0, w: 20, h: 10, prio: 2, ref: 'a' }, { x: 100, y: 0, w: 20, h: 10, prio: 1, ref: 'b' }], 0), ['a']);
  assert.deepEqual(DC.place([{ x: -50, y: -50, w: 20, h: 10, prio: 2, ref: 'a' }, { x: -40, y: -45, w: 20, h: 10, prio: 1, ref: 'b' }], 0), ['a'], 'negative coordinates');
  assert.deepEqual(DC.place([]), []);
});

test('declutter scales: 2,000 candidate labels in well under a frame', () => {
  const boxes = Array.from({ length: 2000 }, (_, i) => ({ x: (i * 37) % 1400, y: (i * 91) % 900, w: 40, h: 14, prio: i % 7, ref: i }));
  const t0 = process.hrtime.bigint();
  const kept = DC.place(boxes, 2);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(kept.length > 100 && kept.length < 2000);
  assert.ok(ms < 30, ms + ' ms');
});
