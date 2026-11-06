'use strict';

// Where each TD describer area's C-Class log lives.
//
// ROOT_AREA (LA, Portslade's area) stays exactly where it has always been —
// data/logs/td/td-<date>.jsonl — because four months of history and every tool that reads it
// (derive-*, backtest-transits, held-split, gone-holds, the crossing-audit scripts, the map
// service's replay tools) match `td-YYYY-MM-DD.jsonl` in that one folder. Any other area a
// crossing is configured for gets its own subfolder, data/logs/td/<AREA>/td-<date>.jsonl.
//
// Why a subfolder rather than one shared file: berth codes repeat across areas (0006 is in LA
// and most other areas), so a reader that forgot to filter on `area` would silently mix a
// distant area's steps into Portslade's analysis. Separate folders mean an existing reader
// cannot see another area's lines at all, and those readers' strict filename filters skip a
// subfolder entry rather than tripping over it (multi-crossing-readiness.md, Phase A step 2).

const path = require('path');

const TD_LOG_ROOT = path.join(__dirname, '..', 'data', 'logs', 'td');
const ROOT_AREA = 'LA';

// TD area ids are two characters (LA, BM, X7, Q3...). Anything else is a config error, and
// is refused here because it becomes part of a filesystem path.
const AREA_RE = /^[A-Z0-9]{2}$/;

function isValidArea(area) {
  return typeof area === 'string' && AREA_RE.test(area);
}

function tdLogDir(area) {
  if (!isValidArea(area)) throw new Error(`invalid TD area id: ${JSON.stringify(area)}`);
  return area === ROOT_AREA ? TD_LOG_ROOT : path.join(TD_LOG_ROOT, area);
}

function tdLogFile(area, dateStamp) {
  return path.join(tdLogDir(area), `td-${dateStamp}.jsonl`);
}

// The distinct TD areas the configured crossings need C-Class from, in config order.
// A crossing with no td.area contributes nothing; an invalid one is reported and skipped.
function crossingTdAreas(crossingsConfig) {
  const areas = [];
  for (const [id, c] of Object.entries(crossingsConfig || {})) {
    const area = c && c.td && c.td.area;
    if (area == null) continue;
    if (!isValidArea(area)) { console.error(`crossing ${id}: invalid td.area ${JSON.stringify(area)} — ignored`); continue; }
    if (!areas.includes(area)) areas.push(area);
  }
  return areas;
}

module.exports = { TD_LOG_ROOT, ROOT_AREA, isValidArea, tdLogDir, tdLogFile, crossingTdAreas };
