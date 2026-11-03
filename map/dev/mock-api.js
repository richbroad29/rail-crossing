#!/usr/bin/env node
// A stand-in for the map service, for developing and testing the page. It implements the HTTP API
// of map-service/docs/CONTRACT.md section 5 and nothing else, with synthetic trains that move
// along real station sequences (coordinates from map-service/data/stations.json).
//
//   node map/dev/mock-api.js                      Sussex routes, 60 trains, port 3100
//   node map/dev/mock-api.js --count 1500 --national   1,500 trains spread over Great Britain
//   node map/dev/mock-api.js --port 3200 --max-sse 2   (2 stream clients, then 503: tests fallback)
//   --tick 1000   how often the simulation advances and the stream batches updates (ms)
//   --stepms 0    make every train report a new position this often (ms); 0 = realistic 8-18 s
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
const path = require('path');
const geo = require('../geo.js');
const stationsLib = require('../stations.js');
const classes = require('../classes.js');

// ---- arguments ----------------------------------------------------------------------------------
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
const STEP_MS = Number(arg('stepms', 0));      // force every train to report this often (tests); 0 = realistic 8-18 s
let seed = Number(arg('seed', 12345));
function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }

// ---- stations -----------------------------------------------------------------------------------
const raw = require(path.join(__dirname, '../../map-service/data/stations.json')).stations;
const STATIONS = Object.keys(raw).map((crs) => ({
  tiploc: crs, crs, name: raw[crs].name, lat: +raw[crs].lat.toFixed(5), lon: +raw[crs].lon.toFixed(5)
}));
const BY_CRS = {};
STATIONS.forEach((s) => { BY_CRS[s.crs] = s; });

// Real Sussex sequences (CRS codes). Every one is checked at start-up.
const SUSSEX = [
  { cls: 'express', stops: ['VIC', 'GTW', 'HHE', 'BTN'], all: ['VIC', 'ECR', 'GTW', 'TBD', 'HHE', 'BTN'] },
  { cls: 'stopping', stops: null, all: ['VIC', 'CLJ', 'ECR', 'GTW', 'TBD', 'HHE', 'BUG', 'HSK', 'PRP', 'BTN'] },
  { cls: 'stopping', stops: null, all: ['BTN', 'HOV', 'PLD', 'SWK', 'SSE', 'LAC', 'EWR', 'WRH', 'WWO', 'GBS', 'ANG', 'BAA', 'BOG'] },
  { cls: 'stopping', stops: null, all: ['BTN', 'HOV', 'PLD', 'SWK', 'SSE', 'LAC', 'EWR', 'WRH', 'WWO', 'GBS', 'ANG', 'LIT'] },
  { cls: 'express', stops: ['BTN', 'WRH', 'CCH', 'PMS'], all: ['BTN', 'HOV', 'SSE', 'WRH', 'ANG', 'BAA', 'CCH', 'HAV', 'PMS'] },
  { cls: 'stopping', stops: null, all: ['BTN', 'FMR', 'LWS', 'GLY', 'PLG', 'EBN'] },
  { cls: 'stopping', stops: null, all: ['BTN', 'MCB', 'LWS', 'PLG', 'BEX', 'HGS'] },
  { cls: 'stopping', stops: null, all: ['BTN', 'PRP', 'HSK', 'BUG', 'HHE', 'TBD', 'CRW'] },
  { cls: 'freight', stops: [], all: ['HAV', 'CCH', 'BAA', 'ANG', 'WRH', 'SSE', 'HOV', 'PLD', 'BTN'] },
  { cls: 'ecs', stops: [], all: ['VIC', 'CLJ', 'ECR', 'GTW', 'HHE', 'BTN'] },
  { cls: 'special', stops: [], all: ['HHE', 'BUG', 'HSK', 'PRP', 'BTN'] },
  { cls: 'express', stops: ['LBG', 'ECR', 'GTW', 'BTN'], all: ['LBG', 'ECR', 'RDH', 'GTW', 'HHE', 'BTN'] }
];
SUSSEX.forEach((r) => r.all.forEach((c) => { if (!BY_CRS[c]) throw new Error('mock: unknown CRS ' + c); }));

// National chains: walk from a random station to its nearest unvisited neighbours.
function nearest(from, used, maxKm) {
  let best = null, bd = maxKm;
  for (let i = 0; i < STATIONS.length; i++) {
    const s = STATIONS[i];
    if (used.has(s.crs)) continue;
    const d = geo.haversineKm(from.lat, from.lon, s.lat, s.lon);
    if (d < bd && d > 1.2) { bd = d; best = s; }
  }
  return best;
}
function randomChain(cls) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const start = STATIONS[Math.floor(rnd() * STATIONS.length)];
    const used = new Set([start.crs]);
    const chain = [start];
    const len = 6 + Math.floor(rnd() * 14);
    // Keep a rough heading so chains look like lines, not scribbles.
    for (let i = 0; i < len; i++) {
      const next = nearest(chain[chain.length - 1], used, cls === 'express' ? 60 : 25);
      if (!next) break;
      if (chain.length > 2) {
        const a = geo.bearing(chain[chain.length - 2].lat, chain[chain.length - 2].lon, chain[chain.length - 1].lat, chain[chain.length - 1].lon);
        const b = geo.bearing(chain[chain.length - 1].lat, chain[chain.length - 1].lon, next.lat, next.lon);
        const d = Math.abs(((b - a + 540) % 360) - 180);
        if (d > 100) { used.add(next.crs); i--; if (used.size > 400) break; continue; }
      }
      used.add(next.crs); chain.push(next);
    }
    if (chain.length >= 4) return chain.map((s) => s.crs);
  }
  return ['VIC', 'BTN'];
}

// ---- trains -------------------------------------------------------------------------------------
const AREAS = ['LA', 'LB', 'LC', 'GA', 'EA', 'MC', 'WA', 'ZA'];
const TOCS = {
  express: ['GX', 'SN', 'GR', 'VT', 'XC', 'GW'], stopping: ['SN', 'TL', 'SE', 'SW', 'NT', 'LO'],
  ecs: ['SN', 'TL', 'SE'], freight: ['DB', 'GB', 'FL', 'DR'], special: ['NR']
};
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const HC_DIGIT = { express: ['1', '1', '1', '9'], stopping: ['2'], ecs: ['5'], freight: ['4', '6', '6', '7', '8'], special: ['0', '3'] };
function headcode(cls) {
  return pick(HC_DIGIT[cls]) + pick(LETTERS.split('')) + String(Math.floor(rnd() * 100)).padStart(2, '0');
}
function pickClass() {
  const r = rnd();
  if (r < 0.22) return 'express';
  if (r < 0.7) return 'stopping';
  if (r < 0.8) return 'ecs';
  if (r < 0.94) return 'freight';
  return 'special';
}

// The simulation clock. `freeze=1` stops it (for screenshots: a train that is standing stays standing).
let frozenAt = 0;
const NOW = () => frozenAt || Date.now();
let nextId = 1, globalVer = 1;
const TRAINS = new Map();

function buildSchedule(crsList, stopsSet, speed, dwell) {
  const pts = crsList.map((c) => BY_CRS[c]);
  const sched = [];
  let t = 0;
  for (let i = 0; i < pts.length; i++) {
    const stop = i === 0 || i === pts.length - 1 || !stopsSet || stopsSet.has(pts[i].crs);
    const arr = t;
    const dep = stop && i < pts.length - 1 ? t + dwell : t;
    sched.push({ st: pts[i], arr, dep, stop, platform: String(1 + (pts[i].crs.charCodeAt(0) + i) % 6) });
    if (i < pts.length - 1) {
      const km = geo.haversineKm(pts[i].lat, pts[i].lon, pts[i + 1].lat, pts[i + 1].lon);
      t = dep + (km * 1000 * 1.15) / speed;
    }
  }
  return { sched, total: t };
}

function makeTrain(route, now, phase) {
  const cls = route.cls || pickClass();
  const speed = cls === 'express' ? 30 + rnd() * 10 : cls === 'freight' ? 14 + rnd() * 6 : 18 + rnd() * 10;
  const stopsSet = route.stops ? new Set(route.stops) : null;
  const fwd = buildSchedule(route.all, stopsSet, speed, 40 + rnd() * 30);
  const rev = buildSchedule(route.all.slice().reverse(), stopsSet, speed, 40 + rnd() * 30);
  const layover = 90 + rnd() * 120;
  const lap = fwd.total + layover;
  const tocs = TOCS[cls];
  const hc = headcode(cls);
  const t = {
    id: 't' + (nextId++).toString(36) + Math.floor(rnd() * 36).toString(36),
    cls, hc, speed, fwd, rev, layover,
    lapLen: lap, startedAt: now - phase * lap * 2 * 1000,        // phase 0..1 through the out-and-back cycle (lap is in seconds)
    area: route.all.every((c) => ['VIC', 'CLJ', 'ECR', 'GTW', 'TBD', 'HHE', 'BTN', 'HOV', 'PLD'].includes(c)) ? 'LA' : pick(AREAS),
    toc: pick(tocs), hasSvc: cls !== 'special' && rnd() > 0.1, noHdg: rnd() < 0.03, approx: rnd() < 0.05,
    prev: rnd() < 0.12 ? [headcode(cls)] : [],
    stepEvery: STEP_MS || 8000 + rnd() * 10000, nextStepAt: 0, lastKey: '', berthN: Math.floor(rnd() * 900),
    firstSeenAt: now - rnd() * 600000,
    trail: [], berths: [],
    // Reported position (what the "service" currently says):
    lat: 0, lon: 0, hdg: null, pl: 'i', at: now, ver: 0
  };
  // Back-fill a trail so a freshly opened panel has a line to draw.
  for (let k = 12; k >= 1; k--) {
    const tt = now - k * 45000, q = truth(t, tt);
    t.trail.push([+q.lat.toFixed(5), +q.lon.toFixed(5), tt]);
  }
  advance(t, now, true);
  return t;
}

// Where the train really is at `now`: { lat, lon, hdg, dwelling, stationIdx, between:[i,j], speedMs, dirFwd, lapStart }
function dwellHdg(S, i) {
  const a = S.sched, here = a[i].st;
  if (i > 0) return geo.bearing(a[i - 1].st.lat, a[i - 1].st.lon, here.lat, here.lon);
  return a.length > 1 ? geo.bearing(here.lat, here.lon, a[1].st.lat, a[1].st.lon) : null;
}
function truth(t, now) {
  const el = (now - t.startedAt) / 1000;
  const lapNo = Math.floor(el / t.lapLen);
  const lt = el - lapNo * t.lapLen;
  const dirFwd = lapNo % 2 === 0;
  const S = dirFwd ? t.fwd : t.rev;
  const lapStart = now - lt * 1000;
  if (lt >= S.total) {
    const st = S.sched[S.sched.length - 1].st;
    return { lat: st.lat, lon: st.lon, hdg: dwellHdg(S, S.sched.length - 1), dwelling: true, idx: S.sched.length - 1, S, dirFwd, lapStart, speedMs: 0, lt };
  }
  for (let i = 0; i < S.sched.length; i++) {
    const c = S.sched[i];
    if (lt >= c.arr && lt < c.dep) return { lat: c.st.lat, lon: c.st.lon, hdg: dwellHdg(S, i), dwelling: true, idx: i, S, dirFwd, lapStart, speedMs: 0, lt };
    const n = S.sched[i + 1];
    if (n && lt >= c.dep && lt < n.arr) {
      const f = (lt - c.dep) / (n.arr - c.dep);
      return {
        lat: c.st.lat + (n.st.lat - c.st.lat) * f, lon: c.st.lon + (n.st.lon - c.st.lon) * f,
        hdg: geo.bearing(c.st.lat, c.st.lon, n.st.lat, n.st.lon), dwelling: false, idx: i, between: [i, i + 1],
        S, dirFwd, lapStart, speedMs: t.speed, lt
      };
    }
  }
  const last = S.sched[S.sched.length - 1].st;
  return { lat: last.lat, lon: last.lon, hdg: dwellHdg(S, S.sched.length - 1), dwelling: true, idx: S.sched.length - 1, S, dirFwd, lapStart, speedMs: 0, lt };
}

// Report a new position if it is time (a "berth step"): at its own cadence, or when it stops/starts.
function advance(t, now, force) {
  const tr = truth(t, now);
  const key = tr.dwelling ? 's' + tr.idx + (tr.dirFwd ? 'f' : 'r') : 'm';
  if (!force && now < t.nextStepAt && key === t.lastKey) return false;
  t.lastKey = key;
  t.nextStepAt = now + t.stepEvery * (0.7 + rnd() * 0.6);
  let lat = tr.lat, lon = tr.lon, pl = tr.dwelling ? 's' : 'i';
  if (tr.dwelling && tr.hdg != null) {
    // A stopped train sits on its platform: fan platforms out 35 m apart, square to the way it faces,
    // so several trains at one big station sit side by side instead of on one point.
    const plat = parseInt(tr.S.sched[tr.idx].platform, 10) || 1;
    const d = (plat - 3.5) * 0.035, h = (tr.hdg + 90) * Math.PI / 180;
    lat += d * Math.cos(h) / 111.2;
    lon += d * Math.sin(h) / (111.2 * Math.cos(lat * Math.PI / 180));
  }
  if (t.approx) { pl = 'a'; lat += (rnd() - 0.5) * 0.004; lon += (rnd() - 0.5) * 0.006; }
  // Moving trains: the last berth's centre is behind the true position; coarsen to ~12 s steps.
  t.lat = +lat.toFixed(5); t.lon = +lon.toFixed(5);
  t.hdg = t.noHdg ? null : tr.hdg == null ? (t.hdg == null ? null : t.hdg) : Math.round(tr.hdg);
  t.pl = pl; t.at = now;
  t.berthN++;
  t.ver = ++globalVer;
  t.trail.push([t.lat, t.lon, now]);
  if (t.trail.length > 40) t.trail.shift();
  t.berths.push({ area: t.area, berth: String(1000 + (t.berthN % 9000)).padStart(4, '0'), at: now });
  if (t.berths.length > 20) t.berths.shift();
  t.speedEst = tr.dwelling ? 0 : Math.round(tr.speedMs * 2.237 * (0.9 + rnd() * 0.2));
  return true;
}

function toWire(t) {
  const tr = truth(t, NOW());
  const o = {
    id: t.id, hc: t.hc, lat: t.lat, lon: t.lon, hdg: t.hdg, area: t.area,
    berth: t.berths.length ? t.berths[t.berths.length - 1].berth : '0000', at: t.at, pl: t.pl
  };
  if (t.hasSvc) {
    const fS = tr.S.sched;
    const o0 = fS[0].st, d0 = fS[fS.length - 1].st;
    const total = tr.S.total * 1000;
    o.svc = {
      uid: 'C' + t.id.toUpperCase().slice(0, 5), toc: t.toc, o: o0.name, d: d0.name,
      dep: clock(tr.lapStart), arr: clock(tr.lapStart + total),
      cat: t.cls === 'freight' ? 'EE' : t.cls === 'ecs' ? 'EE' : 'OO',
      pwr: t.cls === 'freight' ? 'D' : 'EMU', load: t.cls === 'freight' ? '' : '377'
    };
  }
  return o;
}

const clockFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London' });
function clock(ms) { return clockFmt.format(new Date(ms)).replace(/^24/, '00'); }

function detail(t) {
  const now = NOW();
  const tr = truth(t, now);
  const S = tr.S.sched;
  const w = toWire(t);
  const calls = S.map((c) => ({
    name: c.st.name, tiploc: c.st.tiploc,
    arr: c.stop && c.arr > 0 ? clock(tr.lapStart + c.arr * 1000) : null,
    dep: c.stop && c !== S[S.length - 1] ? clock(tr.lapStart + c.dep * 1000) : null,
    pass: c.stop ? null : clock(tr.lapStart + c.arr * 1000),
    platform: c.stop ? c.platform : null
  }));
  let place;
  if (t.pl === 's') place = { kind: 'station', station: { crs: S[tr.idx].st.crs, name: S[tr.idx].st.name } };
  else if (t.pl === 'a') place = { kind: 'near', station: { crs: S[tr.idx].st.crs, name: S[tr.idx].st.name } };
  else if (tr.between) place = { kind: 'between', between: tr.between.map((i) => ({ crs: S[i].st.crs, name: S[i].st.name })) };
  else place = { kind: 'station', station: { crs: S[tr.idx].st.crs, name: S[tr.idx].st.name } };
  const service = t.hasSvc ? {
    uid: w.svc.uid, stp: 'P', toc: t.toc, headcode: t.hc, category: w.svc.cat, power: w.svc.pwr, timingLoad: w.svc.load,
    speedMph: t.cls === 'express' ? 100 : 75,
    origin: { name: S[0].st.name, time: w.svc.dep }, destination: { name: S[S.length - 1].st.name, time: w.svc.arr },
    calls
  } : null;
  return {
    train: w, previousHeadcodes: t.prev, firstSeenAt: Math.round(t.firstSeenAt),
    recentBerths: t.berths.slice().reverse(), trail: t.trail.slice(-30), service, place,
    speedMphEstimate: t.speedEst == null || (t.speedEst === 0 && t.pl !== 's') ? null : t.speedEst
  };
}

// ---- population ---------------------------------------------------------------------------------
// Spread trains out: every route gets its trains evenly staggered round its out-and-back cycle, and a
// new train is only accepted if it is at least MIN_SPACING_KM from every train already running, so
// the screenshots show trains on lines rather than a heap at each terminus. (Reported positions
// are snapped to stations, so trains can still share a station briefly as the simulation runs.)
const MIN_SPACING_KM = 0.4;
let spawnCount = 0;
const routeUse = new Map();
let positions = [];                                  // [lat, lon] of every running train as of `now`
function snapshotPositions(now) {
  positions = [];
  TRAINS.forEach((t) => { const q = truth(t, now); positions.push([q.lat, q.lon]); });
}
function tooClose(q) {
  const kx = 111.2 * Math.cos(q.lat * Math.PI / 180);
  for (let i = 0; i < positions.length; i++) {
    const dy = (positions[i][0] - q.lat) * 111.2, dx = (positions[i][1] - q.lon) * kx;
    if (dx * dx + dy * dy < MIN_SPACING_KM * MIN_SPACING_KM) return true;
  }
  return false;
}
function spawn(now) {
  let route, slots;
  if (!NATIONAL || spawnCount < SUSSEX.length * 3) {
    route = SUSSEX[spawnCount % SUSSEX.length];
    slots = NATIONAL ? 3 : Math.max(1, Math.ceil(COUNT / SUSSEX.length));
  } else {
    const cls = pickClass();
    route = { cls, stops: cls === 'express' ? null : cls === 'stopping' ? null : [], all: randomChain(cls) };
    if (cls === 'express') route.stops = [route.all[0], route.all[Math.floor(route.all.length / 2)], route.all[route.all.length - 1]];
    slots = 1;
  }
  spawnCount++;
  const key = route.all.join('-');
  const n = routeUse.get(key) || 0;
  routeUse.set(key, n + 1);
  let t = null, q = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const phase = attempt === 0 ? ((n % slots) + 0.5) / slots * 0.5 + rnd() * 0.02 : rnd();
    t = makeTrain(route, now, phase);
    q = truth(t, now);
    if (!tooClose(q)) break;
    if (attempt === 39 && process.env.MOCK_DEBUG) process.stderr.write('spawn gave up on spacing: ' + route.all[0] + '-' + route.all.at(-1) + ' n=' + positions.length + '\n');
  }
  TRAINS.set(t.id, t);
  positions.push([q.lat, q.lon]);
  return t;
}
(function init() {
  const now = NOW();
  for (let i = 0; i < COUNT; i++) spawn(now);
  process.stderr.write('mock: ' + TRAINS.size + ' trains' + (NATIONAL ? ' (national)' : ' (Sussex)') + '\n');
})();

const flags = { stale: false, sse503: false, down: false };
const clients = new Set();
let removedSince = [];

function inBox(b, t) { return t.lat >= b[0] && t.lat <= b[2] && t.lon >= b[1] && t.lon <= b[3]; }
function parseBbox(q) {
  if (!q) return null;
  const p = q.split(',').map(Number);
  if (p.length !== 4 || p.some((v) => !isFinite(v))) return 'bad';
  return p;
}

let tickN = 0;
setInterval(() => {
  const now = NOW();
  tickN++;
  TRAINS.forEach((t) => advance(t, now, false));
  // Churn: now and then one train ends and another starts.
  if (tickN % 15 === 0 && TRAINS.size > 5) {
    const ids = Array.from(TRAINS.keys());
    const gone = ids[Math.floor(rnd() * ids.length)];
    TRAINS.delete(gone); removedSince.push(gone);
    snapshotPositions(now);
    spawn(now);
  }
  clients.forEach((c) => {
    const coarse = geo.bboxArea(c.bbox) > 400;
    if (coarse && tickN % 10 !== 0) return;
    const upsert = [], remove = [];
    TRAINS.forEach((t) => {
      if (t.ver <= c.sentVer) return;
      if (inBox(c.bbox, t)) { upsert.push(toWire(t)); c.known.add(t.id); }
      else if (c.known.has(t.id)) { remove.push(t.id); c.known.delete(t.id); }
    });
    removedSince.forEach((id) => { if (c.known.delete(id)) remove.push(id); });
    c.sentVer = globalVer;
    if (upsert.length || remove.length) sse(c.res, 'update', { serverTime: now, upsert, remove });
  });
  removedSince = [];
}, TICK_MS);
setInterval(() => clients.forEach((c) => sse(c.res, 'ping', {})), 20000);

function sse(res, ev, data) { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n'); }

// ---- HTTP ---------------------------------------------------------------------------------------
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
    return send(req, res, 200, flags);
  }
  if (!p.startsWith('/map/v1/')) return err(req, res, 404, 'Not found.');
  if (flags.down) return err(req, res, 503, 'The train service is down for maintenance.');
  const route = p.slice('/map/v1/'.length);
  const bbox = parseBbox(u.searchParams.get('bbox'));
  if (bbox === 'bad') return err(req, res, 400, 'The bbox must be four numbers: south,west,north,east.');
  const now = Date.now();

  if (route === 'health') {
    return send(req, res, 200, {
      status: 'ok', uptimeSecs: Math.round(process.uptime()), rssMB: Math.round(process.memoryUsage().rss / 1e6),
      heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
      feeds: { td: { connected: true, lastMessageAt: now, staleSecs: 0, messagesPerMin: 1200 } },
      reference: {}, model: { trains: TRAINS.size, placed: TRAINS.size, unplaced: 0, anchoredBerths: 0, learnedEdges: 0 },
      clients: { sse: clients.size }
    });
  }
  if (route === 'trains') {
    const list = [];
    TRAINS.forEach((t) => { if (!bbox || inBox(bbox, t)) list.push(toWire(t)); });
    return send(req, res, 200, { serverTime: now, feedStale: flags.stale, trains: list }, { 'Cache-Control': 'no-store' });
  }
  if (route === 'stream') {
    if (flags.sse503 || clients.size >= MAX_SSE) return err(req, res, 503, 'Too many people are watching right now. Try again shortly.');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no'
    });
    const c = { res, bbox: bbox || geo.GB_BBOX.slice(), sentVer: globalVer, known: new Set() };
    const list = [];
    TRAINS.forEach((t) => { if (inBox(c.bbox, t)) { list.push(toWire(t)); c.known.add(t.id); } });
    sse(res, 'snapshot', { serverTime: now, feedStale: flags.stale, trains: list });
    clients.add(c);
    req.on('close', () => clients.delete(c));
    return undefined;
  }
  let m = route.match(/^train\/([^/]+)$/);
  if (m) {
    const t = TRAINS.get(decodeURIComponent(m[1]));
    if (!t) return err(req, res, 404, 'We cannot see that train any more. It may have finished its journey.');
    return send(req, res, 200, detail(t), { 'Cache-Control': 'no-store' });
  }
  if (route === 'stations') {
    const list = bbox ? STATIONS.filter((s) => geo.inBbox(bbox, s.lat, s.lon)) : STATIONS;
    const clean = list.map((s) => ({ tiploc: s.tiploc, crs: s.crs, name: s.name, lat: s.lat, lon: s.lon }));
    return send(req, res, 200, { stations: clean }, { 'Cache-Control': 'public, max-age=86400' });
  }
  if (route === 'search') {
    const q = (u.searchParams.get('q') || '').trim();
    if (!q) return send(req, res, 200, { trains: [], stations: [] });
    const all = Array.from(TRAINS.values()).map((t) => {
      const S = t.fwd.sched;
      return { id: t.id, hc: t.hc, o: S[0].st.name, d: S[S.length - 1].st.name };
    });
    return send(req, res, 200, {
      trains: stationsLib.searchTrains(all, q, 20).slice(0, 10),
      stations: stationsLib.searchStations(STATIONS, q, 10).map((s) => ({ crs: s.crs, name: s.name, lat: s.lat, lon: s.lon }))
    }, { 'Cache-Control': 'no-store' });
  }
  return err(req, res, 404, 'Not found.');
});

server.listen(PORT, '127.0.0.1', () => process.stderr.write('mock map API on http://localhost:' + PORT + '/map/v1/\n'));
void classes;
