'use strict';

// The anchor table that phase 1 reads: every berth SMART ties to a station under our reading, and the
// berths that are only next to one. Written to <out>/smart-anchors-<stamp>.json, one berth per line so
// it can be read, grepped and diffed by eye.

const fs = require('fs');
const path = require('path');
const { redact } = require('./env');

/**
 * @param {object} p
 * @param {string} p.generatedAt  ISO timestamp
 * @param {string} p.smartFile    which SMART file this came from
 * @param {object} p.anchors      analyseAnchors' result
 * @returns {string} JSON text
 */
function anchorsFileText({ generatedAt, smartFile, anchors }) {
  const head = {
    _comment: 'Phase-0 output of smart-check. Each anchor is a TD berth that SMART puts AT a station, reading an arrival (EVENT A/C) as the station being at TOBERTH and a departure (B/D) at FROMBERTH. '
      + 'A hint is the other berth of a station step: next to a station, not at it. n counts the SMART rows that claimed the berth. '
      + 'A berth claimed by several stations carries claims (CRS -> rows) and maxKm (the largest distance between claimants); suspicious means maxKm is over counts.suspiciousKm. crs is the station with most claims.',
    generatedAt,
    smartFile,
    reading: { arrival: 'TOBERTH', departure: 'FROMBERTH', hint: 'the other berth of a station step' },
    counts: anchors.totals,
    areas: anchors.perArea
  };
  const list = rows => (rows.length ? '\n' + rows.map(r => '  ' + JSON.stringify(r)).join(',\n') + '\n ' : '');
  const text = '{\n'
    + Object.entries(head).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`).join('')
    + ` "anchors": [${list(anchors.table)}],\n`
    + ` "hints": [${list(anchors.hintTable)}]\n}\n`;
  JSON.parse(text);                                       // never write a file that is not valid JSON
  return text;
}

/** Write atomically (temp file, then rename), scrubbing any secret from the text first. */
function writeAnchorsFile(file, text, secrets = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, redact(text, secrets));
  fs.renameSync(tmp, file);
  return file;
}

module.exports = { anchorsFileText, writeAnchorsFile };
