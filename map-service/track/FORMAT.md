# Track pack format, version 2

One file, `track-pack-<yyyymmdd>.bin`, little-endian throughout. Everything the service needs
loads as typed arrays, one section each, so loading is a handful of `readSync` calls into
8-byte-aligned buffers with no parsing. The reader is `src/track/pack.js`; the writer is
`track/lib/assemble.js`; the constants (section ids, element types, enumerations) live in
`src/track/format.js`, which both import, so this file and the code cannot drift without a test
noticing (`test/track.test.js` round-trips every section).

## File layout

```
offset  size  field
0       4     magic "RTKP" (ASCII)
4       4     u32   format version (2). A reader refuses a version it does not know (it reads 1 and 2).
8       4     u32   section count N
12      4     u32   flags (0)
16      8     f64   total file size in bytes (a truncated download fails this check)
24      8     f64   build time, epoch milliseconds
32      32*N  section table
...           sections, each starting on an 8-byte boundary
```

Section table entry (32 bytes):

| bytes | field |
| --- | --- |
| 0-7 | id, ASCII, NUL padded |
| 8-11 | u32 element type: 1 u8, 2 i32, 3 u32, 4 f32, 5 f64, 6 raw bytes |
| 12-15 | u32 element count |
| 16-23 | f64 byte offset from the start of the file |
| 24-31 | f64 byte length |

Unknown ids are ignored (so a later minor addition does not break an old reader); a missing
required section is an error. Coordinates are **integers in 1e-7 degrees** (1.1 cm of latitude), as `Int32`.
Distances are **metres**, measured on the stored polyline with an equirectangular approximation at the local latitude
(`src/track/geom.js`, shared by builder and runtime).

## Sections

Graph. A *node* is a junction or a track end; an *edge* is the track between two nodes, with its own polyline.

| id | type | count | meaning |
| --- | --- | --- | --- |
| META | bytes | | UTF-8 JSON: format, pack date, build time, builder commit, sources (OSM data timestamp, NaPTAN date and hash), parameters, counts, graph/station/signal statistics, the list of unsnapped stations |
| NLAT, NLON | i32 | nodes | node position |
| NADJO | u32 | nodes+1 | CSR offsets into NADJ |
| NADJ | u32 | 2 x edges | directed edges leaving each node, `(edge << 1) \| reversed`: bit 0 = 0 means leaving along the edge's own direction from its `from` node, 1 means leaving backwards from its `to` node |
| EFROM, ETO | u32 | edges | node ids; an edge keeps the direction of the OSM way it came from |
| EVO | u32 | edges+1 | offsets into VLAT/VLON; edge `e` owns vertices `EVO[e] .. EVO[e+1]-1`. The first and last vertex are the coordinates of its nodes |
| VLAT, VLON | i32 | vertices | polyline vertices, simplified to the builder's tolerance (1 m by default, 2 m at most) |
| ELEN | f32 | edges | metres along the stored polyline (the runtime recomputes cumulative distance per vertex from the vertices, so this is a cross-check) |
| ECLS | u8 | edges | class: 0 main, 1 branch, 2 siding, 3 yard, 4 crossover, 5 other (industrial, military, tourism, test) |
| EELEC | u8 | edges | 0 unknown, 1 none, 2 overhead, 3 third rail, 4 other |
| ESPD | u8 | edges | maxspeed in mph, 0 unknown |
| EFLG | u8 | edges | bit 0 tunnel (`tunnel=*`, `covered=yes` or `layer<0`), bit 1 bridge, bit 2 light_rail, bit 3 reserved. **Metadata only: tunnels are ordinary track in the graph and the overview.** |
| ENAME, EREF, ETRK | u32 | edges | string ids (0 = none): OSM `name`, `ref`, `railway:track_ref` / `track_ref` |

Strings.

| id | type | meaning |
| --- | --- | --- |
| STRO | u32 | n+1 offsets into STRB; string `i` is `STRB[STRO[i] .. STRO[i+1])`, UTF-8. String 0 is empty |
| STRB | bytes | the UTF-8 text |

Signals (OSM `railway=signal` nodes that carry a `ref`, snapped to an edge; contract section 9.3).

| id | type | meaning |
| --- | --- | --- |
| SGEDGE | u32 | edge |
| SGOFF | f32 | metres from the edge's first node |
| SGDIST | f32 | metres from the signal's mapped position to the track |
| SGLAT, SGLON | i32 | the signal's own mapped position |
| SGREF | u32 | string id of `ref` |
| SGDIR | u8 | `railway:signal:direction`: 0 unknown, 1 forward, 2 backward, 3 both. Only set when the node is a vertex of the way (relative to the edge direction); a tag on a node beside the track means nothing and is stored as 0 |
| SGSIDE | u8 | 0 on the track, 1 left, 2 right of the edge, facing `from` to `to` (British signals stand on the left of the line they govern) |
| SGKIND | u8 | bits: 1 main, 2 distant, 4 shunting, 8 combined, 16 minor (from `railway:signal:*` tag keys), 128 node is a vertex of the way |

Stations (NaPTAN rail stations, by TIPLOC) and their snaps. A station may have no snaps (unsnapped).

| id | type | meaning |
| --- | --- | --- |
| STTIP, STNAME | u32 | string ids: TIPLOC, name |
| STLAT, STLON | i32 | the NaPTAN position |
| STSNO | u32 | stations+1 offsets into the SN* arrays |
| SNEDGE | u32 | edge |
| SNOFF | f32 | stop point: metres from the edge's first node |
| SNDIST | f32 | metres from the station position (primary) or the platform (platform snaps) to the track |
| SNPLAT | u32 | string id of the platform reference as OSM writes it (`"1"`, `"1;2"`, `"9w"`, `"Line A"`); 0 for the primary snap |
| SNLO, SNHI | f32 | the stretch of the edge the platform covers (equal to SNOFF for a primary snap; the whole edge for a snap from a track ref) |
| SNFLG | u8 | bit 0 primary (nearest running edge within 300 m), bit 1 from a track way's platform number, bit 2 from an OSM platform alongside the track |

Network overview (two levels, each gzip-compressed GeoJSON; **not loaded into memory**, read on demand).

| id | meaning |
| --- | --- |
| NETWLO | about 100 m deviation, for zoom 7 and below |
| NETWHI | about 15 m deviation, for zoom 8 to 11 |

Both are one `FeatureCollection` of two `MultiLineString` features (`class: main`, `class: branch`), every
running line (tunnels included and not marked), no siding, yard, crossover or depot spur, 4 or 5 decimal places.

## Derived index (stored from format 2)

Computed once by the builder (`src/track/derive.js`, shared with the reader) and stored, so that loading a pack is a handful of
`readSync` calls and nothing is computed. Format 1 packs lack these sections and the reader derives them itself, which costs
about 0.1 s on a laptop and 20 s on the 1/8-core production server (measured by the lead): that is why they are stored.

| id | type | count | meaning |
| --- | --- | --- | --- |
| VCUM | f32 | vertices | metres from the start of the edge to each vertex |
| EBST, EBEN | f32 | edges | tangent bearing at the first / last node, measured to the first vertex 15 m in (the routing turn limit) |
| GSEGE | u32 | vertices | the edge a segment (identified by its first vertex) belongs to |
| GKEY, GOFF, GSEG | u32 | cells+, cells+1, segments | the sparse 450 m grid: sorted keys of occupied cells, offsets, and the segments in each |

`track/upgrade.js in.bin out.bin [--manifest in.manifest.json]` rewrites a format-1 pack as format 2 without rebuilding it from
OSM, and records `upgradedFrom` (format and hash) in the new manifest.

## Derived at load, not stored

The route search's scratch arrays (allocated on first `route()`).

## Versioning

Bump `VERSION` in `src/track/format.js` for any change an old reader cannot ignore (a changed meaning of an
existing section, a new *required* section). Adding a section an old reader may skip does not need a bump (the derived index
was such a change for an OLD reader but is optional for a NEW one, which is why format 1 stays readable: `MIN_VERSION` is 1).
The service refuses a pack whose version it does not know and keeps the pack it already has.

- 1: graph, strings, signals, stations, overview.
- 2: adds the derived index (VCUM, EBST, EBEN, GSEGE, GKEY, GOFF, GSEG).
