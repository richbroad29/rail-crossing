'use strict';

// TD log reading and LA coverage, on a fixture log whose hop distances are known.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { findTdLogFiles, readTdLogs } = require('../lib/td-logs');
const { analyseCoverage, describeCoverage } = require('../lib/coverage');
const { tmpdir, writeText } = require('./smart-check-helpers');

const line = (event, from, to, extra = {}) => JSON.stringify({ ts: '2026-10-25T14:02:10.000Z', area: 'LA', event, desc: '1H15', from: from ?? null, to: to ?? null, trust_uid: null, ...extra });

// The eastbound chain, one step per line.
const CHAIN = ['0016', '0014', '0012', '0010', '0008', '0006', '0004', '0002'];
const chainSteps = () => CHAIN.slice(0, -1).map((b, i) => line('CA', b, CHAIN[i + 1]));

/**
 * Two days of logs, each with every chain step once (so every chain step is seen exactly twice), plus:
 *   0006>0100 once only          (seen too few times to count as a connection)
 *   a CC interpose at T999       (a berth with no steps at all)
 *   a CB cancel at 0016          (a berth from a cancel)
 * and noise that must be ignored or counted as bad: another area, a non-JSON line, a blank line, a
 * heartbeat event, a half-written last line. A third, OLD file holds berth 9999, outside any window.
 */
function makeLogDir() {
  const dir = tmpdir('phase0-td-');
  writeText(dir, 'td-2026-10-24.jsonl', [
    ...chainSteps(),
    line('CA', '0006', '0100'),
    line('CC', null, 'T999'),
    line('CA', '0001', '0002', { area: 'SX' }),
    'this is not json',
    '',
    line('CT', null, null)
  ].join('\n') + '\n');
  writeText(dir, 'td-2026-10-25.jsonl', [
    ...chainSteps(),
    line('CB', '0016', null),
    line('CA', '0004', '0004'),                              // a step to the same berth: not an edge
    '{"ts":"2026-10-25T23:59:59.000Z","area":"LA","event":"CA","from":"00'    // cut off mid-write
  ].join('\n'));
  writeText(dir, 'td-2026-10-10.jsonl', line('CA', '9998', '9999') + '\n');
  writeText(dir, 'notes.txt', 'not a log');
  return dir;
}

test('findTdLogFiles: the window is counted back from the newest file, and other names are ignored', () => {
  const dir = makeLogDir();
  const w7 = findTdLogFiles(dir, 7);
  assert.deepEqual(w7.files.map(f => f.date), ['2026-10-24', '2026-10-25']);
  assert.equal(w7.found, 3);
  assert.equal(w7.newest, '2026-10-25');
  assert.equal(w7.oldest, '2026-10-24');
  assert.deepEqual(findTdLogFiles(dir, 1).files.map(f => f.date), ['2026-10-25']);
  assert.deepEqual(findTdLogFiles(dir, 365).files.map(f => f.date), ['2026-10-10', '2026-10-24', '2026-10-25']);
  assert.equal(findTdLogFiles(dir, 16).files.length, 3, '15 days back is inside a 16-day window');
  assert.equal(findTdLogFiles(dir, 15).files.length, 2, '15 days back is outside a 15-day window');
});

test('findTdLogFiles: a missing folder and an empty folder are answers, not errors', () => {
  const missing = findTdLogFiles('/nonexistent/td', 7);
  assert.equal(missing.readable, false);
  assert.match(missing.reason, /does not exist/);
  assert.deepEqual(missing.files, []);
  const empty = findTdLogFiles(tmpdir(), 7);
  assert.equal(empty.readable, true);
  assert.deepEqual(empty.files, []);
  assert.equal(empty.newest, null);
});

test('findTdLogFiles: a plain and a gzipped file for the same day are not both read', () => {
  const dir = tmpdir();
  writeText(dir, 'td-2026-10-25.jsonl.gz', line('CA', '1', '2') + '\n');
  writeText(dir, 'td-2026-10-25.jsonl', line('CA', '3', '4') + '\n');
  const r = findTdLogFiles(dir, 7);
  assert.equal(r.files.length, 1);
  assert.ok(r.files[0].file.endsWith('td-2026-10-25.jsonl'));
});

test('readTdLogs: berths, steps and what was skipped, with a gzipped day and a half-written last line', async () => {
  const dir = makeLogDir();
  writeText(dir, 'td-2026-10-23.jsonl.gz', line('CA', '0002', '0000') + '\n');       // gzipped, inside the window
  const t = await readTdLogs(findTdLogFiles(dir, 7).files);

  assert.deepEqual([...t.berths].sort(), ['0000', '0002', '0004', '0006', '0008', '0010', '0012', '0014', '0016', '0100', 'T999']);
  assert.ok(!t.berths.has('9999'), 'the old file is outside the window');
  assert.ok(!t.berths.has('0001'), 'the SX line is another area');
  assert.ok(t.stepBerths.has('0100') && !t.stepBerths.has('T999'), 'T999 came from an interpose, not a step');
  assert.equal(t.edges.get('0006').get('0004'), 2, 'each chain step was seen once per day');
  assert.equal(t.edges.get('0006').get('0100'), 1);
  assert.equal(t.edges.get('0004').has('0004'), false, 'a step from a berth to itself is not an edge');
  assert.equal(t.edges.get('0004').get('0002'), 2, 'but its real step onward is, seen on both days');
  assert.equal(t.edges.get('0002').get('0000'), 1);

  assert.equal(t.bad, 2, 'the "not json" line and the half-written last line');
  // Non-blank lines per file, counted from makeLogDir: 10-23 has 1; 10-24 has 7 chain steps + 0006>0100 +
  // the CC + the SX line + "not json" + the CT = 12 (the blank line is not counted); 10-25 has 7 chain
  // steps + the CB + the 0004>0004 step + the half-written line = 10.
  assert.deepEqual(t.perFile.map(f => [f.date, f.lines, f.bad]), [['2026-10-23', 1, 0], ['2026-10-24', 12, 1], ['2026-10-25', 10, 1]]);
  // CA lines in area LA: 1 (10-23) + 7 + 1 (10-24) + 7 + 1 (10-25) = 17. The SX line is excluded.
  assert.deepEqual(t.events, { CA: 17, CB: 1, CC: 1, CT: 1 });
  assert.equal(t.areaLines, 20);
});

test('readTdLogs: one unreadable day does not lose the others', async () => {
  const dir = makeLogDir();
  const files = findTdLogFiles(dir, 7).files;
  files.splice(1, 0, { date: '2026-10-24x', file: path.join(dir, 'td-2026-10-99.jsonl') });  // does not exist
  const t = await readTdLogs(files);
  assert.equal(t.perFile.filter(f => f.error).length, 1);
  assert.equal(t.perFile.find(f => f.error).error, 'FILE_MISSING');
  assert.ok(t.berths.has('0006'));
});

test('readTdLogs: another area can be asked for, and CRLF line ends are fine', async () => {
  const dir = tmpdir();
  writeText(dir, 'td-2026-10-25.jsonl', [line('CA', 'A1', 'A2', { area: 'SX' }), line('CA', 'B1', 'B2')].join('\r\n') + '\r\n');
  const t = await readTdLogs(findTdLogFiles(dir, 7).files, { area: 'SX' });
  assert.deepEqual([...t.berths].sort(), ['A1', 'A2']);
  assert.equal(t.areaLines, 1);
});

// ---- coverage ---------------------------------------------------------------------------------------

test('coverage: planted hop distances on the chain, an unconnected berth, and a step seen once', async () => {
  const t = await readTdLogs(findTdLogFiles(makeLogDir(), 7).files);
  const cov = analyseCoverage({ berths: t.berths, edges: t.edges, anchored: new Set(['0006']) });

  // 10 berths seen: the 8 chain berths, 0100 (reached only by a step seen once) and T999 (no steps).
  // From the anchor 0006 along steps seen at least twice:
  //   0 steps: 0006                 1: 0008 0004                  2: 0010 0002                 3: 0012
  //   not within 3: 0014 0016 (4 and 5 steps), 0100 (its only step was seen once), T999 (no steps)
  assert.equal(cov.berthsSeen, 10);
  assert.deepEqual(cov.atHop, [1, 2, 2, 1]);
  assert.deepEqual(cov.within, [1, 3, 5, 6]);
  assert.deepEqual(cov.sharePct, [10, 30, 50, 60]);
  assert.equal(cov.beyond, 4);
  assert.equal(cov.anchoredSeen, 1);
  assert.deepEqual(cov.edges, { distinct: 8, usable: 7, seenTooFew: 1 });
});

test('coverage: counting the step seen once as a connection (minEdgeCount 1) pulls 0100 in at 1 step', async () => {
  const t = await readTdLogs(findTdLogFiles(makeLogDir(), 7).files);
  const cov = analyseCoverage({ berths: t.berths, edges: t.edges, anchored: new Set(['0006']), minEdgeCount: 1 });
  assert.deepEqual(cov.atHop, [1, 3, 2, 1]);
  assert.equal(cov.edges.seenTooFew, 0);
});

test('coverage: distance is undirected, so berths behind an anchor count as well as those ahead', () => {
  const edges = new Map([['A', new Map([['B', 2]])], ['B', new Map([['C', 2]])], ['C', new Map([['D', 2]])]]);
  const berths = new Set(['A', 'B', 'C', 'D']);
  const cov = analyseCoverage({ berths, edges, anchored: new Set(['C']) });
  assert.deepEqual(cov.atHop, [1, 2, 1, 0], 'C at 0; B and D at 1; A at 2');
});

test('coverage: the nearest of several anchors decides, and anchors not seen in the logs are only counted', () => {
  const edges = new Map([['A', new Map([['B', 2]])], ['B', new Map([['C', 2]])], ['C', new Map([['D', 2]])], ['D', new Map([['E', 2]])]]);
  const berths = new Set(['A', 'B', 'C', 'D', 'E']);
  const cov = analyseCoverage({ berths, edges, anchored: new Set(['A', 'E', 'NEVER-SEEN']) });
  assert.deepEqual(cov.atHop, [2, 2, 1, 0], 'A and E at 0; B and D at 1; C at 2 from either');
  assert.equal(cov.anchorsInArea, 3);
  assert.equal(cov.anchorsNotSeen, 1);
});

test('coverage message: anchors that never appear in the logs point at a berth-id format mismatch', () => {
  const logs = { files: [{ date: '2026-10-25' }], oldest: '2026-10-25', newest: '2026-10-25' };
  const edges = new Map([['0001', new Map([['0003', 2]])]]);
  const prefixed = analyseCoverage({ berths: new Set(['0001', '0003']), edges, anchored: new Set(['LA0001', 'LA0003', 'LA0005']) });
  assert.equal(prefixed.anchorsInArea, 3);
  assert.equal(prefixed.anchoredSeen, 0);
  const msg = describeCoverage(prefixed, { logs });
  assert.match(msg, /^LA: 2 berths seen in 1 day of TD logs \(2026-10-25\); 0% are anchored at a station,/);
  assert.match(msg, /None of the 3 LA anchors appears among the berths in the TD logs: check that SMART and TD write berth ids the same way \(prefix, zero padding\)\.$/);

  // with at least one anchor seen, or with no anchors at all, there is nothing to say
  const ok = analyseCoverage({ berths: new Set(['0001', '0003']), edges, anchored: new Set(['0001']) });
  assert.ok(!/None of the/.test(describeCoverage(ok, { logs })));
  const noAnchors = analyseCoverage({ berths: new Set(['0001']), edges, anchored: new Set() });
  assert.ok(!/None of the/.test(describeCoverage(noAnchors, { logs })));
});

test('coverage: no anchors, no berths and no edges are all fine', () => {
  const none = analyseCoverage({ berths: new Set(['A', 'B']), edges: new Map(), anchored: new Set() });
  assert.deepEqual(none.within, [0, 0, 0, 0]);
  assert.equal(none.beyond, 2);
  const empty = analyseCoverage({ berths: new Set(), edges: new Map(), anchored: new Set(['X']) });
  assert.deepEqual(empty.sharePct, [0, 0, 0, 0]);
  assert.equal(empty.berthsSeen, 0);
});
