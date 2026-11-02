'use strict';

// CORPUS indexing (blank-as-space, several CRS per STANOX, numeric STANOX) and the station table loader.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadCorpus, judgeCorpus, describeCorpusFacts } = require('../lib/corpus');
const { loadStations, DEFAULT_STATIONS_FILE } = require('../lib/stations');
const { tmpdir, corpusRow, writeCorpus, writeText } = require('./smart-check-helpers');

const FIXTURE = [
  corpusRow({ stanox: '87101', tiploc: 'PSLDAWH', crs: 'PLD', name: 'PORTSLADE' }),
  corpusRow({ stanox: '87101', tiploc: 'PSLDAWH1' }),                       // same timing point, no CRS on this row
  corpusRow({ stanox: '87102', tiploc: 'STHWICK', crs: 'SWK', name: 'SOUTHWICK' }),
  corpusRow({ stanox: '87200', tiploc: 'HOVEJN' }),                         // a junction: a STANOX but no CRS
  corpusRow({ stanox: '87300', tiploc: 'TWOCRS1', crs: 'AAA' }),            // one STANOX, two different CRS
  corpusRow({ stanox: '87300', tiploc: 'TWOCRS2', crs: 'BBB' }),
  corpusRow({ stanox: '87400', tiploc: 'ONECRS1', crs: 'CCC' }),            // one CRS on two STANOX
  corpusRow({ stanox: '87401', tiploc: 'ONECRS2', crs: 'CCC' }),
  corpusRow({ stanox: ' ', tiploc: 'NOSTANOX', crs: 'DDD' }),               // a CRS without a STANOX
  corpusRow({ stanox: '87500', tiploc: 'LOWER', crs: ' pld2 ' }),           // not a CRS: counted as odd, not indexed
  corpusRow({ stanox: '87600', tiploc: 'LOWCASE', crs: 'eee' }),            // lower case is normalised
  corpusRow({ tiploc: 'BLANKS' })                                           // everything blank
];

test('the index keeps every distinct CRS of a STANOX and every STANOX of a CRS', async () => {
  const { index, facts } = await loadCorpus(writeCorpus(tmpdir(), FIXTURE));
  assert.deepEqual(index.crsForStanox('87101'), ['PLD']);
  assert.deepEqual(index.crsForStanox('87300'), ['AAA', 'BBB']);
  assert.deepEqual(index.crsForStanox('87200'), [], 'a junction has a STANOX but no CRS');
  assert.equal(index.hasStanox('87200'), true);
  assert.equal(index.hasStanox('99999'), false);
  assert.deepEqual(index.stanoxesForCrs('CCC'), ['87400', '87401']);
  assert.deepEqual(index.stanoxesForCrs('PLD'), ['87101']);
  assert.deepEqual(index.crsForStanox('87600'), ['EEE']);
  assert.deepEqual(index.crsForStanox('87500'), [], 'pld2 is not a CRS');
  assert.equal(index.tiplocs.has('PSLDAWH'), true);
  assert.equal(index.tiplocs.has(''), false, 'blank TIPLOCs are not stored');

  // Counted by hand from FIXTURE: 12 rows. A STANOX is on every row except the NOSTANOX and BLANKS rows (10).
  // A valid CRS is on PLD, SWK, AAA, BBB, CCC, CCC, DDD, EEE (8); ' pld2 ' is present but not a CRS (1 odd).
  // Distinct STANOX: 87101 87102 87200 87300 87400 87401 87500 87600 (8), of which 87200 and 87500 have no CRS (6).
  assert.equal(facts.rows, FIXTURE.length);
  assert.equal(facts.rowsWithStanox, 10);
  assert.equal(facts.rowsWithCrs, 8);
  assert.equal(facts.rowsWithOddCrs, 1);
  assert.equal(facts.distinctStanox, 8);
  assert.equal(facts.distinctStanoxWithCrs, 6);
  assert.equal(facts.stanoxWithSeveralCrs, 1);
  assert.deepEqual(facts.stanoxWithSeveralCrsSample, [{ stanox: '87300', crs: ['AAA', 'BBB'] }]);
  assert.equal(facts.crsWithSeveralStanox, 1);
  assert.deepEqual(facts.wrapper, { kind: 'object-with-array', key: 'TIPLOCDATA', keys: ['TIPLOCDATA'] });
});

test('a STANOX delivered as a JSON number still joins its zero-padded twin', async () => {
  const rows = [{ ...corpusRow({ tiploc: 'X', crs: 'PLD' }), STANOX: 1234 }];
  const { index } = await loadCorpus(writeCorpus(tmpdir(), rows));
  assert.deepEqual(index.crsForStanox('01234'), ['PLD']);
});

test('judgeCorpus: ok, and each way it cannot do its one job, with a sentence for the report', async () => {
  const dir = tmpdir();
  assert.deepEqual(judgeCorpus((await loadCorpus(writeCorpus(dir, FIXTURE))).facts), { ok: true, problem: null });

  const empty = judgeCorpus((await loadCorpus(writeText(dir, 'html.json', '<html>down</html>'))).facts);
  assert.equal(empty.ok, false);
  assert.match(empty.problem, /no readable rows \(the file starts: "<html>down<\/html>"\)/);

  const noStanox = judgeCorpus((await loadCorpus(writeCorpus(dir, [{ TIPLOC: 'A', '3ALPHA': 'PLD' }], 'a.json'))).facts);
  assert.match(noStanox.problem, /no CORPUS row has a STANOX value.*fields seen: TIPLOC, 3ALPHA/);

  const noCrs = judgeCorpus((await loadCorpus(writeCorpus(dir, [{ TIPLOC: 'A', STANOX: '87101', '3ALPHA': ' ' }], 'b.json'))).facts);
  assert.match(noCrs.problem, /no CORPUS row has both a STANOX and a 3ALPHA/);
});

test('the notes describe the CORPUS facts', async () => {
  const { facts } = await loadCorpus(writeCorpus(tmpdir(), FIXTURE));
  const text = describeCorpusFacts(facts).join('\n');
  assert.match(text, /CORPUS: 12 rows; wrapper \{"TIPLOCDATA":\[…\]\}; gzip/);
  assert.match(text, /1 STANOX carry more than one CRS, 1 CRS more than one STANOX/);
  assert.match(text, /STANOX with several CRS: 87300 -> AAA, BBB/);
});

// ---- the station table ------------------------------------------------------------------------------

test('loadStations reads the generated shape, skips junk and counts it', () => {
  const file = writeText(tmpdir(), 'st.json', JSON.stringify({
    _source: 'unit test',
    stations: {
      PLD: { name: 'Portslade', lat: 50.836044, lon: -0.204898 },
      NAM: { lat: 51, lon: 0 },                       // no name: falls back to the CRS
      BAD: { name: 'No coordinates' },
      XX: { name: 'Two-letter code', lat: 51, lon: 0 },
      LOW: { name: 'lower', lat: 100, lon: 0 },       // latitude out of range
      STR: { name: 'string coords', lat: '51', lon: '0' }
    }
  }));
  const t = loadStations(file);
  assert.deepEqual([...t.byCrs.keys()].sort(), ['NAM', 'PLD']);
  assert.equal(t.byCrs.get('NAM').name, 'NAM');
  assert.equal(t.skipped, 4);
  assert.equal(t.source, 'unit test');
  assert.equal(t.count, 2);
});

test('loadStations also accepts a bare CRS map', () => {
  const t = loadStations(writeText(tmpdir(), 'bare.json', JSON.stringify({ PLD: { name: 'Portslade', lat: 50.8, lon: -0.2 } })));
  assert.equal(t.count, 1);
  assert.equal(t.source, null);
});

test('loadStations errors name the file and the way to fix it', () => {
  assert.throws(() => loadStations('/nonexistent/stations.json'), e => e.code === 'STATIONS_UNREADABLE' && /build-stations\.js/.test(e.message) && /--stations/.test(e.message));
  assert.throws(() => loadStations(writeText(tmpdir(), 'x.json', '{not json')), e => e.code === 'STATIONS_INVALID' && /not valid JSON/.test(e.message));
  assert.throws(() => loadStations(writeText(tmpdir(), 'e.json', '{"stations":{}}')), e => e.code === 'STATIONS_EMPTY');
});

test('the committed national table loads, is complete, and has the Portslade stations where they are', () => {
  const t = loadStations(DEFAULT_STATIONS_FILE);
  const doc = JSON.parse(fs.readFileSync(DEFAULT_STATIONS_FILE, 'utf8'));
  assert.equal(t.skipped, 0);
  assert.equal(t.count, doc._count);
  assert.ok(t.count > 2500, `only ${t.count} stations`);
  assert.match(doc._licence, /ODbL/);
  assert.match(doc._licence, /Attribution to David Wheatley, Trainline EU/);
  assert.match(doc._source, /uk-railway-stations \d+\.\d+\.\d+ \(https:\/\/github\.com\/davwheat\/uk-railway-stations\)/);
  const near = (crs, lat, lon) => {
    const s = t.byCrs.get(crs);
    assert.ok(s, `${crs} is in the table`);
    assert.ok(Math.abs(s.lat - lat) < 0.01 && Math.abs(s.lon - lon) < 0.01, `${crs} is at ${s.lat},${s.lon}`);
  };
  // The ordering along the coast is the real one: Shoreham, Southwick, Fishersgate, Portslade, Aldrington, Hove.
  near('SSE', 50.834, -0.272); near('SWK', 50.832, -0.237); near('FSG', 50.834, -0.219);
  near('PLD', 50.836, -0.205); near('AGT', 50.837, -0.182); near('HOV', 50.835, -0.170);
  const lons = ['SSE', 'SWK', 'FSG', 'PLD', 'AGT', 'HOV'].map(c => t.byCrs.get(c).lon);
  assert.deepEqual([...lons].sort((a, b) => a - b), lons, 'west to east');
});

test('the committed table is one station per line, sorted, and every CRS is unique', () => {
  const lines = fs.readFileSync(DEFAULT_STATIONS_FILE, 'utf8').split('\n');
  const stationLines = lines.filter(l => /^ {2}"[A-Z]{3}": \{/.test(l));
  const doc = JSON.parse(fs.readFileSync(DEFAULT_STATIONS_FILE, 'utf8'));
  assert.equal(stationLines.length, doc._count);
  const crs = stationLines.map(l => l.slice(3, 6));
  assert.deepEqual([...crs].sort(), crs, 'sorted by CRS');
  assert.equal(new Set(crs).size, crs.length);
  assert.ok(path.basename(DEFAULT_STATIONS_FILE) === 'stations.json');
});
