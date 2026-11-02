'use strict';

// The streaming row scanner: exactness across every possible chunk boundary, strings that look like
// structure, multi-byte characters, gzip detection by content, damaged input, and bounded memory.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { RowScanner, scanStream, streamRows, describeWrapper, wrapperText } = require('../lib/json-rows');

const BOM = String.fromCharCode(0xfeff);

// Every awkward thing a row can hold: braces and brackets inside strings, escaped quotes, a
// backslash directly before a closing quote, non-ASCII (2-, 3- and 4-byte UTF-8), empty values.
const ROWS = [
  { TD: 'LA', FROMBERTH: '0006', TOBERTH: '0004', COMMENT: '' },
  { TD: 'LA', FROMBERTH: '0004', TOBERTH: '0002', COMMENT: 'a } closing brace, a { opening one, and ] and [' },
  { TD: 'SX', FROMBERTH: 'A\\', TOBERTH: 'B"', COMMENT: 'quote " and backslash \\ and escaped quote \\" together' },
  { TD: 'XX', FROMBERTH: 'é', TOBERTH: '日本', COMMENT: 'naïve — “curly” \u{1F682}' },
  { TD: 'LA', FROMBERTH: '', TOBERTH: '0001', COMMENT: '{"looks":"like a row"}' }
];
const COMPACT = JSON.stringify({ BERTHDATA: ROWS });
const PRETTY = JSON.stringify({ BERTHDATA: ROWS }, null, 2);

function scanStrings(pieces, opts = {}) {
  const rows = [];
  const s = new RowScanner({ onRow: r => rows.push(r), ...opts });
  for (const p of pieces) s.write(p);
  return { rows, summary: s.finish(), scanner: s };
}

test('a whole document yields every row, compact or pretty-printed', () => {
  for (const doc of [COMPACT, PRETTY, PRETTY.replace(/\n/g, '\r\n')]) {
    const { rows, summary } = scanStrings([doc]);
    assert.deepEqual(rows, ROWS);
    assert.equal(summary.rows, ROWS.length);
    assert.equal(summary.bad, 0);
    assert.equal(summary.endedCleanly, true);
  }
});

test('cutting the document at EVERY possible point gives the same rows', () => {
  for (const doc of [COMPACT, PRETTY]) {
    for (let k = 0; k <= doc.length; k++) {
      const { rows, summary } = scanStrings([doc.slice(0, k), doc.slice(k)]);
      assert.deepEqual(rows, ROWS, `split at ${k}`);
      assert.equal(summary.bad, 0, `split at ${k}`);
    }
  }
});

test('every chunk size from 1 character up gives the same rows', () => {
  for (const doc of [COMPACT, PRETTY]) {
    for (let size = 1; size <= 40; size++) {
      const pieces = [];
      for (let i = 0; i < doc.length; i += size) pieces.push(doc.slice(i, i + size));
      assert.deepEqual(scanStrings(pieces).rows, ROWS, `chunk size ${size}`);
    }
  }
});

test('random three-way splits give the same rows (seeded, so a failure reproduces)', () => {
  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let t = 0; t < 400; t++) {
    const a = rnd(PRETTY.length), b = rnd(PRETTY.length);
    const [i, j] = a < b ? [a, b] : [b, a];
    assert.deepEqual(scanStrings([PRETTY.slice(0, i), PRETTY.slice(i, j), PRETTY.slice(j)]).rows, ROWS, `split ${i},${j}`);
  }
});

test('multi-byte characters split across byte chunks are reassembled, for every chunk size', async () => {
  const bytes = Buffer.from(COMPACT, 'utf8');
  assert.ok(bytes.length > COMPACT.length, 'the fixture really does contain multi-byte characters');
  for (const size of [1, 2, 3, 4, 5, 7, 16]) {
    const chunks = [];
    for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
    const rows = [];
    const summary = await scanStream(Readable.from(chunks, { objectMode: false }), { onRow: r => rows.push(r) });
    assert.deepEqual(rows, ROWS, `byte chunk size ${size}`);
    assert.equal(summary.bytes, bytes.length);
  }
});

test('a UTF-8 byte order mark and CRLF line ends do not matter', () => {
  const { rows, summary } = scanStrings([BOM + PRETTY.replace(/\n/g, '\r\n')]);
  assert.deepEqual(rows, ROWS);
  assert.deepEqual(summary.wrapper, { kind: 'object-with-array', key: 'BERTHDATA', keys: ['BERTHDATA'] });
});

test('a leaf object is a row; an object holding another object or array is not', () => {
  const { rows } = scanStrings(['{"W":[{"a":1},{"b":{"c":2}},{"d":[3]},{"e":4}]}']);
  // "b" and "d" contain a container, so they are not rows; the innermost objects are.
  assert.deepEqual(rows, [{ a: 1 }, { c: 2 }, { e: 4 }]);
});

test('bare array, one-row-per-line and wrapper documents all read', () => {
  assert.deepEqual(scanStrings([JSON.stringify(ROWS)]).rows, ROWS);
  assert.deepEqual(scanStrings([ROWS.map(r => JSON.stringify(r)).join('\n')]).rows, ROWS);
});

test('wrapper kinds are told apart from the start of the document, and every key read on the way is reported', () => {
  const w = (kind, key, keys) => ({ kind, key, keys });
  assert.deepEqual(describeWrapper('{"BERTHDATA":[{"TD":"LA"'), w('object-with-array', 'BERTHDATA', ['BERTHDATA']));
  assert.deepEqual(describeWrapper('  {\n  "TIPLOCDATA" : [\n {'), w('object-with-array', 'TIPLOCDATA', ['TIPLOCDATA']));
  assert.deepEqual(describeWrapper('{"Some \\"odd\\" key":[{}'), w('object-with-array', 'Some "odd" key', ['Some "odd" key']));
  assert.deepEqual(describeWrapper('[{"TD":"LA"}'), w('bare-array', null, []));
  assert.deepEqual(describeWrapper('{"TD":"LA","FROMBERTH":"0006"}\n{"TD"'), w('bare-rows', null, []));
  assert.deepEqual(describeWrapper('<html>'), w('unknown', null, []));
  assert.deepEqual(describeWrapper(''), w('unknown', null, []));
  assert.deepEqual(describeWrapper('{}'), w('unknown', null, []));
});

test('a version, date or metadata key ahead of the data is not mistaken for "no wrapper"', () => {
  const w = (key, keys) => ({ kind: 'object-with-array', key, keys });
  assert.deepEqual(describeWrapper('{"VERSION":"2026-10-30","BERTHDATA":[{"TD":"LA"'), w('BERTHDATA', ['VERSION', 'BERTHDATA']));
  assert.deepEqual(describeWrapper('{"generated":1730000000,"ok":true,"note":null,"BERTHDATA":['), w('BERTHDATA', ['generated', 'ok', 'note', 'BERTHDATA']));
  // nested values, with braces and brackets and quotes inside strings, are stepped over
  assert.deepEqual(describeWrapper('{"meta":{"v":1,"n":[1,2],"s":"a } ] \\" {"},"BERTHDATA":[{'), w('BERTHDATA', ['meta', 'BERTHDATA']));
  assert.deepEqual(describeWrapper('{\n  "VERSION": "x",\n  "BERTHDATA": [\n    {'), w('BERTHDATA', ['VERSION', 'BERTHDATA']));
  assert.deepEqual(describeWrapper(BOM + '{"A":"x","B":[{'), w('B', ['A', 'B']));
});

test('a head that ends before the answer is "unknown", never a wrong answer', () => {
  assert.deepEqual(describeWrapper('{"BERTH'), { kind: 'unknown', key: null, keys: [] });
  assert.deepEqual(describeWrapper('{"VERSION":"abc'), { kind: 'unknown', key: null, keys: ['VERSION'] });
  assert.deepEqual(describeWrapper('{"meta":{"v":1,'), { kind: 'unknown', key: null, keys: ['meta'] });
  assert.deepEqual(describeWrapper('{"VERSION":12'), { kind: 'unknown', key: null, keys: ['VERSION'] });
  assert.deepEqual(describeWrapper('{"VERSION"'), { kind: 'unknown', key: null, keys: [] });
});

test('wrapperText says what the wrapper is in words', () => {
  assert.equal(wrapperText({ kind: 'object-with-array', key: 'BERTHDATA', keys: ['BERTHDATA'] }), '{"BERTHDATA":[…]}');
  assert.equal(wrapperText({ kind: 'object-with-array', key: 'BERTHDATA', keys: ['VERSION', 'BERTHDATA'] }), '{"VERSION":…,"BERTHDATA":[…]}');
  assert.equal(wrapperText({ kind: 'bare-array', key: null, keys: [] }), 'a bare array […]');
  assert.equal(wrapperText({ kind: 'bare-rows', key: null, keys: [] }), 'bare rows with no wrapper');
  assert.equal(wrapperText({ kind: 'unknown', key: null, keys: [] }), 'an unrecognised layout');
});

test('a row that is not valid JSON is counted and sampled, and the rest still read', () => {
  const doc = '{"W":[{"a":1},{"a":2,},{b:3},{"a":4}]}';
  const { rows, summary } = scanStrings([doc]);
  assert.deepEqual(rows, [{ a: 1 }, { a: 4 }]);
  assert.equal(summary.bad, 2);
  assert.equal(summary.badSamples.length, 2);
  assert.match(summary.badSamples[0].reason, /unparseable row/);
  assert.equal(summary.badSamples[0].sample, '{"a":2,}');
});

test('a document that stops inside a row is reported as truncated, not as a crash', () => {
  const cut = COMPACT.slice(0, COMPACT.indexOf('"0002"') + 2);       // ends inside the second row
  const { rows, summary } = scanStrings([cut]);
  assert.deepEqual(rows, [ROWS[0]]);
  assert.equal(summary.endedCleanly, false);
  assert.equal(summary.bad, 1);
  assert.match(summary.badSamples[0].reason, /ended inside a row/);
});

test('a document that stops after the last row but before the closing ]} is not clean, yet has no bad row', () => {
  const { rows, summary } = scanStrings([COMPACT.slice(0, COMPACT.lastIndexOf(']}'))]);
  assert.deepEqual(rows, ROWS);
  assert.equal(summary.endedCleanly, false);
  assert.equal(summary.bad, 0);
});

test('memory is bounded: an oversized row is dropped and counted, its neighbours survive', () => {
  const big = { TD: 'LA', COMMENT: 'x'.repeat(20000) };
  const doc = JSON.stringify({ W: [ROWS[0], big, ROWS[1]] });
  const max = 1000, chunk = 300;
  const rows = [];
  const s = new RowScanner({ onRow: r => rows.push(r), maxRowChars: max });
  let worstCarry = 0;
  for (let i = 0; i < doc.length; i += chunk) {
    s.write(doc.slice(i, i + chunk));
    worstCarry = Math.max(worstCarry, s.carry.length);
  }
  const summary = s.finish();
  assert.deepEqual(rows, [ROWS[0], ROWS[1]]);
  assert.equal(summary.bad, 1);
  assert.match(summary.badSamples[0].reason, /longer than 1000/);
  assert.ok(worstCarry <= max + chunk, `carry reached ${worstCarry} characters`);
});

test('the same oversize rule applies when the whole row arrives in one chunk', () => {
  const doc = JSON.stringify({ W: [ROWS[0], { COMMENT: 'y'.repeat(5000) }, ROWS[1]] });
  const { rows, summary } = scanStrings([doc], { maxRowChars: 1000 });
  assert.deepEqual(rows, [ROWS[0], ROWS[1]]);
  assert.equal(summary.bad, 1);
});

test('head and tail are kept for diagnosis, whatever the chunking', () => {
  const pieces = [];
  for (let i = 0; i < COMPACT.length; i += 7) pieces.push(COMPACT.slice(i, i + 7));
  const { summary } = scanStrings(pieces, { headChars: 30, tailChars: 20 });
  assert.equal(summary.head, COMPACT.slice(0, 30));
  assert.equal(summary.tail, COMPACT.slice(-20));
  assert.equal(summary.chars, COMPACT.length);
});

// ---- files: gzip detected by content, damage reported plainly -------------------------------------

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-rows-')); }

test('gzip is detected from the first bytes, not the file name', async () => {
  const dir = tmpdir();
  const gzNamedPlain = path.join(dir, 'looks-plain.json');
  const plainNamedGz = path.join(dir, 'looks-gzipped.json.gz');
  fs.writeFileSync(gzNamedPlain, zlib.gzipSync(COMPACT));
  fs.writeFileSync(plainNamedGz, COMPACT);
  for (const [file, compressed] of [[gzNamedPlain, true], [plainNamedGz, false]]) {
    const rows = [];
    const res = await streamRows(file, { onRow: r => rows.push(r) });
    assert.deepEqual(rows, ROWS, file);
    assert.equal(res.compressed, compressed, file);
    assert.equal(res.size, fs.statSync(file).size);
    assert.equal(res.bytes, Buffer.byteLength(COMPACT));
  }
});

test('a truncated gzip file says so in plain words', async () => {
  const dir = tmpdir();
  const file = path.join(dir, 'cut.json.gz');
  const whole = zlib.gzipSync(PRETTY.repeat(1));
  fs.writeFileSync(file, whole.subarray(0, whole.length - 12));
  await assert.rejects(streamRows(file, { onRow() {} }), e => e.code === 'GZIP_DAMAGED' && /damaged or incomplete/.test(e.message) && /Download it again/.test(e.message));
});

test('a file that starts like gzip but is not reports damage, not a stack trace', async () => {
  const file = path.join(tmpdir(), 'junk.json.gz');
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('this is not a gzip stream at all')]));
  await assert.rejects(streamRows(file, { onRow() {} }), e => e.code === 'GZIP_DAMAGED');
});

test('a missing file names the path and a stable error code', async () => {
  await assert.rejects(streamRows('/nonexistent/smart.json', { onRow() {} }), e => e.code === 'FILE_MISSING' && /nonexistent\/smart\.json/.test(e.message));
});

test('a folder given as the file is reported as a folder, not as a raw EISDIR', async () => {
  const dir = tmpdir();
  await assert.rejects(streamRows(dir, { onRow() {} }), e => e.code === 'FILE_UNREADABLE' && e.message === `${dir} is a folder, not a file.`);
});

test('an empty file reads as zero rows, cleanly', async () => {
  const file = path.join(tmpdir(), 'empty.json');
  fs.writeFileSync(file, '');
  const res = await streamRows(file, { onRow() { assert.fail('no row expected'); } });
  assert.equal(res.rows, 0);
  assert.deepEqual(res.wrapper, { kind: 'unknown', key: null, keys: [] });
});
