'use strict';

// Wires the live train map together: SMART + CORPUS + the station table → berth-geo, the TD
// feed → train-map, the CIF parse → map-services. Kept out of index.js so the crossing service's
// startup reads the same as before with one call added.
//
// Every failure here is non-fatal and leaves the crossing prediction path untouched: with no
// SMART the map simply has no areas and serves an empty list.

const fs = require('fs');
const path = require('path');
const { BerthGeo } = require('./berth-geo');
const { TrainMap } = require('./train-map');
const { MapServices } = require('./map-services');
const smart = require('./smart-fetcher');

const CONFIG = require('../config/map.json');
const STATIONS = require('../config/map-stations.json').stations;
const GRAPH_DIR = path.join(__dirname, '..', 'data', 'map');
const GRAPH_FILE = path.join(GRAPH_DIR, 'berth-graph.json');

function inBox(p, [s, w, n, e]) { return p.lat >= s && p.lat <= n && p.lon >= w && p.lon <= e; }

// Which TD areas cover the region: every area with a SMART station step at a station inside the
// box. Derived, not listed, so a new describer area or a changed boundary needs no config edit.
async function regionAreas(corpus) {
  if (Array.isArray(CONFIG.region.areas) && CONFIG.region.areas.length) return new Set(CONFIG.region.areas);
  const counts = new Map();
  await smart.loadSmartFromDisk(undefined, r => {
    const crs = corpus.stanoxToCrs(r.stanox);
    const st = crs && STATIONS[crs];
    if (st && r.td && inBox(st, CONFIG.region.bbox)) counts.set(r.td, (counts.get(r.td) || 0) + 1);
    return false;   // keep nothing on this pass — it only counts
  });
  return new Set(counts.keys());
}

async function buildGeo(geo, corpus) {
  const areas = await regionAreas(corpus);
  const rows = await smart.loadSmartFromDisk(undefined, r => areas.has(r.td));
  const res = geo.loadSmart(rows, s => corpus.stanoxToCrs(s), td => areas.has(td));

  // TIPLOCs that count as "in the region" for the headcode → service index: every timing point
  // SMART knows in these areas, plus every station in the box.
  const tiplocs = new Set();
  for (const r of rows) for (const t of corpus.tiplocsForStanox(r.stanox)) tiplocs.add(t);
  for (const [crs, st] of Object.entries(STATIONS)) {
    if (inBox(st, CONFIG.region.bbox)) for (const t of corpus.tiplocsForCrs(crs)) tiplocs.add(t);
  }
  console.log(`Train map: areas ${[...areas].sort().join(',') || '(none)'}; `
    + `${res.anchored} berths anchored at stations, ${res.hinted} hinted, ${tiplocs.size} region TIPLOCs`);
  return { areas, tiplocs };
}

/**
 * @returns {Promise<object>} { trainMap, geo, config, services, refresh, save }
 */
async function setupTrainMap({ corpus, tdListener }) {
  let regionTiplocs = new Set();
  const geo = new BerthGeo({ stations: STATIONS, interpolation: CONFIG.interpolation });
  const services = new MapServices({
    inRegion: t => regionTiplocs.has(t),
    resolveName: t => corpus.resolveTiploc(t)
  });
  const trainMap = new TrainMap({ config: CONFIG, geo, services });

  async function refresh(download) {
    try {
      if (download || !smart.latestFileExists()) {
        const r = await smart.downloadSmart();
        console.log(`SMART downloaded: ${r.bytes} bytes`);
      }
      const { areas, tiplocs } = await buildGeo(geo, corpus);
      regionTiplocs = tiplocs;
      trainMap.setAreas(areas);
    } catch (e) {
      console.error('Train map: SMART load failed (map keeps its previous areas):', e.message);
    }
  }

  function save() {
    try {
      if (!fs.existsSync(GRAPH_DIR)) fs.mkdirSync(GRAPH_DIR, { recursive: true });
      if (geo.saveLearnedIfDirty(GRAPH_FILE)) return true;
    } catch (e) { console.error('Train map: graph save failed:', e.message); }
    return false;
  }

  const learned = geo.loadLearnedFromFile(GRAPH_FILE);
  if (learned) console.log(`Train map: ${learned} learned berth edges loaded`);
  await refresh(false);

  tdListener.on('cclass', (type, msg) => trainMap.handle(type, msg));
  const t = setInterval(save, (CONFIG.graphPersistSecs || 600) * 1000);
  if (t.unref) t.unref();

  return { trainMap, geo, config: CONFIG, services, refresh, save };
}

module.exports = { setupTrainMap };
