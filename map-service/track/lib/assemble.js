'use strict';

// Graph -> pack sections (typed arrays), and sections -> file.

const fs = require('fs');
const crypto = require('crypto');
const F = require('../../src/track/format');
const { classify, electrification, maxspeedMph, flags } = require('./graph');
const { deriveSections } = require('../../src/track/derive');

class StringTable {
  constructor() { this.list = ['']; this.map = new Map([['', 0]]); }
  intern(s) {
    if (!s) return 0;
    let i = this.map.get(s);
    if (i === undefined) { i = this.list.length; this.list.push(s); this.map.set(s, i); }
    return i;
  }
  build() {
    const enc = this.list.map(s => Buffer.from(s, 'utf8'));
    const STRO = new Uint32Array(enc.length + 1);
    let n = 0;
    enc.forEach((b, i) => { STRO[i] = n; n += b.length; });
    STRO[enc.length] = n;
    const STRB = new Uint8Array(n);
    enc.forEach((b, i) => STRB.set(b, STRO[i]));
    return { STRO, STRB };
  }
}

/** The graph's own sections: nodes, adjacency, edges, vertices. Strings go through `strings`. */
function graphSections(g, strings) {
  const N = g.nLat.length, E = g.edges.from.length;
  const s = {};
  s.NLAT = Int32Array.from(g.nLat); s.NLON = Int32Array.from(g.nLon);
  s.EFROM = Uint32Array.from(g.edges.from); s.ETO = Uint32Array.from(g.edges.to);
  s.EVO = Uint32Array.from(g.edges.vstart);
  s.VLAT = Int32Array.from(g.edges.vlat); s.VLON = Int32Array.from(g.edges.vlon);
  s.ELEN = new Float32Array(E);                       // filled by the caller from the loaded geometry
  s.ECLS = new Uint8Array(E); s.EELEC = new Uint8Array(E); s.ESPD = new Uint8Array(E); s.EFLG = new Uint8Array(E);
  s.ENAME = new Uint32Array(E); s.EREF = new Uint32Array(E); s.ETRK = new Uint32Array(E);
  for (let e = 0; e < E; e++) {
    const t = g.tagsOf(g.edges.way[e]);
    s.ECLS[e] = classify(t);
    s.EELEC[e] = electrification(t);
    s.ESPD[e] = maxspeedMph(t);
    s.EFLG[e] = flags(t);
    s.ENAME[e] = strings.intern(t.name || '');
    s.EREF[e] = strings.intern(t.ref || '');
    s.ETRK[e] = strings.intern(t['railway:track_ref'] || t.track_ref || '');
  }
  const deg = new Uint32Array(N + 1);
  for (let e = 0; e < E; e++) { deg[s.EFROM[e]]++; deg[s.ETO[e]]++; }
  const off = new Uint32Array(N + 1);
  for (let i = 0; i < N; i++) off[i + 1] = off[i] + deg[i];
  const fill = off.slice(0, N);
  s.NADJO = off;
  s.NADJ = new Uint32Array(off[N]);
  for (let e = 0; e < E; e++) { s.NADJ[fill[s.EFROM[e]]++] = e * 2; s.NADJ[fill[s.ETO[e]]++] = e * 2 + 1; }
  return s;
}

/** Write a pack. `sections` are typed arrays by id; META and NETW are given as Buffers. Returns {bytes, sha256, sections}. */
function writePack(file, sections, { metaJson, networkLo, networkHi, built = Date.now(), version = F.VERSION }) {
  const entries = [];
  // Format 2 stores the derived index (computed here, once, from the vertex arrays) so the runtime reader does no work.
  if (version >= 2 && !sections.GKEY) sections = Object.assign({}, sections, deriveSections(sections.VLAT, sections.VLON, sections.EVO));
  if (version < 2) { sections = Object.assign({}, sections); for (const id of ['VCUM', 'EBST', 'EBEN', 'GKEY', 'GOFF', 'GSEG', 'GSEGE']) delete sections[id]; }
  const order = Object.keys(F.SECTIONS);
  const put = (id, data) => entries.push({ id, type: F.SECTIONS[id], count: data.length, buf: Buffer.from(data.buffer, data.byteOffset, data.byteLength) });
  put('META', Buffer.from(metaJson, 'utf8'));
  for (const id of order) { if (id === 'META' || id === 'NETWLO' || id === 'NETWHI') continue; if (sections[id]) put(id, sections[id]); }
  if (networkLo) put('NETWLO', networkLo);
  if (networkHi) put('NETWHI', networkHi);
  let pos = F.HEADER_BYTES + entries.length * F.ENTRY_BYTES;
  const align = n => Math.ceil(n / F.ALIGN) * F.ALIGN;
  for (const e of entries) { pos = align(pos); e.offset = pos; pos += e.buf.length; }
  const total = align(pos);
  const out = Buffer.alloc(total);
  out.write(F.MAGIC, 0, 'latin1');
  out.writeUInt32LE(version, 4); out.writeUInt32LE(entries.length, 8); out.writeUInt32LE(0, 12);
  out.writeDoubleLE(total, 16); out.writeDoubleLE(built, 24);
  entries.forEach((e, i) => {
    const o = F.HEADER_BYTES + i * F.ENTRY_BYTES;
    out.write(e.id, o, 'latin1');
    out.writeUInt32LE(e.type, o + 8); out.writeUInt32LE(e.count, o + 12);
    out.writeDoubleLE(e.offset, o + 16); out.writeDoubleLE(e.buf.length, o + 24);
    e.buf.copy(out, e.offset);
  });
  fs.writeFileSync(file, out);
  return { bytes: total, sha256: crypto.createHash('sha256').update(out).digest('hex'), sections: entries.map(e => ({ id: e.id, count: e.count, bytes: e.buf.length })) };
}

module.exports = { StringTable, graphSections, writePack };
