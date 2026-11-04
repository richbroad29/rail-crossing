'use strict';

// Test support for the track pack: a minimal PBF *writer* (just enough protobuf for DenseNodes and
// Ways), so the real builder pipeline (pbf reader -> extract -> graph -> sections -> TrackPack) can be
// run end to end on a few planted ways with known answers, offline, in milliseconds.

const fs = require('fs');
const zlib = require('zlib');
const { extract } = require('../track/lib/osm-extract');
const { buildGraph } = require('../track/lib/graph');
const { StringTable, graphSections } = require('../track/lib/assemble');
const { TrackPack } = require('../src/track/pack');

// ---- protobuf encoding ---------------------------------------------------------------------------
function varint(n) {
  const out = [];
  while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
}
const zz = n => (n >= 0 ? n * 2 : -n * 2 - 1);
const field = (f, wire, payload) => Buffer.concat([varint(f * 8 + wire), payload]);
const vfield = (f, n) => field(f, 0, varint(n));
const bfield = (f, buf) => field(f, 2, Buffer.concat([varint(buf.length), buf]));
const packedField = (f, nums, signedDelta) => {
  let prev = 0;
  const parts = nums.map((n) => { const v = signedDelta ? zz(n - prev) : n; prev = n; return varint(v); });
  return bfield(f, Buffer.concat(parts));
};

function stringTable(strs) { return bfield(1, Buffer.concat(strs.map(s => bfield(1, Buffer.from(s, 'utf8'))))); }

function blob(type, payload) {
  const z = zlib.deflateSync(payload);
  const body = Buffer.concat([vfield(2, payload.length), bfield(3, z)]);
  const head = Buffer.concat([bfield(1, Buffer.from(type)), vfield(3, body.length)]);
  const len = Buffer.alloc(4); len.writeUInt32BE(head.length);
  return Buffer.concat([len, head, body]);
}

/**
 * @param {string} file
 * @param {{nodes: Array<{id:number, lat7:number, lon7:number, tags?:object}>, ways: Array<{id:number, refs:number[], tags:object}>, perBlock?: number}} spec
 */
function writePbf(file, { nodes, ways, perBlock = 4 }) {
  const parts = [];
  const hdr = Buffer.concat([
    bfield(4, Buffer.from('OsmSchema-V0.6')), bfield(4, Buffer.from('DenseNodes')), bfield(5, Buffer.from('Sort.Type_then_ID')),
    bfield(16, Buffer.from('track-synth')), vfield(32, 1793654486)
  ]);
  parts.push(blob('OSMHeader', hdr));
  const sortedNodes = nodes.slice().sort((a, b) => a.id - b.id);
  for (let i = 0; i < sortedNodes.length; i += perBlock) {
    const chunk = sortedNodes.slice(i, i + perBlock);
    const strs = [''];
    const sid = (s) => { let k = strs.indexOf(s); if (k < 0) { k = strs.length; strs.push(s); } return k; };
    const kv = [];
    for (const n of chunk) { for (const [k, v] of Object.entries(n.tags || {})) kv.push(sid(k), sid(v)); kv.push(0); }
    const anyTags = chunk.some(n => n.tags && Object.keys(n.tags).length);
    const dense = Buffer.concat([
      packedField(1, chunk.map(n => n.id), true), packedField(8, chunk.map(n => n.lat7), true), packedField(9, chunk.map(n => n.lon7), true),
      anyTags ? packedField(10, kv, false) : Buffer.alloc(0)
    ]);
    const group = bfield(2, bfield(2, dense));
    parts.push(blob('OSMData', Buffer.concat([stringTable(strs), group])));
  }
  for (let i = 0; i < ways.length; i += perBlock) {
    const chunk = ways.slice(i, i + perBlock);
    const strs = [''];
    const sid = (s) => { let k = strs.indexOf(s); if (k < 0) { k = strs.length; strs.push(s); } return k; };
    const wbufs = chunk.map((w) => {
      const keys = [], vals = [];
      for (const [k, v] of Object.entries(w.tags)) { keys.push(sid(k)); vals.push(sid(v)); }
      return bfield(3, Buffer.concat([vfield(1, w.id), packedField(2, keys, false), packedField(3, vals, false), packedField(8, w.refs, true)]));
    });
    parts.push(blob('OSMData', Buffer.concat([stringTable(strs), bfield(2, Buffer.concat(wbufs))])));
  }
  fs.writeFileSync(file, Buffer.concat(parts));
}

// ---- planting geography --------------------------------------------------------------------------
const LAT0 = 51.0, LON0 = -1.0, KY = 111194.9266;
const KX = KY * Math.cos(LAT0 * Math.PI / 180);
/** Metres east/north of the origin -> 1e-7 degree integers. */
const at = (x, y) => ({ lat7: Math.round((LAT0 + y / KY) * 1e7), lon7: Math.round((LON0 + x / KX) * 1e7) });

/**
 * A planted layout from named points and ways, built through the real pipeline.
 * @param {string} dir a temp dir
 * @param {{points: Object<string,[number,number]>, ways: Array<{name?: string, pts: string[], tags?: object}>, nodeTags?: Object<string,object>}} layout
 * @returns {{pack: TrackPack, ex: object, graph: object, nodeId: Object<string, number>}}
 */
function synth(dir, layout, { tolerance = 0.5, perBlock = 4 } = {}) {
  const ids = {};
  const nodes = [];
  let next = 5000000000;          // beyond 32 bits, to exercise the 64-bit varints
  for (const [name, [x, y]] of Object.entries(layout.points)) {
    ids[name] = next; next += 3;
    nodes.push({ id: ids[name], ...at(x, y), tags: (layout.nodeTags || {})[name] });
  }
  const ways = layout.ways.map((w, i) => ({ id: 100 + i, refs: w.pts.map(p => ids[p]), tags: Object.assign({ railway: 'rail' }, w.tags || {}) }));
  // an unrelated non-rail way and a far-away node, which the extractor must ignore
  ways.push({ id: 9999, refs: [ids[Object.keys(ids)[0]]], tags: { highway: 'residential' } });
  const file = require('path').join(dir, 'synth.osm.pbf');
  writePbf(file, { nodes, ways, perBlock });
  const ex = extract(file);
  const graph = buildGraph(ex, { tolerance });
  const strings = new StringTable();
  const S = graphSections(graph, strings);
  Object.assign(S, strings.build());
  const pack = new TrackPack(S, {});
  for (let e = 0; e < pack.nEdges; e++) S.ELEN[e] = pack.length(e);
  return { pack, ex, graph, nodeId: ids, file };
}

module.exports = { writePbf, synth, at };
