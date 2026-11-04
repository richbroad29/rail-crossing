'use strict';

// OSM railway=signal nodes that carry a `ref`, snapped to edges, for contract section 9.3 (pinning a
// berth boundary where the signal ref matches the berth id).
//
// A signal mapped as a vertex of a track way is snapped to the edge it sits on (on-way: its
// railway:signal:direction is relative to that way's direction, which edges preserve). One mapped
// beside the track is snapped to the nearest edge within 25 m; its direction tag is meaningless there,
// so it is stored as unknown and its SIDE of the track is recorded instead (UK signals stand on the
// left of the line they govern, so side tells a consumer which way the signal faces).

const F = require('../../src/track/format');
const { kxAt, KY, DEG7 } = require('../../src/track/geom');
const { lowerBound } = require('./osm-extract');

const OFF_WAY_MAX_M = 25;

const KINDS = [['main', F.SIGKIND.MAIN], ['distant', F.SIGKIND.DISTANT], ['shunting', F.SIGKIND.SHUNTING], ['combined', F.SIGKIND.COMBINED], ['minor', F.SIGKIND.MINOR]];

function kindOf(tags) {
  let k = 0;
  for (const key of Object.keys(tags)) for (const [name, bit] of KINDS) if (key === 'railway:signal:' + name || key.startsWith('railway:signal:' + name + ':')) k |= bit;
  return k;
}

function snapSignals(pack, g, ex, strings, { log = () => {} } = {}) {
  const stats = { signalNodes: 0, withRef: 0, onWay: 0, snappedOnWay: 0, snappedOffWay: 0, unsnapped: 0, withDirection: 0, duplicateRefs: 0 };
  const rows = [];
  for (const s of ex.special) {
    if (s.tags.railway !== 'signal') continue;
    stats.signalNodes++;
    const ref = (s.tags.ref || '').trim();
    if (!ref) continue;
    stats.withRef++;
    const lat = s.lat * DEG7, lon = s.lon * DEG7;
    const wi = lowerBound(g.wanted, s.id);
    const onEdge = wi < g.wanted.length && g.wanted[wi] === s.id ? g.signalEdge.get(wi) : undefined;
    let snap = null, onWay = false;
    if (onEdge !== undefined && onEdge >= 0) { snap = pack.projectOnEdge(onEdge, lat, lon); if (snap && snap.dist <= 3) { onWay = true; stats.onWay++; } else snap = null; }
    if (!snap) snap = pack.nearestOnTrack(lat, lon, { maxDist: OFF_WAY_MAX_M });
    if (!snap) { stats.unsnapped++; continue; }
    if (onWay) stats.snappedOnWay++; else stats.snappedOffWay++;
    // side of the track, facing along the edge direction
    const kx = kxAt(s.lat);
    const sx = (s.lon - snap.lon / DEG7) * DEG7 * kx, sy = (s.lat - snap.lat / DEG7) * DEG7 * KY;
    const br = snap.bearing * Math.PI / 180;
    const cross = Math.sin(br) * sy - Math.cos(br) * sx;
    const side = snap.dist < 0.5 ? F.SIGSIDE.ON : cross > 0 ? F.SIGSIDE.LEFT : F.SIGSIDE.RIGHT;
    let dir = F.SIGDIR.UNKNOWN;
    const dtag = s.tags['railway:signal:direction'];
    if (onWay && dtag) { dir = dtag === 'forward' ? F.SIGDIR.FORWARD : dtag === 'backward' ? F.SIGDIR.BACKWARD : dtag === 'both' ? F.SIGDIR.BOTH : F.SIGDIR.UNKNOWN; if (dir) stats.withDirection++; }
    rows.push({ edge: snap.edge, offset: snap.offset, dist: snap.dist, lat: s.lat, lon: s.lon, ref, dir, side, kind: kindOf(s.tags) | (onWay ? F.SIGKIND.ON_WAY : 0) });
  }
  const refs = new Map();
  for (const r of rows) refs.set(r.ref, (refs.get(r.ref) || 0) + 1);
  stats.distinctRefs = refs.size;
  stats.duplicateRefs = [...refs.values()].filter(n => n > 1).length;
  log(`signals: ${stats.signalNodes} railway=signal nodes, ${stats.withRef} with a ref, ${rows.length} snapped (${stats.snappedOnWay} on-way, ${stats.snappedOffWay} beside track), ${stats.unsnapped} unsnapped, ${stats.distinctRefs} distinct refs`);
  const n = rows.length;
  const s = { SGEDGE: new Uint32Array(n), SGOFF: new Float32Array(n), SGDIST: new Float32Array(n), SGLAT: new Int32Array(n), SGLON: new Int32Array(n), SGREF: new Uint32Array(n), SGDIR: new Uint8Array(n), SGSIDE: new Uint8Array(n), SGKIND: new Uint8Array(n) };
  rows.forEach((r, i) => { s.SGEDGE[i] = r.edge; s.SGOFF[i] = r.offset; s.SGDIST[i] = r.dist; s.SGLAT[i] = r.lat; s.SGLON[i] = r.lon; s.SGREF[i] = strings.intern(r.ref); s.SGDIR[i] = r.dir; s.SGSIDE[i] = r.side; s.SGKIND[i] = r.kind; });
  return { sections: s, stats };
}

module.exports = { snapSignals };
