#!/usr/bin/env node
'use strict';
// Per-frame CPU cost of the motion engine for N tracked trains (default 1,500), no browser: the real
// store.fill, driving every train along real-shaped spans at 60 fps on a virtual clock.
//   node map/test/bench-engine.js [trains] [frames]
if (process.env.NODE_TEST_CONTEXT) { console.log('bench is not a unit test; run: node map/test/bench-engine.js'); process.exit(0); }
const motion = require('../motion.js');
const engine = require('../engine.js');
const { createSim } = require('../dev/mock-sim.js');

const N = Number(process.argv[2] || 1500), FRAMES = Number(process.argv[3] || 900);
const sim = createSim({ count: N, national: true, seed: 99 });
let now = Date.UTC(2026, 10, 3, 12, 0, 0);
sim.init(now);
const spans = { map: new Map(), peek(id) { let s = this.map.get(id); if (!s) { const raw = sim.span(id); s = raw && engine.prepareSpan(raw); if (s) this.map.set(id, s); } return s; }, need() {} };
const clock = { render: (t) => t - 10000 };
const store = motion.createStore({ spans, clock });
store.setView(true, null);
const wires = []; sim.TRAINS.forEach((t) => wires.push(sim.wireOf(t)));
store.applySnapshot(wires, now);
// warm up, and keep feeding updates as the mock's steps are delivered, like the stream does
const times = [];
let tracked = 0;
for (let f = 0; f < FRAMES + 120; f++) {
  now += 1000 / 60;
  if (f % 60 === 0) {
    sim.tick(now);
    const up = []; sim.TRAINS.forEach((t) => { if (t.ver > (t._sent || 0)) { up.push(sim.wireOf(t)); t._sent = sim.ver; } });
    store.applyUpdate(up, sim.takeRemoved(), now);
  }
  const a = process.hrtime.bigint();
  store.fill(now, null);
  const dt = Number(process.hrtime.bigint() - a) / 1e6;
  if (f >= 120) times.push(dt);
}
store.forEach((r) => { if (r.mode === 'track') tracked++; });
times.sort((x, y) => x - y);
const q = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
console.log(JSON.stringify({ trains: store.size, tracked, frames: times.length, fillMs: { p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), p99: +q(0.99).toFixed(3), max: +q(1).toFixed(3) }, budget60fps: 16.7, node: process.version }));
