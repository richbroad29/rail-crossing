'use strict';

// A small, dependency-free reader for OpenStreetMap PBF files (build-time only: nothing in the
// service's runtime requires this). It reads blob by blob, never the whole file, and decodes only
// what the caller asks for, because the UK extract is 2+ GB and the builder wants a few hundred
// thousand railway ways out of tens of millions of objects.
//
// Wire format (https://wiki.openstreetmap.org/wiki/PBF_Format): a file is a sequence of
// [4-byte big-endian BlobHeader length][BlobHeader][Blob]. The Blob is zlib-compressed protobuf.
// "OSMHeader" blobs describe the file; "OSMData" blobs hold a PrimitiveBlock: a string table plus
// groups of nodes (dense or plain), ways and relations.

const fs = require('fs');
const zlib = require('zlib');

// ---- protobuf primitives -------------------------------------------------------------------------
// Varints are read into doubles: exact to 2^53, which is far beyond any OSM id (about 1.3e10).

class Cursor {
  constructor(buf, pos = 0, end = buf.length) { this.buf = buf; this.pos = pos; this.end = end; }
  varint() {
    const b = this.buf;
    let p = this.pos;
    let x = b[p++];
    if (x < 128) { this.pos = p; return x; }
    x &= 127;
    let mult = 128, c;
    do { c = b[p++]; x += (c & 127) * mult; mult *= 128; } while (c >= 128);
    this.pos = p;
    return x;
  }
  /** Skip a field whose tag has just been read. */
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 2) { const n = this.varint(); this.pos += n; }
    else if (wire === 1) this.pos += 8;
    else if (wire === 5) this.pos += 4;
    else throw new Error('unsupported protobuf wire type ' + wire);
  }
}

const zigzag = n => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

/** Decode a packed run of varints [s,e) into a plain array. */
function packed(buf, s, e) {
  const out = [];
  const c = new Cursor(buf, s, e);
  while (c.pos < e) out.push(c.varint());
  return out;
}

/** Decode a packed run of delta-coded sint64 values into `out` (a typed array or array) and return the count. */
function deltaInto(buf, s, e, out) {
  const c = new Cursor(buf, s, e);
  let acc = 0, n = 0;
  while (c.pos < e) { acc += zigzag(c.varint()); out[n++] = acc; }
  return n;
}

// ---- the file ------------------------------------------------------------------------------------

class PbfFile {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.blobs = null;
    this.header = null;
  }
  close() { if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; } }

  /** Index every blob (offset + size + type) by reading only the small headers. Tolerates a truncated tail. */
  index() {
    if (this.blobs) return this.blobs;
    const blobs = [];
    const lenBuf = Buffer.alloc(4);
    let pos = 0;
    while (pos + 4 <= this.size) {
      if (fs.readSync(this.fd, lenBuf, 0, 4, pos) < 4) break;
      const hlen = lenBuf.readUInt32BE(0);
      if (hlen > 64 * 1024) throw new Error(`${this.file}: implausible BlobHeader length ${hlen} at ${pos}`);
      const hb = Buffer.alloc(hlen);
      fs.readSync(this.fd, hb, 0, hlen, pos + 4);
      let type = '', datasize = 0;
      const c = new Cursor(hb);
      while (c.pos < hb.length) {
        const tag = c.varint(), f = tag >>> 3, w = tag & 7;
        if (f === 1 && w === 2) { const n = c.varint(); type = hb.toString('utf8', c.pos, c.pos + n); c.pos += n; }
        else if (f === 3 && w === 0) datasize = c.varint();
        else c.skip(w);
      }
      const dataOffset = pos + 4 + hlen;
      if (dataOffset + datasize > this.size) break; // truncated (a download in progress)
      blobs.push({ type, dataOffset, datasize });
      pos = dataOffset + datasize;
    }
    this.blobs = blobs;
    return blobs;
  }

  /** The decompressed protobuf payload of one blob. */
  read(blob) {
    const raw = Buffer.allocUnsafe(blob.datasize);
    fs.readSync(this.fd, raw, 0, blob.datasize, blob.dataOffset);
    const c = new Cursor(raw);
    let data = null, zdata = null;
    while (c.pos < raw.length) {
      const tag = c.varint(), f = tag >>> 3, w = tag & 7;
      if (w !== 2) { c.skip(w); continue; }
      const n = c.varint();
      if (f === 1) data = raw.subarray(c.pos, c.pos + n);
      else if (f === 3) zdata = raw.subarray(c.pos, c.pos + n);
      else if (f === 4) throw new Error('LZMA-compressed blobs are not supported');
      c.pos += n;
    }
    if (data) return data;
    if (zdata) return zlib.inflateSync(zdata);
    throw new Error('blob with no data');
  }

  /** The OSMHeader: required/optional features, writing program, replication timestamp (epoch seconds). */
  readHeader() {
    if (this.header) return this.header;
    const first = this.index().find(b => b.type === 'OSMHeader');
    if (!first) throw new Error(`${this.file} has no OSMHeader blob: not a PBF file?`);
    const buf = this.read(first);
    const h = { required: [], optional: [], program: null, source: null, timestamp: null, bbox: null };
    const c = new Cursor(buf);
    while (c.pos < buf.length) {
      const tag = c.varint(), f = tag >>> 3, w = tag & 7;
      if (w === 2) {
        const n = c.varint(), s = c.pos; c.pos += n;
        if (f === 4) h.required.push(buf.toString('utf8', s, s + n));
        else if (f === 5) h.optional.push(buf.toString('utf8', s, s + n));
        else if (f === 16) h.program = buf.toString('utf8', s, s + n);
        else if (f === 17) h.source = buf.toString('utf8', s, s + n);
      } else if (w === 0) { const v = c.varint(); if (f === 32) h.timestamp = v; }
      else c.skip(w);
    }
    this.header = h;
    return h;
  }
}

// ---- primitive blocks ----------------------------------------------------------------------------

/**
 * Parse the skeleton of a PrimitiveBlock: where each string is, the group ranges, and the coordinate
 * scaling. Nothing is materialised beyond offsets, so skipping a block costs one pass over its tags.
 */
function scanBlock(buf) {
  const blk = { buf, strS: null, strE: null, nStr: 0, groups: [], gran: 100, latOff: 0, lonOff: 0, _cache: null };
  const c = new Cursor(buf);
  while (c.pos < buf.length) {
    const tag = c.varint(), f = tag >>> 3, w = tag & 7;
    if (f === 1 && w === 2) {
      const n = c.varint(), end = c.pos + n;
      const s = [], e = [];
      const t = new Cursor(buf, c.pos, end);
      while (t.pos < end) {
        const tt = t.varint();
        if ((tt >>> 3) === 1 && (tt & 7) === 2) { const len = t.varint(); s.push(t.pos); e.push(t.pos + len); t.pos += len; }
        else t.skip(tt & 7);
      }
      blk.strS = s; blk.strE = e; blk.nStr = s.length; blk._cache = new Array(s.length);
      c.pos = end;
    } else if (f === 2 && w === 2) {
      const n = c.varint();
      blk.groups.push(groupKinds(buf, c.pos, c.pos + n));
      c.pos += n;
    } else if ((f === 17 || f === 19 || f === 20) && w === 0) {
      const v = c.varint();
      if (f === 17) blk.gran = v; else if (f === 19) blk.latOff = zigzag2(v); else blk.lonOff = zigzag2(v);
    } else c.skip(w);
  }
  return blk;
}
// lat_offset / lon_offset are plain int64 (two's-complement varints), not zigzag. A negative value
// arrives as a 10-byte varint whose double is >= 2^63; treat anything that large as negative.
function zigzag2(v) { return v >= 2 ** 63 ? v - 2 ** 64 : v; }

/** Classify a PrimitiveGroup: which kinds it holds and the byte ranges of each element. */
function groupKinds(buf, s, e) {
  const g = { start: s, end: e, nodes: [], dense: [], ways: [], relations: [] };
  const c = new Cursor(buf, s, e);
  while (c.pos < e) {
    const tag = c.varint(), f = tag >>> 3, w = tag & 7;
    if (w !== 2) { c.skip(w); continue; }
    const n = c.varint(), a = c.pos; c.pos += n;
    if (f === 1) g.nodes.push([a, a + n]);
    else if (f === 2) g.dense.push([a, a + n]);
    else if (f === 3) g.ways.push([a, a + n]);
    else if (f === 4) g.relations.push([a, a + n]);
  }
  return g;
}

/** What a block contains: 'nodes' | 'ways' | 'relations' | 'empty' (first group decides, as the sort guarantees). */
function blockKind(blk) {
  for (const g of blk.groups) {
    if (g.nodes.length || g.dense.length) return 'nodes';
    if (g.ways.length) return 'ways';
    if (g.relations.length) return 'relations';
  }
  return 'empty';
}

/** Lazily decoded string by table index. */
function str(blk, i) {
  let v = blk._cache[i];
  if (v === undefined) { v = blk.buf.toString('utf8', blk.strS[i], blk.strE[i]); blk._cache[i] = v; }
  return v;
}

/** Index of a string in the table, or -1. Compares bytes, so it costs no string allocation. */
function findStr(blk, text) {
  const t = Buffer.from(text, 'utf8');
  const { buf, strS, strE } = blk;
  for (let i = 0; i < blk.nStr; i++) {
    if (strE[i] - strS[i] !== t.length) continue;
    if (buf.compare(t, 0, t.length, strS[i], strE[i]) === 0) return i;
  }
  return -1;
}

/**
 * Walk the ways of a block. `onWay(id, keys, vals, refsStart, refsEnd)` receives the packed-key and
 * packed-value ranges as [s,e] pairs and the refs range, so the caller can reject a way on its first
 * tag without decoding the rest.
 */
function eachWay(blk, onWay) {
  const buf = blk.buf;
  for (const g of blk.groups) {
    for (const [s, e] of g.ways) {
      let id = 0, ks = 0, ke = 0, vs = 0, ve = 0, rs = 0, re = 0;
      const c = new Cursor(buf, s, e);
      while (c.pos < e) {
        const tag = c.varint(), f = tag >>> 3, w = tag & 7;
        if (w === 0) { const v = c.varint(); if (f === 1) id = v; }
        else if (w === 2) {
          const n = c.varint(), a = c.pos; c.pos += n;
          if (f === 2) { ks = a; ke = a + n; } else if (f === 3) { vs = a; ve = a + n; } else if (f === 8) { rs = a; re = a + n; }
        } else c.skip(w);
      }
      onWay(id, ks, ke, vs, ve, rs, re);
    }
  }
}

module.exports = { PbfFile, Cursor, scanBlock, blockKind, str, findStr, eachWay, packed, deltaInto, zigzag };
