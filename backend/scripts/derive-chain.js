'use strict';

// derive-chain — reconstruct the berth chain THROUGH a crossing, and the gap
// (median dwell) between berths, purely from TD-feed timestamps. This is the
// first concrete output of the position-based-triggering ("berth-chain")
// analysis, and it also refines the strip-map `CHAIN` constant in the observer
// app (observe/observe.js).
//
// Method (no geography needed):
//   - each train's from→to steps give the berth ORDER;
//   - the time between a train's consecutive steps = its dwell in the berth it
//     sat in = the journey-time GAP to the next berth; median over many trains.
// We classify a train's direction by which confirmed anchor berths it visits
// and in what order, then walk the dominant predecessor/successor links out
// from the anchors to assemble the chain.
//
// Run on the VPS (full history lives there), from backend/:
//   node scripts/derive-chain.js            # scan all td-*.jsonl(.gz)
//   node scripts/derive-chain.js --days 21  # most recent 21 days only
//   node scripts/derive-chain.js --crossing portslade
//
// Read-only: scans logs + config, prints a summary and a paste-ready CHAIN
// snippet, and writes data/derived/<crossing>-chain.json. Touches nothing live.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'data', 'logs', 'td');
const OUT_DIR = path.join(ROOT, 'data', 'derived');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'crossings.json'), 'utf-8'));

// ---- args ----
const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; }
const CROSSING = argVal('--crossing', 'portslade');
const DAYS = parseInt(argVal('--days', '0'), 10) || 0; // 0 = all
const MAX_DWELL_S = 600; // ignore gaps > 10 min (a stabled/held train, not a step)

const td = CONFIG[CROSSING] && CONFIG[CROSSING].td;
if (!td) { console.error(`No td config for crossing "${CROSSING}"`); process.exit(1); }

// Confirmed anchors from config: approach.from → protecting (approach.to) → clear.to.
function anchorsFor(dirKey) {
  const d = td[dirKey];
  return [
    { b: d.approach.from, role: 'approach' },
    { b: d.approach.to, role: 'protecting' }, // == clear.from
    { b: d.clear.to, role: 'clear' }
  ];
}
const ANCHORS = { east: anchorsFor('eastbound'), west: anchorsFor('westbound') };
const ROLE = { east: {}, west: {} };
['east', 'west'].forEach(d => ANCHORS[d].forEach(a => { ROLE[d][a.b] = a.role; }));

// ---- gather log files ----
function logFiles() {
  if (!fs.existsSync(LOG_DIR)) return [];
  let files = fs.readdirSync(LOG_DIR).filter(f => /^td-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f)).sort();
  if (DAYS > 0) files = files.slice(-DAYS);
  return files.map(f => path.join(LOG_DIR, f));
}
function readLines(file) {
  const buf = fs.readFileSync(file);
  const text = file.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf-8') : buf.toString('utf-8');
  return text.split('\n');
}

// ---- accumulation ----
const dwell = { east: {}, west: {} };          // berth -> [secs]
const succ = { east: {}, west: {} }, pred = { east: {}, west: {} };
const trains = { east: 0, west: 0 };
function bump(m, a, b) { (m[a] = m[a] || {})[b] = (m[a][b] || 0) + 1; }

// Direction of a train from the order its step sequence visits the anchors.
function classify(seq) {
  function score(dir) {
    let last = -1, n = 0;
    for (const a of ANCHORS[dir]) { const i = seq.indexOf(a.b); if (i >= 0 && i > last) { n++; last = i; } }
    return n;
  }
  const e = score('east'), w = score('west');
  if (e >= 2 && e >= w) return 'east';
  if (w >= 2 && w > e) return 'west';
  return null;
}

const files = logFiles();
let dates = [];
for (const file of files) {
  dates.push(path.basename(file).slice(3, 13));
  let lines;
  try { lines = readLines(file); } catch (e) { console.error(`skip ${file}: ${e.message}`); continue; }
  const byTrain = {};
  for (const l of lines) {
    if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!o.desc || !o.to) continue;
    (byTrain[o.desc] = byTrain[o.desc] || []).push({ t: Date.parse(o.ts), from: o.from, to: o.to });
  }
  for (const hc in byTrain) {
    const ev = byTrain[hc].filter(e => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
    if (ev.length < 2) continue;
    const dir = classify(ev.map(e => e.to));
    if (!dir) continue;
    trains[dir]++;
    for (let i = 0; i < ev.length; i++) {
      if (ev[i].from) { bump(succ[dir], ev[i].from, ev[i].to); bump(pred[dir], ev[i].to, ev[i].from); }
      if (i < ev.length - 1) { const s = (ev[i + 1].t - ev[i].t) / 1000; if (s > 0 && s < MAX_DWELL_S) (dwell[dir][ev[i].to] = dwell[dir][ev[i].to] || []).push(s); }
    }
  }
}

// ---- build chains ----
const median = a => { if (!a || !a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)]); };
const top = (m, b) => { const h = m[b]; if (!h) return null; return Object.entries(h).sort((x, y) => y[1] - x[1])[0]; };

function buildChain(dir) {
  const minCount = Math.max(3, Math.ceil(trains[dir] * 0.1));
  const anchorBerths = ANCHORS[dir].map(a => a.b);
  const seen = new Set(anchorBerths);
  // walk back from the approach anchor
  let back = [anchorBerths[0]];
  for (let i = 0; i < 6; i++) { const p = top(pred[dir], back[0]); if (!p || p[1] < minCount || seen.has(p[0])) break; back.unshift(p[0]); seen.add(p[0]); }
  back.pop(); // drop the approach anchor (re-added with the middle)
  // walk forward from the clear anchor
  let fwd = [], cur = anchorBerths[2];
  for (let i = 0; i < 6; i++) { const s = top(succ[dir], cur); if (!s || s[1] < minCount || seen.has(s[0])) break; fwd.push(s[0]); seen.add(s[0]); cur = s[0]; }

  const ordered = back.concat(anchorBerths).concat(fwd);
  const nodes = [];
  ordered.forEach(b => {
    nodes.push({ b: b, gap: median(dwell[dir][b]), role: ROLE[dir][b] || undefined });
    if (ROLE[dir][b] === 'protecting') nodes.push({ x: true }); // crossing sits after protecting
  });
  return nodes;
}

const chain = { east: buildChain('east'), west: buildChain('west') };
const result = {
  generatedAt: new Date().toISOString(),
  crossingId: CROSSING, area: td.area,
  daysScanned: files.length, dateRange: dates.length ? [dates[0], dates[dates.length - 1]] : [],
  trains: trains, chain: chain,
  note: 'gap = median dwell seconds in that berth (journey-time spacing, not geographic distance)'
};

// ---- output ----
function fmtNode(n) { return n.x ? '║XING║' : (n.b + (n.gap != null ? '(' + n.gap + 's)' : '') + (n.role ? '·' + n.role : '')); }
console.log(`\nderive-chain — ${CROSSING} (area ${td.area})`);
console.log(`scanned ${files.length} day(s) ${result.dateRange.join(' … ') || '(none)'}; through-trains: east=${trains.east} west=${trains.west}`);
if (!files.length) console.log(`NOTE: no TD logs in ${LOG_DIR} — run on the VPS where the history lives.`);
for (const d of ['east', 'west']) console.log(`\n${d.toUpperCase()}\n  ${chain[d].map(fmtNode).join('  →  ')}`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `${CROSSING}-chain.json`);
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(`\nwrote ${outFile}`);

// paste-ready snippet for observe/observe.js CHAIN constant
const snippet = (d) => '    ' + d + ': [' + chain[d].map(n => n.x ? '{ x: true }' : ('{ b: \'' + n.b + '\', gap: ' + (n.gap == null ? 60 : n.gap) + (n.role ? ', role: \'' + n.role + '\'' : '') + ' }')).join(', ') + ']';
console.log('\n// paste into observe.js CHAIN:\n  var CHAIN = {\n' + snippet('east') + ',\n' + snippet('west') + '\n  };');
