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

const BOARD_TIMES = ['arrival', 'departure'];
const CLASS_RULES = ['approachStop', 'stopping'];

// The direction slots are the two keys of `directions`; every per-direction block is keyed by
// them, and the code never names one (docs/crossing-definition.md on main). A block keyed by
// anything else would be silently ignored — the shape a half-done rename leaves behind — so
// it is refused here, at load, instead. Returns a list of problems (empty = ok).
function definitionProblems(def) {
  const problems = [];
  const slots = Object.keys(def.directions || {});
  if (slots.length !== 2) {
    problems.push(`directions must name exactly two direction slots, has ${slots.length}`);
    return problems;
  }
  const isSlot = k => slots.includes(k);
  const isComment = k => k.startsWith('_');
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  for (const d of slots) {
    const bt = def.directions[d] && def.directions[d].boardTime;
    if (!BOARD_TIMES.includes(bt)) problems.push(`directions.${d}.boardTime must be one of ${BOARD_TIMES.join('/')}, is ${JSON.stringify(bt)}`);
  }
  const td = def.td || {};
  for (const [k, v] of Object.entries(td)) {
    if (isComment(k) || !isObj(v)) continue;            // e.g. td.area
    if (!isSlot(k)) problems.push(`td.${k} is not a direction slot (${slots.join(', ')})`);
    else if (v.classRule !== undefined && !CLASS_RULES.includes(v.classRule)) {
      problems.push(`td.${k}.classRule must be one of ${CLASS_RULES.join('/')}, is ${JSON.stringify(v.classRule)}`);
    }
  }
  const sched = def.schedule || {};
  const before = sched.tiplocsBefore;
  if (before !== undefined) {
    const keys = Object.keys(before).filter(k => !isComment(k));
    if (keys.length !== 2 || !keys.every(isSlot)) {
      problems.push(`schedule.tiplocsBefore must be keyed by the two direction slots (${slots.join(', ')}), has ${keys.join(', ') || 'none'}`);
    } else {
      const other = new Set(before[slots[1]] || []);
      for (const t of before[slots[0]] || []) if (other.has(t)) problems.push(`schedule.tiplocsBefore: ${t} is on both sides`);
    }
  }
  if (sched.stationSide !== undefined && !isSlot(sched.stationSide)) {
    problems.push(`schedule.stationSide must be a direction slot (${slots.join(', ')}), is ${JSON.stringify(sched.stationSide)}`);
  }
  // Every other block keyed by direction.
  const timing = def.timing || {}, pres = def.presentation || {};
  const keyed = {
    'schedule.interpolation': sched.interpolation,
    'timing.closeBefore': timing.closeBefore,
    'timing.openAfter': timing.openAfter,
    'timing.openAfterSecs.crossingAnchored': timing.openAfterSecs && timing.openAfterSecs.crossingAnchored,
    'timing.openAfterSecs.stationAnchored': timing.openAfterSecs && timing.openAfterSecs.stationAnchored,
    'timing.openLagSecs': timing.openLagSecs,
    'timing.areaEntryLeadSecs': timing.areaEntryLeadSecs,
    'timing.closeTrigger': timing.closeTrigger,
    'presentation.directions': pres.directions,
    'presentation.chain': pres.chain,
    'presentation.offChainEta': pres.offChainEta
  };
  for (const [where, block] of Object.entries(keyed)) {
    if (!isObj(block)) continue;
    for (const k of Object.keys(block)) {
      if (!isComment(k) && !isSlot(k)) problems.push(`${where}.${k} is not a direction slot (${slots.join(', ')})`);
    }
  }
  return problems;
}

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
    const problems = definitionProblems(out[id]);
    if (problems.length) throw new Error(`crossing definition ${f}: ${problems.join('; ')}`);
  }
  return out;
}

module.exports = { loadCrossings, definitionProblems, DEFAULT_DIR };
