#!/usr/bin/env node
'use strict';

// Regenerates map-service/data/stations.json: the national CRS -> { name, lat, lon } table that puts a
// SMART station on the map.
//
// Source: the `uk-railway-stations` npm package (David Wheatley, ODbL-1.0), itself derived from
// Trainline EU's station list. To regenerate:
//
//   npm pack uk-railway-stations && tar xzf uk-railway-stations-*.tgz
//   node map-service/scripts/build-stations.js package/stations.json
//
// Deterministic: the same input gives the same bytes (sorted by CRS, coordinates rounded to six
// decimal places, no timestamp), so a diff of the output is a diff of the data. The input's version is
// recorded from the package.json next to it. One station per line so the table can be read in a diff.
//
// Strict on purpose: a record that is not a CRS with in-UK coordinates is skipped and counted, more than
// 1% skipped aborts, two records for one CRS with different coordinates abort, and an input whose
// package.json does not say ODbL-1.0 aborts (the licence text written to the output would be wrong).
// The package README's field table has lat and long described the wrong way round; the data itself is
// right, and the range check below would catch a swap.

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const REPO_URL = 'https://github.com/davwheat/uk-railway-stations';
const UPSTREAM_URL = 'https://github.com/trainline-eu/stations';
const LICENCE_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';
// Generous bounds around the whole UK, Shetland and Northern Ireland included: a sanity check, not a filter.
const LAT_RANGE = [49, 61];
const LON_RANGE = [-9, 2.5];
const MAX_SKIPPED_SHARE = 0.01;

const round6 = x => Number(x.toFixed(6));

function readPackageInfo(inputPath) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(path.dirname(inputPath), 'package.json'), 'utf8'));
    return { name: p.name || null, version: p.version || null, license: p.license || null };
  } catch (_) {
    return null;
  }
}

/**
 * Build the table text from the package's stations.json.
 * @returns {{ text: string, count: number, skipped: Array<{record: object, reason: string}>, version: string|null }}
 */
function build(inputPath) {
  let records;
  try { records = JSON.parse(fs.readFileSync(inputPath, 'utf8')); }
  catch (e) { throw new Error(`Cannot read ${inputPath} as JSON (${e.code || e.message}).`); }
  if (!Array.isArray(records)) throw new Error(`${inputPath} is not an array of station records.`);

  const pkg = readPackageInfo(inputPath);
  if (pkg && pkg.license !== 'ODbL-1.0') {
    throw new Error(`The package next to ${inputPath} declares licence "${pkg.license}", not ODbL-1.0: the licence text this script writes would be wrong. Check the source before regenerating.`);
  }

  const stations = new Map();
  const skipped = [];
  for (const r of records) {
    const crs = r && typeof r.crsCode === 'string' ? r.crsCode.trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(crs)) { skipped.push({ record: r, reason: 'not a three-letter CRS code' }); continue; }
    const { lat, long: lon } = r;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      skipped.push({ record: r, reason: 'latitude or longitude is not a number' }); continue;
    }
    if (lat < LAT_RANGE[0] || lat > LAT_RANGE[1] || lon < LON_RANGE[0] || lon > LON_RANGE[1]) {
      skipped.push({ record: r, reason: `coordinates (${lat}, ${lon}) are outside the UK: swapped lat/long?` }); continue;
    }
    const entry = { name: String(r.stationName || '').trim() || crs, lat: round6(lat), lon: round6(lon) };
    const prior = stations.get(crs);
    if (prior) {
      if (prior.lat !== entry.lat || prior.lon !== entry.lon) {
        throw new Error(`CRS ${crs} appears twice with different coordinates (${prior.lat},${prior.lon} and ${entry.lat},${entry.lon}): the source is ambiguous, so no table was written.`);
      }
      continue;                                                       // an exact repeat is harmless
    }
    stations.set(crs, entry);
  }

  if (stations.size === 0) throw new Error(`${inputPath} produced no stations.`);
  if (skipped.length / records.length > MAX_SKIPPED_SHARE) {
    throw new Error(`${skipped.length} of ${records.length} records were unusable (first: ${skipped[0].reason}); the input is probably not what this script expects, so no table was written.`);
  }

  const version = pkg && pkg.version ? pkg.version : null;
  const sorted = [...stations.keys()].sort();
  const header = {
    _source: `uk-railway-stations${version ? ' ' + version : ''} (${REPO_URL}) by David Wheatley, derived from Trainline EU's station list (${UPSTREAM_URL}) and the sources listed there.`,
    _licence: `Open Database Licence (ODbL) 1.0, ${LICENCE_URL} . Attribution to David Wheatley, Trainline EU and their sources is required, and this derived table is distributed under the same licence.`,
    _generator: 'map-service/scripts/build-stations.js (deterministic: the same input gives the same bytes)',
    _count: sorted.length
  };
  const lines = sorted.map(crs => `  ${JSON.stringify(crs)}: ${JSON.stringify(stations.get(crs))}`);
  const text = '{\n'
    + Object.entries(header).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`).join('')
    + ' "stations": {\n' + lines.join(',\n') + '\n }\n}\n';

  const roundTrip = JSON.parse(text);                                   // the text must be valid JSON...
  if (Object.keys(roundTrip.stations).length !== sorted.length) throw new Error('internal error: the table did not round-trip');
  return { text, count: sorted.length, skipped, version };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    console.error(`${e.message}\nUsage: node scripts/build-stations.js <path to uk-railway-stations stations.json> [--out <file>]`);
    return 2;
  }
  if (parsed.values.help || parsed.positionals.length !== 1) {
    (parsed.values.help ? console.log : console.error)('Usage: node scripts/build-stations.js <path to uk-railway-stations stations.json> [--out <file>]\n'
      + 'Writes map-service/data/stations.json (or --out). Get the input with: npm pack uk-railway-stations && tar xzf uk-railway-stations-*.tgz');
    return parsed.values.help ? 0 : 2;
  }
  const out = path.resolve(parsed.values.out || path.join(__dirname, '..', 'data', 'stations.json'));
  try {
    const { text, count, skipped, version } = build(path.resolve(parsed.positionals[0]));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out + '.tmp', text);
    fs.renameSync(out + '.tmp', out);
    console.log(`${count} stations (uk-railway-stations ${version || 'version unknown'}) -> ${out}`);
    for (const s of skipped) console.warn(`skipped ${JSON.stringify(s.record)}: ${s.reason}`);
    return 0;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { build, main };
