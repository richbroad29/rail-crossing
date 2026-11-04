#!/usr/bin/env node
// A stand-in for the map service, for developing and testing the page. It implements the HTTP API
// of map-service/docs/CONTRACT.md sections 5 and 8-14 (phase 2), with synthetic trains that move
// along real station sequences (coordinates from map-service/data/stations.json) on curvy synthetic
// track cut into berths, with realistic step noise. The simulation is in mock-sim.js / mock-track.js.
//
//   node map/dev/mock-api.js                      Sussex routes, 60 trains, port 3100
//   node map/dev/mock-api.js --count 1500 --national   1,500 trains spread over Great Britain
//   node map/dev/mock-api.js --port 3200 --max-sse 2   (2 stream clients, then 503: tests fallback)
//   --tick 1000   how often the simulation advances and the stream batches updates (ms)
//   --stepms 0    compress time so a berth step comes about this often (ms); 0 = real time (steps every 10-40 s)
//   --noise iid|persistent   transit noise (default iid: every berth +-25% independently)
//
// Then open  map/index.html  through any static server with  ?api=http://localhost:3100
// (see map/README.md in the report for the exact commands).
//
// Fault injection, so the page's failure states can be seen and tested:
//   GET /__mock/set?stale=1      feedStale: true on every response
//   GET /__mock/set?sse503=1     /stream answers 503 (forces the polling fallback)
//   GET /__mock/set?down=1       every /map/v1 route answers 503
//   GET /__mock/set?freeze=1     stop the simulation clock (freeze=0 resumes)
//   GET /__mock/set?stale=0&sse503=0&down=0   back to normal
//
// DEVELOPMENT ONLY: unlike the real service it sends Access-Control-Allow-Origin: * itself,
// because there is no Caddy in front of it.
'use strict';

const http = require('http');
const zlib = require('zlib');
const geo = require('../geo.js');
const stationsLib = require('../stations.js');
const { createSim } = require('./mock-sim.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const PORT = Number(arg('port', 3100));
const COUNT = Number(arg('count', 60));
const NATIONAL = !!arg('national', false);
const MAX_SSE = Number(arg('max-sse', 300));
const TICK_MS = Number(arg('tick', 1000));
const STEP_MS = Number(arg('stepms', 0));
const sim = createSim({ count: COUNT, national: NATIONAL, seed: Number(arg('seed', 12345)), timescale: STEP_MS ? STEP_MS / 15000 : 1,
  noise: { mode: arg('noise', 'iid') } });

// `freeze=1` stops the simulation clock (for screenshots: a train that is standing stays standing).
let frozenAt = 0;
const NOW = () => frozenAt || Date.now();
sim.init(NOW());
process.stderr.write('mock: ' + sim.TRAINS.size + ' trains' + (NATIONAL ? ' (national)' : ' (Sussex)') + '\n');

const flags = { stale: false, sse503: false, down: false };
const clients = new Set();
const inBox = (b, w) => w.lat >= b[0] && w.lat <= b[2] && w.lon >= b[1] && w.lon <= b[3];
function parseBbox(q) {
  if (!q) return null;
  const p = q.split(',').map(Number);
  if (p.length !== 4 || p.some((v) => !isFinite(v))) return 'bad';
  return p;
}

let tickN = 0;
setInterval(() => {
  if (frozenAt) return;
  const now = NOW();
  tickN++;
  sim.tick(now);
  const removedNow = sim.takeRemoved();
  clients.forEach((c) => {
    const coarse = geo.bboxArea(c.bbox) > 400;
    if (coarse && tickN % 10 !== 0) return;
    const upsert = [], remove = [];
    sim.TRAINS.forEach((t) => {
      if (t.ver <= c.sentVer) return;
      const w = sim.wireOf(t);
      if (inBox(c.bbox, w)) { upsert.push(w); c.known.add(t.id); }
      else if (c.known.has(t.id)) { remove.push(t.id); c.known.delete(t.id); }
    });
    removedNow.forEach((id) => { if (c.known.delete(id)) remove.push(id); });
    c.sentVer = sim.ver;
    if (upsert.length || remove.length) sse(c.res, 'update', { serverTime: now, upsert, remove });
  });
}, TICK_MS);
setInterval(() => clients.forEach((c) => sse(c.res, 'ping', {})), 20000);

function sse(res, ev, data) { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n'); }

function send(req, res, status, body, extra) {
  const json = JSON.stringify(body);
  const h = Object.assign({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, extra || {});
  if (json.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    h['Content-Encoding'] = 'gzip';
    res.writeHead(status, h);
    res.end(zlib.gzipSync(json));
  } else { res.writeHead(status, h); res.end(json); }
}
function err(req, res, status, msg) { send(req, res, status, { error: msg }, { 'Cache-Control': 'no-store' }); }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p === '/__mock/set') {
    ['stale', 'sse503', 'down'].forEach((k) => { if (u.searchParams.has(k)) flags[k] = u.searchParams.get(k) === '1'; });
    if (u.searchParams.has('freeze')) frozenAt = u.searchParams.get('freeze') === '1' ? Date.now() : 0;
    if (u.searchParams.has('stack')) flags.stacked = sim.stackAt(u.searchParams.get('stack').toUpperCase(), Number(u.searchParams.get('n') || 3), NOW());
    if (u.searchParams.has('hold')) flags.held = sim.holdTrain(u.searchParams.get('hold'), Number(u.searchParams.get('secs') || 400), NOW());
    return send(req, res, 200, flags);
  }
  if (!p.startsWith('/map/v1/')) return err(req, res, 404, 'Not found.');
  if (flags.down) return err(req, res, 503, 'The train service is down for maintenance.');
  const route = p.slice('/map/v1/'.length);
  const bbox = parseBbox(u.searchParams.get('bbox'));
  if (bbox === 'bad') return err(req, res, 400, 'The bbox must be four numbers: south,west,north,east.');
  const now = NOW();

  if (route === 'health') {
    return send(req, res, 200, {
      status: 'ok', uptimeSecs: Math.round(process.uptime()), rssMB: Math.round(process.memoryUsage().rss / 1e6),
      heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
      feeds: { td: { connected: true, lastMessageAt: now, staleSecs: 0, messagesPerMin: 1200 } },
      reference: {}, model: { trains: sim.TRAINS.size, placed: sim.TRAINS.size, unplaced: 0, anchoredBerths: 0, learnedEdges: 0 },
      clients: { sse: clients.size }
    });
  }
  if (route === 'trains') {
    const list = [];
    sim.TRAINS.forEach((t) => { const w = sim.wireOf(t); if (!bbox || inBox(bbox, w)) list.push(w); });
    return send(req, res, 200, { serverTime: now, feedStale: flags.stale, trains: list }, { 'Cache-Control': 'no-store' });
  }
  if (route === 'stream') {
    if (flags.sse503 || clients.size >= MAX_SSE) return err(req, res, 503, 'Too many people are watching right now. Try again shortly.');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no'
    });
    const c = { res, bbox: bbox || geo.GB_BBOX.slice(), sentVer: sim.ver, known: new Set() };
    const list = [];
    sim.TRAINS.forEach((t) => { const w = sim.wireOf(t); if (inBox(c.bbox, w)) { list.push(w); c.known.add(t.id); } });
    sse(res, 'snapshot', { serverTime: now, feedStale: flags.stale, trains: list });
    clients.add(c);
    req.on('close', () => clients.delete(c));
    return undefined;
  }
  let m = route.match(/^train\/([^/]+)$/);
  if (m) {
    const t = sim.TRAINS.get(decodeURIComponent(m[1]));
    if (!t) return err(req, res, 404, 'We cannot see that train any more. It may have finished its journey.');
    return send(req, res, 200, sim.detail(t, now), { 'Cache-Control': 'no-store' });
  }
  m = route.match(/^span\/([^/]+)$/);
  if (m) {
    const sp = sim.span(decodeURIComponent(m[1]));
    if (!sp) return err(req, res, 404, 'No such span.');
    return send(req, res, 200, sp, { 'Cache-Control': 'public, max-age=604800, immutable' });
  }
  m = route.match(/^station\/([A-Za-z]{3})$/);
  if (m) {
    const b = sim.board(m[1].toUpperCase(), now);
    if (!b) return err(req, res, 404, 'We do not know that station.');
    return send(req, res, 200, b, { 'Cache-Control': 'no-store' });
  }
  if (route === 'network') {
    const level = u.searchParams.get('level') === 'lo' ? 'lo' : 'hi';
    return send(req, res, 200, sim.network(level), { 'Cache-Control': 'public, max-age=86400' });
  }
  if (route === 'stations') {
    const list = bbox ? sim.STATIONS.filter((s) => geo.inBbox(bbox, s.lat, s.lon)) : sim.STATIONS;
    const clean = list.map((s) => ({ tiploc: s.tiploc, crs: s.crs, name: s.name, lat: s.lat, lon: s.lon }));
    return send(req, res, 200, { stations: clean }, { 'Cache-Control': 'public, max-age=86400' });
  }
  if (route === 'search') {
    const q = (u.searchParams.get('q') || '').trim();
    if (!q) return send(req, res, 200, { trains: [], stations: [] });
    return send(req, res, 200, {
      trains: stationsLib.searchTrains(sim.searchRows(), q, 20).slice(0, 10),
      stations: stationsLib.searchStations(sim.STATIONS, q, 10).map((s) => ({ crs: s.crs, name: s.name, lat: s.lat, lon: s.lon }))
    }, { 'Cache-Control': 'no-store' });
  }
  return err(req, res, 404, 'Not found.');
});

server.listen(PORT, '127.0.0.1', () => process.stderr.write('mock map API on http://localhost:' + PORT + '/map/v1/\n'));
