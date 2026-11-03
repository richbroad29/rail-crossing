'use strict';

// The track-pack binary format: constants shared by the offline builder (track/build.js) and the
// runtime reader (src/track/pack.js). Documented for humans in track/FORMAT.md; this file is the
// source of truth for the names, element types and enumerations.

const MAGIC = 'RTKP';
const VERSION = 1;
const HEADER_BYTES = 32;      // fixed part of the header, before the section table
const ENTRY_BYTES = 32;       // one section-table entry
const ALIGN = 8;              // every section starts on an 8-byte boundary

// Element types of a section.
const T = { U8: 1, I32: 2, U32: 3, F32: 4, F64: 5, BYTES: 6 };
const ARRAYS = { [T.U8]: Uint8Array, [T.I32]: Int32Array, [T.U32]: Uint32Array, [T.F32]: Float32Array, [T.F64]: Float64Array, [T.BYTES]: Uint8Array };

// Section ids (<= 8 ASCII characters) and their element types.
const SECTIONS = {
  META: T.BYTES,    // UTF-8 JSON: provenance, counts, parameters
  // graph nodes (junctions and ends)
  NLAT: T.I32, NLON: T.I32,          // position, 1e-7 degrees
  NADJO: T.U32, NADJ: T.U32,         // CSR: directed edges leaving each node, (edge << 1) | reversed
  // edges
  EFROM: T.U32, ETO: T.U32,          // node ids
  EVO: T.U32,                        // n+1 offsets into VLAT/VLON; edge e owns vertices EVO[e]..EVO[e+1]-1, first and last are its nodes
  ELEN: T.F32,                       // metres along the stored polyline
  ECLS: T.U8, EELEC: T.U8, ESPD: T.U8, EFLG: T.U8,
  ENAME: T.U32, EREF: T.U32, ETRK: T.U32,   // string ids; 0 = none
  VLAT: T.I32, VLON: T.I32,
  // strings: id i spans STRB[STRO[i] .. STRO[i+1]); id 0 is the empty string
  STRO: T.U32, STRB: T.BYTES,
  // OSM signals, snapped to edges
  SGEDGE: T.U32, SGOFF: T.F32, SGDIST: T.F32, SGLAT: T.I32, SGLON: T.I32,
  SGREF: T.U32, SGDIR: T.U8, SGSIDE: T.U8, SGKIND: T.U8,
  // NaPTAN stations and their snaps (several per station: one per platform track where OSM separates them)
  STTIP: T.U32, STNAME: T.U32, STLAT: T.I32, STLON: T.I32, STSNO: T.U32,
  SNEDGE: T.U32, SNOFF: T.F32, SNDIST: T.F32, SNPLAT: T.U32, SNLO: T.F32, SNHI: T.F32, SNFLG: T.U8,
  // the national overview at two simplification levels, as gzipped GeoJSON bytes (read on demand, not held in memory)
  NETWLO: T.BYTES,                  // ~100 m deviation, for zoom <= 7
  NETWHI: T.BYTES                   // ~15 m deviation, for zoom 8..11
};

// Edge classes (ECLS).
const CLS = { MAIN: 0, BRANCH: 1, SIDING: 2, YARD: 3, CROSSOVER: 4, OTHER: 5 };
const CLS_NAMES = ['main', 'branch', 'siding', 'yard', 'crossover', 'other'];

// Edge flags (EFLG), bit set. TUNNEL is metadata only: tunnels are ordinary track in the graph and the overview.
const FLG = { TUNNEL: 1, BRIDGE: 2, LIGHT_RAIL: 4, PLATFORM_TRACK: 8 };

// Electrification (EELEC).
const ELEC = { UNKNOWN: 0, NONE: 1, OVERHEAD: 2, THIRD_RAIL: 3, OTHER: 4 };
const ELEC_NAMES = ['unknown', 'none', 'overhead', 'third rail', 'other'];

// Signals.
const SIGDIR = { UNKNOWN: 0, FORWARD: 1, BACKWARD: 2, BOTH: 3 };     // relative to the edge direction (only meaningful when the node is on the way)
const SIGSIDE = { ON: 0, LEFT: 1, RIGHT: 2 };                        // which side of the edge, facing from -> to
const SIGKIND = { MAIN: 1, DISTANT: 2, SHUNTING: 4, COMBINED: 8, MINOR: 16, ON_WAY: 128 };

// Station snap flags (SNFLG).
const SNAP = { PRIMARY: 1, TRACK_REF: 2, PLATFORM: 4 };

const E7 = 1e-7;

module.exports = { MAGIC, VERSION, HEADER_BYTES, ENTRY_BYTES, ALIGN, T, ARRAYS, SECTIONS, CLS, CLS_NAMES, FLG, ELEC, ELEC_NAMES, SIGDIR, SIGSIDE, SIGKIND, SNAP, E7 };
