'use strict';

// The station-table generator: reproducible output, strict about bad input, licence and attribution kept.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { build, main } = require('../../scripts/build-stations');
const { tmpdir } = require('./smart-check-helpers');

const REC = (crsCode, stationName, lat, long, extra = {}) => ({ stationName, lat, long, crsCode, constituentCountry: 'england', ...extra });
const GOOD = [
  REC('PLD', 'Portslade', 50.836044, -0.204898),
  REC('HOV', 'Hove', 50.835206, -0.17018),
  REC('AAA', 'Needs "quotes" & accents é', 51.123456789, -1.5, { iataAirportCode: 'XYZ' })
];

/** Writes <dir>/pkg/stations.json (+ package.json) and returns the stations.json path. */
function makePackage(records, pkg = { name: 'uk-railway-stations', version: '9.9.9', license: 'ODbL-1.0' }) {
  const dir = path.join(tmpdir(), 'pkg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stations.json'), JSON.stringify(records));
  if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return path.join(dir, 'stations.json');
}

test('output is one station per line, sorted by CRS, rounded to 6 decimals, valid JSON', () => {
  const { text, count } = build(makePackage(GOOD));
  assert.equal(count, 3);
  const doc = JSON.parse(text);
  assert.deepEqual(Object.keys(doc.stations), ['AAA', 'HOV', 'PLD']);
  assert.deepEqual(doc.stations.AAA, { name: 'Needs "quotes" & accents é', lat: 51.123457, lon: -1.5 });
  const lines = text.split('\n');
  assert.equal(lines.filter(l => /^ {2}"[A-Z]{3}": \{/.test(l)).length, 3);
  assert.ok(text.endsWith('\n'));
});

test('the same input gives the same bytes, whatever order it arrives in', () => {
  const a = build(makePackage(GOOD)).text;
  const b = build(makePackage([...GOOD].reverse())).text;
  assert.equal(a, b);
  assert.ok(!/20\d\d-\d\d-\d\dT/.test(a), 'no timestamp in the output');
});

test('attribution, licence, package version and generator are in the file', () => {
  const doc = JSON.parse(build(makePackage(GOOD)).text);
  assert.match(doc._source, /uk-railway-stations 9\.9\.9 \(https:\/\/github\.com\/davwheat\/uk-railway-stations\) by David Wheatley/);
  assert.match(doc._source, /Trainline EU/);
  assert.match(doc._licence, /Open Database Licence \(ODbL\) 1\.0/);
  assert.match(doc._licence, /Attribution to David Wheatley, Trainline EU/);
  assert.match(doc._generator, /build-stations\.js/);
  assert.equal(doc._count, 3);
});

test('records that are not usable stations are skipped and reported, within the 1% allowance', () => {
  const many = Array.from({ length: 300 }, (_, i) => REC(String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + (Math.floor(i / 26) % 26)) + 'Q', 'S' + i, 51, -1));
  const { count, skipped } = build(makePackage([...many, REC('ZZ', 'Two letters', 51, 0)]));
  assert.equal(count, 300);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /three-letter CRS/);
});

test('too many unusable records means the input is not what we think, and nothing is written', () => {
  assert.throws(() => build(makePackage([REC('PLD', 'P', 50.8, -0.2), REC('X', 'bad', 1, 1)])), /1 of 2 records were unusable/);
});

test('swapped latitude and longitude are caught by the range check', () => {
  const recs = [REC('PLD', 'Portslade', -0.204898, 50.836044), REC('HOV', 'Hove', 50.835206, -0.17018)];
  assert.throws(() => build(makePackage(recs)), /outside the UK: swapped lat\/long\?/);
});

test('one CRS twice: an exact repeat is fine, different coordinates abort', () => {
  assert.equal(build(makePackage([...GOOD, GOOD[0]])).count, 3);
  assert.throws(() => build(makePackage([...GOOD, REC('PLD', 'Elsewhere', 52, -1)])), /CRS PLD appears twice with different coordinates/);
});

test('an input whose package.json is not ODbL-1.0 is refused, because the licence text would be wrong', () => {
  assert.throws(() => build(makePackage(GOOD, { name: 'x', version: '1', license: 'MIT' })), /declares licence "MIT", not ODbL-1\.0/);
});

test('without a package.json the table is still built, with the version left out', () => {
  const doc = JSON.parse(build(makePackage(GOOD, null)).text);
  assert.match(doc._source, /^uk-railway-stations \(https/);
});

test('unreadable or wrongly shaped input is an error with a sentence', () => {
  assert.throws(() => build('/nonexistent/stations.json'), /Cannot read .* as JSON/);
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 's.json'), '{"not":"an array"}');
  assert.throws(() => build(path.join(dir, 's.json')), /not an array of station records/);
});

test('the command line writes the file atomically and exits 0; bad input exits 1; bad usage exits 2', () => {
  const out = path.join(tmpdir(), 'nested', 'stations.json');
  const logs = [];
  const log = console.log, err = console.error;
  console.log = m => logs.push(m); console.error = m => logs.push(m);
  try {
    assert.equal(main([makePackage(GOOD), '--out', out]), 0);
    assert.ok(fs.existsSync(out));
    assert.ok(!fs.existsSync(out + '.tmp'));
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8'))._count, 3);
    assert.equal(main(['/nonexistent.json', '--out', out]), 1);
    assert.equal(main([]), 2);
    assert.equal(main(['--bogus']), 2);
    assert.equal(main(['--help']), 0);
  } finally { console.log = log; console.error = err; }
  assert.ok(logs.some(l => /3 stations \(uk-railway-stations 9\.9\.9\)/.test(l)));
});
