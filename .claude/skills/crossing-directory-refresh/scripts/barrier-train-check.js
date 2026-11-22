#!/usr/bin/env node
'use strict';
// Does a candidate barrier bit really follow the trains over a level crossing, and which crossing is it?
//
// barrier-bit-scan.js finds bit pairs that SWITCH like barriers; points and signals can too (Nov 2026:
// 81 candidate bytes in London areas with at most one road crossing). This is the train check that
// binds a bit to a crossing - crossing-launch Stage 3's "byte hunt and berth discovery are one
// computation" - run on every candidate at once, without being told any berths.
//
// For each candidate pair, both ways round (the scan cannot tell up from down):
//   1. DOWN SPANS: the down bit's on-periods, edges from timed SF messages only (a span that an SG/SH
//      refresh cuts into is dropped: its edge is unknown).
//   2. CROSSING STEPS: every train step (CA) in the pair's own area is scored by the share of its
//      occurrences inside a down span. A barrier has a step per line that trains make only with the
//      barrier down: the step onto or just past the crossing. (Yapton, 13-20 Nov 2026: BH72>AR12 100%,
//      BH73>BH75 99.9%, next best 93%.)
//   3. THE BAR (constants below, each with where it came from): a crossing step, and one for trains the
//      OTHER way too (a signal or a set of points serves one route; a barrier stops the road for every
//      train), every closure holding a train, the bit down well before the train and up just after it.
//      Without the both-ways and down-before rules, 72 of 125 London points/signals candidates passed
//      on 20-21 Nov and only the lack of a nearby crossing stopped them; with them, none does.
//   4. WHERE: trains making the crossing steps are followed (same headcode, any area) back and forward to
//      the nearest SMART-timed station event; the crossing sits between the two stations in proportion to
//      the running times either side, and is named from the crossing list - or reported as WHICH ONE?
//      when two listed crossings are too close together to choose between.
//   One crossing can show in two areas' S-Class (Yapton is BM 09 and CH 18: all 456 down-bit changes on
//   20 Nov within 5 s of each other), and in several bytes; the summary counts crossings, not bits.
//
// Usage (on the Mac; reads gz):
//   node barrier-train-check.js --sclass <dir> --cclass <dir>[,<dir>...] --from YYYY-MM-DD --to YYYY-MM-DD
//        (--scan <barrier-scan-*.txt> | --pair AREA:BYTE:U:D[,...]) [--area X[,Y...]] [--json out.json]
//        [--refdata ~/rail-map-refdata] [--crossings scripts/crossing-list.csv] [--steps N]
//   --sclass   folder with sclass-<date> / survey-<date>.jsonl[.gz] (raw S-Class)
//   --cclass   folder(s) with train steps: td-all-<date> (every area), cclass-<AREA>-<date>, td-<date>
//              (LA). A day with a td-all file uses td-all only, so an area is never counted twice.
//   --steps N  also print each candidate's N best steps (default 0; 3 is useful when reading one)
// Known answer: BM byte 09 (Yapton). It must come out CONFIRMED on steps BH72>AR12 and BH73>BH75,
// named Yapton (1939); the run says PASS or FAIL. If FAIL, nothing else it says can be trusted.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const HOME = process.env.HOME;
const REPO = path.resolve(__dirname, '../../../..');
const tilde = p => p && p.replace(/^~(?=\/|$)/, HOME);
const SCLASS = tilde(val('--sclass', null));
const CCLASS = (val('--cclass', '') || '').split(',').filter(Boolean).map(tilde);
const FROM = val('--from', null), TO = val('--to', null);
const SCAN = val('--scan', null), PAIRS = val('--pair', null);
const ONLY = val('--area', null);
const JSON_OUT = val('--json', null);
const REF = val('--refdata', path.join(HOME, 'rail-map-refdata'));
const XLIST = val('--crossings', path.join(REPO, 'scripts/crossing-list.csv'));
const SHOW_STEPS = Number(val('--steps', 0));
if (!SCLASS || !CCLASS.length || !FROM || !TO || !(SCAN || PAIRS)) {
  console.error('need --sclass, --cclass, --from, --to and --scan or --pair (see the header)'); process.exit(2);
}

// ---- The bar. Each number says what it measures and where it came from. ----
const BAR = {
  stepShare: 0.97,     // crossing step: share of its trains inside a down span (Yapton 100% / 99.9%)
  stepPerDay: 2,       // ...made at least this often a day, so a quiet siding cannot pass by luck
  cover: 0.90,         // share of down spans holding a crossing step: every closure has a train (Yapton 99.7%)
  oppShare: 0.90,      // the other direction's step may sit a little lower (its train can clear as the barrier lifts)
  leadMin: 10,         // median s from the down bit going on to the first train's step: a barrier is down
                       //   BEFORE the train comes (Yapton ~90-107 s); bits that come on with the step are
                       //   train detection, not a barrier (London 20-21 Nov: dozens at 0 s)
  raiseMin: 3,         // median s from the last train's step to the down bit going off: a barrier lifts
  raiseMax: 120,       //   after the train has gone (Yapton 16 s), not at the same instant
  downMax: 0.6,        // the bit is down at most this share of the time
  nameKm: 1.5,         // named only if the crossing list has a crossing this close to the estimate,
  nameGapKm: 0.5,      //   and the next one is this much further and at least twice as far (else WHICH ONE?)
                       // ...and trains in BOTH directions must pass with it down: a signal or a set of
                       //   points serves one route (London: nearly every candidate that passed the rest)
};
const KNOWN = { pair: 'BM:09', steps: ['BM:BH72>AR12', 'BM:BH73>BH75'], uid: '1939', name: 'Yapton' };

// ---------------------------------------------------------------------------------------------------
const inRange = d => d >= FROM && d <= TO;
const lines = async function* (file) {
  let input = fs.createReadStream(file);
  if (file.endsWith('.gz')) input = input.pipe(zlib.createGunzip());
  yield* readline.createInterface({ input, crlfDelay: Infinity });
};
const med = xs => { if (!xs.length) return null; const s = Float64Array.from(xs).sort(); return s[s.length >> 1]; };
const pct = (xs, p) => { if (!xs.length) return null; const s = Float64Array.from(xs).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// ---- candidates ----
const cands = [];   // { area, byte, a, b, perDay, scanNote }
if (PAIRS) for (const p of PAIRS.split(',')) {
  const [area, byte, u, d] = p.split(':');
  cands.push({ area, byte: byte.toUpperCase(), a: +u, b: +d, perDay: null, scanNote: '' });
}
if (SCAN) for (const l of fs.readFileSync(SCAN, 'utf8').split('\n')) {
  const m = l.match(/^(\S+)\s+([0-9A-F]{2})\s+(\d)\s+(\d)\s+([\d.]+)\s+.*\bYES\b\s*(.*)$/);
  if (m) cands.push({ area: m[1], byte: m[2], a: +m[3], b: +m[4], perDay: +m[5], scanNote: m[6].trim() });
}
const onlySet = ONLY ? new Set(ONLY.split(',')) : null;
const wanted = cands.filter(c => !onlySet || onlySet.has(c.area));
const watchBytes = new Set(wanted.map(c => `${c.area}:${c.byte}`));
const watchAreas = new Set(wanted.map(c => c.area));

// ---- S-Class: per watched byte, its value changes ----
const changes = new Map();   // "AREA:BYTE" -> [t, value, timed] flat array
const sDays = new Map();     // area -> Set(date) with any S-Class
async function readSclass() {
  const files = fs.readdirSync(SCLASS).filter(f => /^(sclass|survey)-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f))
    .filter(f => inRange(f.slice(7, 17))).sort((x, y) => x.slice(7, 17).localeCompare(y.slice(7, 17)) || x.localeCompare(y));
  const value = new Map();
  for (const f of files) {
    const day = f.slice(7, 17);
    for await (const line of lines(path.join(SCLASS, f))) {
      const ai = line.indexOf('"area":"'); if (ai < 0) continue;
      const area = line.slice(ai + 8, line.indexOf('"', ai + 8));
      if (!watchAreas.has(area)) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (!/^S[FGH]$/.test(e.msgType) || typeof e.data !== 'string') continue;
      (sDays.get(area) || sDays.set(area, new Set()).get(area)).add(day);
      const t = Date.parse(e.feedTime || e.ts) / 1000, timed = e.msgType === 'SF';
      const start = parseInt(e.address, 16);
      for (let i = 0; i + 1 < e.data.length; i += 2) {
        const k = `${area}:${(start + i / 2).toString(16).toUpperCase().padStart(2, '0')}`;
        if (!watchBytes.has(k)) continue;
        const v = parseInt(e.data.slice(i, i + 2), 16), old = value.get(k);
        value.set(k, v);
        if (old === v) continue;
        const arr = changes.get(k) || changes.set(k, []).get(k);
        arr.push(t, v, old === undefined ? 0 : (timed ? 1 : 0));
      }
    }
  }
  console.log(`S-Class: ${files.length} file(s) ${files.length ? files[0].slice(7, 17) + '..' + files[files.length - 1].slice(7, 17) : '-'}`);
}

// Down spans of one bit: [start, end] pairs, timed edges only, none longer than 3 h (a feed gap).
function spansOf(k, bit) {
  const ch = changes.get(k) || [];
  const out = [];
  let start = null, prev = null;
  const order = [];
  for (let i = 0; i < ch.length; i += 3) order.push(i);
  order.sort((x, y) => ch[x] - ch[y]);
  for (const i of order) {
    const t = ch[i], v = ch[i + 1], timed = ch[i + 2] === 1;
    const now = (v >> bit) & 1, was = prev === null ? null : (prev >> bit) & 1;
    prev = v;
    if (was === null || now === was) continue;
    if (!timed) { start = null; continue; }
    if (now) start = t;
    else if (start !== null) { if (t - start <= 3 * 3600) out.push(start, t); start = null; }
  }
  return out;
}

// ---- Train steps (C-Class), every area: interned key, time, headcode ----
const keyIds = new Map(), keyOf = [], areaOfKey = [];
const descIds = new Map(), descOf = [];
let N = 0, kArr = new Int32Array(1 << 20), tArr = new Float64Array(1 << 20), dArr = new Int32Array(1 << 20);
const intern = (map, list, s) => { let id = map.get(s); if (id === undefined) { id = list.length; list.push(s); map.set(s, id); } return id; };
function push(area, from, to, desc, t) {
  if (!from || !to || !Number.isFinite(t)) return;
  if (N === kArr.length) {
    const g = (A) => { const n = new A.constructor(A.length * 2); n.set(A); return n; };
    kArr = g(kArr); tArr = g(tArr); dArr = g(dArr);
  }
  const key = `${area}:${from}>${to}`;
  let id = keyIds.get(key);
  if (id === undefined) { id = keyOf.length; keyOf.push(key); areaOfKey.push(area); keyIds.set(key, id); }
  kArr[N] = id; tArr[N] = t; dArr[N] = intern(descIds, descOf, desc || ''); N++;
}
const cDays = new Map();   // area -> Set(date) with any train step
async function readCclass() {
  const re = /^(td-all|td|cclass-([A-Z0-9]{2}))-(\d{4}-\d{2}-\d{2})(-partial)?\.jsonl(\.gz)?$/;
  const byDay = new Map();
  for (const dir of CCLASS) for (const f of fs.readdirSync(dir)) {
    const m = f.match(re); if (!m || !inRange(m[3])) continue;
    const d = byDay.get(m[3]) || byDay.set(m[3], []).get(m[3]);
    d.push({ file: path.join(dir, f), kind: m[1] === 'td-all' ? 'all' : 'area', name: f });
  }
  for (const day of [...byDay.keys()].sort()) {
    let fs_ = byDay.get(day);
    if (fs_.some(x => x.kind === 'all')) fs_ = fs_.filter(x => x.kind === 'all').slice(0, 1);
    const before = N; let first = Infinity, last = -Infinity;
    for (const { file } of fs_) for await (const line of lines(file)) {
      if (line.indexOf('"CA') < 0) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      let area, t;
      if (e.type === 'CA_MSG') { area = e.area_id; t = Number(e.time) / 1000; push(area, e.from, e.to, e.descr, t); }
      else if (e.event === 'CA') { area = e.area; t = Date.parse(e.ts) / 1000; push(area, e.from, e.to, e.desc, t); }
      else continue;
      (cDays.get(area) || cDays.set(area, new Set()).get(area)).add(day);
      if (t < first) first = t; if (t > last) last = t;
    }
    const iso = s => Number.isFinite(s) ? new Date(s * 1000).toISOString().slice(5, 16).replace('T', ' ') : '-';
    console.log(`train steps ${day}: ${fs_.map(x => x.name).join(' + ')}  ${N - before} steps, ${iso(first)}-${iso(last)} UTC`);
  }
}

// ---- Geography: SMART anchors, station coordinates, crossing list ----
function loadGeo() {
  const smart = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REF, 'smart-latest.json.gz')))).BERTHDATA;
  const corpus = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REF, 'corpus-latest.json.gz'))));
  const tip = new Map();   // STANOX -> [TIPLOC]
  const nameOf = new Map();
  for (const r of corpus.TIPLOCDATA || corpus) {
    const s = String(r.STANOX || '').trim(); if (!s) continue;
    if (r.TIPLOC) (tip.get(s) || tip.set(s, []).get(s)).push(String(r.TIPLOC).trim());
    const n = String(r.NLCDESC || '').trim(); if (n && (!nameOf.has(s) || n.length < nameOf.get(s).length)) nameOf.set(s, n);
  }
  const coord = new Map();  // TIPLOC -> [lat, lon] from NaPTAN rail (ATCOCode 9100<TIPLOC>)
  const nap = fs.readFileSync(path.join(REF, 'naptan-rail.csv'), 'utf8').split('\n');
  const h = csvRow(nap[0]), iA = h.indexOf('ATCOCode'), iLat = h.indexOf('Latitude'), iLon = h.indexOf('Longitude');
  for (const l of nap.slice(1)) {
    if (!l) continue; const r = csvRow(l);
    if (r[iA] && r[iA].startsWith('9100') && r[iLat]) coord.set(r[iA].slice(4), [+r[iLat], +r[iLon]]);
  }
  const anchor = new Map();  // "AREA:FROM>TO" -> { stanox, name, at:[lat,lon], offset, event }
  for (const r of smart) {
    const s = String(r.STANOX || '').trim(); if (!s || !r.FROMBERTH || !r.TOBERTH) continue;
    const at = (tip.get(s) || []).map(x => coord.get(x)).find(Boolean); if (!at) continue;
    const k = `${r.TD}:${r.FROMBERTH}>${r.TOBERTH}`;
    if (!anchor.has(k)) anchor.set(k, { stanox: s, name: nameOf.get(s) || r.STANME || s, at, offset: Number(r.BERTHOFFSET) || 0, event: r.EVENT });
  }
  const xs = [];
  const rows = fs.readFileSync(XLIST, 'utf8').split('\n').filter(Boolean);
  const hx = csvRow(rows[0]);
  for (const l of rows.slice(1)) {
    const r = Object.fromEntries(csvRow(l).map((v, i) => [hx[i], v]));
    if (r.excluded || r.status !== 'Open' || !r.lat) continue;
    xs.push({ uid: r.uid, name: r.display_name || r.name, type: r.type, lat: +r.lat, lon: +r.lon });
  }
  return { anchor, xs };
}
function csvRow(l) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur.replace(/\r$/, '')); return out;
}
const km = (a, b) => { const r = Math.PI / 180, x = (b[1] - a[1]) * r * Math.cos((a[0] + b[0]) / 2 * r), y = (b[0] - a[0]) * r; return 6371 * Math.hypot(x, y); };

// ---- The check for one candidate, one way round ----
function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
function check(c, downBit, upBit, areaSteps, days) {
  const k = `${c.area}:${c.byte}`;
  const sp = spansOf(k, downBit);
  const S = sp.length / 2;
  if (!S) return null;
  const starts = new Float64Array(S), ends = new Float64Array(S);
  for (let i = 0; i < S; i++) { starts[i] = sp[2 * i]; ends[i] = sp[2 * i + 1]; }
  // time covered: each day both feeds have this area, first to last change of the byte that day
  const ch = changes.get(k); let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < ch.length; i += 3) { if (ch[i] < lo) lo = ch[i]; if (ch[i] > hi) hi = ch[i]; }
  let down = 0; for (let i = 0; i < S; i++) down += ends[i] - starts[i];
  const downShare = down / Math.max(1, hi - lo);
  const inside = t => { const i = lowerBound(starts, t + 1e-6) - 1; return i >= 0 && t <= ends[i] ? i : -1; };
  // score every step key in the area
  const n = new Map(), hit = new Map();
  for (const j of areaSteps) {
    const t = tArr[j]; if (t < lo || t > hi) continue;
    const key = kArr[j];
    n.set(key, (n.get(key) || 0) + 1);
    if (inside(t) >= 0) hit.set(key, (hit.get(key) || 0) + 1);
  }
  const minN = Math.max(10, BAR.stepPerDay * days);
  const ranked = [...n.entries()].filter(([, v]) => v >= minN)
    .map(([key, v]) => ({ key, n: v, share: (hit.get(key) || 0) / v }))
    .sort((x, y) => y.share - x.share || y.n - x.n);
  return { downBit, upBit, starts, ends, spans: S, perDay: S / days, downShare, ranked, inside };
}

// The trains behind one step: for each (up to 300), the nearest SMART-timed station event before and
// after it, same headcode, within 20 min. Gives the step's DIRECTION (which stations its trains come
// from and go to - the same station on either track) and, with both sides, where on the stretch it is.
function trainsOf(key, geo, keyIdx, byDesc) {
  const before = new Map(), after = new Map(), legs = [];
  let used = 0;
  for (const j of keyIdx.get(key) || []) {
    if (++used > 300) break;
    const t = tArr[j], list = byDesc.get(dArr[j]); if (!list) continue;
    let b = null, a = null;
    for (const x of list) {
      const an = geo.anchor.get(keyOf[kArr[x]]); if (!an) continue;
      const dt = tArr[x] + an.offset - t;
      if (dt < -1200 || dt > 1200) continue;
      if (dt <= 0 && (!b || dt > b.dt)) b = { an, dt };
      if (dt > 0 && (!a || dt < a.dt)) a = { an, dt };
    }
    if (b) before.set(b.an.stanox, (before.get(b.an.stanox) || 0) + 1);
    if (a) after.set(a.an.stanox, (after.get(a.an.stanox) || 0) + 1);
    if (b && a && b.an.stanox !== a.an.stanox) legs.push({ A: b.an, B: a.an, f: -b.dt / (a.dt - b.dt) });
  }
  const norm = m => { const s = [...m.values()].reduce((x, y) => x + y, 0); return new Map([...m].map(([k, v]) => [k, v / (s || 1)])); };
  return { before: norm(before), after: norm(after), seen: before.size + after.size ? used : 0, legs };
}
const overlap = (m1, m2) => { let s = 0; for (const [k, v] of m1) if (m2.has(k)) s += Math.min(v, m2.get(k)); return s; };
// Share of key2's trains (same headcode) that also make key1 within 10 min: the same trains, so the same
// direction, whatever the stations say (a SMART step can be the station itself, which reads as "after"
// from the step before it and "before" from itself).
function sharedTrains(key1, key2, keyIdx, byDesc) {
  let n = 0, both = 0;
  const k1 = keyIdx.get(key1) || [];
  for (const j of keyIdx.get(key2) || []) {
    if (++n > 300) break;
    const list = byDesc.get(dArr[j]) || [];
    const t = tArr[j];
    if (list.some(x => kArr[x] === key1 && Math.abs(tArr[x] - t) <= 600)) both++;
  }
  return n ? both / Math.min(n, 300) : 0;
}
// +1 = same direction, -1 = opposite, 0 = cannot tell
function sense(t1, t2) {
  const same = overlap(t1.before, t2.before) + overlap(t1.after, t2.after);
  const opp = overlap(t1.before, t2.after) + overlap(t1.after, t2.before);
  if (opp >= 0.3 && opp > 2 * same) return -1;
  if (same >= 0.3 && same > 2 * opp) return 1;
  return 0;
}

// The verdict for one candidate: the crossing steps (one per direction), then every closure checked
// against them, then where it is.
function evaluate(r, geo, keyIdx, byDesc) {
  const top = r.ranked.filter(s => s.share >= BAR.oppShare).slice(0, 8);
  const primary = top.find(s => s.share >= BAR.stepShare);
  const out = { primary: null, opposite: null, cover: 0, leadMed: null, leadP10: null, raiseMed: null, loc: null, dirKnown: false };
  if (!primary) return out;
  out.primary = primary;
  const tp = trainsOf(primary.key, geo, keyIdx, byDesc);
  out.dirKnown = tp.before.size + tp.after.size > 0;
  const tr = new Map([[primary.key, tp]]);
  out.unsure = 0;
  for (const s of top) {
    if (s === primary) continue;
    const ts = trainsOf(s.key, geo, keyIdx, byDesc); tr.set(s.key, ts);
    const d = sharedTrains(primary.key, s.key, keyIdx, byDesc) >= 0.3 ? 1 : sense(tp, ts);
    if (d === -1 && (!out.opposite || s.n > out.opposite.n)) out.opposite = s;
    if (d === 0) out.unsure++;
  }
  // every closure must hold a train over the crossing, either way
  const set = new Set([primary.key, ...(out.opposite ? [out.opposite.key] : [])]);
  const S = r.spans, first = new Float64Array(S).fill(NaN), last = new Float64Array(S).fill(NaN);
  for (const key of set) for (const j of keyIdx.get(key) || []) {
    const i = r.inside(tArr[j]); if (i < 0) continue;
    if (isNaN(first[i]) || tArr[j] < first[i]) first[i] = tArr[j];
    if (isNaN(last[i]) || tArr[j] > last[i]) last[i] = tArr[j];
  }
  let covered = 0; const lead = [], raise = [];
  for (let i = 0; i < S; i++) if (!isNaN(first[i])) { covered++; lead.push(first[i] - r.starts[i]); raise.push(r.ends[i] - last[i]); }
  Object.assign(out, { cover: covered / S, leadMed: med(lead), leadP10: pct(lead, 0.1), raiseMed: med(raise) });
  // where: fold both directions' legs onto one stretch
  const pairs = new Map();
  for (const key of set) for (const { A, B, f } of tr.get(key).legs) {
    const flip = A.stanox > B.stanox, [P, Q] = flip ? [B, A] : [A, B], k = `${P.stanox}|${Q.stanox}`;
    (pairs.get(k) || pairs.set(k, { A: P, B: Q, fr: [] }).get(k)).fr.push(flip ? 1 - f : f);
  }
  const best = [...pairs.values()].sort((x, y) => y.fr.length - x.fr.length)[0];
  if (best && best.fr.length >= 5) {
    const f = med(best.fr);
    const at = [best.A.at[0] + f * (best.B.at[0] - best.A.at[0]), best.A.at[1] + f * (best.B.at[1] - best.A.at[1])];
    const near = geo.xs.map(x => ({ ...x, d: km(at, [x.lat, x.lon]) })).sort((a, b) => a.d - b.d).slice(0, 3);
    // named only when the next listed crossing is clearly further: the estimate is good to a few hundred
    // metres (Yapton 0.1-0.2 km off), not enough to choose between crossings 300 m apart
    const close = near[0] && near[0].d <= BAR.nameKm;
    const clear = close && (!near[1] || (near[1].d - near[0].d >= BAR.nameGapKm && near[1].d >= 2 * near[0].d));
    out.loc = { between: [best.A.name, best.B.name], frac: f, trains: best.fr.length, at, near,
      named: clear ? near[0] : null, either: close && !clear ? near.filter(x => x.d <= Math.max(BAR.nameKm, 2 * near[0].d + BAR.nameGapKm)) : null };
  }
  return out;
}

function verdict(r, e) {
  if (!r) return { v: 'NO DATA', why: ['no down spans'] };
  if (!e.primary) return { v: 'REJECTED', why: [`no step >=${BAR.stepShare * 100}% inside (best ${r.ranked[0] ? (r.ranked[0].share * 100).toFixed(0) + '%' : '-'})`] };
  const hard = [], soft = [];
  if (e.cover < BAR.cover) hard.push(`closures with a train ${(e.cover * 100).toFixed(0)}%`);
  if (e.leadMed !== null && e.leadMed < BAR.leadMin) hard.push(`down only ${Math.round(e.leadMed)} s before the train`);
  if (e.raiseMed !== null && (e.raiseMed < BAR.raiseMin || e.raiseMed > BAR.raiseMax)) hard.push(`up ${Math.round(e.raiseMed)} s after the train`);
  if (r.downShare > BAR.downMax) hard.push(`down ${(r.downShare * 100).toFixed(0)}% of the time`);
  if (!e.dirKnown) soft.push('no timed station near its trains: direction unknown');
  else if (!e.opposite && e.unsure) soft.push('other direction not found');
  else if (!e.opposite) hard.push('trains one way only');
  if (!e.loc) soft.push('no timed station each side: not placed');
  else if (e.loc.either) { if (!hard.length && !soft.length) return { v: 'WHICH ONE?', why: [`${e.loc.either.map(x => `${x.name} (${x.uid}) ${x.d.toFixed(1)} km`).join(' or ')}`] }; soft.push('crossing ambiguous'); }
  else if (!e.loc.named) soft.push(`nearest crossing ${e.loc.near[0] ? e.loc.near[0].d.toFixed(1) + ' km' : '-'}`);
  if (hard.length) return { v: 'REJECTED', why: [...hard, ...soft] };
  return soft.length ? { v: 'POSSIBLE', why: soft } : { v: 'CONFIRMED', why: [] };
}

(async () => {
  await readSclass();
  await readCclass();
  const geo = loadGeo();
  console.log(`geography: ${geo.anchor.size} SMART steps placed at a station, ${geo.xs.length} open road crossings`);
  // per-area step lists, time order
  const order = new Int32Array(N); for (let i = 0; i < N; i++) order[i] = i;
  order.sort((x, y) => tArr[x] - tArr[y]);
  const byArea = new Map();
  for (const j of order) { const a = areaOfKey[kArr[j]]; if (watchAreas.has(a)) (byArea.get(a) || byArea.set(a, []).get(a)).push(j); }
  const results = [];
  for (const c of wanted) {
    const steps = byArea.get(c.area) || [];
    const sd = sDays.get(c.area) || new Set(), cd = cDays.get(c.area) || new Set();
    const days = [...sd].filter(d => cd.has(d)).length;
    if (!days || !steps.length) { results.push({ c, ver: { v: 'NO DATA', why: [`S-Class days ${sd.size}, train-step days ${cd.size}`] } }); continue; }
    results.push({ c, days, ways: [check(c, c.b, c.a, steps, days), check(c, c.a, c.b, steps, days)].filter(Boolean) });
  }
  // index the steps (and their trains) that any candidate might call a crossing step
  const want = new Set();
  for (const o of results) for (const r of o.ways || []) for (const s of r.ranked.filter(x => x.share >= BAR.oppShare).slice(0, 8)) want.add(s.key);
  const keyIdx = new Map(), needDesc = new Set();
  for (const j of order) if (want.has(kArr[j])) { (keyIdx.get(kArr[j]) || keyIdx.set(kArr[j], []).get(kArr[j])).push(j); needDesc.add(dArr[j]); }
  const byDesc = new Map();
  for (const j of order) if (needDesc.has(dArr[j])) (byDesc.get(dArr[j]) || byDesc.set(dArr[j], []).get(dArr[j])).push(j);
  const rank = { CONFIRMED: 0, 'WHICH ONE?': 1, POSSIBLE: 2, REJECTED: 3, 'NO DATA': 4 };
  for (const o of results) {
    if (o.ver) continue;
    if (!o.ways.length) { o.ver = { v: 'NO DATA', why: ['no complete down span'] }; continue; }
    // both ways round; keep the better reading
    const tried = o.ways.map(r => { const e = evaluate(r, geo, keyIdx, byDesc); return { r, e, ver: verdict(r, e) }; });
    tried.sort((p, q) => rank[p.ver.v] - rank[q.ver.v] || q.e.cover - p.e.cover || (q.e.primary ? q.e.primary.share : 0) - (p.e.primary ? p.e.primary.share : 0));
    Object.assign(o, tried[0]);
  }

  // ---- report ----
  results.sort((p, q) => rank[p.ver.v] - rank[q.ver.v] || p.c.area.localeCompare(q.c.area) || (q.r ? q.r.perDay : 0) - (p.r ? p.r.perDay : 0));
  const short = key => keyOf[key].split(':')[1];
  const fmt = (x, d = 0) => x === null || x === undefined ? '-' : x.toFixed(d);
  console.log(`\nbarrier-train-check ${FROM}..${TO}: ${wanted.length} candidate pair(s); bar: a step >=${BAR.stepShare * 100}% inside the down bit,` +
    ` trains BOTH ways with it down (other way >=${BAR.oppShare * 100}%), >=${BAR.cover * 100}% of closures with a train,` +
    ` down >=${BAR.leadMin} s before the train, up ${BAR.raiseMin}-${BAR.raiseMax} s after it, down <=${BAR.downMax * 100}% of the time, a listed crossing within ${BAR.nameKm} km`);
  console.log('verdict     area byte dn up days closures/d down%  crossing steps: this way / other way (share inside, per day)   trains%  lead_s raise_s  where');
  for (const o of results) {
    const { c, r, e, ver } = o;
    const head = `${ver.v.padEnd(11)} ${c.area.padEnd(4)} ${c.byte.padEnd(4)} ${r ? String(r.downBit).padEnd(2) + ' ' + String(r.upBit).padEnd(2) : '-  -  '} ${String(o.days || '-').padStart(4)}`;
    if (!r) { console.log(`${head}  ${ver.why.join('; ')}`); continue; }
    const st = s => s ? `${short(s.key)} ${(s.share * 100).toFixed(1)}% ${(s.n / o.days).toFixed(0)}/d` : '-';
    const steps = e.primary ? `${st(e.primary)} / ${st(e.opposite)}` : `best ${st(r.ranked[0])}`;
    const loc = e.loc;
    const where = loc ? `${loc.between[0]} - ${loc.between[1]} @${(loc.frac * 100).toFixed(0)}%` +
      (loc.near[0] ? ` -> ${loc.near[0].name} (${loc.near[0].uid} ${loc.near[0].type}) ${loc.near[0].d.toFixed(1)} km` +
        (loc.near[1] ? `, next ${loc.near[1].name} ${loc.near[1].d.toFixed(1)} km` : '') : '') : '';
    console.log(`${head} ${r.perDay.toFixed(1).padStart(10)} ${(r.downShare * 100).toFixed(0).padStart(5)}  ${steps.padEnd(62)} ${fmt(e.cover * 100, 1).padStart(7)} ${fmt(e.leadMed).padStart(7)} ${fmt(e.raiseMed).padStart(7)}  ${where}${ver.why.length ? '  [' + ver.why.join('; ') + ']' : ''}${c.scanNote ? '  {' + c.scanNote + '}' : ''}`);
    if (SHOW_STEPS) for (const s of r.ranked.slice(0, SHOW_STEPS)) console.log(`      ${short(s.key).padEnd(14)} ${(s.share * 100).toFixed(1).padStart(6)}% inside, ${s.n} steps`);
  }
  const count = v => results.filter(o => o.ver.v === v).length;
  console.log(`\n${count('CONFIRMED')} confirmed, ${count('WHICH ONE?')} barrier but which crossing unclear, ${count('POSSIBLE')} possible, ${count('REJECTED')} rejected, ${count('NO DATA')} no data`);
  const named = new Map();
  for (const o of results) if (o.ver.v === 'CONFIRMED') { const x = o.e.loc.named; (named.get(x.uid) || named.set(x.uid, { x, pairs: [] }).get(x.uid)).pairs.push(`${o.c.area}:${o.c.byte}`); }
  if (named.size) console.log(`${named.size} distinct crossing(s) confirmed: ` + [...named.values()].map(v => `${v.x.name} (${v.x.uid}) ${[...new Set(v.pairs)].join('+')}`).join('; '));
  const which = new Map();
  for (const o of results) if (o.ver.v === 'WHICH ONE?') { const k = o.e.loc.either.map(x => x.name).join(' or '); (which.get(k) || which.set(k, []).get(k)).push(`${o.c.area}:${o.c.byte}`); }
  if (which.size) console.log(`${which.size} unresolved: ` + [...which].map(([k, v]) => `${k} ${[...new Set(v)].join('+')}`).join('; '));
  // known answer
  const kas = results.filter(o => `${o.c.area}:${o.c.byte}` === KNOWN.pair);
  if (kas.length) for (const ka of kas) {
    const got = ka.e && ka.e.primary ? [ka.e.primary, ka.e.opposite].filter(Boolean).map(s => keyOf[s.key]) : [];
    const ok = ka.ver.v === 'CONFIRMED' && KNOWN.steps.every(s => got.includes(s)) && ka.e.loc.named.uid === KNOWN.uid;
    console.log(`known answer ${KNOWN.pair} ${KNOWN.name}: ${ok ? 'PASS' : 'FAIL'} (verdict ${ka.ver.v}; steps ${got.join(', ') || '-'}; named ${ka.e && ka.e.loc && ka.e.loc.named ? ka.e.loc.named.name : '-'})`);
  } else console.log(`known answer ${KNOWN.pair}: not in this run`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results.map(({ c, r, e, ver, days }) => ({
    area: c.area, byte: c.byte, scanUp: c.a, scanDown: c.b, verdict: ver.v, why: ver.why, days,
    downBit: r ? r.downBit : null, upBit: r ? r.upBit : null, closuresPerDay: r ? r.perDay : null, downShare: r ? r.downShare : null,
    step: e && e.primary ? { step: keyOf[e.primary.key], share: e.primary.share, n: e.primary.n } : null,
    otherWay: e && e.opposite ? { step: keyOf[e.opposite.key], share: e.opposite.share, n: e.opposite.n } : null,
    trainsShare: e ? e.cover : null, leadMed: e ? e.leadMed : null, leadP10: e ? e.leadP10 : null, raiseMed: e ? e.raiseMed : null,
    where: e && e.loc ? { between: e.loc.between, frac: e.loc.frac, at: e.loc.at, near: e.loc.near, named: e.loc.named } : null,
  })), null, 1));
})();
