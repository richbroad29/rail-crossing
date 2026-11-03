#!/usr/bin/env node
'use strict';

// The offline track-pack builder (contract section 8). Runs on a Mac or a GitHub Actions runner,
// never on the VPS. No dependencies: the PBF reader is in lib/pbf.js. See README.md and FORMAT.md.
//
//   node track/build.js --pbf PATH --naptan PATH [--out DIR] [--tolerance 1.0] [--date YYYYMMDD]
//   node track/build.js --download [--cache DIR] [--out DIR]       fetch Geofabrik + NaPTAN first

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const F = require('../src/track/format');
const { TrackPack, loadPack } = require('../src/track/pack');
const { extract } = require('./lib/osm-extract');
const { buildGraph, MIN_COMPONENT_M } = require('./lib/graph');
const { StringTable, graphSections, writePack } = require('./lib/assemble');
const { parseNaptan, snapStations, stationSections } = require('./lib/stations');
const { snapSignals } = require('./lib/signals');
const { overview } = require('./lib/network');
const { download, GEOFABRIK, NAPTAN } = require('./lib/fetch');

function parseArgs(argv) {
  const a = { out: path.join(__dirname, 'out'), tolerance: 1.0, cache: path.join(__dirname, '.cache'), loTol: 100, hiTol: 15 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i]; };
    if (k === '--pbf') a.pbf = v(); else if (k === '--naptan') a.naptan = v(); else if (k === '--out') a.out = v();
    else if (k === '--tolerance') a.tolerance = Number(v()); else if (k === '--date') a.date = v(); else if (k === '--cache') a.cache = v();
    else if (k === '--download') a.download = true; else if (k === '--lo-tolerance') a.loTol = Number(v()); else if (k === '--hi-tolerance') a.hiTol = Number(v());
    else if (k === '-h' || k === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 9).join('\n')); process.exit(0); }
    else throw new Error(`Unknown argument ${k}`);
  }
  if (!(a.tolerance > 0 && a.tolerance <= 2)) throw new Error('--tolerance must be in (0, 2] metres (contract: <= 2 m)');
  return a;
}

const sha256File = (f) => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const T0 = Date.now();
  const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
  const timings = {};
  const lap = (name, t) => { timings[name] = Math.round((Date.now() - t) / 100) / 10; };

  if (args.download) {
    fs.mkdirSync(args.cache, { recursive: true });
    args.pbf = args.pbf || path.join(args.cache, 'united-kingdom-latest.osm.pbf');
    args.naptan = args.naptan || path.join(args.cache, 'naptan-rail.csv');
    log('downloading Geofabrik UK extract (~2.3 GB)');
    let t = Date.now(); await download(GEOFABRIK, args.pbf, { log }); lap('downloadPbf', t);
    log('downloading NaPTAN rail stations');
    await download(NAPTAN, args.naptan, { log });
  }
  if (!args.pbf || !args.naptan) throw new Error('Give --pbf and --naptan, or --download.');
  fs.mkdirSync(args.out, { recursive: true });

  // 1. OSM
  let t = Date.now();
  const ex = extract(args.pbf, { log });
  lap('extract', t);
  const osmDate = ex.source.timestamp ? new Date(ex.source.timestamp * 1000) : new Date();
  const date = args.date || ymd(osmDate);

  // 2. graph
  t = Date.now();
  const g = buildGraph(ex, { tolerance: args.tolerance, log });
  const strings = new StringTable();
  const S = graphSections(g, strings);
  Object.assign(S, strings.build());
  const pack = new TrackPack(S, {});
  for (let e = 0; e < pack.nEdges; e++) S.ELEN[e] = pack.length(e);
  lap('graph', t);

  // 3. stations
  t = Date.now();
  const naptan = parseNaptan(args.naptan);
  const st = snapStations(pack, naptan, ex, { log });
  Object.assign(S, stationSections(st.stations, strings));
  lap('stations', t);

  // 4. signals
  t = Date.now();
  const sg = snapSignals(pack, g, ex, strings, { log });
  Object.assign(S, sg.sections);
  lap('signals', t);

  // 5. network overview
  t = Date.now();
  const lo = overview(pack, args.loTol, 4), hi = overview(pack, args.hiTol, 5);
  log(`overview lo: ${lo.lines} chains, ${lo.points} points, ${(lo.json.length / 1e6).toFixed(2)} MB raw, ${(lo.gz.length / 1e6).toFixed(2)} MB gz (${args.loTol} m)`);
  log(`overview hi: ${hi.lines} chains, ${hi.points} points, ${(hi.json.length / 1e6).toFixed(2)} MB raw, ${(hi.gz.length / 1e6).toFixed(2)} MB gz (${args.hiTol} m)`);
  lap('overview', t);

  // 6. write
  Object.assign(S, strings.build());
  const classKm = {};
  let tunnelEdges = 0, tunnelKm = 0, totalKm = 0;
  for (let e = 0; e < pack.nEdges; e++) {
    const km = S.ELEN[e] / 1000;
    classKm[F.CLS_NAMES[S.ECLS[e]]] = (classKm[F.CLS_NAMES[S.ECLS[e]]] || 0) + km;
    totalKm += km;
    if (S.EFLG[e] & F.FLG.TUNNEL) { tunnelEdges++; tunnelKm += km; }
  }
  for (const k of Object.keys(classKm)) classKm[k] = Math.round(classKm[k] * 10) / 10;
  let commit = null;
  try { commit = execSync('git rev-parse HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) { /* not a checkout */ }
  const naptanHash = await sha256File(args.naptan);
  const meta = {
    format: F.VERSION, packDate: date, builtAt: new Date().toISOString(), builderCommit: commit,
    sources: {
      osm: { file: path.basename(args.pbf), dataTimestamp: osmDate.toISOString(), writingProgram: ex.source.program, bytes: fs.statSync(args.pbf).size, licence: 'ODbL, © OpenStreetMap contributors' },
      naptan: { file: path.basename(args.naptan), newestModification: naptan.newestModified, sha256: naptanHash }
    },
    parameters: { toleranceMetres: args.tolerance, minComponentMetres: MIN_COMPONENT_M, overviewLoMetres: args.loTol, overviewHiMetres: args.hiTol, primarySnapMaxMetres: 300 },
    counts: {
      nodes: pack.nNodes, edges: pack.nEdges, vertices: pack.nVertices, km: Math.round(totalKm), kmByClass: classKm, tunnelEdges, tunnelKm: Math.round(tunnelKm),
      stations: st.stats.stations, stationsSnapped: st.stats.snapped, stationsUnsnapped: st.stats.unsnapped, stationsWithPlatformSnaps: st.stats.withPlatformSnaps, platformSnaps: st.stats.platformSnaps,
      signals: sg.sections.SGEDGE.length, signalNodesTotal: sg.stats.signalNodes, signalsWithRef: sg.stats.withRef
    },
    graphStats: g.stats, stationStats: st.stats, signalStats: sg.stats,
    unsnappedStations: st.unsnapped
  };
  const file = path.join(args.out, `track-pack-${date}.bin`);
  t = Date.now();
  const w = writePack(file, S, { metaJson: JSON.stringify(meta), networkLo: lo.gz, networkHi: hi.gz });
  lap('write', t);

  // 7. verify what was written by loading it back through the runtime reader
  const back = loadPack(file);
  const same = back.nEdges === pack.nEdges && back.nNodes === pack.nNodes && back.nVertices === pack.nVertices &&
    back.stationCount() === st.stations.length && Buffer.compare(back.network('lo'), lo.gz) === 0 && Buffer.compare(back.network('hi'), hi.gz) === 0;
  if (!same) throw new Error('verification failed: the pack read back differs from what was built');
  log('verified: pack reads back identical');

  const loFile = path.join(args.out, `network-lo-${date}.geojson.gz`), hiFile = path.join(args.out, `network-hi-${date}.geojson.gz`);
  fs.writeFileSync(loFile, lo.gz); fs.writeFileSync(hiFile, hi.gz);
  timings.total = Math.round((Date.now() - T0) / 100) / 10;
  const manifest = {
    file: path.basename(file), sha256: w.sha256, bytes: w.bytes, format: F.VERSION, packDate: date, builtAt: meta.builtAt,
    sources: meta.sources, counts: meta.counts,
    overview: {
      lo: { file: path.basename(loFile), toleranceMetres: args.loTol, gzipBytes: lo.gz.length, rawBytes: lo.json.length, sha256: crypto.createHash('sha256').update(lo.gz).digest('hex') },
      hi: { file: path.basename(hiFile), toleranceMetres: args.hiTol, gzipBytes: hi.gz.length, rawBytes: hi.json.length, sha256: crypto.createHash('sha256').update(hi.gz).digest('hex') }
    },
    sections: w.sections, timingsSecs: timings, node: process.version, peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024)
  };
  fs.writeFileSync(path.join(args.out, `track-pack-${date}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
  log(`wrote ${file} (${(w.bytes / 1e6).toFixed(2)} MB, sha256 ${w.sha256.slice(0, 12)}...) in ${timings.total}s total, peak RSS ${manifest.peakRssMB} MB`);
}

main().catch((e) => { console.error('build failed: ' + (e && e.stack || e)); process.exit(1); });
