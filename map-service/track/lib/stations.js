'use strict';

// NaPTAN rail stations -> snaps on the track graph.
//
// Every station gets, when it can:
//   * one PRIMARY snap: the nearest point on a running edge (not siding, yard or crossover) within 300 m
//     of the NaPTAN point;
//   * one snap per platform track where OSM separates them, from two sources:
//       - OSM railway=platform / platform_edge ways: the track edges running alongside the platform
//         (sampled every 6 m: nearest track within 8 m, parallel to within 20 degrees, mean distance 4 m or less, three or more samples), the stop point being the middle of the stretch
//         of track that platform covers, lo/hi its ends;
//       - track ways carrying railway:track_ref / track_ref (the platform number), within 400 m.
// Stations with no running edge in range are reported as unsnapped, never guessed at.

const fs = require('fs');
const F = require('../../src/track/format');
const { CsvParser } = require('../../src/csv');
const { lowerBound } = require('./osm-extract');
const { dist7, bearing7, kxAt, KY, DEG7 } = require('../../src/track/geom');

const RUNNING = [F.CLS.MAIN, F.CLS.BRANCH, F.CLS.OTHER];
const PRIMARY_MAX_M = 300;

function parseNaptan(file) {
  const rows = [];
  let head = null, newest = '';
  const p = new CsvParser((r) => {
    if (!head) { head = Object.fromEntries(r.map((h, i) => [h, i])); return; }
    const atco = r[head.ATCOCode] || '';
    if (!atco.startsWith('9100')) return;
    if ((r[head.Status] || 'active') !== 'active') return;
    const lat = Number(r[head.Latitude]), lon = Number(r[head.Longitude]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return;
    const mod = r[head.ModificationDateTime] || '';
    if (mod > newest) newest = mod;
    rows.push({ tiploc: atco.slice(4), name: (r[head.CommonName] || '').replace(/ Rail Station$/i, ''), lat, lon });
  });
  p.write(fs.readFileSync(file, 'utf8'));
  p.end();
  return { rows, newestModified: newest.slice(0, 10) };
}

/** Platform polylines (1e-7 degree integer pairs) from the extract. */
function platformsFrom(ex) {
  const out = [];
  const { wanted, lat, lon, refs } = ex;
  for (const w of ex.ways) {
    if (w.tags.railway !== 'platform' && w.tags.railway !== 'platform_edge') continue;
    if (w.len < 2) continue;
    const la = [], lo = [];
    let ok = true;
    for (let k = 0; k < w.len; k++) {
      const i = lowerBound(wanted, refs[w.start + k]);
      if (wanted[i] !== refs[w.start + k]) { ok = false; break; }
      la.push(lat[i]); lo.push(lon[i]);
    }
    if (ok) out.push({ la, lo, ref: (w.tags.ref || w.tags.name || '').trim(), id: w.id });
  }
  return out;
}

function densify(la, lo, stepM) {
  const pts = [];
  for (let i = 0; i + 1 < la.length; i++) {
    const len = dist7(la[i], lo[i], la[i + 1], lo[i + 1]);
    const n = Math.max(1, Math.ceil(len / stepM));
    const b = len > 0.5 ? bearing7(la[i], lo[i], la[i + 1], lo[i + 1]) : null;
    for (let k = 0; k < n; k++) pts.push({ la: la[i] + (la[i + 1] - la[i]) * k / n, lo: lo[i] + (lo[i + 1] - lo[i]) * k / n, b });
  }
  pts.push({ la: la[la.length - 1], lo: lo[lo.length - 1], b: pts.length ? pts[pts.length - 1].b : null });
  return pts;
}

/**
 * @returns {{stations: Array, stats: object, unsnapped: Array}} stations[i] = {tiploc, name, lat7, lon7, snaps: [{edge, offset, dist, platform, lo, hi, flag}]}
 */
function snapStations(pack, naptan, ex, { log = () => {} } = {}) {
  const platforms = platformsFrom(ex);
  const stations = naptan.rows.map(r => ({ tiploc: r.tiploc, name: r.name, lat7: Math.round(r.lat * 1e7), lon7: Math.round(r.lon * 1e7), snaps: [], platformsSeen: 0 }));
  const stats = { stations: stations.length, platformWays: platforms.length, platformsAssigned: 0, platformsNoTrack: 0 };

  // 1. primary snaps
  for (const s of stations) {
    let n = pack.nearestOnTrack(s.lat7 * DEG7, s.lon7 * DEG7, { maxDist: PRIMARY_MAX_M, classes: RUNNING });
    // A station called "Low Level" is underground whatever the NaPTAN point says (it sits on the concourse above
    // the platforms, where the nearest track is the high-level one): prefer the nearest tunnel track.
    if (/\blow level\b/i.test(s.name)) {
      const under = pack.nearestOnTrack(s.lat7 * DEG7, s.lon7 * DEG7, { maxDist: PRIMARY_MAX_M, classes: RUNNING, k: 10 }).find(x => pack.s.EFLG[x.edge] & F.FLG.TUNNEL);
      if (under) n = under;
    }
    if (n) s.snaps.push({ edge: n.edge, offset: n.offset, dist: n.dist, platform: '', lo: n.offset, hi: n.offset, flag: F.SNAP.PRIMARY });
  }

  // A station's level: underground or not, from where its primary snap sits. Platforms and platform-numbered tracks only
  // attach to a station on the same level, so two stations stacked on one footprint (Glasgow Central and Central Low Level)
  // do not collect each other's platforms.
  const tunnelOf = (e) => (pack.s.EFLG[e] & F.FLG.TUNNEL ? 1 : 0);
  const levelOf = (st) => { const pr = st.snaps.find(x => x.flag & F.SNAP.PRIMARY); return pr ? tunnelOf(pr.edge) : null; };

  // 2. platforms -> the nearest station within 250 m (by the platform's nearest vertex) that has a track of its own level beside it
  const byPlat = new Map();
  const votesFor = (p, level) => {
    const votes = new Map();      // edge -> {n, min, max, d}
    for (const q of densify(p.la, p.lo, 6)) {
      const opts = { maxDist: 8, classes: RUNNING, k: 3 };
      if (q.b !== null) { opts.bearing = q.b; opts.bearingTol = 20; }
      const sn = pack.nearestOnTrack(q.la * DEG7, q.lo * DEG7, opts).find(x => level === null || tunnelOf(x.edge) === level);
      if (!sn) continue;
      const v = votes.get(sn.edge) || { n: 0, min: Infinity, max: -Infinity, d: 0 };
      v.n++; v.d += sn.dist; v.min = Math.min(v.min, sn.offset); v.max = Math.max(v.max, sn.offset);
      votes.set(sn.edge, v);
    }
    // 3+ samples (~20 m alongside) and close: a track the platform serves, not one across a wide concourse
    return [...votes].filter(([, v]) => v.n >= 3 && v.d / v.n <= 4);
  };
  for (const p of platforms) {
    const cLa = p.la.reduce((a, b) => a + b, 0) / p.la.length, cLo = p.lo.reduce((a, b) => a + b, 0) / p.lo.length;
    const cands = [];
    for (const s of stations) {
      if (Math.abs(s.lat7 - cLa) > 70000 || Math.abs(s.lon7 - cLo) > 120000) continue;   // ~800 m box: cheap reject
      let d = Infinity;
      for (let i = 0; i < p.la.length; i++) { const dd = dist7(s.lat7, s.lon7, p.la[i], p.lo[i]); if (dd < d) d = dd; }
      if (d < 250) cands.push([d, s]);
    }
    cands.sort((x, y) => x[0] - y[0]);
    if (!cands.length) continue;
    stats.platformsAssigned++;
    let placed = false;
    for (const [, best] of cands) {
      const good = votesFor(p, levelOf(best));
      if (!good.length) continue;
      placed = true;
      best.platformsSeen++;
      for (const [edge, v] of good) {
        if (!p.ref && best.snaps.some(x => x.edge === edge)) continue;      // an unnumbered platform beside the track already snapped adds nothing
        const key = edge + '|' + p.ref;
        const list = byPlat.get(best.tiploc) || [];
        if (!list.some(x => x.key === key)) list.push({ key, edge, offset: (v.min + v.max) / 2, dist: v.d / v.n, platform: p.ref, lo: v.min, hi: v.max, flag: F.SNAP.PLATFORM });
        byPlat.set(best.tiploc, list);
      }
      break;
    }
    if (!placed) stats.platformsNoTrack++;
  }
  for (const s of stations) for (const x of byPlat.get(s.tiploc) || []) s.snaps.push(x);

  // 3. track ways that carry a platform number
  const trk = pack.s.ETRK;
  let trackRefEdges = 0;
  for (let e = 0; e < pack.nEdges; e++) {
    if (!trk[e] || !RUNNING.includes(pack.ecls[e])) continue;
    trackRefEdges++;
    const mid = pack.snapAt(e, pack.length(e) / 2);
    let best = null, bd = 400;
    for (const s of stations) { if (Math.abs(s.lat7 - mid.lat * 1e7) > 70000 || Math.abs(s.lon7 - mid.lon * 1e7) > 120000) continue; const d = dist7(s.lat7, s.lon7, Math.round(mid.lat * 1e7), Math.round(mid.lon * 1e7)); if (d < bd) { bd = d; best = s; } }
    if (!best) continue;
    const lv = levelOf(best);
    if (lv !== null && tunnelOf(e) !== lv) continue;
    const ref = pack.str(trk[e]);
    const near = pack.nearestOnTrack(best.lat7 * DEG7, best.lon7 * DEG7, { maxDist: 400, classes: RUNNING, k: 50 }).find(x => x.edge === e);
    const off = near ? near.offset : pack.length(e) / 2;
    const have = best.snaps.find(x => x.edge === e && (x.flag & F.SNAP.PLATFORM));
    if (have) { if (!have.platform) have.platform = ref; have.flag |= F.SNAP.TRACK_REF; continue; }
    best.snaps.push({ edge: e, offset: off, dist: near ? near.dist : bd, platform: ref, lo: 0, hi: pack.length(e), flag: F.SNAP.TRACK_REF });
  }
  stats.trackRefEdges = trackRefEdges;

  const unsnapped = stations.filter(s => !s.snaps.some(x => x.flag & F.SNAP.PRIMARY)).map(s => `${s.tiploc} ${s.name}`);
  stats.snapped = stations.length - unsnapped.length;
  stats.unsnapped = unsnapped.length;
  stats.withPlatformSnaps = stations.filter(s => s.snaps.some(x => x.flag & (F.SNAP.PLATFORM | F.SNAP.TRACK_REF))).length;
  stats.platformSnaps = stations.reduce((n, s) => n + s.snaps.filter(x => x.flag & (F.SNAP.PLATFORM | F.SNAP.TRACK_REF)).length, 0);
  log(`stations: ${stats.snapped}/${stats.stations} snapped (${stats.unsnapped} unsnapped); ${stats.withPlatformSnaps} with platform tracks (${stats.platformSnaps} snaps)`);
  return { stations, stats, unsnapped };
}

function stationSections(stations, strings) {
  const n = stations.length;
  const s = { STTIP: new Uint32Array(n), STNAME: new Uint32Array(n), STLAT: new Int32Array(n), STLON: new Int32Array(n), STSNO: new Uint32Array(n + 1) };
  let total = 0; for (const st of stations) total += st.snaps.length;
  Object.assign(s, { SNEDGE: new Uint32Array(total), SNOFF: new Float32Array(total), SNDIST: new Float32Array(total), SNPLAT: new Uint32Array(total), SNLO: new Float32Array(total), SNHI: new Float32Array(total), SNFLG: new Uint8Array(total) });
  let j = 0;
  stations.forEach((st, i) => {
    s.STTIP[i] = strings.intern(st.tiploc); s.STNAME[i] = strings.intern(st.name); s.STLAT[i] = st.lat7; s.STLON[i] = st.lon7;
    s.STSNO[i] = j;
    for (const x of st.snaps) { s.SNEDGE[j] = x.edge; s.SNOFF[j] = x.offset; s.SNDIST[j] = x.dist; s.SNPLAT[j] = strings.intern(x.platform); s.SNLO[j] = x.lo; s.SNHI[j] = x.hi; s.SNFLG[j] = x.flag; j++; }
  });
  s.STSNO[n] = j;
  return s;
}

module.exports = { parseNaptan, snapStations, stationSections, platformsFrom };
