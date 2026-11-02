'use strict';

// The bounded accumulators behind the format facts, checked against brute force.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Counter, NumberHistogram, FieldStats } = require('../lib/stats');
const { fmtInt, pct, fmtPct, oneLine, listCap } = require('../lib/format');
const { str, stanoxKey, crsKey, areaKey, classifyEvent } = require('../lib/norm');
const { haversineKm, inBox } = require('../lib/geo');

function bruteQuantile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

test('histogram quantiles are exact and match a brute-force sort (planted 1..10)', () => {
  const h = new NumberHistogram();
  for (let i = 10; i >= 1; i--) h.add(i);
  assert.deepEqual(h.summary(), { count: 10, min: 1, p10: 1.9, median: 5.5, p90: 9.1, max: 10 });
});

test('histogram agrees with brute force on random data with many repeats', () => {
  let seed = 99;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const values = Array.from({ length: 5000 }, () => (rnd() % 601) - 300);
  const h = new NumberHistogram();
  values.forEach(v => h.add(v));
  for (const q of [0, 0.1, 0.25, 0.5, 0.9, 0.99, 1]) {
    assert.ok(Math.abs(h.quantile(q) - bruteQuantile(values, q)) < 1e-9, `q=${q}`);
  }
  assert.equal(h.count, 5000);
});

test('histogram keeps working after more values arrive (cached index is invalidated)', () => {
  const h = new NumberHistogram();
  h.add(1); h.add(3);
  assert.equal(h.quantile(0.5), 2);
  h.add(100);
  assert.equal(h.quantile(1), 100);
  assert.equal(h.quantile(0.5), 3);
});

test('an empty histogram has nulls, a single value is every quantile', () => {
  assert.deepEqual(new NumberHistogram().summary(), { count: 0, min: null, p10: null, median: null, p90: null, max: null });
  const h = new NumberHistogram();
  h.add(-7);
  assert.deepEqual(h.summary(), { count: 1, min: -7, p10: -7, median: -7, p90: -7, max: -7 });
});

test('histogram memory is bounded: values past the cap are counted, and the summary says it is approximate', () => {
  const h = new NumberHistogram(3);
  [1, 2, 3, 4, 5, 2].forEach(v => h.add(v));
  assert.equal(h.counts.size, 3);
  assert.equal(h.overflow, 2);
  const s = h.summary();
  assert.equal(s.approximate, true);
  assert.equal(s.overflow, 2);
  assert.equal(s.max, 3);
});

test('counter orders by frequency then key, shows blanks, and caps distinct values', () => {
  const c = new Counter(3);
  ['B', 'A', 'B', '', 'A', 'B', 'Z', 'Q'].forEach(v => c.add(v));
  assert.deepEqual(c.toObject(), { B: 3, A: 2, '(empty)': 1, '(other)': 2 });
  assert.equal(c.total, 8);
});

test('field stats separate "the key exists" from "the value is not blank"', () => {
  const f = new FieldStats();
  f.observe({ TD: 'LA', PLATFORM: '' });
  f.observe({ TD: 'LA', PLATFORM: '  ' });
  f.observe({ TD: 'LA', PLATFORM: '2', EXTRA: null });
  assert.deepEqual(f.summary(), [
    { name: 'TD', present: 3, nonEmpty: 3 },          // equal presence: first-seen order, TD before PLATFORM
    { name: 'PLATFORM', present: 3, nonEmpty: 1 },
    { name: 'EXTRA', present: 1, nonEmpty: 0 }
  ]);
});

test('field stats stop remembering new key names past the cap', () => {
  const f = new FieldStats(2);
  f.observe({ a: 1, b: 1, c: 1, d: 1 });
  assert.equal(f.summary().length, 2);
  assert.equal(f.namesPastCap, 2);
});

test('value normalisers coerce rather than crash', () => {
  assert.equal(str(' LA '), 'LA');
  assert.equal(str(null), '');
  assert.equal(str(undefined), '');
  assert.equal(str(12), '12');
  assert.equal(str({ a: 1 }), '');
  assert.equal(stanoxKey('87101'), '87101');
  assert.equal(stanoxKey(1234), '01234');      // a JSON number lost its leading zero
  assert.equal(stanoxKey('1234'), '01234');
  assert.equal(stanoxKey(' 87101 '), '87101');
  assert.equal(stanoxKey('AB123'), 'AB123');   // not purely numeric: left alone
  assert.equal(crsKey(' pld '), 'PLD');
  assert.equal(crsKey(' '), '');               // CORPUS blanks are a single space
  assert.equal(crsKey('PLDX'), '');
  assert.equal(crsKey('P1D'), '');
  assert.equal(areaKey(' la '), 'LA');
  assert.deepEqual(classifyEvent('A'), { kind: 'arrival', dir: 'up' });
  assert.deepEqual(classifyEvent('B'), { kind: 'departure', dir: 'up' });
  assert.deepEqual(classifyEvent('C'), { kind: 'arrival', dir: 'down' });
  assert.deepEqual(classifyEvent('D'), { kind: 'departure', dir: 'down' });
  assert.equal(classifyEvent('E'), null);
  assert.equal(classifyEvent(''), null);
});

test('formatting helpers', () => {
  assert.equal(fmtInt(0), '0');
  assert.equal(fmtInt(999), '999');
  assert.equal(fmtInt(1000), '1,000');
  assert.equal(fmtInt(1234567.6), '1,234,568');
  assert.equal(fmtInt(-1234), '-1,234');
  assert.equal(pct(3, 4), 75);
  assert.equal(pct(1, 3), 33.3);
  assert.equal(pct(5, 0), 0);
  assert.equal(fmtPct(3, 4), '75.0%');
  assert.equal(fmtPct(0, 0), 'n/a');
  assert.equal(oneLine('a\n  b\t c', 100), 'a b c');
  assert.equal(oneLine('abcdef', 4), 'abc…');
  assert.equal(listCap(['a', 'b', 'c'], 2), 'a, b +1 more');
  assert.equal(listCap(['a', 'b'], 2), 'a, b');
});

test('geometry: known distances and the box edges', () => {
  const PLD = { lat: 50.836044, lon: -0.204898 }, HOV = { lat: 50.835206, lon: -0.17018 };
  const d = haversineKm(PLD, HOV);
  assert.ok(d > 2.3 && d < 2.6, `Portslade to Hove is about 2.5 km, got ${d}`);
  assert.equal(haversineKm(PLD, PLD), 0);
  // Exact references from the formula rather than distances remembered from a map: along a meridian
  // (or the equator) one degree is 2*pi*R/360 km.
  const oneDegree = (2 * Math.PI * 6371.0088) / 360;
  assert.ok(Math.abs(haversineKm({ lat: 10, lon: 5 }, { lat: 11, lon: 5 }) - oneDegree) < 1e-6);
  assert.ok(Math.abs(haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - oneDegree) < 1e-6);
  assert.ok(Math.abs(haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }) - Math.PI * 6371.0088) < 1e-6, 'antipodes');
  const EDB = { lat: 55.952, lon: -3.189 };
  assert.ok(haversineKm(PLD, EDB) > 595 && haversineKm(PLD, EDB) < 610, 'Portslade to Edinburgh is some 600 km');
  const box = { south: 50.72, west: -0.96, north: 51.17, east: 0.87 };
  assert.equal(inBox(PLD, box), true);
  assert.equal(inBox(EDB, box), false);
  assert.equal(inBox({ lat: 50.72, lon: -0.96 }, box), true, 'edges are inclusive');
  assert.equal(inBox({ lat: 50.7199, lon: 0 }, box), false);
});
