#!/usr/bin/env node
'use strict';

// Works out, for every crossing in scripts/crossing-list.csv, the station on each side of it along
// its railway line and where trains going that way commonly terminate ("towards Brighton"), from
// Network Rail's national timetable (CIF). Writes scripts/data/crossing-stations.json, which
// scripts/build-crossings.js reads for each crossing page's "Nearby stations" (Rich, 2026-11-23).
//
// Run on the Mac, against a full CIF extract (the backend archives them; ~150 MB gzipped):
//   node scripts/derive-crossing-stations.js ~/rc-data/cifupd/archive/cif-full-<date>-<seq>.json.gz
// Re-run at the twice-yearly list refresh, or after a timetable change. Needs the network only to
// ask OpenStreetMap which way the track runs at crossings near a junction (cached in ~/rc-data).
//
// How:
//  1. Stations are the NaPTAN list in scripts/data/stations.json (by CRS code); a timetable point is
//     a station when its TIPLOC record carries one of those CRS codes.
//  2. Each passenger schedule becomes its sequence of stations. Two stations next to each other in
//     a schedule are joined. But a schedule lists only timing points, so a fast train "joins"
//     Portslade straight to Shoreham past two small stations: such a shortcut is spotted (a chain of
//     stations runs between its ends at about the same length) and its trains are counted on each
//     link of the chain instead.
//  3. A crossing lies on the link it adds least distance to (station to crossing to station is
//     barely longer than station to station when the crossing is between them). Near a junction
//     two lines can both pass close by (Keymer: the Lewes line, and the Brighton main line), so the
//     direction the track runs at the crossing (OpenStreetMap) must point at both stations.
//  4. "Towards", each way: among the places trains going that way finish, the nearest one at least
//     SHARE of them run to (else the most common). A train that ends by coupling onto another
//     (a "join" in the timetable) is followed to where that train finishes, so Bosham is not
//     "towards Horsham" just because Portsmouth portions join there.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'scripts', 'data', 'crossing-stations.json');
const CACHE = path.join(os.homedir(), 'rc-data', 'rail-orientation.json');
const PASSENGER = new Set(['OO', 'OW', 'OL', 'XX', 'XZ', 'XC']);
const SHARE = 0.2;          // a terminus at least this share of trains run to counts as "common" (0.2 v 0.25 v 0.3 compared on the Sussex pilot, 2026-11-23: 0.2 reads as locals would)
const LIMIT_M = 800;        // crossing more than this far off every station-to-station link: no entry
const UA = 'railcrossing.uk station-neighbour build';
const END_SHARE = 0.8;      // this share of trains ending at the next station: it's the end of the line
// A train through London (Thameslink to Peterborough, say) is "towards" the first central London
// station it reaches, not its far end: someone at Crawley thinks London Bridge, not Peterborough.
const CENTRAL_LONDON = new Set(['VIC', 'LBG', 'BFR', 'CTK', 'ZFD', 'STP', 'KGX', 'EUS', 'WAT', 'WAE', 'CHX', 'CST', 'LST', 'FST', 'MYB', 'PAD', 'MOG']);
// Crossings at a junction, where neither distance nor the track's direction can tell the lines
// apart, are settled by hand here: crossing number -> the two stations either side (checked on
// OpenStreetMap, whose railway ways carry the line's name and Network Rail line reference).
const OVERRIDES = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'crossing-stations-overrides.json'), 'utf8')).crossings;

const cifPath = process.argv[2];
if (!cifPath) { console.error('usage: node scripts/derive-crossing-stations.js <cif-full.json.gz>'); process.exit(1); }

const stations = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'data', 'stations.json'), 'utf8')).stations;
const byCrs = new Map(stations.map(s => [s.crs, s]));
function parseCsv(text) {           // as scripts/build-crossings.js
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; rows.push(row); row = []; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.length > 1 || r[0]);
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] == null ? '' : r[i]])));
}
const crossings = parseCsv(fs.readFileSync(path.join(ROOT, 'scripts', 'crossing-list.csv'), 'utf8')).filter(r => r.excluded !== 'yes');

const R = 6371000, rad = x => x * Math.PI / 180, deg = x => x * 180 / Math.PI;
function metres(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {           // degrees clockwise from north
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
const lineDiff = (a, b) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); };   // 0..90, ignoring direction
const dist = (a, b) => metres(byCrs.get(a), byCrs.get(b));

async function main() {
  // ---- 1. read the timetable --------------------------------------------------------------
  const tiplocCrs = new Map();
  // Only a station's main TIPLOC carries its CRS; its other TIPLOCs (London Victoria's VICTRIC and
  // VICTRIE, say) share its STANOX. Until 2026-11-23 those were missed, and every train ending at
  // Victoria or London Bridge silently dropped out of the counts.
  const tiplocs = [], stanoxCrs = new Map();
  let tiplocsDone = false;
  const finishTiplocs = () => {
    if (tiplocsDone) return; tiplocsDone = true;
    for (const t of tiplocs) if (t.crs) { tiplocCrs.set(t.tiploc, t.crs); if (t.stanox) stanoxCrs.set(t.stanox, t.crs); }
    for (const t of tiplocs) if (!t.crs && t.stanox && stanoxCrs.has(t.stanox)) tiplocCrs.set(t.tiploc, stanoxCrs.get(t.stanox));
  };
  const joins = new Map();                 // "<assoc uid>@<tiploc>" -> main uid (category JJ)
  const scheds = [];                       // { uid, seq, endTiploc, stp }
  const rl = readline.createInterface({ input: fs.createReadStream(cifPath).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.startsWith('{"TiplocV1"')) {
      const t = JSON.parse(line).TiplocV1;
      tiplocs.push({ tiploc: t.tiploc_code, crs: t.crs_code && byCrs.has(t.crs_code) ? t.crs_code : null, stanox: t.stanox });
    } else if (line.startsWith('{"JsonAssociationV1"')) {
      finishTiplocs();
      const a = JSON.parse(line).JsonAssociationV1;
      if (a.category === 'JJ' && a.transaction_type === 'Create') joins.set(`${a.assoc_train_uid}@${a.location}`, a.main_train_uid);
    } else if (line.startsWith('{"JsonScheduleV1"')) {
      finishTiplocs();
      const s = JSON.parse(line).JsonScheduleV1;
      const sg = s.schedule_segment;
      if (s.CIF_stp_indicator === 'C' || !sg || !PASSENGER.has(sg.CIF_train_category)) continue;
      const locs = sg.schedule_location || [];
      if (!locs.some(l => l.public_arrival || l.public_departure)) continue;
      const seq = [];
      for (const l of locs) { const c = tiplocCrs.get(l.tiploc_code); if (c && seq[seq.length - 1] !== c) seq.push(c); }
      if (seq.length >= 2) scheds.push({ uid: s.CIF_train_uid, seq, endTiploc: locs[locs.length - 1].tiploc_code, stp: s.CIF_stp_indicator });
    }
  }
  // Where each train really finishes: a train that ends by joining another finishes where that one does.
  const endOf = new Map();                 // uid -> end TIPLOC (the permanent schedule's, if several)
  for (const s of scheds) if (!endOf.has(s.uid) || s.stp === 'P') endOf.set(s.uid, s.endTiploc);
  function finish(uid, tiploc, depth = 0) {
    const main = joins.get(`${uid}@${tiploc}`);
    if (!main || depth > 3 || !endOf.has(main)) return tiplocCrs.get(tiploc) || null;
    return finish(main, endOf.get(main), depth + 1);
  }
  let followed = 0;
  for (const s of scheds) { s.dest = finish(s.uid, s.endTiploc); if (joins.has(`${s.uid}@${s.endTiploc}`)) followed++; }
  console.log(`${scheds.length} passenger schedules, ${joins.size} joins (${followed} schedules followed through one)`);

  // ---- 2. links between stations, and the shortcuts fast trains make -----------------------
  const nbr = new Map();                   // crs -> Set(crs)
  const link = (a, b) => { (nbr.get(a) || nbr.set(a, new Set()).get(a)).add(b); (nbr.get(b) || nbr.set(b, new Set()).get(b)).add(a); };
  for (const s of scheds) for (let i = 0; i + 1 < s.seq.length; i++) link(s.seq[i], s.seq[i + 1]);
  // The shortest chain from a to b of at most 8 links, not using a-b itself (straight-line lengths).
  function chain(a, b) {
    const best = new Map([[a, { d: 0, prev: null, hops: 0 }]]), todo = [a], limit = dist(a, b) * 1.1 + 300;
    while (todo.length) {
      todo.sort((p, q) => best.get(p).d - best.get(q).d);
      const u = todo.shift(), bu = best.get(u);
      if (u === b) break;
      if (bu.hops >= 8) continue;
      for (const v of nbr.get(u)) {
        if ((u === a && v === b) || (u === b && v === a)) continue;
        const d = bu.d + dist(u, v);
        if (d > limit) continue;
        if (!best.has(v) || d < best.get(v).d) { best.set(v, { d, prev: u, hops: bu.hops + 1 }); todo.push(v); }
      }
    }
    if (!best.has(b)) return null;
    const out = [b]; let u = b; while (u !== a) { u = best.get(u).prev; out.unshift(u); }
    return out.length > 2 ? out : null;
  }
  const shortcut = new Map();              // "a|b" -> [a, ..., b] for a link that is a shortcut
  const key = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
  for (const [a, set] of nbr) for (const b of set) if (a < b) { const c = chain(a, b); if (c) shortcut.set(key(a, b), c); }
  // Trains on each real link, by direction, and where they finish. A shortcut's trains count on
  // every link of its chain.
  const flow = new Map();                  // "a>b" -> Map(dest -> trains)
  function add(a, b, dest) { const k = `${a}>${b}`; const m = flow.get(k) || flow.set(k, new Map()).get(k); m.set(dest, (m.get(dest) || 0) + 1); }
  for (const s of scheds) {
    if (!s.dest) continue;
    const end = s.seq.lastIndexOf(s.dest);
    const stop = end > 0 ? end : s.seq.length - 1;
    const ahead = new Array(s.seq.length).fill(null);     // first central London station after i
    for (let i = s.seq.length - 2, next = null; i >= 0; i--) { if (CENTRAL_LONDON.has(s.seq[i + 1])) next = s.seq[i + 1]; ahead[i] = next; }
    for (let i = 0; i < stop; i++) {
      const a = s.seq[i], b = s.seq[i + 1], c = shortcut.get(key(a, b));
      const path = c ? (c[0] === a ? c : [...c].reverse()) : [a, b];
      const dest = ahead[i] && s.seq.indexOf(ahead[i], i + 1) <= stop ? ahead[i] : s.dest;
      for (let j = 0; j + 1 < path.length; j++) add(path[j], path[j + 1], dest);
    }
  }
  const links = [];
  for (const [a, set] of nbr) for (const b of set) if (a < b && !shortcut.has(key(a, b))) links.push([a, b]);
  console.log(`${links.length} station-to-station links, ${shortcut.size} fast-train shortcuts set aside`);

  // ---- 3. which link each crossing is on ---------------------------------------------------
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  async function trackAt(r) {              // which way the track runs at the crossing, 0-180, or null
    if (r.uid in cache) return cache[r.uid];
    const lat = Number(r.lat), lon = Number(r.lon), d = 0.0009;
    const box = [lon - d * 1.6, lat - d, lon + d * 1.6, lat + d].map(v => v.toFixed(6)).join(',');
    let value = null;
    try {
      const res = await fetch(`https://api.openstreetmap.org/api/0.6/map?bbox=${box}`, { headers: { 'User-Agent': UA } });
      if (res.ok) {
        const xml = await res.text(), at = new Map();
        for (const m of xml.matchAll(/<node id="(\d+)"[^>]*?lat="([\d.-]+)" lon="([\d.-]+)"/g)) at.set(m[1], { lat: +m[2], lon: +m[3] });
        let best = null;
        for (const m of xml.matchAll(/<way id="\d+"[^>]*?>([\s\S]*?)<\/way>/g)) {
          if (!/<tag k="railway" v="(rail|light_rail|narrow_gauge|preserved)"\/>/.test(m[1]) || /<tag k="service" v="(siding|yard|spur)"\/>/.test(m[1])) continue;
          const pts = [...m[1].matchAll(/<nd ref="(\d+)"\/>/g)].map(x => at.get(x[1])).filter(Boolean);
          for (let i = 0; i + 1 < pts.length; i++) {
            const mid = { lat: (pts[i].lat + pts[i + 1].lat) / 2, lon: (pts[i].lon + pts[i + 1].lon) / 2 };
            const dd = Math.min(metres(pts[i], { lat, lon }), metres(pts[i + 1], { lat, lon }), metres(mid, { lat, lon }));
            if (!best || dd < best.dd) best = { dd, b: bearing(pts[i], pts[i + 1]) % 180 };
          }
        }
        if (best && best.dd < 60) value = Math.round(best.b);
      }
    } catch (e) { /* offline: no orientation, fall back to distance alone */ }
    cache[r.uid] = value;
    await new Promise(r => setTimeout(r, 250));
    return value;
  }
  // A station near the crossing says nothing about direction; one further off must lie along the track.
  const fits = (x, track, crs) => metres(x, byCrs.get(crs)) < 250 || lineDiff(bearing(x, byCrs.get(crs)), track) <= 50;
  const towards = (a, b, x) => {           // trains going a -> b
    const m = flow.get(`${a}>${b}`);
    if (!m) return null;
    const n = [...m.values()].reduce((p, q) => p + q, 0);
    const endHere = (m.get(b) || 0) / n;
    if (endHere >= END_SHARE) return { towards: null, end: true, trains: n };
    // Where the rest go, beyond the next station: the nearest common one, else the most common.
    const rest = [...m.entries()].filter(([d]) => d !== b), r = rest.reduce((p, [, k]) => p + k, 0);
    const list = rest.map(([d, k]) => ({ d, k, share: k / r, far: metres(x, byCrs.get(d)) }));
    const common = list.filter(t => t.share >= SHARE).sort((p, q) => p.far - q.far);
    const pick = common[0] || list.sort((p, q) => q.k - p.k)[0];
    return { towards: pick.d, share: Math.round(pick.share * 100) / 100, trains: n };
  };
  const trainsOn = (a, b) => [`${a}>${b}`, `${b}>${a}`].reduce((t, k) => t + [...(flow.get(k) || new Map()).values()].reduce((p, q) => p + q, 0), 0);
  const LONDON = { lat: 51.5074, lon: -0.1278 };
  const out = {};
  let none = 0, checked = 0;
  for (const r of crossings) {
    const x = { lat: Number(r.lat), lon: Number(r.lon) };
    const cands = [];
    for (const [a, b] of links) {
      const A = byCrs.get(a), B = byCrs.get(b), ab = metres(A, B);
      const ax = metres(A, x); if (ax > ab + LIMIT_M) continue;
      const bx = metres(B, x); if (bx > ab + LIMIT_M) continue;
      const extra = ax + bx - ab;
      if (extra <= LIMIT_M) cands.push({ a, b, extra });
    }
    cands.sort((p, q) => p.extra - q.extra);
    const ov = OVERRIDES[r.uid];
    if (ov) { const [a, b] = ov.pair; cands.unshift({ a, b, extra: metres(byCrs.get(a), x) + metres(x, byCrs.get(b)) - metres(byCrs.get(a), byCrs.get(b)), fixed: true }); }
    if (!cands.length) { none++; continue; }
    // Near-equal fits on the same side (a crossing at a station, with a junction beyond): the
    // link more trains use (Angmering: Ford, not the Littlehampton curve).
    let pick = cands[0].fixed ? cands[0] : cands.filter(c => c.extra <= cands[0].extra + 40).sort((p, q) => trainsOn(q.a, q.b) - trainsOn(p.a, p.b))[0];
    // A close second on another line: let the track's direction decide.
    if (!pick.fixed && cands[1] && cands[1].extra < Math.max(150, cands[0].extra * 3)) {
      checked++;
      const track = await trackAt(r);
      if (track != null) pick = cands.find(c => fits(x, track, c.a) && fits(x, track, c.b)) || cands[0];
    }
    const sides = [[pick.a, pick.b], [pick.b, pick.a]].map(([from, to]) => ({ station: to, ...(towards(from, to, x) || {}) })).filter(s => s.towards || s.end);
    if (!sides.length) { none++; continue; }
    sides.sort((p, q) => metres(byCrs.get(p.station), LONDON) - metres(byCrs.get(q.station), LONDON));   // up side first
    out[r.uid] = { extraM: Math.round(pick.extra), sides };
  }
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  const body = Object.entries(out).sort((p, q) => Number(p[0]) - Number(q[0])).map(([n, v]) => `${JSON.stringify(n)}:${JSON.stringify(v)}`).join(',\n');
  fs.writeFileSync(OUT, `{"_source":"scripts/derive-crossing-stations.js from ${path.basename(cifPath)}; the station on each side of the crossing (CRS), up side first, and where trains going that way commonly finish. Do not edit.",\n"crossings":{\n${body}\n}}\n`);
  console.log(`${Object.keys(out).length} crossings placed (${checked} checked against the track's direction), ${none} not near a passenger line -> ${path.relative(ROOT, OUT)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
