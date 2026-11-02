'use strict';

// The anchor table file (what phase 1 reads) and the memory probe.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { anchorsFileText, writeAnchorsFile } = require('../lib/anchors-file');
const { analyseAnchors } = require('../lib/smart-analysis');
const { MemoryProbe } = require('../lib/memory');
const { stationMap, tmpdir } = require('./smart-check-helpers');

const STATIONS = stationMap({
  PLD: { name: 'Portslade', lat: 50.836044, lon: -0.204898 },
  HOV: { name: 'Hove', lat: 50.835206, lon: -0.17018 },
  EDB: { name: 'Edinburgh', lat: 55.952, lon: -3.189 }
});
const CRS = { 1: ['PLD'], 2: ['HOV'], 3: ['EDB'] };
const row = (stanox, event, from, to) => ({ td: 'LA', stanox, event, from, to });
const ANCHORS = analyseAnchors([
  row('1', 'A', '0006', '0004'), row('1', 'B', '0004', '0002'),     // anchor 0004@PLD (n=2), hints 0006 and 0002
  row('3', 'A', '0098', '0004')                                      // EDB claims 0004 too: a suspicious conflict
], { crsForStanox: s => CRS[s] || [], stations: STATIONS });

test('the file is valid JSON with the counts, one berth per line, and every conflict claimant kept', () => {
  const text = anchorsFileText({ generatedAt: '2026-11-02T10:15:00.000Z', smartFile: '/x/smart.json.gz', anchors: ANCHORS });
  const doc = JSON.parse(text);
  assert.equal(doc.generatedAt, '2026-11-02T10:15:00.000Z');
  assert.equal(doc.smartFile, '/x/smart.json.gz');
  assert.deepEqual(doc.reading, { arrival: 'TOBERTH', departure: 'FROMBERTH', hint: 'the other berth of a station step' });
  assert.deepEqual(doc.counts, { anchors: 1, hints: 3, conflicts: 1, suspicious: 1, areas: 1, suspiciousKm: 5 });
  assert.deepEqual(doc.areas, { LA: { anchors: 1, hints: 3, conflicts: 1, suspicious: 1 } });
  assert.equal(doc.anchors.length, 1);
  assert.deepEqual(doc.anchors[0], { td: 'LA', berth: '0004', crs: 'PLD', lat: 50.836044, lon: -0.204898, n: 3, claims: { PLD: 2, EDB: 1 }, maxKm: doc.anchors[0].maxKm, suspicious: true });
  assert.ok(doc.anchors[0].maxKm > 590 && doc.anchors[0].maxKm < 610);
  assert.deepEqual(doc.hints.map(h => `${h.berth}@${h.crs}`), ['0002@PLD', '0006@PLD', '0098@EDB']);
  assert.match(doc._comment, /anchor is a TD berth that SMART puts AT a station/);

  const lines = text.split('\n');
  assert.equal(lines.filter(l => /^ {2}\{"td":"LA"/.test(l)).length, 4, 'one berth per line: 1 anchor + 3 hints');
  assert.ok(text.endsWith('}\n'));
});

test('an empty table is still valid JSON', () => {
  const none = analyseAnchors([], { crsForStanox: () => [], stations: STATIONS });
  const doc = JSON.parse(anchorsFileText({ generatedAt: 'x', smartFile: 'y', anchors: none }));
  assert.deepEqual(doc.anchors, []);
  assert.deepEqual(doc.hints, []);
});

test('writing is atomic and scrubs any secret that reached the text', () => {
  const dir = path.join(tmpdir(), 'nested', 'out');
  const file = path.join(dir, 'smart-anchors-x.json');
  const text = anchorsFileText({ generatedAt: 't', smartFile: '/path/with/hunter2$"x/smart.gz', anchors: ANCHORS });
  writeAnchorsFile(file, text, ['hunter2$"x']);
  assert.deepEqual(fs.readdirSync(dir), ['smart-anchors-x.json'], 'no .tmp left behind');
  const written = fs.readFileSync(file, 'utf8');
  assert.ok(!written.includes('hunter2'));
  assert.ok(written.includes('/path/with/***/smart.gz'));
  JSON.parse(written);
});

test('the memory probe keeps the highest heap sample, says where, and reports peak RSS and the limit', () => {
  const p = new MemoryProbe();
  const keep = [];
  for (let i = 0; i < 200; i++) keep.push(new Array(10000).fill(i));                 // some tens of MB
  p.sample('after allocating');
  keep.length = 0;
  p.sample('after releasing');
  const r = p.report();
  assert.ok(r.peakHeapUsedMB > 5, `peak ${r.peakHeapUsedMB} MB`);
  assert.ok(['after allocating', 'after releasing', 'end'].includes(r.peakHeapAt));
  assert.ok(r.heapLimitMB > 50);
  assert.ok(r.peakRssMB >= r.peakHeapUsedMB, 'resident memory is at least the heap in use');
  assert.equal(typeof r.peakRssMB, 'number');
});
