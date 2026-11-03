'use strict';

// The runtime track model: loads a track pack into typed arrays and answers nearestOnTrack / route /
// slice / pointAt. Nothing here depends on the builder. Memory discipline: each section is read into
// its own typed array, sections the service does not need up front (the overview GeoJSON) stay on
// disk, and the only derived structures are the grid index, per-vertex cumulative distance and the
// edge-end bearings used by the routing turn limit.

const fs = require('fs');
const F = require('./format');
const { Grid } = require('./spatial');
const { KY, DEG7, kxAt, bearing7, angDiff } = require('./geom');
const { routeBetween, sliceRoute, pointOnRoute } = require('./route');

const DEFAULT_MAX_DIST = 300;

/** Read the header and section table of a pack file (cheap: a few KB). */
function readDirectory(fd, size) {
  const head = Buffer.alloc(F.HEADER_BYTES);
  if (size < F.HEADER_BYTES || fs.readSync(fd, head, 0, F.HEADER_BYTES, 0) < F.HEADER_BYTES) throw new Error('track pack: file too short to be a pack');
  if (head.toString('latin1', 0, 4) !== F.MAGIC) throw new Error('track pack: wrong magic (not a track pack)');
  const version = head.readUInt32LE(4);
  if (version !== F.VERSION) throw new Error(`track pack: format version ${version}, this reader understands ${F.VERSION}`);
  const count = head.readUInt32LE(8);
  const total = head.readDoubleLE(16);
  if (total !== size) throw new Error(`track pack: header says ${total} bytes but the file is ${size} (truncated or corrupt)`);
  const table = Buffer.alloc(count * F.ENTRY_BYTES);
  fs.readSync(fd, table, 0, table.length, F.HEADER_BYTES);
  const dir = new Map();
  for (let i = 0; i < count; i++) {
    const o = i * F.ENTRY_BYTES;
    const id = table.toString('latin1', o, o + 8).replace(/\0+$/, '');
    const type = table.readUInt32LE(o + 8), n = table.readUInt32LE(o + 12);
    const offset = table.readDoubleLE(o + 16), bytes = table.readDoubleLE(o + 24);
    if (offset + bytes > size) throw new Error(`track pack: section ${id} runs past the end of the file`);
    dir.set(id, { id, type, count: n, offset, bytes });
  }
  return { version, built: head.readDoubleLE(24), dir, size };
}

function readSection(fd, ent) {
  const Arr = F.ARRAYS[ent.type];
  if (!Arr) throw new Error(`track pack: section ${ent.id} has unknown type ${ent.type}`);
  const ab = new ArrayBuffer(ent.bytes);
  const buf = Buffer.from(ab);
  let got = 0;
  while (got < ent.bytes) {
    const r = fs.readSync(fd, buf, got, ent.bytes - got, ent.offset + got);
    if (r <= 0) throw new Error(`track pack: short read in section ${ent.id}`);
    got += r;
  }
  return new Arr(ab);
}

class TrackPack {
  /** @param {Object<string, TypedArray>} s sections by id; @param {object} meta parsed META; @param {{file?:string, networkEntry?:object}} [src] */
  constructor(s, meta, src = {}) {
    for (const id of ['NLAT', 'NLON', 'NADJO', 'NADJ', 'EFROM', 'ETO', 'EVO', 'ECLS', 'VLAT', 'VLON', 'STRO', 'STRB']) {
      if (!s[id]) throw new Error(`track pack: required section ${id} is missing`);
    }
    this.s = s;
    this.meta = meta || {};
    this.file = src.file || null;
    this._networkEntries = src.networkEntries || {};
    this.nNodes = s.NLAT.length;
    this.nEdges = s.EFROM.length;
    this.nVertices = s.VLAT.length;
    this.vlat = s.VLAT; this.vlon = s.VLON; this.evo = s.EVO;
    this.efrom = s.EFROM; this.eto = s.ETO; this.ecls = s.ECLS;
    this.adjo = s.NADJO; this.adj = s.NADJ;
    this._decode = new TextDecoder();
    this._initDerived();
    this._stationIndex = null;
  }

  _initDerived() {
    const { vlat, vlon, evo } = this;
    const E = this.nEdges, V = this.nVertices;
    // cumulative metres from the start of the edge to each vertex (Float32: 2 mm at 30 km)
    const vcum = new Float32Array(V);
    const bStart = new Float32Array(E), bEnd = new Float32Array(E);
    for (let e = 0; e < E; e++) {
      const a = evo[e], b = evo[e + 1];
      let acc = 0;
      vcum[a] = 0;
      for (let v = a + 1; v < b; v++) {
        const kx = kxAt((vlat[v - 1] + vlat[v]) / 2);
        const dy = (vlat[v] - vlat[v - 1]) * DEG7 * KY, dx = (vlon[v] - vlon[v - 1]) * DEG7 * kx;
        acc += Math.sqrt(dx * dx + dy * dy);
        vcum[v] = acc;
      }
      // tangent bearings at each end, measured to the first vertex >= 15 m in (stable against OSM wiggle at a switch)
      let j = a + 1;
      while (j < b - 1 && vcum[j] < 15) j++;
      bStart[e] = b - a >= 2 ? bearing7(vlat[a], vlon[a], vlat[j], vlon[j]) : 0;
      j = b - 2;
      while (j > a && acc - vcum[j] < 15) j--;
      bEnd[e] = b - a >= 2 ? bearing7(vlat[j], vlon[j], vlat[b - 1], vlon[b - 1]) : 0;
    }
    this.vcum = vcum; this.bStart = bStart; this.bEnd = bEnd;
    this.grid = new Grid(vlat, vlon, evo);
    this._route = null;
  }

  length(e) { return this.vcum[this.evo[e + 1] - 1]; }

  // ---- strings ----------------------------------------------------------------------------------
  str(i) {
    if (!i) return '';
    const { STRO, STRB } = this.s;
    return this._decode.decode(STRB.subarray(STRO[i], STRO[i + 1]));
  }

  // ---- edges ------------------------------------------------------------------------------------
  edgeInfo(e) {
    const s = this.s, fl = s.EFLG ? s.EFLG[e] : 0;
    return {
      edge: e, from: this.efrom[e], to: this.eto[e], length: this.length(e),
      cls: this.ecls[e], clsName: F.CLS_NAMES[this.ecls[e]],
      electrified: s.EELEC ? F.ELEC_NAMES[s.EELEC[e]] : 'unknown',
      maxspeedMph: s.ESPD && s.ESPD[e] ? s.ESPD[e] : null,
      name: s.ENAME ? this.str(s.ENAME[e]) || null : null,
      ref: s.EREF ? this.str(s.EREF[e]) || null : null,
      trackRef: s.ETRK ? this.str(s.ETRK[e]) || null : null,
      tunnel: !!(fl & F.FLG.TUNNEL), bridge: !!(fl & F.FLG.BRIDGE), lightRail: !!(fl & F.FLG.LIGHT_RAIL)
    };
  }

  /** The stored polyline of an edge, from its first node to its last, as [[lat, lon], ...] in degrees. */
  edgePolyline(e) {
    const out = [];
    for (let v = this.evo[e]; v < this.evo[e + 1]; v++) out.push([this.vlat[v] * DEG7, this.vlon[v] * DEG7]);
    return out;
  }

  /** Directed edges leaving a node, as (edge << 1) | reversed. */
  edgesAt(node) { return this.adj.subarray(this.adjo[node], this.adjo[node + 1]); }

  // ---- nearest on track -------------------------------------------------------------------------
  /**
   * The nearest point on the track to (lat, lon).
   * @param {{maxDist?: number, avoidSidings?: boolean, classes?: number[], bearing?: number, bearingTol?: number, k?: number, edge?: number}} [opts]
   *   maxDist metres (default 300); avoidSidings excludes siding and yard edges; classes restricts to those ECLS values;
   *   bearing/bearingTol (default 45) keep only edges running that way (either direction: a track has no sense);
   *   k > 1 returns an array of the nearest k distinct edges (each at its closest point) instead of one snap.
   * @returns {Snap|null|Snap[]} Snap = {edge, offset, dist, lat, lon, bearing, cls}; offset is metres from the edge's first node.
   */
  nearestOnTrack(lat, lon, opts = {}) {
    const maxDist = opts.maxDist === undefined ? DEFAULT_MAX_DIST : opts.maxDist;
    const k = opts.k || 1;
    const qla = Math.round(lat * 1e7), qlo = Math.round(lon * 1e7);
    const kx = kxAt(qla);
    const rLat = Math.ceil(maxDist / KY / DEG7), rLon = Math.ceil(maxDist / kx / DEG7);
    const { vlat, vlon, vcum, grid, ecls } = this;
    const allow = opts.classes ? new Set(opts.classes) : null;
    const tol = opts.bearingTol === undefined ? 45 : opts.bearingTol;
    const best = new Map();       // edge -> candidate
    let bestD2 = maxDist * maxDist;
    grid.forBox(qla - rLat, qlo - rLon, qla + rLat, qlo + rLon, (v) => {
      const e = grid.segEdge[v];
      if (opts.avoidSidings && (ecls[e] === F.CLS.SIDING || ecls[e] === F.CLS.YARD)) return;
      if (allow && !allow.has(ecls[e])) return;
      const ax = (vlon[v] - qlo) * DEG7 * kx, ay = (vlat[v] - qla) * DEG7 * KY;
      const bx = (vlon[v + 1] - qlo) * DEG7 * kx, by = (vlat[v + 1] - qla) * DEG7 * KY;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + t * dx, py = ay + t * dy, d2 = px * px + py * py;
      if (d2 > maxDist * maxDist) return;
      if (k === 1 && d2 >= bestD2) return;
      if (opts.bearing !== undefined && opts.bearing !== null) {
        const sb = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
        const diff = angDiff(sb, opts.bearing);
        if (Math.min(diff, 180 - diff) > tol) return;
      }
      const prev = best.get(e);
      if (!prev || d2 < prev.d2) best.set(e, { v, t, d2 });
      if (d2 < bestD2 && k === 1) bestD2 = d2;
    });
    if (!best.size) return k > 1 ? [] : null;
    const list = [...best.entries()].sort((a, b) => a[1].d2 - b[1].d2).slice(0, k);
    const snaps = list.map(([e, c]) => this._snapAt(e, c.v, c.t, Math.sqrt(c.d2)));
    return k > 1 ? snaps : snaps[0];
  }

  /** Project a point onto one edge only (e.g. to snap an OSM signal to the way it sits on). */
  projectOnEdge(e, lat, lon) {
    const { vlat, vlon, evo } = this;
    const qla = Math.round(lat * 1e7), qlo = Math.round(lon * 1e7), kx = kxAt(qla);
    let bv = -1, bt = 0, bd = Infinity;
    for (let v = evo[e]; v + 1 < evo[e + 1]; v++) {
      const ax = (vlon[v] - qlo) * DEG7 * kx, ay = (vlat[v] - qla) * DEG7 * KY;
      const dx = (vlon[v + 1] - vlon[v]) * DEG7 * kx, dy = (vlat[v + 1] - vlat[v]) * DEG7 * KY, len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + t * dx, py = ay + t * dy, d2 = px * px + py * py;
      if (d2 < bd) { bd = d2; bv = v; bt = t; }
    }
    return bv < 0 ? null : this._snapAt(e, bv, bt, Math.sqrt(bd));
  }

  _snapAt(e, v, t, dist) {
    const { vlat, vlon, vcum } = this;
    const la = vlat[v] + t * (vlat[v + 1] - vlat[v]), lo = vlon[v] + t * (vlon[v + 1] - vlon[v]);
    return {
      edge: e, offset: vcum[v] + t * (vcum[v + 1] - vcum[v]), dist,
      lat: la * DEG7, lon: lo * DEG7, bearing: bearing7(vlat[v], vlon[v], vlat[v + 1], vlon[v + 1]), cls: this.ecls[e]
    };
  }

  /** A snap at a given offset along an edge (clamped), e.g. for a station platform stop point. */
  snapAt(edge, offset) {
    const { evo, vcum } = this;
    const a = evo[edge], b = evo[edge + 1] - 1;
    const off = Math.max(0, Math.min(vcum[b], offset));
    let lo = a, hi = b;
    while (hi - lo > 1) { const m = (lo + hi) >>> 1; if (vcum[m] <= off) lo = m; else hi = m; }
    const span = vcum[lo + 1] - vcum[lo];
    return this._snapAt(edge, lo, span > 0 ? (off - vcum[lo]) / span : 0, 0);
  }

  // ---- routes -----------------------------------------------------------------------------------
  /**
   * Shortest path by length between two snaps (as returned by nearestOnTrack / station snaps). Either end may also be an ARRAY of
   * snaps (e.g. every platform track of a station): the shortest route from any of the first to any of the second is returned,
   * with `route.from` / `route.to` naming the pair it used.
   * @param {{avoidSidings?: boolean, maxDeflection?: number, maxLength?: number}} [opts]
   *   avoidSidings: never use siding or yard edges (except the ones the endpoints sit on);
   *   maxDeflection: the sharpest turn, in degrees, a train can make between two edges at a node (default 100, which forbids
   *   heel-to-heel moves at a junction); maxLength: give up beyond this many metres.
   * @returns {Route|null} {length, pieces, ...} or null when the snaps are not connected under the options.
   */
  route(from, to, opts = {}) { return routeBetween(this, from, to, opts); }

  slice(route, d0, d1) { return sliceRoute(this, route, d0, d1); }
  pointAt(route, d) { return pointOnRoute(this, route, d); }

  // ---- stations and signals ---------------------------------------------------------------------
  _stations() {
    if (this._stationIndex) return this._stationIndex;
    const s = this.s, m = new Map();
    if (s.STTIP) for (let i = 0; i < s.STTIP.length; i++) m.set(this.str(s.STTIP[i]), i);
    this._stationIndex = m;
    return m;
  }

  /** {tiploc, name, lat, lon, snaps: [{edge, offset, dist, platform, lo, hi, primary, lat, lon, bearing}]} or null. Unsnapped stations have snaps: []. */
  station(tiploc) {
    const i = this._stations().get(tiploc);
    if (i === undefined) return null;
    const s = this.s;
    const snaps = [];
    for (let j = s.STSNO[i]; j < s.STSNO[i + 1]; j++) {
      const at = this.snapAt(s.SNEDGE[j], s.SNOFF[j]);
      snaps.push({
        edge: s.SNEDGE[j], offset: s.SNOFF[j], dist: s.SNDIST[j], platform: this.str(s.SNPLAT[j]) || null,
        lo: s.SNLO[j], hi: s.SNHI[j], primary: !!(s.SNFLG[j] & F.SNAP.PRIMARY), fromTrackRef: !!(s.SNFLG[j] & F.SNAP.TRACK_REF),
        fromPlatform: !!(s.SNFLG[j] & F.SNAP.PLATFORM), lat: at.lat, lon: at.lon, bearing: at.bearing, cls: at.cls
      });
    }
    return { tiploc, name: this.str(s.STNAME[i]), lat: s.STLAT[i] * DEG7, lon: s.STLON[i] * DEG7, snaps };
  }
  stationCount() { return this.s.STTIP ? this.s.STTIP.length : 0; }
  stationTiplocs() { return [...this._stations().keys()]; }

  /** All signals as plain objects (they number a few tens of thousands). */
  signals() {
    const s = this.s, out = [];
    if (!s.SGEDGE) return out;
    for (let i = 0; i < s.SGEDGE.length; i++) {
      out.push({
        edge: s.SGEDGE[i], offset: s.SGOFF[i], dist: s.SGDIST[i], lat: s.SGLAT[i] * DEG7, lon: s.SGLON[i] * DEG7, ref: this.str(s.SGREF[i]),
        direction: ['unknown', 'forward', 'backward', 'both'][s.SGDIR[i]], side: ['on', 'left', 'right'][s.SGSIDE[i]],
        kind: s.SGKIND[i] & 127, onWay: !!(s.SGKIND[i] & F.SIGKIND.ON_WAY)
      });
    }
    return out;
  }

  /** The gzipped overview GeoJSON for level 'lo' (zoom <= 7) or 'hi' (zoom 8..11), read from the file on demand; null if absent or in-memory. */
  network(level = 'hi') {
    const ent = this._networkEntries[level];
    if (!ent || !this.file) return null;
    const fd = fs.openSync(this.file, 'r');
    try { return Buffer.from(readSection(fd, ent).buffer); } finally { fs.closeSync(fd); }
  }

  /** SHA-256 (hex) of the pack file, for the overview's ETag; null for an in-memory pack. Streams the file in 1 MB reads. */
  sha256() {
    if (!this.file) return null;
    if (this._sha) return this._sha;
    const h = require('crypto').createHash('sha256');
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      let n;
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    } finally { fs.closeSync(fd); }
    this._sha = h.digest('hex');
    return this._sha;
  }

  /** Approximate bytes held by the typed arrays (not counting V8 overhead). */
  bytesHeld() {
    let n = 0;
    for (const a of Object.values(this.s)) n += a.byteLength;
    n += this.vcum.byteLength + this.bStart.byteLength + this.bEnd.byteLength;
    n += this.grid.segEdge.byteLength + this.grid.keys.byteLength + this.grid.offs.byteLength + this.grid.segs.byteLength;
    if (this._route) n += this._route.bytes();
    return n;
  }
}

/** Load a pack file. `skip` lists section ids to leave on disk. */
function loadPack(file, { skip = [] } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const { dir } = readDirectory(fd, size);
    const s = {};
    let meta = {};
    for (const [id, ent] of dir) {
      if (id === 'NETWLO' || id === 'NETWHI') continue;
      if (!(id in F.SECTIONS) || skip.includes(id)) continue;
      if (id === 'META') { meta = JSON.parse(Buffer.from(readSection(fd, ent).buffer).toString('utf8')); continue; }
      s[id] = readSection(fd, ent);
    }
    return new TrackPack(s, meta, { file, networkEntries: { lo: dir.get('NETWLO') || null, hi: dir.get('NETWHI') || null } });
  } finally { fs.closeSync(fd); }
}

module.exports = { TrackPack, loadPack, readDirectory, readSection };
