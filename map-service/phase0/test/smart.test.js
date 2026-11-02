'use strict';

// SMART reading: format facts on a planted fixture, the compact rows, and the SMART_FORMAT verdict
// in each of its PASS / WARN / FAIL situations.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readSmart, compactRow, judgeSmartFormat, describeSmartFacts, EXPECTED_FIELDS } = require('../lib/smart');
const { tmpdir, smartRow, smartDoc, writeText, writeSmart } = require('./smart-check-helpers');

// Planted fixture, 15 rows: 10 arrivals (alternating EVENT A / C) carrying ARRIVAL_OFFSETS, 4 departures
// (alternating B / D) carrying DEPARTURE_OFFSETS, and one row with an undocumented EVENT. The expected
// quantiles in the tests were worked out by hand from these lists.
const ARRIVAL_OFFSETS = ['-20', '-10', '0', '0', '10', '10', '10', '20', '30', '40'];
const DEPARTURE_OFFSETS = ['-5', 'abc', '', '5'];

function plantedRows() {
  const rows = [];
  ARRIVAL_OFFSETS.forEach((o, i) => rows.push(smartRow({
    TD: i < 8 ? 'LA' : 'SX', EVENT: i % 2 ? 'C' : 'A', BERTHOFFSET: o, STANOX: '87101',
    FROMBERTH: '0006', TOBERTH: '0004', FROMLINE: '1', TOLINE: '1', PLATFORM: i < 3 ? '1' : '', STEPTYPE: i === 9 ? 'I' : 'B'
  })));
  DEPARTURE_OFFSETS.forEach((o, i) => rows.push(smartRow({
    EVENT: i % 2 ? 'D' : 'B', BERTHOFFSET: o, STANOX: '87102', FROMBERTH: '0004', TOBERTH: '0002', STEPTYPE: 'B'
  })));
  rows.push(smartRow({ EVENT: 'X', BERTHOFFSET: '99', STANOX: '87103' }));       // not a documented EVENT
  return rows;                                                                  // 15 rows
}

test('format facts on a planted fixture: counts, distinct values, offsets, population', async () => {
  const file = writeSmart(tmpdir(), plantedRows());
  const { facts, rows, stanoxInfo } = await readSmart(file);

  assert.equal(facts.rows, 15);
  assert.equal(rows.length, 15);
  assert.equal(facts.bad, 0);
  assert.deepEqual(facts.wrapper, { kind: 'object-with-array', key: 'BERTHDATA', keys: ['BERTHDATA'] });
  assert.equal(facts.endedCleanly, true);
  assert.equal(facts.compressed, true);
  assert.deepEqual(facts.fields.map(f => f.name).sort(), [...EXPECTED_FIELDS].sort());
  for (const n of EXPECTED_FIELDS) assert.equal(facts.presentPct[n], 100, n);

  assert.deepEqual(facts.events, { A: 5, C: 5, B: 2, D: 2, X: 1 });
  assert.deepEqual(facts.stepTypes, { B: 14, I: 1 });                // 9 arrivals + 4 departures + the stray row are 'B'; one arrival is 'I'
  assert.equal(facts.tdAreas, 2);
  assert.deepEqual(facts.tdAreaCodes, ['LA', 'SX']);

  // arrival offsets -20,-10,0,0,10,10,10,20,30,40: median 10, p10 = -11, p90 = 31 (worked by hand)
  assert.deepEqual(facts.offsets.arrival, { count: 10, min: -20, p10: -11, median: 10, p90: 31, max: 40, nonNumeric: 0, empty: 0 });
  // departure offsets: numeric -5 and 5; 'abc' is non-numeric; '' is blank
  assert.deepEqual(facts.offsets.departure, { count: 2, min: -5, p10: -4, median: 0, p90: 4, max: 5, nonNumeric: 1, empty: 1 });
  assert.equal(facts.offsets.other.count, 1);                         // the EVENT=X row
  assert.equal(facts.offsets.other.max, 99);

  // PLATFORM is filled on 3 of 15 rows (20%); FROMLINE / TOLINE on the 10 arrivals (66.7%)
  assert.deepEqual(facts.populated.PLATFORM, { rows: 3, pct: 20 });
  assert.deepEqual(facts.populated.FROMLINE, { rows: 10, pct: 66.7 });
  assert.deepEqual(facts.populated.TOLINE, { rows: 10, pct: 66.7 });

  assert.equal(stanoxInfo.get('87101').rows, 10);
  assert.equal(stanoxInfo.get('87102').rows, 4);
  assert.equal(stanoxInfo.size, 3);
});

test('"key present" and "value non-blank" are counted separately, and a missing key shows as less than 100%', async () => {
  const rows = [smartRow({ STANOX: '1', PLATFORM: '2' }), smartRow({ STANOX: '2' })];
  delete rows[1].COMMENT;                                              // the key is absent from one row
  const { facts } = await readSmart(writeSmart(tmpdir(), rows));
  const comment = facts.fields.find(f => f.name === 'COMMENT');
  assert.deepEqual(comment, { name: 'COMMENT', present: 1, nonEmpty: 0 });
  assert.equal(facts.presentPct.COMMENT, 50);
  assert.equal(facts.populated.PLATFORM.pct, 50);
});

test('berth offsets of an arrival and a departure never mix, and numbers given as JSON numbers still count', async () => {
  const rows = [smartRow({ EVENT: 'A', BERTHOFFSET: 5 }), smartRow({ EVENT: 'a', BERTHOFFSET: ' +7 ' }), smartRow({ EVENT: 'B', BERTHOFFSET: '-3.5' })];
  const { facts } = await readSmart(writeSmart(tmpdir(), rows));
  assert.equal(facts.offsets.arrival.count, 2);
  assert.equal(facts.offsets.arrival.median, 6);
  assert.equal(facts.offsets.departure.min, -3.5);
  assert.deepEqual(facts.events, { A: 1, B: 1, a: 1 }, 'raw EVENT values are reported as found');
});

test('rows that fail to parse are counted and sampled, not fatal', async () => {
  const good = JSON.stringify(smartRow({ STANOX: '87101' }));
  const text = `{"BERTHDATA":[${good},{"TD":"LA",},${good},{oops},${good}]}`;
  const { facts, rows } = await readSmart(writeText(tmpdir(), 'bad.json', text));
  assert.equal(rows.length, 3);
  assert.equal(facts.bad, 2);
  assert.equal(facts.badSamples.length, 2);
});

test('compactRow trims, upper-cases, pads a numeric STANOX, and interns repeated strings', () => {
  const pool = new Map();
  const intern = s => { if (!pool.has(s)) pool.set(s, s); return pool.get(s); };
  const a = compactRow({ TD: ' la ', FROMBERTH: ' 0006', TOBERTH: '0004 ', STANOX: 1234, EVENT: 'a' }, intern);
  assert.deepEqual(a, { td: 'LA', from: '0006', to: '0004', stanox: '01234', event: 'A' });
  const b = compactRow({ TD: 'LA', FROMBERTH: '0006', TOBERTH: null, STANOX: '01234', EVENT: 'A' }, intern);
  assert.equal(b.to, '');
  assert.ok(Object.is(a.td, b.td) && Object.is(a.from, b.from), 'equal strings are one stored string');
  assert.deepEqual(compactRow({}), { td: '', from: '', to: '', stanox: '', event: '' });
});

test('keepRaw returns the original objects of the rows it selects', async () => {
  const rows = [smartRow({ TD: 'LA', COMMENT: 'keep me' }), smartRow({ TD: 'SX' })];
  const { rawKept } = await readSmart(writeSmart(tmpdir(), rows), { keepRaw: c => c.td === 'LA' });
  assert.equal(rawKept.length, 1);
  assert.equal(rawKept[0].raw.COMMENT, 'keep me');
  assert.equal(rawKept[0].compact.td, 'LA');
});

// ---- the verdict ------------------------------------------------------------------------------------

async function judge(text, name = 'x.json') {
  const { facts } = await readSmart(writeText(tmpdir(), name, text));
  return { facts, ...judgeSmartFormat(facts) };
}

test('SMART_FORMAT PASS: documented wrapper, every expected field, observed names in the message', async () => {
  const r = await judge(smartDoc(plantedRows()));
  assert.equal(r.status, 'PASS');
  assert.match(r.message, /SMART reads as documented: 15 rows inside \{"BERTHDATA":\[…\]\}/);
  for (const n of EXPECTED_FIELDS.slice(0, 12)) assert.ok(r.message.includes(n), `message names ${n}`);
  assert.ok(!r.message.includes('\n'));
});

test('SMART_FORMAT PASS tolerates a few unparseable rows (under 1%) and says how many were skipped', async () => {
  const good = JSON.stringify(smartRow({ STANOX: '1' }));
  const rows = Array(300).fill(good);
  const r = await judge(`{"BERTHDATA":[${rows.join(',')},{bad,}]}`);
  assert.equal(r.status, 'PASS');
  assert.match(r.message, /1 unparseable row skipped/);
});

test('SMART_FORMAT WARN: a different wrapper key, but the rows parse', async () => {
  const r = await judge(JSON.stringify({ BERTH_DATA: plantedRows() }));
  assert.equal(r.status, 'WARN');
  assert.match(r.message, /the wrapper is \{"BERTH_DATA":\[…\]\} not \{"BERTHDATA":\[…\]\}/);
  assert.match(r.message, /Fields seen: TD, FROMBERTH/);
});

test('SMART_FORMAT WARN: a bare array and a bare-rows file are named as such', async () => {
  const rows = plantedRows();
  assert.match((await judge(JSON.stringify(rows))).message, /the wrapper is a bare array/);
  const lines = rows.map(r => JSON.stringify(r)).join('\n');
  const r = await judge(lines);
  assert.equal(r.status, 'WARN');
  assert.match(r.message, /bare rows with no wrapper/);
});

test('SMART_FORMAT WARN: an expected field missing on more than 1% of rows is named with its percentage', async () => {
  const rows = plantedRows();
  for (const r of rows.slice(0, 3)) delete r.ROUTE;                    // 3 of 15 rows = 20% missing
  const r = await judge(smartDoc(rows));
  assert.equal(r.status, 'WARN');
  assert.match(r.message, /ROUTE \(missing on 20\.0%\)/);
});

test('SMART_FORMAT WARN: extra fields are reported but do not by themselves spoil a PASS', async () => {
  const rows = plantedRows().map(r => ({ ...r, NEWFIELD: 'x' }));
  const r = await judge(smartDoc(rows));
  assert.equal(r.status, 'PASS');
  assert.match(r.message, /Extra fields: NEWFIELD/);
});

test('SMART_FORMAT WARN: more than 1% unparseable rows', async () => {
  const good = JSON.stringify(smartRow({ STANOX: '1' }));
  const r = await judge(`{"BERTHDATA":[${good},{bad,},${good}]}`);
  assert.equal(r.status, 'WARN');
  assert.match(r.message, /1 of 3 rows \(33\.3%\) failed to parse/);
});

test('SMART_FORMAT WARN: a file that stops before the document ends', async () => {
  const text = smartDoc(plantedRows());
  const r = await judge(text.slice(0, text.lastIndexOf(']}')));
  assert.equal(r.status, 'WARN');
  assert.match(r.message, /ends inside the document \(truncated\?\)/);
});

test('SMART_FORMAT FAIL: nothing parses, and the message quotes how the file starts', async () => {
  const r = await judge('<html><body>Service unavailable</body></html>');
  assert.equal(r.status, 'FAIL');
  assert.match(r.message, /No SMART rows could be read \(0 rows parsed\); the file starts: "<html><body>Service unavailable<\/body><\/html>"/);
});

test('SMART_FORMAT FAIL: rows parse but the core fields are not there (a different file entirely)', async () => {
  const r = await judge(JSON.stringify({ BERTHDATA: [{ a: 1 }, { a: 2 }] }));
  assert.equal(r.status, 'FAIL');
  assert.match(r.message, /2 rows parse but they do not look like SMART: TD, FROMBERTH, TOBERTH, STANOX, EVENT missing from most rows\. Fields seen: a/);
});

test('SMART_FORMAT FAIL on an empty file', async () => {
  const r = await judge('');
  assert.equal(r.status, 'FAIL');
  assert.match(r.message, /0 rows parsed/);
});

test('every verdict message is a single line, even when the file contains newlines', async () => {
  const r = await judge('line one\nline two\r\nline three');
  assert.equal(r.status, 'FAIL');
  assert.ok(!/[\r\n]/.test(r.message));
});

test('the notes describe the facts in plain lines', async () => {
  const { facts } = await readSmart(writeSmart(tmpdir(), plantedRows()));
  const text = describeSmartFacts(facts).join('\n');
  assert.match(text, /SMART: 15 rows; wrapper \{"BERTHDATA":\[…\]\}; gzip;/);
  assert.match(text, /SMART EVENT values: \{"A":5,"C":5,"B":2,"D":2,"X":1\}/);
  assert.match(text, /BERTHOFFSET in seconds \(arrival = EVENT A\/C, departure = B\/D, other = any other EVENT\)/);
  assert.match(text, /\n {2}arrival {3}n=10 min=-20 p10=-11 median=10 p90=31 max=40; non-numeric 0, blank 0/);
  assert.match(text, /\n {2}departure n=2 min=-5 p10=-4 median=0 p90=4 max=5; non-numeric 1, blank 1/);
  assert.match(text, /PLATFORM 20%, FROMLINE 66\.7%, TOLINE 66\.7%/);
});
