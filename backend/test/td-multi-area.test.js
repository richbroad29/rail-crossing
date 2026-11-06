'use strict';

// Multi-area TD ingest (multi-crossing-readiness.md, Phase A step 2).
//
// 1. td-paths: area LA (Portslade) keeps EXACTLY its old log path; other areas get a subfolder.
// 2. td-listener: the areas that drive crossings come from config, not a hard-coded 'LA';
//    an S-Class area that is also a crossing area is logged both ways, never diverted.
// 3. td-rotation: per-area subfolders are gzipped/pruned like the top level.
//
// Every write goes to a temp folder — nothing touches data/logs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const tdPaths = require('../src/td-paths');
const td = require('../src/td-listener');
const rotation = require('../src/td-rotation');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS  ${label}`); pass++; }
  else {
    console.log(`  FAIL  ${label}`);
    console.log(`          got:      ${actual}`);
    console.log(`          expected: ${expected}`);
    fail++;
  }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const readLines = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);

(async () => {
  console.log('\nMulti-area TD ingest\n');

  // ---- 1. paths ---------------------------------------------------------------------------
  console.log('  -- td-paths --');
  const ROOT = path.join(__dirname, '..', 'data', 'logs', 'td');
  check('LA log dir is unchanged (data/logs/td)', tdPaths.tdLogDir('LA'), ROOT);
  check('LA log file is unchanged (td-<date>.jsonl at the top level)',
    tdPaths.tdLogFile('LA', '2026-11-06'), path.join(ROOT, 'td-2026-11-06.jsonl'));
  check('another area gets its own subfolder', tdPaths.tdLogFile('BM', '2026-11-06'),
    path.join(ROOT, 'BM', 'td-2026-11-06.jsonl'));
  let threw = false;
  try { tdPaths.tdLogDir('../x'); } catch (_) { threw = true; }
  check('an invalid area id is refused (it would become a path)', threw, true);
  check('live config needs exactly area LA',
    tdPaths.crossingTdAreas(require('../config/crossings.json')).join(','), 'LA');
  check('areas are de-duplicated, area-less crossings skipped',
    tdPaths.crossingTdAreas({ a: { td: { area: 'LA' } }, b: { td: { area: 'BM' } }, c: { td: { area: 'LA' } }, d: {} }).join(','),
    'LA,BM');

  // ---- 2. listener routing ----------------------------------------------------------------
  console.log('  -- td-listener routing --');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-multi-area-'));
  const tdFile = area => path.join(tmp, 'td', area, 'td.jsonl');
  const ccFile = area => path.join(tmp, 'cclass', area, 'cc.jsonl');
  td._setLogFilesForTest({ td: tdFile, cclass: ccFile });

  const sightings = [];
  td.on('sighting', s => sightings.push(`${s.area}:${s.headcode}:${s.to}`));

  const ca = (area, descr, from, to) => ({ CA_MSG: { area_id: area, msg_type: 'CA', descr, from, to, time: String(Date.now()) } });
  const frame = () => JSON.stringify([
    ca('LA', '1H23', '0008', '0006'),
    ca('BM', '2N77', '0008', '0006'),  // an S-Class area (in sclass.json)
    ca('Q9', '9Z99', '0008', '0006')   // an area nobody asked for
  ]);
  const isSclassArea = Object.keys(require('../config/sclass.json').areas || {}).includes('BM');
  check('fixture: BM is an S-Class area', isSclassArea, true);

  // Before start(): no areas are assumed — nothing reaches a crossing.
  td._setCrossingAreasForTest([]);
  td._processMessageForTest(frame());
  check('no configured areas: no sightings', sightings.length, 0);

  // Today's live configuration: LA only. Must behave exactly as the old hard-coded 'LA'.
  sightings.length = 0;
  td._setCrossingAreasForTest(['LA']);
  td._processMessageForTest(frame());
  await wait(150);
  check('LA only: just the LA sighting', sightings.join(' '), 'LA:1H23:0006');
  check('LA only: LA step written to the LA td log', readLines(tdFile('LA')).map(e => e.desc).join(','), '1H23');
  // S-Class C-Class capture runs whatever the crossing areas are: one BM line per frame so far.
  check('LA only: BM step kept in its S-Class C-Class log (every frame)', readLines(ccFile('BM')).map(e => e.desc).join(','), '2N77,2N77');
  check('LA only: BM step NOT in any td log', fs.existsSync(tdFile('BM')), false);
  check('LA only: unrequested area written nowhere', fs.existsSync(tdFile('Q9')) || fs.existsSync(ccFile('Q9')), false);
  check('LA td line has the same shape as before',
    Object.keys(readLines(tdFile('LA'))[0]).join(','), 'ts,area,event,desc,from,to,trust_uid');

  // A second crossing in BM: BM now drives sightings and gets a td log, AND keeps its S-Class log.
  sightings.length = 0;
  td._setCrossingAreasForTest(['LA', 'BM']);
  td._processMessageForTest(frame());
  await wait(150);
  check('LA+BM: both sightings, each tagged with its area', sightings.join(' '), 'LA:1H23:0006 BM:2N77:0006');
  check('LA+BM: BM step written to the BM td log', readLines(tdFile('BM')).map(e => e.desc).join(','), '2N77');
  check('LA+BM: BM step still written to its S-Class C-Class log too', readLines(ccFile('BM')).length, 3);
  check('LA+BM: LA td log holds only LA lines', readLines(tdFile('LA')).every(e => e.area === 'LA'), true);
  check('LA+BM: unrequested area still written nowhere', fs.existsSync(tdFile('Q9')), false);

  // ---- 3. rotation ------------------------------------------------------------------------
  console.log('  -- td-rotation --');
  const rroot = path.join(tmp, 'rot');
  fs.mkdirSync(path.join(rroot, 'BM'), { recursive: true });
  fs.mkdirSync(path.join(rroot, 'notes'), { recursive: true });
  const dayAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const old = `td-${dayAgo(10)}.jsonl`, recent = `td-${dayAgo(2)}.jsonl`, ancient = `td-${dayAgo(200)}.jsonl`;
  for (const d of ['', 'BM', 'notes']) for (const f of [old, recent, ancient]) fs.writeFileSync(path.join(rroot, d, f), '{"a":1}\n');
  const res = await rotation.runOnce(rroot);
  const has = (d, f) => fs.existsSync(path.join(rroot, d, f));
  check('top level (LA): 10-day-old log gzipped', has('', old + '.gz') && !has('', old), true);
  check('top level (LA): recent log untouched', has('', recent), true);
  check('top level (LA): 200-day-old log pruned', has('', ancient), false);
  check('BM subfolder: 10-day-old log gzipped', has('BM', old + '.gz') && !has('BM', old), true);
  check('BM subfolder: 200-day-old log pruned', has('BM', ancient), false);
  check('a folder not named like an area is left alone', has('notes', old) && has('notes', ancient), true);
  check('gzipped content intact', zlib.gunzipSync(fs.readFileSync(path.join(rroot, 'BM', old + '.gz'))).toString(), '{"a":1}\n');
  check('counts', `${res.gzipped}/${res.pruned}`, '2/2');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
