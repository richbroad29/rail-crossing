#!/usr/bin/env node
'use strict';

// Rewrite a pack in the current format without rebuilding it from OSM: every graph, station and signal
// section is carried over unchanged, the overview layers are copied, and the derived index (format 2)
// is computed once and stored.
//
//   node track/upgrade.js <in.bin> <out.bin> [--manifest <in.manifest.json>]
//
// Writes <out.bin> and <out>.manifest.json (the input manifest, if given, with format, bytes, sha256 and
// section sizes updated and `upgradedFrom` recording the source pack's format and hash).

const fs = require('fs');
const path = require('path');
const { loadPack, readDirectory } = require('../src/track/pack');
const { writePack } = require('./lib/assemble');
const F = require('../src/track/format');

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : null; };
const manifestIn = flag('--manifest');
const [inFile, outFile] = args;
if (!inFile || !outFile) { console.error('usage: upgrade.js <in.bin> <out.bin> [--manifest <in.manifest.json>]'); process.exit(2); }

const fd = fs.openSync(inFile, 'r');
const srcVersion = readDirectory(fd, fs.fstatSync(fd).size).version;
const srcHash = require('crypto').createHash('sha256').update(fs.readFileSync(inFile)).digest('hex');
fs.closeSync(fd);

const pack = loadPack(inFile);
const sections = {};
for (const [id, arr] of Object.entries(pack.s)) sections[id] = arr;
for (const id of F.SECTIONS && ['VCUM', 'EBST', 'EBEN', 'GKEY', 'GOFF', 'GSEG', 'GSEGE']) delete sections[id];       // recomputed from the vertices
const meta = Object.assign({}, pack.meta, { format: F.VERSION });
const w = writePack(outFile, sections, { metaJson: JSON.stringify(meta), networkLo: pack.network('lo'), networkHi: pack.network('hi'), built: pack.meta.builtAtMs || Date.now() });
console.log(`wrote ${outFile}: ${(w.bytes / 1048576).toFixed(1)} MB, sha256 ${w.sha256}`);

const mf = manifestIn ? JSON.parse(fs.readFileSync(manifestIn, 'utf8')) : { packDate: pack.meta.packDate };
mf.file = path.basename(outFile); mf.sha256 = w.sha256; mf.bytes = w.bytes; mf.format = F.VERSION;
mf.sections = w.sections;
mf.upgradedFrom = { format: srcVersion, sha256: srcHash };
fs.writeFileSync(outFile.replace(/\.bin$/, '') + '.manifest.json', JSON.stringify(mf, null, 2));
