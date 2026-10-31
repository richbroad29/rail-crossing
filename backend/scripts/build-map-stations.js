'use strict';

// Regenerates config/map-stations.json — the CRS → coordinates table that berth-geo uses to put
// SMART's station-anchored berths on the map.
//
// Source: the `uk-railway-stations` dataset (davwheat, ODbL-1.0, itself from Trainline EU's
// station list, which is built from NaPTAN and other open sources). It is read from a local copy
// rather than fetched at runtime so the backend has no new network dependency and the table is
// reviewable in a diff:
//
//   npm pack uk-railway-stations && tar xzf uk-railway-stations-*.tgz
//   node scripts/build-map-stations.js package/stations.json
//
// The box is the map region (config/map.json → region.bbox) widened by MARGIN_DEG, so a berth just
// inside the region edge still has an anchor beyond it to interpolate towards.

const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/build-map-stations.js <stations.json>'); process.exit(1); }

const mapCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'map.json'), 'utf8'));
const [south, west, north, east] = mapCfg.region.bbox;
const MARGIN_DEG = 0.15;

const all = JSON.parse(fs.readFileSync(src, 'utf8'));
const stations = {};
for (const s of all) {
  if (!s.crsCode || typeof s.lat !== 'number' || typeof s.long !== 'number') continue;
  if (s.lat < south - MARGIN_DEG || s.lat > north + MARGIN_DEG) continue;
  if (s.long < west - MARGIN_DEG || s.long > east + MARGIN_DEG) continue;
  stations[s.crsCode] = { name: s.stationName, lat: +s.lat.toFixed(6), lon: +s.long.toFixed(6) };
}

const sorted = Object.fromEntries(Object.keys(stations).sort().map(k => [k, stations[k]]));
const out = {
  _source: 'uk-railway-stations (github.com/davwheat/uk-railway-stations), ODbL-1.0. Contains data '
    + 'from Trainline EU (github.com/trainline-eu/stations) and its sources. Regenerate with '
    + 'scripts/build-map-stations.js.',
  _bbox: [south - MARGIN_DEG, west - MARGIN_DEG, north + MARGIN_DEG, east + MARGIN_DEG].map(v => +v.toFixed(2)),
  stations: sorted
};
// One station per line: the table is meant to be read in a diff.
const lines = Object.entries(sorted).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
const text = '{\n'
  + ` "_source": ${JSON.stringify(out._source)},\n`
  + ` "_bbox": ${JSON.stringify(out._bbox)},\n`
  + ' "stations": {\n' + lines.join(',\n') + '\n }\n}\n';
JSON.parse(text); // must round-trip
const target = path.join(__dirname, '..', 'config', 'map-stations.json');
fs.writeFileSync(target, text);
console.log(`${Object.keys(sorted).length} stations -> ${target}`);
