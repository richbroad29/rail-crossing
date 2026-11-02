'use strict';

// Builders shared by the tests. Not a test file (no .test.js suffix), so the runner skips it.
// Everything built here is SYNTHETIC: STANOXes, berths and names are invented for the planted answers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

function tmpdir(prefix = 'phase0-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** A SMART row with every documented field present; override what a test cares about. */
function smartRow(o = {}) {
  return {
    TD: 'LA', FROMBERTH: '', TOBERTH: '', FROMLINE: '', TOLINE: '', BERTHOFFSET: '0', PLATFORM: '',
    EVENT: 'A', ROUTE: '', STANOX: '', STANME: '', STEPTYPE: 'B', COMMENT: '', ...o
  };
}

const smartDoc = rows => JSON.stringify({ BERTHDATA: rows });

/** Write text to <dir>/<name>, gzipped if the name ends .gz. Returns the path. */
function writeText(dir, name, text) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, name.endsWith('.gz') ? zlib.gzipSync(text) : text);
  return file;
}

function writeSmart(dir, rows, name = 'smart.json.gz') { return writeText(dir, name, smartDoc(rows)); }

/** A CORPUS row as the documentation describes it; blanks are a single space, as in the real file. */
function corpusRow({ stanox = ' ', tiploc = ' ', crs = ' ', name = ' ' } = {}) {
  return { NLC: '000000', STANOX: stanox, TIPLOC: tiploc, '3ALPHA': crs, UIC: ' ', NLCDESC: name, NLCDESC16: name.slice(0, 16) };
}

const corpusDoc = rows => JSON.stringify({ TIPLOCDATA: rows });
function writeCorpus(dir, rows, name = 'corpus.json.gz') { return writeText(dir, name, corpusDoc(rows)); }

/** A stations table as `loadStations` returns it: Map CRS -> { name, lat, lon }. */
function stationMap(obj) { return new Map(Object.entries(obj)); }

module.exports = { tmpdir, smartRow, smartDoc, writeText, writeSmart, corpusRow, corpusDoc, writeCorpus, stationMap };
