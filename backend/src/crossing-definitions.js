'use strict';

// Loads the crossing definitions: one file per crossing in config/crossings/<id>.json, the
// file name being the crossing id. Returns { <id>: definition } — the same shape the single
// config/crossings.json used to have, so every consumer reads it exactly as before.
//
// A definition holds everything about one crossing (docs/crossing-definition.md on main):
// the backend settings, plus a `presentation` block the backend ignores and the website's
// generator (scripts/build-crossings.js on main) reads.
//
// Not loaded as definitions: anything not named <id>.json with a lower-case id, and generated
// companion files such as <id>.timings.json.

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'config', 'crossings');
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// `source` is the definitions folder (default config/crossings), or — for scripts that still
// take a --config file — a single JSON file in the old all-crossings shape.
function loadCrossings(source = DEFAULT_DIR) {
  if (source.endsWith('.json')) return JSON.parse(fs.readFileSync(source, 'utf8'));
  const out = {};
  for (const f of fs.readdirSync(source).sort()) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    if (!ID_RE.test(id)) continue;                 // e.g. portslade.timings.json
    try {
      out[id] = JSON.parse(fs.readFileSync(path.join(source, f), 'utf8'));
    } catch (e) {
      throw new Error(`crossing definition ${f}: ${e.message}`);
    }
  }
  return out;
}

module.exports = { loadCrossings, DEFAULT_DIR };
