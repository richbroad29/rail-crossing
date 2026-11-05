#!/usr/bin/env node
'use strict';

// Replays a crossing-service TD log through the REAL service (real App, real stompit) via the fake
// NROD, then reports how many trains were placed and spot-checks some against SMART.
//
//   node dev/replay-report.js --file=/path/td-2026-11-01.jsonl --ref-dir=/path/refdata [--speed=3000] [--area=LA]
//
// Instrumentation: it wraps the model's private _attach() to record every train the moment it is
// placed on a berth, so a train that appears and goes again between two samples is still counted.
// It touches nothing else and writes nothing (a temp data folder, removed afterwards).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { FakeNrod } = require('./fake-nrod');
const { App } = require('../src/app');
const { loadConfig } = require('../src/config');
const { haversineKm } = require('../src/geo');
const stomp = require('../src/stomp');
const log = require('../src/log');

async function runReplay({ file, refDir, speed = 3000, quiet = true, overrides = {}, track = null }) {
  const fake = new FakeNrod({ mode: 'replay', file, speed });
  const port = await fake.start();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  const { config } = loadConfig({ env: {}, argv: [], overrides: { port: 0, http: { batchMs: 50 }, td: { backoffMinMs: 20, backoffMaxMs: 100 }, ...overrides } });
  if (quiet) log.setSink(() => {});
  const app = new App({ config, dataDir, fake: { host: '127.0.0.1', port, refDir }, track });
  const seen = new Map();                 // id -> record of the train as last attached
  const visited = new Set();              // every berth any train was put on
  const orig = app.model._attach.bind(app.model);
  app.model._attach = (t, keyId, ts, o) => {
    orig(t, keyId, ts, o);
    const g = app.graph;
    visited.add(keyId);
    const r = seen.get(t.id) || { id: t.id, firstHc: t.hc, everPlaced: false, attaches: 0 };
    r.hc = t.hc; r.area = g.areaOf[t.keyId]; r.berth = g.berth(t.keyId); r.placed = t.placed; r.attaches++;
    if (t.placed) { r.everPlaced = true; r.pl = t.pl; r.lat = t.lat; r.lon = t.lon; r.place = t.place; r.hdg = t.hdg; }
    seen.set(t.id, r);
  };
  try {
    await app.start();
    await fake.done;
    await new Promise(r => setTimeout(r, 600));       // let the last frames and a tick or two land
    const stats = { ...app.model.stats };
    const counts = app.model.counts();
    const records = [...seen.values()];
    return { fake, app, records, visited, stats, counts, sent: fake.sent, total: fake.total, graph: app.graph.stats(), stop: async () => { await app.stop(); await fake.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); stomp._resetForTest(); log.setSink(null); } };
  } catch (e) {
    await app.stop().catch(() => {}); await fake.stop().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true }); stomp._resetForTest(); log.setSink(null);
    throw e;
  }
}

/**
 * Two readings. `atSight`: placed when the train was first put on its berth (what a user would have
 * seen live as the day unfolded, with the graph still learning). `afterLearning`: the same berths read
 * against the graph at the end of the replay (what the next day starts with, once the learned edges
 * have been seen twice and are usable).
 */
function summarise(res, area = null) {
  const recs = area ? res.records.filter(r => r.area === area) : res.records;
  const placed = recs.filter(r => r.everPlaced), unplaced = recs.filter(r => !r.everPlaced);
  const by = k => placed.filter(r => r.pl === k).length;
  const g = res.app.graph;
  const fin = recs.map(r => g.position(g.lookup(r.area, r.berth)));
  const finBy = k => fin.filter(p => p && p.pl === k).length;
  const vis = [...res.visited].filter(k => !area || g.areaOf[k] === area).map(k => g.position(k));
  const visBy = k => vis.filter(p => p && p.pl === k).length;
  return {
    berthsVisited: { total: vis.length, station: visBy('s'), interpolated: visBy('i'), approx: visBy('a'), unplaced: vis.filter(p => !p).length },
    trains: recs.length,
    atSight: { placed: placed.length, unplaced: unplaced.length, station: by('s'), interpolated: by('i'), approx: by('a') },
    afterLearning: { placed: fin.filter(Boolean).length, unplaced: fin.filter(p => !p).length, station: finBy('s'), interpolated: finBy('i'), approx: finBy('a') },
    unplacedBerths: [...new Set(unplaced.map(r => `${r.area}:${r.berth}`))].sort()
  };
}

/** Five placed trains checked against SMART: the anchoring row, and the distance to the station it names. */
async function spotCheck(res, { smartFile, n = 5 }) {
  const { loadSmart } = require('../src/reference');
  const smart = await loadSmart(smartFile);
  const rows = (area, berth) => {
    const out = [];
    for (let i = 0; i < smart.rows; i++) {
      if (smart.area[i] !== area) continue;
      const ev = smart.event[i];
      const anchoredTo = ev === 'A' || ev === 'C' ? smart.to[i] : ev === 'B' || ev === 'D' ? smart.from[i] : null;
      if (anchoredTo === berth) out.push(`${smart.area[i]} ${smart.from[i]}->${smart.to[i]} STANOX ${smart.stanox[i]} EVENT ${ev} (${ev === 'A' || ev === 'C' ? 'arrival: station at TOBERTH' : 'departure: station at FROMBERTH'})`);
    }
    return out;
  };
  const picks = [];
  const stationRecs = res.records.filter(r => r.everPlaced && r.pl === 's');
  const seenBerths = new Set();
  for (const r of stationRecs) { const k = `${r.area}:${r.berth}`; if (seenBerths.has(k)) continue; seenBerths.add(k); picks.push(r); if (picks.length >= n) break; }
  return picks.map(r => ({
    train: r.hc, berth: `${r.area}:${r.berth}`, placedAt: r.place.station, lat: r.lat, lon: r.lon,
    smartRows: rows(r.area, r.berth).slice(0, 2)
  }));
}

if (require.main === module) {
  (async () => {
    const opt = {};
    for (const a of process.argv.slice(2)) { const m = /^--([a-z-]+)=(.*)$/.exec(a); if (m) opt[m[1]] = m[2]; }
    if (!opt.file || !opt['ref-dir']) { console.error('usage: replay-report.js --file=<td jsonl> --ref-dir=<reference folder> [--speed=3000] [--area=LA]'); process.exit(2); }
    const res = await runReplay({ file: opt.file, refDir: opt['ref-dir'], speed: opt.speed === 'max' ? 'max' : Number(opt.speed || 3000) });
    const s = summarise(res, opt.area || null);
    console.log(JSON.stringify({ sent: res.sent, events: res.total, area: opt.area || 'all', ...s, unplacedBerths: s.unplacedBerths.slice(0, 20), identity: res.stats, graph: res.graph }, null, 1));
    for (const c of await spotCheck(res, { smartFile: path.join(opt['ref-dir'], 'smart-latest.json.gz') })) console.log(JSON.stringify(c));
    await res.stop();
    process.exit(0);
  })().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = { runReplay, summarise, spotCheck };
