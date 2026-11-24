'use strict';
// A crossing's learned routes, ready for the engine (docs/berth-first-v1-plan.md §2; design §5.1, §5.7).
//
// The routes file is written by tools/learn-routes.js (config/crossings/<id>.routes.json). This turns it
// into what the tracker and the engine ask of it:
//   - which berths two areas both describe (one physical berth, two names), named by the crossing's own
//     area, so a train is one entry however many areas report it;
//   - each direction's clear step, in those names;
//   - where a berth sits on the routes in: how many berths from the clear step, so a step can be told
//     apart as towards the crossing or away from it (a train backing out of the approach, as test train
//     3S93 did on 27 Oct, design §4 transition 7).
// Nothing here is measured; every number in it came from the routes file, which carries its provenance.

function compileRoutes(routes) {
  if (!routes || !Array.isArray(routes.areas)) throw new Error('routes: not a routes file (no areas)');
  const preferArea = routes.areas[0];
  const canonMap = new Map();
  const sameBerths = [];
  for (const [keep, others] of (routes.sameBerths && routes.sameBerths.list) || []) {
    for (const o of others) { canonMap.set(o, keep); sameBerths.push([keep, o]); }
  }
  const canon = key => canonMap.get(key) || key;

  const dirs = Object.keys(routes.directions || {});
  const clears = [];
  const steps = new Set();      // every berth-to-berth step on a learned route, as 'from>to'
  const toClear = {};           // dir → Map(berth → fewest berths to the clear step's from-berth)
  const typical = {};           // dir → Map(berth → typical seconds in it: the median of its commonest class)
  const nextOf = {};            // dir → Map(berth → the berth after it on the commonest route through it)
  const stall = {};             // dir → Map(berth → stall threshold seconds: the routes file's p95, every class)
  const certain = {};           // dir → Set of berths from a route's last junction inward: every train there crosses
  const runThrough = {};        // dir → [{ station, berth, secs }]: less than `secs` in `berth` = running through `station`
  for (const d of dirs) {
    const x = routes.directions[d];
    const c = x.clear;
    if (!c) continue;
    const from = canon(`${c.area}:${c.from}`), to = canon(`${c.area}:${c.to}`);
    clears.push({ dir: d, from, to });
    const m = new Map([[from, 0], [to, -1]]);
    const paths = (x.routes || []).map(r => r.berths)
      .concat((x.startsPartWayIn || []).map(s => [s.berth]));       // a partial start is still on a route
    const tm = new Map();
    for (const [k, b] of Object.entries(x.berths || {})) {
      const cls = Object.values(b.timeInBerth || {}).filter(c => typeof c.p50 === 'number').sort((a, b2) => b2.n - a.n)[0];
      if (cls) tm.set(canon(k), cls.p50);
    }
    typical[d] = tm;
    const st = new Map();
    for (const [k, b] of Object.entries(x.berths || {})) {
      const th = b.stall && b.stall.all && b.stall.all.thresholdSecs;
      if (typeof th === 'number') st.set(canon(k), th);
    }
    stall[d] = st;
    const cs = new Set();
    for (const r of x.routes || []) {
      const ks = r.berths.map(canon);
      const from0 = r.lastJunction && r.lastJunction.certainFrom ? ks.indexOf(canon(r.lastJunction.certainFrom)) : -1;
      const iFrom = ks.lastIndexOf(canon(`${c.area}:${c.from}`));
      if (from0 >= 0 && iFrom >= from0) for (let i = from0; i <= iFrom; i++) cs.add(ks[i]);
    }
    certain[d] = cs;
    const nx = new Map();
    for (const r of (x.routes || []).slice().sort((a, b) => b.trains - a.trains)) {
      const ks = r.berths.map(canon);
      for (let i = 0; i + 1 < ks.length; i++) if (!nx.has(ks[i])) nx.set(ks[i], ks[i + 1]);
    }
    nextOf[d] = nx;
    // Run-through tests (design §5.5): the station's own berth (left sooner than any stopper does), and the
    // earlier berth learn-routes found that already shows it (Portslade east: Shoreham's 0010 for Southwick).
    const rt = [];
    for (const r of x.runThrough || []) {
      if (typeof r.thresholdSecs !== 'number') continue;
      rt.push({ station: r.station, berth: canon(r.berth), secs: r.thresholdSecs, kind: 'station' });
      const e = r.earlySignal;
      if (e && e.berth && typeof e.thresholdSecs === 'number') rt.push({ station: r.station, berth: canon(e.berth), secs: e.thresholdSecs, kind: 'earlier' });
    }
    runThrough[d] = rt;
    for (const p of paths) {
      const ks = p.map(canon);
      for (let i = 1; i < ks.length; i++) if (ks[i - 1] !== ks[i]) steps.add(`${ks[i - 1]}>${ks[i]}`);
      const iFrom = ks.lastIndexOf(from);
      if (iFrom < 0) continue;
      for (let i = 0; i <= iFrom; i++) {
        const n = iFrom - i;
        if (!m.has(ks[i]) || m.get(ks[i]) > n) m.set(ks[i], n);
      }
    }
    toClear[d] = m;
  }

  return {
    crossing: routes.crossing,
    areas: routes.areas.slice(),
    preferArea,
    sameBerths,
    canon,
    dirs,
    clears,
    // The steps trains take on the routes, so the tracker knows which berths adjoin before it has seen
    // a train make each one (a lost step needs to know what is one berth behind).
    steps: [...steps].map(k => k.split('>')),
    clearOf: d => clears.find(c => c.dir === d) || null,
    // Berths from the clear step on each direction's routes that `key` is on: { dir: n } (0 = the berth the
    // clear step leaves, -1 = the berth it enters).
    onRoute(key) {
      const k = canon(key), out = {};
      for (const d of dirs) if (toClear[d] && toClear[d].has(k)) out[d] = toClear[d].get(k);
      return out;
    },
    // Typical seconds from now until a train in `key` (there for `inBerthSecs`) makes direction d's clear
    // step: what is left of its typical time in this berth, then the typical time in each berth after it
    // on the commonest route. null when the berth is not on d's routes. An ESTIMATE for linking and for
    // trains the classic timing cannot place yet, never a closure time on its own.
    secsToClear(d, key, inBerthSecs = 0) {
      const m = toClear[d], tm = typical[d], nx = nextOf[d];
      if (!m) return null;
      let k = canon(key);
      if (!m.has(k) || m.get(k) < 0) return null;
      let secs = Math.max(0, (tm.get(k) || 0) - inBerthSecs);
      const clear = clears.find(c => c.dir === d);
      for (let guard = 0; k !== clear.from && guard < 200; guard++) {
        k = nx.get(k);
        if (!k) return null;
        secs += tm.get(k) || 0;
      }
      return secs;
    },
    // Seconds in `key` past which a train on direction d's routes is stalled (design §5.6; the routes
    // file's p95 of normal time in the berth, every class together), or null with too few trains.
    // Inside the last junction on direction d's routes: every train there goes on to cross (design §5.1).
    // Outside it a train counts only if its timetable or board entry says it will (D13).
    isCertain(d, key) { return !!(certain[d] && certain[d].has(canon(key))); },
    // The stations a train on direction d's routes has run through, from the berths it has left: its path
    // [[key, enteredAt], ...] (the first entry is where it was first seen, not a running time, so never tested).
    ranThrough(d, path) {
      const out = new Set();
      for (const t of runThrough[d] || []) {
        for (let i = 1; i + 1 < path.length; i++) {
          if (canon(path[i][0]) !== t.berth) continue;
          if ((path[i + 1][1] - path[i][1]) / 1000 < t.secs) out.add(t.station);
        }
      }
      return out;
    },
    stallSecs(d, key) { const m = stall[d]; return m && m.has(canon(key)) ? m.get(canon(key)) : null; },
    // +1 if a step from → to moves towards the crossing on direction d's routes, -1 if away from it, 0 if
    // either berth is off them.
    heading(d, from, to) {
      const m = toClear[d];
      if (!m) return 0;
      const a = m.get(canon(from)), b = m.get(canon(to));
      if (a === undefined || b === undefined || a === b) return 0;
      return b < a ? 1 : -1;
    }
  };
}

module.exports = { compileRoutes };
