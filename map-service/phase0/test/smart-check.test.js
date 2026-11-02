'use strict';

// The whole script, offline: planted numbers on the synthetic fixtures, every failure mode as a sentence
// and a FAIL (never a stack trace), the download flow through an injected downloader, credentials never
// appearing anywhere, inputs never modified, and nothing written outside --out.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { main, parseOptions } = require('../lib/smart-check');
const { DownloadError } = require('../lib/download');
const { tmpdir, writeText, writeCorpus } = require('./smart-check-helpers');

const FIX = path.join(__dirname, 'fixtures');
const SMART = path.join(FIX, 'smart-synthetic.json');
const CORPUS = path.join(FIX, 'corpus-synthetic.json');
const TD = path.join(FIX, 'td-synthetic');
const BIN = path.join(__dirname, '..', 'bin', 'smart-check.js');

const sink = () => { const chunks = []; return { write: s => { chunks.push(String(s)); return true; }, text: () => chunks.join('') }; };

function readOut(out) {
  const files = fs.readdirSync(out).sort();
  const json = files.find(f => /^smart-check-.*\.json$/.test(f));
  const anchors = files.find(f => /^smart-anchors-.*\.json$/.test(f));
  return {
    files,
    report: json ? JSON.parse(fs.readFileSync(path.join(out, json), 'utf8')) : null,
    text: files.find(f => /^smart-check-.*\.txt$/.test(f)) ? fs.readFileSync(path.join(out, files.find(f => /\.txt$/.test(f))), 'utf8') : null,
    anchors: anchors ? JSON.parse(fs.readFileSync(path.join(out, anchors), 'utf8')) : null,
    anchorsText: anchors ? fs.readFileSync(path.join(out, anchors), 'utf8') : null
  };
}

/** Run main() on the fixtures (overridable) into a fresh out dir. */
async function run(extraArgs = [], deps = {}, { base = true } = {}) {
  const out = tmpdir('phase0-out-');
  const args = [...(base ? ['--smart-file', SMART, '--corpus', CORPUS, '--td-log-dir', TD] : []), '--out', out, ...extraArgs];
  const stdout = sink(), stderr = sink();
  const code = await main(args, { stdout, stderr, now: () => new Date('2026-11-02T10:15:00Z'), ...deps });
  return { code, out, stdout: stdout.text(), stderr: stderr.text(), ...readOut(out) };
}

const checkMap = r => Object.fromEntries(r.report.checks.map(c => [c.id, c]));
const ORDER = ['SMART_FORMAT', 'SMART_SEMANTICS', 'STATION_RESOLUTION', 'PORTSLADE_KNOWN_ANSWER', 'ANCHORS', 'LA_COVERAGE', 'SUSSEX'];

function snapshot(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) Object.assign(out, snapshot(p));
    else out[p] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') + ':' + fs.statSync(p).mtimeMs;
  }
  return out;
}

// ---- the planted run --------------------------------------------------------------------------------

test('the synthetic fixtures give the planted answer in every check, in order, with exit code 0', async () => {
  const r = await run();
  assert.equal(r.code, 0);
  assert.deepEqual(r.report.checks.map(c => c.id), ORDER);
  assert.deepEqual(r.report.checks.map(c => c.status), ['PASS', 'PASS', 'WARN', 'PASS', 'INFO', 'INFO', 'INFO']);
  const c = checkMap(r);

  // 31 rows; 14 testable groups: 12 exact, 1 one step apart (Hove's two-berth platform), 1 neither (Brighton)
  assert.equal(c.SMART_FORMAT.data.rows, 31);
  assert.equal(c.SMART_SEMANTICS.data.groups, 14);
  assert.deepEqual(c.SMART_SEMANTICS.data.ours, { exact: 12, adjacent: 1, none: 1 });
  assert.equal(c.SMART_SEMANTICS.data.pct.oursExact, 85.7);
  assert.equal(c.SMART_SEMANTICS.data.pct.oursAdjacent, 7.1);
  assert.equal(c.SMART_SEMANTICS.data.pct.reversedExact, 0);
  // every testable group here has exactly one arrival row and one departure row, so by row it is the same
  // 12 of 14 (85.7%) each way; Hove's split platform and Brighton's mismatch are the two that do not match
  assert.deepEqual(c.SMART_SEMANTICS.data.rowLevel, {
    arrivalRows: 14, departureRows: 14,
    ours: { arrivalMatched: 12, departureMatched: 12 }, reversed: { arrivalMatched: 0, departureMatched: 0 },
    pct: { oursArrival: 85.7, oursDeparture: 85.7, reversedArrival: 0, reversedDeparture: 0 }
  });

  // 10 STANOX: 9 stations, 8 with coordinates; the ninth (NOWHERE, CRS ZZZ) is the one unresolved
  assert.equal(c.STATION_RESOLUTION.data.stanoxes, 10);
  assert.equal(c.STATION_RESOLUTION.data.stationStanoxes, 9);
  assert.equal(c.STATION_RESOLUTION.data.resolved, 8);
  assert.deepEqual(c.STATION_RESOLUTION.data.unresolvedTop, [{ stanox: '90190', name: 'NOWHERE', crs: 'ZZZ', rows: 2 }]);

  assert.equal(c.PORTSLADE_KNOWN_ANSWER.data.stations.PLD.rows, 4);
  assert.deepEqual(c.PORTSLADE_KNOWN_ANSWER.data.stations.PLD.berths, ['0001', '0002', '0003', '0004', '0005', '0006']);
  assert.equal(c.PORTSLADE_KNOWN_ANSWER.data.southwick.outcome, 'confirmed');
  assert.deepEqual(c.PORTSLADE_KNOWN_ANSWER.data.southwick.arrivalTo, ['0006', '0007'], 'Southwick: the up arrival ends at 0006, the down one at 0007');
  assert.match(c.PORTSLADE_KNOWN_ANSWER.message, /Southwick \(SWK\) arrives into berth 0006 as expected\.$/);
  assert.equal(c.PORTSLADE_KNOWN_ANSWER.data.stations.PLD.rowsDetail, undefined, 'raw rows go in the notes, not the JSON data');

  // 15 anchors in 3 areas, 16 hints, one conflict (Shoreham 2 claims vs Edinburgh 1) 600 km apart
  assert.deepEqual(c.ANCHORS.data.totals, { anchors: 15, hints: 16, conflicts: 1, suspicious: 1, areas: 3, suspiciousKm: 5 });
  assert.equal(c.ANCHORS.data.suspiciousTop[0].berth, '0014');
  assert.deepEqual(c.ANCHORS.data.suspiciousTop[0].claimants.map(x => `${x.crs}:${x.n}`), ['SSE:2', 'EDB:1']);
  assert.ok(c.ANCHORS.data.suspiciousTop[0].maxKm > 590 && c.ANCHORS.data.suspiciousTop[0].maxKm < 610);

  // 17 LA berths seen; 9 anchored (52.9%); 15 within a step (88.2%); 2 unconnected (0102 whose only step was seen once, T999)
  assert.equal(c.LA_COVERAGE.data.berthsSeen, 17);
  assert.deepEqual(c.LA_COVERAGE.data.atHop, [9, 6, 0, 0]);
  assert.deepEqual(c.LA_COVERAGE.data.sharePct, [52.9, 88.2, 88.2, 88.2]);
  assert.equal(c.LA_COVERAGE.data.beyond, 2);
  assert.deepEqual(c.LA_COVERAGE.data.logs.files, ['2026-10-24', '2026-10-25']);
  assert.equal(c.LA_COVERAGE.data.td.bad, 2, 'one "not json" line and one half-written last line');

  // 14 anchored berths in the Sussex box (LA 12, LB 2); Edinburgh's are outside; 7 stations anchored
  assert.equal(c.SUSSEX.data.anchored, 14);
  assert.deepEqual(c.SUSSEX.data.byArea, { LA: 12, LB: 2 });
  assert.equal(c.SUSSEX.data.stationsAnchored, 7);
  assert.equal(c.SUSSEX.data.stationsWithoutAnchor.length, c.SUSSEX.data.stationsInBox - 7);
});

test('the paste-back block has the verdicts and the key facts, and every message is one short line', async () => {
  const r = await run();
  const block = r.stdout.slice(r.stdout.indexOf('===== smart-check'), r.stdout.indexOf('===== end smart-check =====') + 27);
  assert.match(block, /===== smart-check · 2026-11-02T10:15:00\.000Z · paste from here =====/);
  for (const id of ORDER) assert.match(block, new RegExp(`(PASS|WARN|FAIL|INFO)\\s+${id}\\s+\\S`), id);
  for (const key of ['smart.rows = 31', 'smart.tdAreas = 3', 'anchors.berths = 15', 'semantics.oursExactPct = 85.7', 'semantics.oursAdjacentPct = 7.1',
    'semantics.reversedExactPct = 0', 'semantics.rowOursArrivalPct = 85.7', 'semantics.rowOursDeparturePct = 85.7',
    'semantics.rowReversedArrivalPct = 0', 'semantics.rowReversedDeparturePct = 0', 'la.berthsSeen = 17', 'la.anchoredPct = 52.9', 'la.within1Pct = 88.2', 'la.within2Pct = 88.2', 'la.within3Pct = 88.2']) {
    assert.ok(block.includes(`fact  ${key}`), key);
  }
  assert.match(block, /fact {2}heap\.peakUsedMB = [\d.]+/);
  assert.match(block, /fact {2}process\.peakRssMB = [\d.]+/);
  for (const ch of r.report.checks) {
    assert.ok(!/[\r\n]/.test(ch.message), `${ch.id} message has a newline`);
    assert.ok(ch.message.length < 420, `${ch.id} message is ${ch.message.length} characters`);
  }
  assert.match(r.report.checks.find(c => c.id === 'SMART_SEMANTICS').message, /By row: 85\.7% of arrival rows end where some departure starts, and 85\.7% of departure rows start where some arrival ends \(reversed reading: 0% and 0%\)\.$/);
  assert.match(r.stdout, /Full report: .*smart-check-.*\.txt/);
  assert.match(r.stdout, /Anchor table \(for phase 1\): .*smart-anchors-.*\.json/);
});

test('the report records memory: heap and RSS peaks, the limit in force, and how the heap figure should be read', async () => {
  const r = await run();
  assert.ok(r.report.facts['heap.peakUsedMB'] > 0);
  assert.ok(r.report.facts['process.peakRssMB'] > 0);
  assert.match(r.report.facts['heap.detail'], /MB used at the sampled peak \(during: .+\) of a [\d.]+ MB limit; heap is sampled/);
  assert.equal(typeof r.report.facts['runtime.secs'], 'number');
  assert.equal(r.report.facts['node.version'], process.version);
});

test('the anchor table is valid JSON, one berth per line, and carries the planted conflict with every claimant', async () => {
  const r = await run();
  assert.equal(r.anchors.anchors.length, 15);
  assert.equal(r.anchors.hints.length, 16);
  assert.deepEqual(r.anchors.counts, { anchors: 15, hints: 16, conflicts: 1, suspicious: 1, areas: 3, suspiciousKm: 5 });
  const lines = r.anchorsText.split('\n');
  assert.equal(lines.filter(l => /^ {2}\{"td":/.test(l)).length, 31, '15 anchors + 16 hints, one per line');
  const e = r.anchors.anchors.find(a => a.td === 'LA' && a.berth === '0014');
  assert.equal(e.crs, 'SSE', 'Shoreham has 2 claims to Edinburgh\'s 1');
  assert.deepEqual(e.claims, { SSE: 2, EDB: 1 });
  assert.equal(e.suspicious, true);
  const swk = r.anchors.anchors.find(a => a.td === 'LA' && a.berth === '0006');
  assert.deepEqual([swk.crs, swk.lat, swk.lon], ['SWK', 50.832471, -0.237142], 'Southwick is at 0006, with the station table\'s coordinates');
  assert.equal(swk.claims, undefined);
});

test('inputs are only read: contents, timestamps and folder listings are unchanged, and the output has only our files', async () => {
  const before = { ...snapshot(FIX) };
  const listing = fs.readdirSync(TD).sort();
  const r = await run();
  assert.deepEqual(snapshot(FIX), before);
  assert.deepEqual(fs.readdirSync(TD).sort(), listing);
  assert.equal(r.files.length, 3, `smart-check .json, .txt and smart-anchors .json only, got ${r.files}`);
  assert.ok(!r.files.includes('data'), 'nothing was downloaded');
});

test('as a real process: exit code, and NOTHING is written outside --out (cwd, HOME and TMPDIR stay empty)', () => {
  const cwd = tmpdir('phase0-cwd-'), home = tmpdir('phase0-home-'), tmp = tmpdir('phase0-tmp-'), out = tmpdir('phase0-out-');
  const res = spawnSync(process.execPath, [BIN, '--smart-file', SMART, '--corpus', CORPUS, '--td-log-dir', TD, '--out', out], {
    cwd, env: { ...process.env, HOME: home, TMPDIR: tmp }, encoding: 'utf8'
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /===== end smart-check =====/);
  assert.deepEqual(fs.readdirSync(cwd), []);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.deepEqual(fs.readdirSync(tmp), []);
  assert.equal(fs.readdirSync(out).length, 3);
});

// ---- the command line -------------------------------------------------------------------------------

test('--help prints the usage and exits 0; unknown options and bad values exit 2 with a sentence and no stack', async () => {
  const help = await run(['--help'], {}, { base: false });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: node bin\/smart-check\.js/);
  for (const flag of ['--env', '--smart-file', '--corpus', '--stations', '--td-log-dir', '--td-days', '--out', '--naptan', '--debug']) assert.ok(help.stdout.includes(flag), flag);

  for (const args of [['--bogus'], ['--td-days', '0'], ['--td-days', 'x'], ['--td-days', '400'], ['--env'], ['stray']]) {
    const r = await run(args, {}, { base: false });
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /Run with --help for usage\./);
    assert.ok(!/\n\s+at /.test(r.stderr), 'no stack trace');
    assert.equal(r.stdout, '');
  }
  assert.match((await run(['--td-days', '0'], {}, { base: false })).stderr, /--td-days must be a whole number of days from 1 to 366\./);
});

test('the HELP puts this code at ~/rail-map on the VPS, while the defaults still read the crossing back end under ~/rail-crossing', async () => {
  const help = await run(['--help'], {}, { base: false });
  // the map service is its own worktree; ~/rail-crossing is the live crossing checkout and is never a place to run it from
  assert.match(help.stdout, /\n {2}cd ~\/rail-map\/map-service\/phase0\n {2}nice -n 19 node --max-old-space-size=256 bin\/smart-check\.js\n/);
  assert.ok(!/rail-crossing\/map-service/.test(help.stdout));
  // the files of the crossing back end are read where they are
  assert.match(help.stdout, /\(default ~\/rail-crossing\/backend\/\.env\)/);
  assert.match(help.stdout, /\(default ~\/rail-crossing\/backend\/data\/corpus\/corpus-latest\.json\.gz;/);
  assert.match(help.stdout, /TD logs \(default ~\/rail-crossing\/backend\/data\/logs\/td\)/);
});

test('no source file in the map service points at ~/rail-crossing/map-service: that checkout is the live crossing back end', () => {
  const root = path.join(__dirname, '..', '..');
  const folders = [path.join(root, 'phase0', 'lib'), path.join(root, 'phase0', 'bin'), path.join(root, 'scripts')];
  const files = folders.flatMap(dir => fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => path.join(dir, f)));
  assert.ok(files.length > 15, 'the scan really covers the code');
  for (const file of files) assert.ok(!/rail-crossing\/map-service/.test(fs.readFileSync(file, 'utf8')), `${path.relative(root, file)} mentions rail-crossing/map-service`);
});

test('as a real process: --help is 0, a bad flag is 2', () => {
  assert.equal(spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' }).status, 0);
  const bad = spawnSync(process.execPath, [BIN, '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown option/);
});

test('defaults: paths resolve, ~ expands, --out is relative to the phase0 folder by default and to the cwd when given', () => {
  const o = parseOptions([]);
  assert.equal(o.env, path.join(os.homedir(), 'rail-crossing/backend/.env'));
  assert.equal(o.corpus, path.join(os.homedir(), 'rail-crossing/backend/data/corpus/corpus-latest.json.gz'));
  assert.equal(o.corpusExplicit, false);
  assert.equal(o.tdLogDir, path.join(os.homedir(), 'rail-crossing/backend/data/logs/td'));
  assert.equal(o.tdDays, 7);
  assert.equal(o.out, path.resolve(__dirname, '..', 'out'));
  assert.equal(o.smartFile, null);
  assert.equal(o.stations, path.resolve(__dirname, '..', '..', 'data', 'stations.json'));
  const given = parseOptions(['--out', 'rel/dir', '--corpus', '~/c.gz', '--td-days', '3', '--naptan']);
  assert.equal(given.out, path.resolve('rel/dir'));
  assert.equal(given.corpus, path.join(os.homedir(), 'c.gz'));
  assert.equal(given.corpusExplicit, true);
  assert.equal(given.tdDays, 3);
  assert.equal(given.naptan, true);
});

test('an --out folder that cannot be created stops at once with exit 2 and does no work', async () => {
  const blocker = path.join(tmpdir(), 'a-file');
  fs.writeFileSync(blocker, 'x');
  const stdout = sink(), stderr = sink();
  const code = await main(['--smart-file', SMART, '--corpus', CORPUS, '--out', path.join(blocker, 'inside')], { stdout, stderr });
  assert.equal(code, 2);
  assert.match(stderr.text(), /Cannot write to the output folder .* \(ENOTDIR\): pass --out with a folder you can write to\./);
  assert.equal(stdout.text(), '');
});

// ---- failure modes: each is a FAIL with a sentence, dependents say they were skipped ---------------------

const SKIPPED = /^Skipped: /;

test('SMART that is not SMART (an HTML error page): SMART_FORMAT FAIL, every dependent check says it was skipped', async () => {
  const bad = writeText(tmpdir(), 'smart.html', '<html><body>503 Service Unavailable</body></html>');
  const r = await run(['--smart-file', bad]);
  assert.equal(r.code, 1);
  const c = checkMap(r);
  assert.equal(c.SMART_FORMAT.status, 'FAIL');
  assert.match(c.SMART_FORMAT.message, /No SMART rows could be read \(0 rows parsed\); the file starts: "<html><body>503 Service Unavailable<\/body><\/html>"/);
  for (const id of ORDER.slice(1)) {
    assert.equal(c[id].status, 'INFO', id);
    assert.match(c[id].message, SKIPPED, id);
  }
  assert.ok(!/\n\s+at /.test(r.stdout + r.stderr));
});

test('a missing --smart-file, a truncated gzip and a SMART missing its core fields each fail plainly', async () => {
  const missing = await run(['--smart-file', '/nonexistent/smart.json.gz']);
  assert.equal(missing.code, 1);
  assert.match(checkMap(missing).SMART_FORMAT.message, /^Could not read SMART: The file \/nonexistent\/smart\.json\.gz does not exist\.$/);

  const gz = zlib.gzipSync(fs.readFileSync(SMART));
  const cut = path.join(tmpdir(), 'cut.json.gz');
  fs.writeFileSync(cut, gz.subarray(0, gz.length - 20));
  const damaged = await run(['--smart-file', cut]);
  assert.match(checkMap(damaged).SMART_FORMAT.message, /is damaged or incomplete: gzip says .* Download it again\./);

  const other = writeText(tmpdir(), 'other.json', JSON.stringify({ BERTHDATA: [{ a: 1 }, { a: 2 }] }));
  const wrong = await run(['--smart-file', other]);
  assert.match(checkMap(wrong).SMART_FORMAT.message, /do not look like SMART: TD, FROMBERTH, TOBERTH, STANOX, EVENT missing from most rows\. Fields seen: a/);
  assert.equal(checkMap(wrong).SMART_SEMANTICS.status, 'INFO');
});

test('gzipped SMART (as NROD serves it) reads the same as plain', async () => {
  const gz = path.join(tmpdir(), 'smart.json.gz');
  fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(SMART)));
  const r = await run(['--smart-file', gz]);
  assert.equal(r.code, 0);
  assert.equal(checkMap(r).SMART_FORMAT.data.rows, 31);
  assert.equal(checkMap(r).SMART_FORMAT.data.compressed, true);
  assert.match(r.text, /gzip; /);
});

test('SMART_FORMAT can WARN (a different wrapper) and the analyses still run on the rows', async () => {
  const rows = JSON.parse(fs.readFileSync(SMART, 'utf8')).BERTHDATA;
  const file = writeText(tmpdir(), 'renamed.json', JSON.stringify({ SMARTDATA: rows }));
  const r = await run(['--smart-file', file]);
  const c = checkMap(r);
  assert.equal(c.SMART_FORMAT.status, 'WARN');
  assert.match(c.SMART_FORMAT.message, /the wrapper is \{"SMARTDATA":\[…\]\} not \{"BERTHDATA":\[…\]\}/);
  assert.equal(c.SMART_SEMANTICS.status, 'PASS');
  assert.equal(c.ANCHORS.data.totals.anchors, 15);
  assert.equal(r.code, 0, 'a WARN does not fail the run');
});

// Southwick (STANOX 90102) in the fixture: up arrival 0008>0006, up departure 0006>0004, down arrival 0005>0007,
// down departure 0007>(blank). Portslade's rows are untouched in all three runs below.
const fixtureRows = () => JSON.parse(fs.readFileSync(SMART, 'utf8')).BERTHDATA;
const smartFileOf = rows => writeText(tmpdir(), 'smart.json', JSON.stringify({ BERTHDATA: rows }));

test('Southwick CASE 2 end to end: arrivals that end elsewhere make PORTSLADE_KNOWN_ANSWER a WARN naming the berths, and a WARN does not fail the run', async () => {
  const rows = fixtureRows().map(x => (x.STANOX === '90102' && x.EVENT === 'A' ? { ...x, TOBERTH: '0004' } : x));
  const r = await run(['--smart-file', smartFileOf(rows)]);
  const c = checkMap(r);
  assert.equal(c.PORTSLADE_KNOWN_ANSWER.status, 'WARN');
  assert.equal(c.PORTSLADE_KNOWN_ANSWER.message,
    'Portslade (PLD) has 4 SMART rows in LA, and every berth they mention is on the known chains (0001, 0002, 0003, 0004, 0005, 0006). '
    + 'Southwick (SWK) is known to sit in berth 0006, but none of its 2 arrival rows in LA ends there (arrivals end at 0004, 0007; departures leave from 0006, 0007).');
  assert.equal(c.PORTSLADE_KNOWN_ANSWER.data.southwick.outcome, 'contradicted');
  assert.match(r.text, /Southwick: expected berth 0006\. Rows in LA: 4 \(2 arrival, 2 departure\); arrivals end at 0004, 0007; departures leave from 0006, 0007\. Result: CONTRADICTED/);
  assert.equal(r.code, 0, 'a WARN never fails the run');
});

test('Southwick CASE 3 end to end: no Southwick rows in SMART leaves PORTSLADE_KNOWN_ANSWER a PASS and says so plainly', async () => {
  const r = await run(['--smart-file', smartFileOf(fixtureRows().filter(x => x.STANOX !== '90102'))]);
  const c = checkMap(r);
  assert.equal(c.PORTSLADE_KNOWN_ANSWER.status, 'PASS');
  assert.match(c.PORTSLADE_KNOWN_ANSWER.message, /Southwick \(SWK\) has no SMART rows in area LA, so berth 0006 could not be checked \(it may simply have none\)\.$/);
  assert.equal(c.PORTSLADE_KNOWN_ANSWER.data.southwick.outcome, 'absent');
  assert.equal(r.code, 0);
});

test('Southwick CASE 1 with the directions the other way round: it is the arrival that counts, not which of A and C it is', async () => {
  // Swap which direction ends at 0006: the down arrival (C) now ends there and the up arrival (A) ends at 0007.
  const rows = fixtureRows().map(x => {
    if (x.STANOX !== '90102') return x;
    if (x.EVENT === 'A') return { ...x, TOBERTH: '0007' };
    if (x.EVENT === 'C') return { ...x, TOBERTH: '0006' };
    return x;
  });
  const r = await run(['--smart-file', smartFileOf(rows)]);
  assert.equal(checkMap(r).PORTSLADE_KNOWN_ANSWER.status, 'PASS');
  assert.equal(checkMap(r).PORTSLADE_KNOWN_ANSWER.data.southwick.outcome, 'confirmed');
});

test('a version key ahead of the data does not stop the wrapper being recognised, and the keys seen are in the message', async () => {
  const rows = JSON.parse(fs.readFileSync(SMART, 'utf8')).BERTHDATA;
  const file = writeText(tmpdir(), 'versioned.json', JSON.stringify({ VERSION: '2026-10-30', BERTHDATA: rows }));
  const r = await run(['--smart-file', file]);
  const c = checkMap(r);
  assert.equal(c.SMART_FORMAT.status, 'PASS');
  assert.match(c.SMART_FORMAT.message, /^SMART reads as documented: 31 rows inside \{"VERSION":…,"BERTHDATA":\[…\]\};/);
  assert.deepEqual(c.SMART_FORMAT.data.wrapper, { kind: 'object-with-array', key: 'BERTHDATA', keys: ['VERSION', 'BERTHDATA'] });
});

test('SMART that writes berth ids with an area prefix (LA0006) is flagged against TD logs that write 0006', async () => {
  const rows = JSON.parse(fs.readFileSync(SMART, 'utf8')).BERTHDATA.map(r => ({ ...r, FROMBERTH: r.FROMBERTH && r.TD + r.FROMBERTH, TOBERTH: r.TOBERTH && r.TD + r.TOBERTH }));
  const file = writeText(tmpdir(), 'prefixed.json', JSON.stringify({ BERTHDATA: rows }));
  const r = await run(['--smart-file', file]);
  const c = checkMap(r);
  assert.equal(c.LA_COVERAGE.data.anchoredSeen, 0);
  assert.match(c.LA_COVERAGE.message, /None of the 12 LA anchors appears among the berths in the TD logs: check that SMART and TD write berth ids the same way/);
  // sorted samples of both: the 12 anchors, 10 shown; the 17 berths in the logs, 10 shown
  assert.match(r.text, /berth id formats, for eyeballing that SMART and TD agree: LA anchors LA0003, LA0004, LA0005, LA0006, LA0007, LA0010, LA0014, LA0096, LA0104, LA0110 \+2 more; berths in the logs 0001, 0002, 0003, 0004, 0005, 0006, 0007, 0008, 0010, 0012 \+7 more/);
  // and the Portslade check, which compares berths with the known chains, shows the same mismatch from the other side
  assert.equal(c.PORTSLADE_KNOWN_ANSWER.status, 'WARN');
  assert.match(c.PORTSLADE_KNOWN_ANSWER.message, /outside the known chains: LA0001, LA0002/);
  assert.equal(r.code, 0);
});

test('SMART and CORPUS that write STANOX at different widths: the facts show it, and the message names it', async () => {
  const rows = JSON.parse(fs.readFileSync(SMART, 'utf8')).BERTHDATA.map(r => ({ ...r, STANOX: r.STANOX + '0' }));      // 6 characters
  const file = writeText(tmpdir(), 'wide.json', JSON.stringify({ BERTHDATA: rows }));
  const r = await run(['--smart-file', file]);
  const c = checkMap(r);
  assert.deepEqual(c.SMART_FORMAT.data.stanoxLengths, { 6: 31 });
  assert.deepEqual(r.report.facts['corpus.format'].stanoxLengths, { 5: 12 });
  assert.equal(c.STATION_RESOLUTION.status, 'FAIL');
  assert.match(c.STATION_RESOLUTION.message, /None of the 10 SMART timing points \(STANOX\) has a CRS in CORPUS, so no station can be placed\. SMART STANOX are mostly 6 characters long but CORPUS's are 5/);
  assert.match(r.text, /SMART STANOX widths in characters \(0 = blank\): \{"6":31\}/);
  assert.match(r.text, /CORPUS STANOX widths in characters: \{"5":12\}/);
});

test('an explicit --corpus that does not exist is an error, not a silent download', async () => {
  let downloads = 0;
  const r = await run(['--corpus', '/nonexistent/corpus.json.gz'], { downloadFile: async () => { downloads++; } });
  assert.equal(downloads, 0);
  assert.equal(r.code, 1);
  const c = checkMap(r);
  assert.match(c.STATION_RESOLUTION.message, /^Cannot tie SMART to stations: The CORPUS file \/nonexistent\/corpus\.json\.gz \(from --corpus\) does not exist\.$/);
  assert.equal(c.SMART_FORMAT.status, 'PASS');
  assert.equal(c.SMART_SEMANTICS.status, 'PASS', 'what does not need CORPUS still runs');
  for (const id of ['PORTSLADE_KNOWN_ANSWER', 'ANCHORS', 'LA_COVERAGE', 'SUSSEX']) assert.match(c[id].message, /^Skipped: CORPUS could not be read\.$/, id);
});

test('a CORPUS that cannot tie a STANOX to a CRS fails STATION_RESOLUTION with the reason', async () => {
  const noStanox = writeCorpus(tmpdir(), [{ TIPLOC: 'PSLDAWH', '3ALPHA': 'PLD' }]);
  const r = await run(['--corpus', noStanox]);
  assert.equal(r.code, 1);
  assert.match(checkMap(r).STATION_RESOLUTION.message, /^Cannot tie SMART to stations: no CORPUS row has a STANOX value, so SMART cannot be tied to stations \(1 rows; fields seen: TIPLOC, 3ALPHA\)\.$/);
  assert.match(checkMap(r).ANCHORS.message, /^Skipped: CORPUS cannot be used\.$/);
});

test('a missing station table fails STATION_RESOLUTION and skips what needs coordinates', async () => {
  const r = await run(['--stations', '/nonexistent/stations.json']);
  assert.equal(r.code, 1);
  const c = checkMap(r);
  assert.match(c.STATION_RESOLUTION.message, /^Cannot tie SMART to stations: Cannot read the station table \/nonexistent\/stations\.json \(ENOENT\)\. It is generated by map-service\/scripts\/build-stations\.js/);
  assert.equal(c.SMART_SEMANTICS.status, 'PASS');
  for (const id of ['PORTSLADE_KNOWN_ANSWER', 'ANCHORS', 'LA_COVERAGE', 'SUSSEX']) assert.match(c[id].message, /^Skipped: the station table could not be read\.$/, id);
});

test('a custom --stations table is used: moving Shoreham out of the Sussex box takes its two LA anchors out of the Sussex count', async () => {
  const table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'stations.json'), 'utf8'));
  table.stations.SSE = { name: 'Moved', lat: 55.95, lon: -3.19 };
  const file = writeText(tmpdir(), 'stations.json', JSON.stringify(table));
  const r = await run(['--stations', file]);
  // Shoreham anchors LA 0014 (its conflict with Edinburgh is now only a few km, so no longer suspicious) and LA 0096.
  // Of the 12 LA anchors that leaves 10 inside the box.
  assert.equal(checkMap(r).SUSSEX.data.byArea.LA, 10);
  assert.equal(checkMap(r).SUSSEX.data.stationsAnchored, 6);
  assert.equal(checkMap(r).ANCHORS.data.totals.suspicious, 0);
});

test('missing TD logs are not an error: LA_COVERAGE says so and the run still passes', async () => {
  const none = await run(['--td-log-dir', '/nonexistent/td']);
  assert.equal(none.code, 0);
  assert.match(checkMap(none).LA_COVERAGE.message, /^No TD logs to measure coverage from: \/nonexistent\/td - the folder does not exist\.$/);
  assert.equal(checkMap(none).LA_COVERAGE.status, 'INFO');
  const empty = await run(['--td-log-dir', tmpdir()]);
  assert.match(checkMap(empty).LA_COVERAGE.message, /^No TD log files \(td-YYYY-MM-DD\.jsonl\) in .*, so coverage was not measured\.$/);
  assert.equal(empty.code, 0);
  assert.ok(!('la.berthsSeen' in empty.report.facts));
});

test('--td-days narrows the window counted back from the newest file', async () => {
  const one = await run(['--td-days', '1']);
  assert.deepEqual(checkMap(one).LA_COVERAGE.data.logs.files, ['2026-10-25']);
  assert.match(checkMap(one).LA_COVERAGE.message, /1 day of TD logs \(2026-10-25\)/);
});

// ---- downloads, through an injected downloader ------------------------------------------------------

const PASSWORD = 'p$ss"w\\rd\'x';
const LOGIN = 'rich@example.com';
function envFile() { return writeText(tmpdir(), 'backend.env', `# comment\nNR_FEED_USER=${LOGIN}\nNR_FEED_PASS=${PASSWORD}\nOTHER=1\n`); }
const allText = r => [r.stdout, r.stderr, r.text, JSON.stringify(r.report), r.anchorsText || ''].join('\n');
function assertNoSecrets(r, extra = []) {
  const basic = Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
  for (const secret of [PASSWORD, JSON.stringify(PASSWORD).slice(1, -1), LOGIN, basic, encodeURIComponent(PASSWORD), ...extra]) {
    assert.ok(!allText(r).includes(secret), `leaked ${secret}`);
  }
  for (const f of r.files) {
    const p = path.join(r.out, f);
    if (fs.statSync(p).isFile()) for (const s of [PASSWORD, LOGIN, basic]) assert.ok(!fs.readFileSync(p, 'utf8').includes(s), `leaked into ${f}`);
  }
}

// A downloader that copies a fixture to where the script asked, as NROD's would deliver it.
function fakeDownloader(calls) {
  return async o => {
    calls.push(o);
    fs.mkdirSync(path.dirname(o.dest), { recursive: true });
    fs.copyFileSync(/type=CORPUS/.test(o.url) ? CORPUS : SMART, o.dest);
    return { path: o.dest, bytes: fs.statSync(o.dest).size, redirects: 1, hosts: ['publicdatafeeds.networkrail.co.uk', 's3.example'], contentType: 'application/gzip', contentEncoding: null };
  };
}

test('no --smart-file and no CORPUS at the default path: both are downloaded into <out>/data, with the login read literally from .env', async () => {
  const calls = [];
  const env = envFile(), out = tmpdir('phase0-out-');
  const stdout = sink(), stderr = sink();
  // The default CORPUS path is under the home folder; an empty HOME means it does not exist.
  const savedHome = process.env.HOME;
  process.env.HOME = tmpdir('phase0-home-');
  let code;
  try {
    code = await main(['--env', env, '--td-log-dir', TD, '--out', out], { stdout, stderr, downloadFile: fakeDownloader(calls), now: () => new Date('2026-11-02T10:15:00Z') });
  } finally { process.env.HOME = savedHome; }

  assert.equal(code, 0, stderr.text());
  assert.deepEqual(calls.map(c => c.url.split('?type=')[1]), ['CORPUS', 'SMART'], 'CORPUS first, then SMART');
  for (const c of calls) {
    assert.deepEqual(c.auth, { user: LOGIN, pass: PASSWORD }, 'the password is the literal one, $ and quotes included');
    assert.equal(c.serverName, 'NROD');
    assert.equal(c.authHint, `check NR_FEED_USER / NR_FEED_PASS in ${env}`);
    assert.equal(path.dirname(c.dest), path.join(out, 'data'), 'downloads go in <out>/data');
  }
  assert.deepEqual(calls.map(c => path.basename(c.dest)), ['corpus-latest.json.gz', 'smart-latest.json.gz']);

  const read = readOut(out);
  assert.ok(read.files.includes('data'));
  assert.equal(read.report.facts['smart.source'], 'downloaded');
  assert.equal(read.report.facts['corpus.source'], 'downloaded');
  assert.deepEqual(read.report.facts['smart.download'].hosts, ['publicdatafeeds.networkrail.co.uk', 's3.example']);
  assert.match(stderr.text(), /CORPUS not found at .*; downloading it into .*\/data \.\.\./);
  assert.match(stderr.text(), /Downloading SMART from NROD into .*\/data \.\.\./);
  assertNoSecrets({ ...read, out, stdout: stdout.text(), stderr: stderr.text() });
});

test('an existing CORPUS is used as it is, and only SMART is downloaded', async () => {
  const calls = [];
  const r = await run(['--env', envFile(), '--corpus', CORPUS], { downloadFile: fakeDownloader(calls) }, { base: false });
  assert.equal(r.code, 0);
  assert.deepEqual(calls.map(c => c.url.split('?type=')[1]), ['SMART']);
  assert.equal(r.report.facts['corpus.source'], 'file');
  assert.equal(r.report.facts['smart.source'], 'downloaded');
});

test('HTTP 401: SMART_FORMAT FAIL with the actionable sentence, dependents skipped, exit 1, no secrets, no stack', async () => {
  const env = envFile();
  const downloadFile = async o => { throw new DownloadError('AUTH', `NROD refused the login (HTTP 401): ${o.authHint}`, { status: 401 }); };
  const r = await run(['--env', env, '--corpus', CORPUS], { downloadFile }, { base: false });
  assert.equal(r.code, 1);
  const c = checkMap(r);
  assert.equal(c.SMART_FORMAT.message, `Could not read SMART: NROD refused the login (HTTP 401): check NR_FEED_USER / NR_FEED_PASS in ${env}`);
  for (const id of ORDER.slice(1)) assert.match(c[id].message, SKIPPED, id);
  assert.ok(!/\n\s+at /.test(r.stdout + r.stderr));
  assertNoSecrets(r);
});

test('a download error that happens to quote the password is scrubbed everywhere it could appear', async () => {
  const env = envFile();
  const basic = Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
  const downloadFile = async () => {
    throw new DownloadError('HTTP', `NROD answered HTTP 418 for ${LOGIN} with password ${PASSWORD}, JSON ${JSON.stringify(PASSWORD)}, header Basic ${basic}`);
  };
  const r = await run(['--env', env, '--corpus', CORPUS], { downloadFile }, { base: false });
  assert.equal(r.code, 1);
  assert.match(checkMap(r).SMART_FORMAT.message, /^Could not read SMART: NROD answered HTTP 418 for \*\*\* with password \*\*\*/);
  assertNoSecrets(r);
});

test('--debug stack traces go through the same scrubbing: an error that quotes the password never reaches stderr unmasked', async () => {
  const env = envFile();
  const basic = Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
  const downloadFile = async () => { throw new Error(`the server echoed ${PASSWORD} and ${LOGIN} and Basic ${basic}`); };
  const r = await run(['--env', env, '--corpus', CORPUS, '--debug'], { downloadFile }, { base: false });
  assert.match(r.stderr, /Error: the server echoed \*\*\* and \*\*\* and Basic \*\*\*\n\s+at /, 'the stack is shown, with the secrets masked');
  assertNoSecrets(r);
});

test('an --out folder that does not exist yet (the normal first run) is created, nested folders included', async () => {
  const base = tmpdir('phase0-fresh-');
  const out = path.join(base, 'not', 'yet', 'there');
  const stdout = sink(), stderr = sink();
  const code = await main(['--smart-file', SMART, '--corpus', CORPUS, '--td-log-dir', TD, '--out', out], { stdout, stderr });
  assert.equal(code, 0, stderr.text());
  assert.equal(readOut(out).files.length, 3);
  assert.deepEqual(fs.readdirSync(base), ['not'], 'and nothing else appeared beside it');
});

test('credentials are only read when something must be downloaded', async () => {
  let calls = 0;
  const r = await run(['--env', '/nonexistent/.env'], { downloadFile: async () => { calls++; } });
  assert.equal(r.code, 0, 'a missing .env does not matter when nothing needs downloading');
  assert.equal(calls, 0);
});

test('a download that needs credentials but cannot find them says where to look', async () => {
  const noFile = await run(['--env', '/nonexistent/.env', '--corpus', CORPUS], { downloadFile: async () => { throw new Error('must not be reached'); } }, { base: false });
  assert.equal(noFile.code, 1);
  assert.match(checkMap(noFile).SMART_FORMAT.message, /^Could not read SMART: Cannot read the credentials file \/nonexistent\/\.env \(ENOENT\)\. Pass --env with the path to the crossing back end's \.env file\.$/);

  const noPass = writeText(tmpdir(), 'half.env', `NR_FEED_USER=${LOGIN}\n`);
  const r = await run(['--env', noPass, '--corpus', CORPUS], { downloadFile: async () => { throw new Error('must not be reached'); } }, { base: false });
  assert.equal(checkMap(r).SMART_FORMAT.message, `Could not read SMART: NR_FEED_USER and NR_FEED_PASS must both be set in ${noPass}.`);
});

test('an unexpected error becomes a FAIL naming the stage and the --debug hint, and --debug adds the stack on stderr only', async () => {
  const boom = async () => { throw new TypeError('something odd inside the downloader'); };
  const quiet = await run(['--env', envFile(), '--corpus', CORPUS], { downloadFile: boom }, { base: false });
  assert.equal(quiet.code, 1);
  assert.equal(checkMap(quiet).SMART_FORMAT.message, 'Could not read SMART: unexpected error while reading SMART: something odd inside the downloader (re-run with --debug for the details)');
  assert.ok(!/\n\s+at /.test(quiet.stderr + quiet.stdout));

  const loud = await run(['--env', envFile(), '--corpus', CORPUS, '--debug'], { downloadFile: boom }, { base: false });
  assert.match(loud.stderr, /TypeError: something odd inside the downloader\n\s+at /);
  assert.ok(!/\n\s+at /.test(loud.stdout), 'the stack goes to stderr, not into the paste-back');
  assert.ok(!/re-run with --debug/.test(checkMap(loud).SMART_FORMAT.message));
});

// ---- NaPTAN -----------------------------------------------------------------------------------------

test('--naptan adds NAPTAN_PROBE (INFO when it works, WARN when it fails) and is absent without the flag', async () => {
  const without = await run();
  assert.ok(!checkMap(without).NAPTAN_PROBE);

  let seenTiplocs = null;
  const ok = await run(['--naptan'], {
    probeNaptan: async ({ tiplocs }) => {
      seenTiplocs = tiplocs;
      return { ok: true, status: 200, host: 'naptan.example', redirects: 0, seconds: 1.2, contentType: 'text/csv', contentEncoding: null, bytes: 99,
        header: ['ATCOCode', 'CommonName'], hasAtcoColumn: true, rows: 3, ragged: 0, rail: 2, railWithTiplocInCorpus: 1, tiplocsChecked: true,
        knownCodeFound: true, prefixes: { 9100: 2 }, stopTypes: { RLY: 2 }, sample: [{ ATCOCode: '9100PSLDAWH' }] };
    }
  });
  assert.ok(seenTiplocs instanceof Set && seenTiplocs.has('PSLDAWH'), 'the probe is given CORPUS\'s TIPLOCs');
  assert.equal(checkMap(ok).NAPTAN_PROBE.status, 'INFO');
  assert.equal(ok.code, 0);
  assert.equal(ok.report.checks.at(-1).id, 'NAPTAN_PROBE', 'it comes last');

  const failed = await run(['--naptan'], { probeNaptan: async () => ({ ok: false, reason: 'HTTP 404 from naptan.example' }) });
  assert.equal(checkMap(failed).NAPTAN_PROBE.status, 'WARN');
  assert.equal(failed.code, 0, 'a failed probe never fails the run');
  assert.match(checkMap(failed).NAPTAN_PROBE.message, /^NaPTAN probe failed: HTTP 404 from naptan\.example/);

  const threw = await run(['--naptan'], { probeNaptan: async () => { throw new Error('the probe itself blew up'); } });
  assert.equal(checkMap(threw).NAPTAN_PROBE.status, 'WARN', 'even a probe that throws is only a WARN');
  assert.match(checkMap(threw).NAPTAN_PROBE.message, /unexpected error: the probe itself blew up/);
  assert.equal(threw.code, 0);
  assert.equal(checkMap(threw).ANCHORS.status, 'INFO', 'and everything before it is still reported');
});

// ---- the report scrubs secrets registered after it was created ---------------------------------------

test('a secret registered AFTER the Report was built is still scrubbed (guards the shared Report contract)', async () => {
  const env = envFile();
  const downloadFile = async o => { throw new DownloadError('HTTP', `server echoed ${o.auth.pass} and ${o.auth.user}`); };
  const r = await run(['--env', env, '--corpus', CORPUS], { downloadFile }, { base: false });
  assert.match(checkMap(r).SMART_FORMAT.message, /^Could not read SMART: server echoed \*\*\* and \*\*\*$/);
});
