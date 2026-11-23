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
  for (const d of dirs) {
    const x = routes.directions[d];
    const c = x.clear;
    if (!c) continue;
    const from = canon(`${c.area}:${c.from}`), to = canon(`${c.area}:${c.to}`);
    clears.push({ dir: d, from, to });
    const m = new Map([[from, 0], [to, -1]]);
    const paths = (x.routes || []).map(r => r.berths)
      .concat((x.startsPartWayIn || []).map(s => [s.berth]));       // a partial start is still on a route
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
