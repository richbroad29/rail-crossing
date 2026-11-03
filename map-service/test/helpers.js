'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const log = require('../src/log');
const { BerthGraph } = require('../src/berth-graph');
const { TrainModel, ChangeSet } = require('../src/model');
const { loadConfig } = require('../src/config');

const FIX = path.join(__dirname, 'fixtures');
const REAL = process.env.MAP_REFDATA || '/Users/richandanna/rail-map-refdata';
const haveReal = ['smart-latest.json.gz', 'corpus-latest.json.gz', 'naptan-rail.csv'].every(f => fs.existsSync(path.join(REAL, f)));

/** The default config, with overrides merged. */
function config(overrides) { return loadConfig({ env: {}, argv: [], overrides }).config; }

function tmpDir(prefix = 'railmap-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } }

/** Silence the logger and collect what it would have printed. */
function captureLog() {
  const lines = [];
  log.setSink(l => lines.push(l));
  return { lines, restore: () => log.setSink(null) };
}

/** A model over a graph with planted anchors: stations at known coordinates along one line. */
function makeModel({ now = () => 1000000, cfgOverrides = {}, stationsAt = {} } = {}) {
  const c = config(cfgOverrides);
  const graph = new BerthGraph({ maxHops: c.placement.maxHops, minEdgeCount: c.placement.minEdgeCount });
  const model = new TrainModel({ graph, now, config: { ...c.model, ...c.placement, region: c.region } });
  const cs = model.addChangeSet(new ChangeSet());
  return { graph, model, cs, cfg: c };
}

/** Compact SMART rows (loadSmart's shape) from [area, from, to, stanox, event] tuples. */
function smartRows(tuples) {
  const d = { rows: 0, area: [], from: [], to: [], stanox: [], event: [], skipped: 0 };
  for (const [a, f, t, s, e] of tuples) { d.area.push(a); d.from.push(f); d.to.push(t); d.stanox.push(s); d.event.push(e); d.rows++; }
  return d;
}

/** A tiny line: stations S1..S3 at known coordinates, berths in one area. */
const LINE = {
  stations: { 111: { key: 'AAA', name: 'Alpha', lat: 51.0, lon: -1.0, crs: 'AAA' }, 222: { key: 'BBB', name: 'Bravo', lat: 51.0, lon: -0.6, crs: 'BBB' } },
  resolve(stanox) { return LINE.stations[stanox] || null; }
};

function gzFile(dir, name, text) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, zlib.gzipSync(Buffer.from(text)));
  return f;
}

/** A reference folder (fake-mode layout) built from the small fixtures. */
function fixtureRefDir() {
  const dir = tmpDir('refdir-');
  fs.writeFileSync(path.join(dir, 'smart-latest.json.gz'), zlib.gzipSync(fs.readFileSync(path.join(FIX, 'smart-fixture.json'))));
  fs.writeFileSync(path.join(dir, 'corpus-latest.json.gz'), zlib.gzipSync(fs.readFileSync(path.join(FIX, 'corpus-fixture.json'))));
  fs.copyFileSync(path.join(FIX, 'naptan-fixture.csv'), path.join(dir, 'naptan-rail.csv'));
  return dir;
}

/** GET helper returning {status, headers, body (Buffer)}. */
function get(port, pathAndQuery, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathAndQuery, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function getJson(port, p, o) {
  const r = await get(port, p, { ...o, headers: { 'Accept-Encoding': 'identity', ...(o && o.headers) } });
  return { ...r, json: r.body.length ? JSON.parse(r.body.toString('utf8')) : null };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000, label = 'condition') {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`); await sleep(10); }
}

module.exports = { FIX, REAL, haveReal, config, tmpDir, rmrf, captureLog, makeModel, smartRows, LINE, gzFile, fixtureRefDir, get, getJson, sleep, until };
