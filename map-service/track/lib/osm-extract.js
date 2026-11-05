'use strict';

// Two passes over the PBF, each decompressing only the blobs it needs.
//
//   pass A (ways):   every railway=rail / light_rail way (the graph) and every railway=platform /
//                    platform_edge way (for station platform snaps), with the few tags we keep and
//                    their node ids.
//   pass B (nodes):  coordinates for exactly those node ids, plus every railway=signal node anywhere
//                    and railway=diamond_crossing nodes (which do NOT connect the ways through them).
//
// Planet files are sorted nodes, then ways, then relations, and say so in the header
// ("Sort.Type_then_ID"). That lets each pass find its own blobs with a binary search and decompress
// them once, rather than both passes inflating all of the 1.5 GB of nodes. Without the feature flag
// the extractor falls back to inflating everything twice, which is slower but correct.

const { PbfFile, Cursor, scanBlock, blockKind, str, findStr, eachWay, deltaInto, packed, zigzag } = require('./pbf');

const WAY_TAGS = new Set([
  'railway', 'usage', 'service', 'electrified', 'voltage', 'maxspeed', 'name', 'ref', 'railway:track_ref', 'track_ref',
  'tunnel', 'covered', 'layer', 'bridge', 'disused', 'abandoned', 'construction', 'railway:preserved', 'operator',
  'railway:traffic_mode', 'gauge', 'highspeed', 'public_transport', 'level', 'area', 'name:en'
]);
const NODE_TAGS = new Set(['railway', 'ref', 'name', 'railway:ref', 'railway:switch']);
const WAY_RAILWAY = ['rail', 'light_rail', 'platform', 'platform_edge'];

/** Growable Float64Array. */
class F64List {
  constructor(n = 1 << 20) { this.a = new Float64Array(n); this.n = 0; }
  push(v) { if (this.n === this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  view() { return this.a.subarray(0, this.n); }
}

/** First index in sorted `a` (from `lo`) whose value is >= x. */
function lowerBound(a, x, lo = 0, hi = a.length) {
  while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

/** Find the blob ranges for node blocks and way blocks. */
function classifyBlobs(pbf, log) {
  const all = pbf.index().filter(b => b.type === 'OSMData');
  const h = pbf.readHeader();
  const sorted = h.required.concat(h.optional).includes('Sort.Type_then_ID');
  const kindAt = i => blockKind(scanBlock(pbf.read(all[i])));
  if (!sorted || all.length < 8) {
    log('header has no Sort.Type_then_ID: classifying every blob (slower)');
    const kinds = all.map((b, i) => kindAt(i));
    return { all, kinds, sorted: false };
  }
  // nodes ... ways ... relations. Binary search the two boundaries. Empty blocks are treated as part of the run before them.
  const firstOf = (pred) => {
    let lo = 0, hi = all.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (pred(kindAt(m))) hi = m; else lo = m + 1; }
    return lo;
  };
  const firstWay = firstOf(k => k !== 'nodes' && k !== 'empty');
  const firstRel = firstOf(k => k === 'relations');
  // Verify the ends of each run, which is cheap and catches an unsorted file claiming to be sorted.
  const check = (i, ok) => { if (i >= 0 && i < all.length && !ok.includes(kindAt(i))) throw new Error(`blob ${i} is not ${ok} although the header says the file is sorted`); };
  check(0, ['nodes', 'empty']); check(firstWay - 1, ['nodes', 'empty']); check(firstWay, ['ways', 'empty']); check(firstRel - 1, ['ways', 'empty']);
  return { all, firstWay, firstRel, sorted: true };
}

/** The tags of a way as an object (only the keys we keep). */
function wayTags(blk, buf, ks, ke, vs, ve) {
  const k = packed(buf, ks, ke), v = packed(buf, vs, ve);
  const t = {};
  for (let i = 0; i < k.length; i++) { const key = str(blk, k[i]); if (WAY_TAGS.has(key)) t[key] = str(blk, v[i]); }
  return t;
}

function passWays(pbf, cls, log) {
  const ways = [];               // {id, tags, start, len}
  const refs = new F64List(1 << 22);
  const range = cls.sorted ? [cls.firstWay, cls.firstRel] : [0, cls.all.length];
  let blocks = 0;
  for (let i = range[0]; i < range[1]; i++) {
    if (!cls.sorted && cls.kinds[i] !== 'ways') continue;
    const buf = pbf.read(cls.all[i]);
    const blk = scanBlock(buf);
    blocks++;
    const kIdx = findStr(blk, 'railway');
    if (kIdx < 0) continue;
    const want = new Set();
    for (const v of WAY_RAILWAY) { const j = findStr(blk, v); if (j >= 0) want.add(j); }
    if (!want.size) continue;
    eachWay(blk, (id, ks, ke, vs, ve, rs, re) => {
      // reject on the railway tag alone, without decoding the rest
      const kc = new Cursor(buf, ks, ke), vc = new Cursor(buf, vs, ve);
      let hit = false;
      while (kc.pos < ke) { const k = kc.varint(), v = vc.varint(); if (k === kIdx) { hit = want.has(v); break; } }
      if (!hit) return;
      const tags = wayTags(blk, buf, ks, ke, vs, ve);
      const start = refs.n;
      const rc = new Cursor(buf, rs, re);
      let acc = 0, n = 0;
      while (rc.pos < re) { acc += zigzag(rc.varint()); refs.push(acc); n++; }
      ways.push({ id, tags, start, len: n });
    });
  }
  log(`pass A: ${blocks} way blocks, ${ways.length} railway/platform ways, ${refs.n} node refs`);
  return { ways, refs: refs.view() };
}

function nodeTags(blk, kvBuf, ks, ke) { // ks..ke index into a pre-decoded kv array
  const t = {};
  for (let i = ks; i < ke; i += 2) {
    const key = str(blk, kvBuf[i]);
    if (NODE_TAGS.has(key) || key.startsWith('railway:signal')) t[key] = str(blk, kvBuf[i + 1]);
  }
  return t;
}

function passNodes(pbf, cls, wanted, log) {
  const lat = new Int32Array(wanted.length), lon = new Int32Array(wanted.length);
  const have = new Uint8Array(wanted.length);
  const special = [];            // {id, lat, lon, tags} for railway=signal / diamond_crossing anywhere
  const range = cls.sorted ? [0, cls.firstWay] : [0, cls.all.length];
  const ids = new Float64Array(16384), lats = new Float64Array(16384), lons = new Float64Array(16384);
  let p = 0, blocks = 0, found = 0, decoded = 0;
  const lo0 = wanted.length ? wanted[0] : Infinity, hi0 = wanted.length ? wanted[wanted.length - 1] : -Infinity;
  for (let i = range[0]; i < range[1]; i++) {
    if (!cls.sorted && cls.kinds[i] !== 'nodes') continue;
    const buf = pbf.read(cls.all[i]);
    const blk = scanBlock(buf);
    blocks++;
    const iRail = findStr(blk, 'railway');
    const spec = new Set();
    if (iRail >= 0) for (const v of ['signal', 'diamond_crossing', 'railway_crossing']) { const j = findStr(blk, v); if (j >= 0) spec.add(j); }
    const scale = (off, raw) => Math.round((off + blk.gran * raw) / 100);
    for (const g of blk.groups) {
      for (const [s, e] of g.dense) {
        let idS = 0, idE = 0, laS = 0, laE = 0, loS = 0, loE = 0, kvS = 0, kvE = 0;
        const c = new Cursor(buf, s, e);
        while (c.pos < e) {
          const tag = c.varint(), f = tag >>> 3, w = tag & 7;
          if (w !== 2) { c.skip(w); continue; }
          const n = c.varint(), a = c.pos; c.pos += n;
          if (f === 1) { idS = a; idE = a + n; } else if (f === 8) { laS = a; laE = a + n; } else if (f === 9) { loS = a; loE = a + n; } else if (f === 10) { kvS = a; kvE = a + n; }
        }
        const n = deltaInto(buf, idS, idE, ids);
        if (!n) continue;
        decoded += n;
        // Tagged specials: walk keys_vals only when this block can contain one.
        let specialIdx = null, kv = null, kvStart = null;
        if (spec.size && kvE > kvS) {
          kv = packed(buf, kvS, kvE);
          specialIdx = [];
          kvStart = [];
          let q = 0;
          for (let nd = 0; nd < n && q < kv.length; nd++) {
            const begin = q;
            let isSpec = false;
            while (q < kv.length && kv[q] !== 0) { if (kv[q] === iRail && spec.has(kv[q + 1])) isSpec = true; q += 2; }
            q++; // the 0 delimiter
            if (isSpec) { specialIdx.push(nd); kvStart.push([begin, q - 1]); }
          }
        }
        // Do any wanted ids fall in this block?
        let hitLo = -1, hitHi = -1;
        if (ids[n - 1] >= lo0 && ids[0] <= hi0) {
          p = lowerBound(wanted, ids[0], p);
          hitLo = p;
          if (p < wanted.length && wanted[p] <= ids[n - 1]) hitHi = lowerBound(wanted, ids[n - 1] + 1, p);
        }
        const anyHit = hitHi > hitLo && hitLo >= 0;
        if (!anyHit && !(specialIdx && specialIdx.length)) continue;
        deltaInto(buf, laS, laE, lats); deltaInto(buf, loS, loE, lons);
        if (anyHit) {
          let w = hitLo;
          for (let nd = 0; nd < n && w < hitHi; nd++) {
            const id = ids[nd];
            while (w < hitHi && wanted[w] < id) w++;
            if (w < hitHi && wanted[w] === id) { lat[w] = scale(blk.latOff, lats[nd]); lon[w] = scale(blk.lonOff, lons[nd]); have[w] = 1; found++; w++; }
          }
          p = hitHi;
        }
        if (specialIdx) {
          specialIdx.forEach((nd, j) => {
            const [a, b] = kvStart[j];
            special.push({ id: ids[nd], lat: scale(blk.latOff, lats[nd]), lon: scale(blk.lonOff, lons[nd]), tags: nodeTags(blk, kv, a, b) });
          });
        }
      }
      // Plain (non-dense) nodes: Geofabrik never writes them, but the format allows it.
      for (const [s, e] of g.nodes) {
        const c = new Cursor(buf, s, e);
        let id = 0, la = 0, lo = 0, ks = 0, ke = 0, vs = 0, ve = 0;
        while (c.pos < e) {
          const tag = c.varint(), f = tag >>> 3, w = tag & 7;
          if (w === 0) { const v = c.varint(); if (f === 1) id = zigzag(v); else if (f === 8) la = zigzag(v); else if (f === 9) lo = zigzag(v); }
          else if (w === 2) { const n = c.varint(), a = c.pos; c.pos += n; if (f === 2) { ks = a; ke = a + n; } else if (f === 3) { vs = a; ve = a + n; } }
          else c.skip(w);
        }
        const w = lowerBound(wanted, id);
        if (w < wanted.length && wanted[w] === id) { lat[w] = scale(blk.latOff, la); lon[w] = scale(blk.lonOff, lo); have[w] = 1; found++; }
        if (iRail >= 0 && ke > ks) {
          const k = packed(buf, ks, ke), v = packed(buf, vs, ve);
          const kv = []; for (let j = 0; j < k.length; j++) kv.push(k[j], v[j]);
          const t = nodeTags(blk, kv, 0, kv.length);
          if (t.railway === 'signal' || t.railway === 'diamond_crossing' || t.railway === 'railway_crossing') special.push({ id, lat: scale(blk.latOff, la), lon: scale(blk.lonOff, lo), tags: t });
        }
      }
    }
  }
  log(`pass B: ${blocks} node blocks, ${decoded} nodes decoded, ${found} of ${wanted.length} wanted found, ${special.length} signal/crossing nodes`);
  return { lat, lon, have, special };
}

/**
 * Extract the railway from a PBF.
 * @returns {{ways, refs, wanted, lat, lon, have, special, source}} node ids are in sorted `wanted`; lat/lon are 1e-7 degree integers aligned with it.
 */
function extract(file, { log = () => {} } = {}) {
  const pbf = new PbfFile(file);
  try {
    const header = pbf.readHeader();
    const t0 = Date.now();
    const cls = classifyBlobs(pbf, log);
    log(`classified ${cls.all.length} data blobs in ${((Date.now() - t0) / 1000).toFixed(1)}s` + (cls.sorted ? ` (nodes 0..${cls.firstWay - 1}, ways ${cls.firstWay}..${cls.firstRel - 1})` : ''));
    const A = passWays(pbf, cls, log);
    // distinct sorted node ids
    const sortedRefs = Float64Array.from(A.refs).sort();
    let n = 0;
    for (let i = 0; i < sortedRefs.length; i++) if (i === 0 || sortedRefs[i] !== sortedRefs[i - 1]) sortedRefs[n++] = sortedRefs[i];
    const wanted = sortedRefs.slice(0, n);
    log(`${wanted.length} distinct nodes wanted`);
    const B = passNodes(pbf, cls, wanted, log);
    return {
      ways: A.ways, refs: A.refs, wanted, lat: B.lat, lon: B.lon, have: B.have, special: B.special,
      source: { program: header.program, timestamp: header.timestamp, dataBlobs: cls.all.length }
    };
  } finally { pbf.close(); }
}

module.exports = { extract, lowerBound, classifyBlobs };
