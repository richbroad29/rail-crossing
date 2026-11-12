#!/usr/bin/env node
'use strict';
// Which signalling bits behave like level-crossing barriers?
//
// Reads the banked raw S-Class logs (backend/data/logs/sclass/sclass-<date>.jsonl[.gz], written by
// td-listener for every area in config/sclass.json with logRaw:'all') and, for every byte in every
// area, tests every ordered pair of bits (U, D) for the barrier cycle Yapton shows:
//
//   U 1->0  (barriers start down)  ...gap g1...  D 0->1 (down)  ...hold H...
//   D 1->0  (start up)             ...gap g2...  U 0->1 (up)
//
// with U and D never both set. Points (normal/reverse) give the same shape with a gap of a few
// seconds and holds of any length; track circuits are one bit, not a pair. So a candidate needs
// enough complete cycles, a median g1 that is a barrier's lowering time, and a median H that is a
// closure's length. It is a SHORTLIST for the berth-correlation proof in crossing-launch Phase 3,
// never a binding on its own.
//
// Known answer: BM byte 09, U=bit 7, D=bit 6 (Yapton). Run with --area BM first; if Yapton is not
// at the top, the scan is broken - fix it before reading anything else it says.
//
// Usage (on the VPS, from ~/rail-crossing):
//   nice -n 19 node --max-old-space-size=300 /tmp/barrier-bit-scan.js [--days 14] [--area BM] [--all]
//     --days N   most recent N complete days (default 14; today's partial file is skipped).
//                For a survey, N = the survey's days, so every area is rated over the same days.
//     --area X   one area only
//     --all      print every pair with >=1 cycle/day, not just candidates
// Only SF messages time a transition; an SG/SH refresh that changes a byte resets that byte's
// cycles (the instant is unknown), so a missed SF cannot fabricate a gap.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DAYS = Number(val('--days', 14));
const ONLY = val('--area', null);
const ALL = args.includes('--all');
const DIR = val('--dir', path.join(process.env.HOME, 'rail-crossing/backend/data/logs/sclass'));
const CFG = val('--config', path.join(process.env.HOME, 'rail-crossing/backend/config/sclass.json'));

// A candidate: >= MIN_PER_DAY cycles/day, lowering gap and closure length in a barrier's range.
const MIN_PER_DAY = 5, G1 = [4, 90], HOLD = [20, 1200];

const today = new Date().toISOString().slice(0, 10);
// sclass-<date> = the configured areas, always banked; survey-<date> = every other area, banked
// only during a survey window (td-listener, sclass.json survey.until). Both prefixes are 7 chars.
const all = fs.readdirSync(DIR)
  .filter(f => /^(sclass|survey)-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f))
  .filter(f => f.slice(7, 17) < today);
const dates = [...new Set(all.map(f => f.slice(7, 17)))].sort().slice(-DAYS);
const files = all.filter(f => dates.includes(f.slice(7, 17))).sort((a, b) => a.slice(7, 17).localeCompare(b.slice(7, 17)) || a.localeCompare(b));
if (!files.length) throw new Error(`no sclass files in ${DIR}`);
const surveyDays = new Set(files.filter(f => f.startsWith('survey-')).map(f => f.slice(7, 17))).size;

const known = {};
try {
  for (const [a, c] of Object.entries(JSON.parse(fs.readFileSync(CFG, 'utf8')).areas || {}))
    for (const [id, x] of Object.entries(c.crossings || {}))
      for (const b of Object.values(x.bits || {}))
        known[`${a}:${b.byte.toUpperCase()}:${b.bit}`] = `${id} ${x.name || ''}`.trim();
} catch (e) { console.error(`(no config read: ${e.message})`); }

// state[area][addr] = { v, pairs: Map(key -> machine) }
const state = {};
const stats = {};           // `${area}:${addr}:${u}:${d}` -> { cycles, g1:[], h:[], g2:[], both }

function machine() { return { downAt: null, lowAt: null, raiseAt: null }; }
function stat(k) { return stats[k] || (stats[k] = { cycles: 0, g1: [], h: [], g2: [], both: 0 }); }

function onChange(area, addr, oldV, newV, t, timed) {
  const a = state[area] || (state[area] = {});
  const s = a[addr] || (a[addr] = { pairs: new Map() });
  const diff = oldV ^ newV;
  for (let u = 0; u < 8; u++) for (let d = 0; d < 8; d++) {
    if (u === d) continue;
    const um = 1 << u, dm = 1 << d;
    if (!(diff & (um | dm))) continue;
    const key = `${area}:${addr}:${u}:${d}`;
    let m = s.pairs.get(key);
    if (!m) { m = machine(); s.pairs.set(key, m); }
    if ((newV & um) && (newV & dm)) { stat(key).both++; Object.assign(m, machine()); continue; }
    if (!timed) { Object.assign(m, machine()); continue; }
    const uOld = !!(oldV & um), uNew = !!(newV & um), dOld = !!(oldV & dm), dNew = !!(newV & dm);
    if (uOld && !uNew && !dNew) { Object.assign(m, machine()); m.lowAt = t; }                // start down
    if (!dOld && dNew && !uNew && m.lowAt != null) { m.downAt = t; m.g1 = t - m.lowAt; }    // down
    if (dOld && !dNew && !uNew && m.downAt != null) { m.raiseAt = t; m.h = t - m.downAt; }  // start up
    if (!uOld && uNew && !dNew && m.raiseAt != null) {                                     // up
      const st = stat(key);
      st.cycles++; st.g1.push(m.g1); st.h.push(m.h); st.g2.push(t - m.raiseAt);
      Object.assign(m, machine());
    }
  }
}

const value = {};           // `${area}:${addr}` -> byte
async function readFile(f) {
  const full = path.join(DIR, f);
  let input = fs.createReadStream(full);
  if (f.endsWith('.gz')) input = input.pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (ONLY && e.area !== ONLY) continue;
    if (!/^S[FGH]$/.test(e.msgType) || typeof e.data !== 'string') continue;
    const start = parseInt(e.address, 16);
    const t = Date.parse(e.ts) / 1000;
    for (let i = 0; i + 1 < e.data.length; i += 2) {
      const addr = (start + i / 2).toString(16).toUpperCase().padStart(2, '0');
      const k = `${e.area}:${addr}`;
      const v = parseInt(e.data.slice(i, i + 2), 16);
      const old = value[k];
      value[k] = v;
      if (old === undefined || old === v) continue;
      onChange(e.area, addr, old, v, t, e.msgType === 'SF');
    }
  }
}

const med = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };

(async () => {
  for (const f of files) await readFile(f);
  const days = dates.length;
  const rows = [];
  for (const [k, s] of Object.entries(stats)) {
    if (!s.cycles) continue;
    const [area, addr, u, d] = k.split(':');
    const r = { area, byte: addr, up: +u, down: +d, perDay: s.cycles / days, g1: med(s.g1), hold: med(s.h),
      g2: med(s.g2), both: s.both, known: known[`${area}:${addr}:${d}`] || known[`${area}:${addr}:${u}`] || '' };
    r.candidate = r.perDay >= MIN_PER_DAY && r.g1 >= G1[0] && r.g1 <= G1[1] && r.hold >= HOLD[0] && r.hold <= HOLD[1] && !r.both;
    if (ALL ? r.perDay >= 1 : r.candidate) rows.push(r);
  }
  // A barrier pair fits both ways round (closed and open swap); which way is right is for the
  // berth correlation to say. Keep one row per pair and say so.
  const seen = new Map();
  for (const r of rows) {
    const k = `${r.area}:${r.byte}:${Math.min(r.up, r.down)}:${Math.max(r.up, r.down)}`;
    const o = seen.get(k);
    if (!o) { seen.set(k, r); continue; }
    const keep = o.perDay >= r.perDay ? o : r;
    keep.reverse = o.candidate && r.candidate;
    seen.set(k, keep);
  }
  rows.length = 0; rows.push(...seen.values());
  rows.sort((a, b) => a.area.localeCompare(b.area) || b.perDay - a.perDay);
  console.log(`barrier-bit-scan: ${days} day(s) ${dates[0]}..${dates[days - 1]}, ${surveyDays} with an all-area survey` +
    `${ONLY ? `, area ${ONLY}` : ''}; candidate = >=${MIN_PER_DAY}/day, lowering ${G1[0]}-${G1[1]}s, closure ${HOLD[0]}-${HOLD[1]}s, never both set`);
  console.log('area byte up down  cycles/day  lower_s  closed_s  raise_s  both  cand  known');
  for (const r of rows)
    console.log(`${r.area.padEnd(4)} ${r.byte.padEnd(4)} ${String(r.up).padEnd(2)} ${String(r.down).padEnd(5)}` +
      `${r.perDay.toFixed(1).padStart(10)} ${String(Math.round(r.g1)).padStart(8)} ${String(Math.round(r.hold)).padStart(9)}` +
      ` ${String(Math.round(r.g2)).padStart(8)} ${String(r.both).padStart(5)}  ${r.candidate ? 'YES ' : '    '}  ${r.reverse ? '(fits either way round) ' : ''}${r.known}`);
  const areas = [...new Set(rows.filter(r => r.candidate).map(r => r.area))];
  console.log(`\n${rows.filter(r => r.candidate).length} candidate pair(s) in ${areas.length} area(s): ${areas.join(' ') || '-'}`);
})();
