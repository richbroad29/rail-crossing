# Track pack builder

Builds the railway track model the live map puts trains on (contract section 8): the graph of real
track from OpenStreetMap, NaPTAN station snaps, OSM signals, and the national network overview. It runs
on a Mac or a GitHub Actions runner, **never on the VPS**; the VPS downloads the published file. The
runtime library that reads the pack is `../src/track/` (no dependencies, loads in under 0.1 s).

Format: [`FORMAT.md`](FORMAT.md). Licence: OSM data is ODbL; the pack and the overview are derived
databases, so credit "© OpenStreetMap contributors" wherever they are shown. The builder is public.

## Build locally

The builder has **no npm dependencies** (the PBF reader is `lib/pbf.js`). Node 20 or newer.

1. Get the inputs (once; the OSM file is 2.3 GB and must never be committed):

   ```
   cd map-service
   node track/build.js --download --cache ~/rail-map-refdata/osm --out ~/rail-map-refdata/track-out
   ```

   `--download` fetches Geofabrik's `united-kingdom-latest.osm.pbf` and the DfT NaPTAN rail CSV into
   `--cache`. To use files you already have, skip it and pass them:

   ```
   node track/build.js --pbf ~/rail-map-refdata/osm/united-kingdom-261102.osm.pbf \
                       --naptan ~/rail-map-refdata/naptan-rail.csv --out ~/rail-map-refdata/track-out
   ```

2. It prints each stage and ends with the pack path. About 40 seconds and 400-500 MB RSS on a 2024 laptop.
   Outputs in `--out`:

   | file | what |
   | --- | --- |
   | `track-pack-<yyyymmdd>.bin` | the pack (date = the OSM extract's date; `--date` overrides) |
   | `track-pack-<yyyymmdd>.manifest.json` | source dates, counts, section sizes, timings, SHA-256 of the pack |
   | `network-lo-<yyyymmdd>.geojson.gz`, `network-hi-<yyyymmdd>.geojson.gz` | the overview layers (also inside the pack) |

   Options: `--tolerance 1.0` (polyline simplification in metres, at most 2), `--lo-tolerance 100`,
   `--hi-tolerance 15`.

3. The builder reads the pack back through the runtime reader and refuses to finish if it differs from what
   it built.

## What it does

1. **Extract** (`lib/osm-extract.js`): two passes, each inflating only the blobs it needs. Pass A reads the
   ways (`railway=rail`, `light_rail`, and `platform` / `platform_edge` for station platforms); pass B reads the
   coordinates of exactly those nodes plus every `railway=signal` node and the crossing nodes.
2. **Graph** (`lib/graph.js`): split ways at junctions. A node shared by two ways is a junction, except a
   `railway=railway_crossing` / `diamond_crossing` node with no `railway:switch` (the tracks cross, they do not
   connect). Edges keep class (main, branch, siding, yard, crossover, other), electrification, maxspeed, name, ref,
   track ref, and a **tunnel flag that is metadata only** (`tunnel=*`, `covered=yes`, `layer<0`): tunnels are
   ordinary track in the graph and in the overview. **Stitch** dangling ends: an end within 1 m of another running
   edge is joined to it, but only on the SAME level (tunnel, bridge and `layer` must all agree), so a flyover or
   dive-under is never joined to the line it crosses; the builder logs every join and every refusal in the manifest
   (`stitches`; `--no-stitch` turns it off for comparison). Simplify to 1 m. Drop components under 200 m and
   light-rail components that touch no `railway=rail`.
3. **Stations** (`lib/stations.js`): primary snap = nearest running edge (not siding, yard or crossover) within
   300 m of the NaPTAN point; platform snaps from OSM platforms alongside the track and from track ways carrying a
   platform number. Unsnapped stations are listed in the manifest.
4. **Signals** (`lib/signals.js`): `railway=signal` nodes with a `ref`, snapped to an edge (exactly, when the node
   is a vertex of the way; otherwise nearest within 25 m, with a side of track).
5. **Overview** (`lib/network.js`): every running line (main and branch, tunnels included) chained through
   degree-2 nodes and simplified at two levels: **lo** about 100 m (zoom 7 and below) and **hi** about 15 m
   (zoom 8 to 11).

## Runtime library

```js
const { loadPack } = require('./src/track');
const pack = loadPack('track-pack-20261102.bin');
const snap = pack.nearestOnTrack(50.8357, -0.2053, { maxDist: 300, avoidSidings: true });
const route = pack.route(pack.station('HASOCKS').snaps, pack.station('PRSP').snaps, { avoidSidings: true });
pack.pointAt(route, 4000);            // {lat, lon, bearing}
pack.slice(route, 1000, 2000);        // [[lat, lon], ...]
pack.network('lo');                   // gzip bytes of the overview, read from disk on demand; pack.sha256() is its ETag
```

**Route between stations with `pack.stationSnaps(name or TIPLOC)`, not between two single snaps.** It returns every
platform-track snap of every TIPLOC of the station (NaPTAN gives Clapham Junction five TIPLOCs, London Bridge two, each
with only its own half of the platforms). Routing from one snap on one track is direction-blind: the primary snap is
the track nearest the NaPTAN point, not the one the train uses, and between two such snaps the shortest path that
needs no reversal can be very long (Clapham Junction to Victoria came out at 33 km, against 4.4 km published; seven of
the 24 test pairs were wrong by 3 to 16 times). With the arrays all 24 are within 10% of the published rail distance
(`test/track-pairs.js`, distances from the ELR mileage tables at railwaycodes.org.uk).

`route()` takes a snap or an array of snaps at either end and returns the
shortest by length, or `null`. It does not allow a heel-to-heel turn at a junction or a reversal along the track
just used (`maxDeflection`, default 100 degrees); pass `maxDeflection: 180` for a move that needs a reversal. 100 is
measured, not guessed: across the whole graph continuing track turns at most 20 degrees at its 99.9th percentile
(the only degree-2 nodes above 100 are 18 siding and yard hairpins), a through route at a three-way junction at most
7 degrees at the 99th, and a heel-to-heel move is 150 degrees or more. All 24 test pairs, and 24,384 station pairs in
SE England, give identical routes at 100, 120, 135 and 150, so the limit sits in an empty gap and decides nothing
on real running track; it only forbids reversals.

Measure it on a real pack (`--expose-gc` for clean memory figures):
`node --expose-gc track/measure.js ~/rail-map-refdata/track-out/track-pack-20261102.bin`.

## Tests and fixture

`node --test test/track.test.js` (offline, 0.2 s). Most tests write a small real PBF with `test/track-synth.js`
and run the builder's own pipeline on planted ways with known answers; the rest use two cuts of the real pack:
`test/fixtures/track-sussex.bin` (31 KB: Hove, Brighton, Preston Park, Hassocks, Clayton Tunnel) and
`test/fixtures/track-routes.bin.gz` (229 KB gzipped: 15 m either side of the shortest route between each of the 24
station pairs of `test/track-pairs.js`, for the route-accuracy regression). Regenerate them after a format, snapping
or graph change:

```
node track/make-fixture.js box    ~/rail-map-refdata/track-out/track-pack-<date>.bin test/fixtures/track-sussex.bin
node track/make-fixture.js routes ~/rail-map-refdata/track-out/track-pack-<date>.bin test/fixtures/track-routes.bin.gz
```

## Visual proof

```
cd track && npm install            # playwright-core only; needs Google Chrome
node viz/render.js ~/rail-map-refdata/track-out/track-pack-<date>.bin ~/rail-map-refdata/track-visual
```

Renders the graph, station snaps, signals, junction nodes (black) and dead ends (red) over OpenFreeMap for
Brighton, Portslade-Shoreham, Clapham Junction, the Marshlink, central Glasgow, Clayton Tunnel and the London
core tunnels, then both overview levels over SE England at zoom 6, 8 and 10, and checks that East Grinstead,
Uckfield, Caterham, the Marshlink and the Arun Valley are on each level.

## How a release is published

`.github/workflows/track-pack.yml` runs monthly (03:17 UTC on the 2nd) and on demand (Actions tab, "Run
workflow", optional `date`). It runs the track tests, downloads the two public inputs, builds, smoke-checks the pack
with `measure.js`, then creates (or refreshes) a GitHub Release tagged `track-pack-<yyyymmdd>` with the pack, the
manifest and the two overview files as assets. It needs no secrets: only the workflow's own `GITHUB_TOKEN`
(contents: write) to create the release. The service downloads the `.bin` from the latest `track-pack-*` release;
SMART never leaves the server.
