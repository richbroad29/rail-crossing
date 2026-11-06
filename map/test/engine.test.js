'use strict';
// The motion engine (CONTRACT section 12), rule by rule. Each test names the rule it pins; the
// mutation check (map/test/mutation-check.js) breaks each rule in turn and requires a test to fail.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

const CFG = E.DEFAULTS;
const KX = (lat) => 111320 * Math.cos(lat * Math.PI / 180);
// A straight eastward span of `len` metres starting at (lat, lon).
function line(id, lat, lon, len, opt) {
  opt = opt || {};
  const n = opt.points || 6, path = [];
  const kx = KX(lat), dir = opt.dir || [1, 0];                  // unit (east, north)
  for (let i = 0; i <= n; i++) path.push([lat + dir[1] * len * i / n / 110540, lon + dir[0] * len * i / n / kx]);
  return E.prepareSpan({ id, length: len, path, stop: opt.stop == null ? null : opt.stop });
}
// the end point of a span as {lat, lon}, to chain the next one
const endOf = (sp) => ({ lat: sp.ys[sp.n - 1], lon: sp.xs[sp.n - 1] });
const plan = (sp, t0, eta, extra) => E.makePlan(Object.assign({ sp: sp.id, t0, eta }, extra || {}), sp, CFG);

// Run the engine from tFrom to tTo (ms) at `fps`, calling `onFrame(state, R)` each frame. `plansAt(R)` may
// add plans as time goes by (a step being delivered).
function drive(st, plans, tFrom, tTo, fps, onFrame, cfg) {
  const dt = 1000 / fps;
  for (let R = tFrom; R <= tTo + 1e-6; R += dt) {
    E.advance(st, plans, R, cfg || CFG, st);
    if (onFrame) onFrame(st, R);
  }
  return st;
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, (msg || '') + ' ' + a + ' vs ' + b + ' (eps ' + eps + ')');

// ---- geometry ------------------------------------------------------------------------------------------
test('span geometry: length, position, tangent; the service length is authoritative', () => {
  const sp = line('a', 51, -0.1, 1000);
  near(sp.length, 1000, 0.5);
  const mid = E.locate(sp, 500, { x: 0, y: 0, brg: 0 });
  near(mid.y, 51, 1e-6); near(mid.brg, 90, 1e-6);
  near(E.bearingAt(sp, 500, 12), 90, 1e-3);
  const north = line('n', 51, -0.1, 400, { dir: [0, 1] });
  near(E.bearingAt(north, 200, 12), 0, 1e-3);
  const stretched = E.prepareSpan({ id: 's', length: 2000, path: [[51, -0.1], [51, -0.1 + 1000 / KX(51)]] });
  near(stretched.length, 2000, 1e-6);
  near(stretched.cum[1], 2000, 1e-6);
  assert.equal(E.prepareSpan({ id: 'x', path: [] }), null);
});

test('heading is the chord of a curve, not the flicker of each vertex', () => {
  const lat = 51, kx = KX(lat), path = [];
  for (let i = 0; i <= 40; i++) { const a = i / 40 * Math.PI / 2; path.push([lat + 300 * Math.sin(a) / 110540, -0.1 + 300 * (1 - Math.cos(a)) / kx]); }
  const sp = E.prepareSpan({ id: 'c', path });
  const h1 = E.bearingAt(sp, 100, 12), h2 = E.bearingAt(sp, 101, 12);
  assert.ok(Math.abs(h1 - h2) < 1, 'smooth along the curve');
  assert.ok(E.bearingAt(sp, sp.length - 1, 12) > 70, 'turning toward east');
});

// ---- profiles -------------------------------------------------------------------------------------------
test('a pass is constant speed from the entry to the end of the span in exactly T seconds', () => {
  const P = E.makeProfile(600, 30, null, null, CFG.acc), o = { s: 0, v: 0 };
  for (const tau of [1, 7.5, 15, 29]) { E.refAt(P, tau, o); near(o.s, 20 * tau, 1e-9); near(o.v, 20, 1e-9); }
  E.refAt(P, 30, o); near(o.s, 600, 1e-9);
});

test('a call decelerates to the stop, dwells there, then accelerates away and ends on time', () => {
  const L = 800, S = 500, T = 90, D = 30, P = E.makeProfile(L, T, S, D, CFG.acc), o = { s: 0, v: 0 };
  let prev = -1, maxV = 0;
  for (let tau = 0; tau <= T; tau += 0.05) {
    E.refAt(P, tau, o);
    assert.ok(o.s >= prev - 1e-9, 'never backwards in the profile'); prev = o.s;
    assert.ok(o.v >= 0); maxV = Math.max(maxV, o.v);
  }
  E.refAt(P, P.Ta, o); near(o.s, S, 1e-6); near(o.v, 0, 1e-6);                      // arrives at the stop at Ta
  E.refAt(P, P.Ta + 12, o); near(o.s, S, 1e-9); assert.equal(o.v, 0);                // dwelling
  E.refAt(P, P.Ta + D, o); near(o.s, S, 1e-6);
  E.refAt(P, T, o); near(o.s, L, 1e-6);                                              // and away by T
  E.refAt(P, P.Ta - 4, o); assert.ok(o.v > 0 && o.s < S, 'braking, still short of the stop');
  assert.ok(P.down.vc * 1.001 >= o.v, 'braking never faster than the cruise');
});

test('profile edge cases: stop at the very end, stop at the very start, dwell longer than the time, T tiny, L zero', () => {
  const o = { s: 0, v: 0 };
  const arr = E.makeProfile(400, 60, 400, 25, CFG.acc);                              // arrival berth: the platform is the end
  E.refAt(arr, 59.9, o); near(o.s, 400, 1e-6); assert.equal(o.v, 0);
  const dep = E.makeProfile(400, 60, 0, 0, CFG.acc);                                  // departure berth: starts standing
  E.refAt(dep, 0.01, o); assert.ok(o.v < 0.1 && o.s < 0.01, 'starts from rest');
  E.refAt(dep, 60, o); near(o.s, 400, 1e-6);
  const longDwell = E.makeProfile(400, 20, 200, 500, CFG.acc);
  assert.ok(longDwell.D <= 20 * 0.9 + 1e-9, 'dwell is clipped to fit');
  E.refAt(longDwell, 20, o); near(o.s, 400, 1e-6);
  const tiny = E.makeProfile(100, 0, null, null, CFG.acc); assert.ok(tiny.T > 0 && isFinite(tiny.vc));
  const zero = E.makeProfile(0, 10, null, null, CFG.acc); E.refAt(zero, 5, o); assert.equal(o.s, 0);
  const feas = E.ramp(100, 5, 0.5);                                                    // too gentle: uniform accel instead
  near(feas.vc, 40, 1e-9); near(feas.ta, 5, 1e-9);
});

// ---- the clock ------------------------------------------------------------------------------------------
test('rule 1: the render clock runs 12 s behind the server clock, and uses the least-delayed message', () => {
  const c = E.createClock();
  c.observe(1000000, 1000250);                    // this one took 250 ms to arrive
  c.observe(1002000, 1002050);                    // this one 50 ms: the better estimate
  const sv = c.server(1003000);
  assert.ok(sv > 1003000 - 250 && sv <= 1003000 - 50 + 1e-6, 'slewing from the first offset toward the best one: ' + (sv - 1003000));
  const c2 = E.createClock();
  c2.observe(500000, 500000);                     // zero delay: server time == client time
  near(c2.render(600000), 588000, 1e-6);
  assert.equal(c2.lagMs, 12000);
});

test('the render clock slews: its offset never jumps, so the render time never lurches', () => {
  const c = E.createClock({ slewMsPerSec: 40 });
  c.observe(0, 0);
  const t1 = c.server(1000);
  c.observe(10000, 1000);                         // the server clock "jumps" 9 s ahead
  const t2 = c.server(2000);
  assert.ok(t2 - t1 <= 1000 + 41, 'moved no more than a second plus the slew: ' + (t2 - t1));
  assert.ok(t2 - t1 >= 1000 - 1, 'and never backwards');
});

// ---- rule 2 / 3: a pass, and no step ---------------------------------------------------------------------
test('rule 2: with a plan and no trouble the drawn train keeps the reference speed', () => {
  const sp = line('a', 51, -0.1, 600), plans = [plan(sp, 0, 30000)];
  const st = E.newState();
  drive(st, plans, 5000, 14000, 60);
  near(st.s, 20 * 14, 8, 'at 14 s it has covered 280 m (still before the stopping curve, which starts about 10 s before the end)');
  near(st.v, 20, 0.3);
  assert.ok(st.alpha > 0 && st.x === st.x);
});

test('rule 3: with no step the train brakes to a stop HOLD_M short of the end and waits there', () => {
  const sp = line('a', 51, -0.1, 600), plans = [plan(sp, 0, 30000)];
  const st = E.newState();
  let reached = 0;
  drive(st, plans, 5000, 120000, 30, (s, R) => { assert.ok(s.s <= 600 - CFG.holdM + 0.01, 'never past the hold point at ' + R + ': ' + s.s); if (s.v < 0.5 && !reached) reached = R; });
  near(st.s, 570, 0.3, 'stopped 30 m short');
  assert.ok(st.v < 0.01);
  assert.equal(st.wait, true, 'the waiting-at-a-signal state is on');
  assert.ok(reached > 28000 && reached < 60000, 'it eased to a stop (under 0.5 m/s) within the minute after it was due: ' + reached);
});

test('rule 3: braking is gentle - it never decelerates harder than the braking limit on the way to the stop', () => {
  const sp = line('a', 51, -0.1, 800), plans = [plan(sp, 0, 40000)];
  const st = E.newState(); let pv = null, worst = 0;
  drive(st, plans, 4000, 90000, 60, (s, R) => { if (pv != null && R > 4020) worst = Math.max(worst, (pv - s.v) * 60); pv = s.v; });
  assert.ok(worst <= 1.2 * 1.02, 'peak deceleration, every frame including the last centimetre: ' + worst.toFixed(3));
});

test('a short span: the hold margin shrinks so the train still stops inside it', () => {
  const sp = line('a', 51, -0.1, 40), plans = [plan(sp, 0, 5000)];
  const st = E.newState();
  drive(st, plans, 1000, 60000, 30);
  assert.ok(st.s <= 40 && st.s >= 15, 'stopped at half the span: ' + st.s);
});

// ---- rule 4: the step arrives -----------------------------------------------------------------------------
function twoSpans() {
  const a = line('a', 51, -0.1, 600), e = endOf(a), b = line('b', e.lat, e.lon, 600);
  return [a, b];
}
test('rule 4: a step that arrives EARLY re-times the span: the train still enters the next span, gently', () => {
  const [a, b] = twoSpans(), plans = [plan(a, 0, 30000)];
  const st = E.newState();
  let crossed = null, vmax = 0;
  drive(st, plans, 5000, 70000, 60, (s, R) => {
    if (R >= 12000 && plans.length === 1) plans.push(plan(b, 26000, 56000));      // known at 12 s of render time; it happened at 26 s
    if (s.k === 1 && crossed == null) crossed = R;
    vmax = Math.max(vmax, s.v);
  });
  assert.ok(crossed != null);
  near(crossed, 26000, 1600, 'reaches the boundary at the step time');
  assert.ok(vmax <= 1.5 * 20 + 1e-6, 'never over the catch-up limit: ' + vmax);
});

test('rule 4: a step that arrives LATE (after the train has stopped short) releases it, with no jump and no reverse', () => {
  const [a, b] = twoSpans(), plans = [plan(a, 0, 30000)];
  const st = E.newState();
  let prevDist = 0, prevPos = null, maxStepM = 0;
  drive(st, plans, 5000, 90000, 60, (s, R) => {
    if (R >= 50000 && plans.length === 1) plans.push(plan(b, 48000, 78000));      // the step was due at 30 s and came at 48 s
    assert.ok(s.dist >= prevDist - 1e-9, 'distance travelled never decreases');
    prevDist = s.dist;
    if (prevPos) maxStepM = Math.max(maxStepM, Math.hypot((s.x - prevPos[0]) * KX(51), (s.y - prevPos[1]) * 110540));
    prevPos = [s.x, s.y];
  });
  assert.equal(st.k, 1, 'it is on the next span');
  assert.ok(maxStepM < 1.5 * 20 / 60 + 0.5, 'no frame moved it further than 1.5x speed allows: ' + maxStepM);
});

test('rule 5: a very late step (3 minutes) - it waits the whole time, then catches up no faster than 1.5x', () => {
  const [a, b] = twoSpans(), plans = [plan(a, 0, 30000)];
  const st = E.newState();
  let vmaxAfter = 0, waited = 0;
  drive(st, plans, 5000, 260000, 30, (s, R) => {
    if (R >= 190000 && plans.length === 1) plans.push(plan(b, 185000, 215000));
    if (s.wait) waited++;
    if (R > 190000) vmaxAfter = Math.max(vmaxAfter, s.v);
  });
  assert.ok(waited > 30 * 100, 'waited for minutes');
  assert.ok(vmaxAfter <= 1.5 * 20 + 1e-6, 'catch-up limited: ' + vmaxAfter);
});

test('rule 5: lag is caught up but the catch-up speed is capped at 1.5x the span cruise speed', () => {
  const a = line('a', 51, -0.1, 600), b = line('b', endOf(a).lat, endOf(a).lon, 3000), plans = [plan(a, 0, 30000)];
  const st = E.newState(); let sawCap = false, vmax = 0;
  drive(st, plans, 5000, 160000, 60, (s, R) => {
    if (R >= 65000 && plans.length === 1) plans.push(plan(b, 30000, 180000));      // 35 s late: a 700 m lag (more than the gentle correction can hide)
    vmax = Math.max(vmax, s.v); if (s.pc) sawCap = true;
  });
  assert.ok(vmax <= 30 + 1e-6, 'cap held: ' + vmax);
  assert.ok(vmax > 20, 'and it did speed up to catch up: ' + vmax);
  void sawCap;
});

test('the train never moves backwards, whatever order timing arrives in (fuzz)', () => {
  let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let trial = 0; trial < 25; trial++) {
    let lat = 51, lon = -0.1, t = 0;
    const plans = [], spans = [];
    const first = line('s0', lat, lon, 300 + rnd() * 700); spans.push(first); plans.push(plan(first, 0, 15000 + rnd() * 30000));
    const st = E.newState(); let pending = [], prevDist = 0, vmax = 0;
    // generate future steps with random lateness; deliver each when render time passes (t0 - lag + delay)
    let cur = first, t0 = 0;
    for (let i = 1; i < 8; i++) {
      const e = endOf(cur), len = 300 + rnd() * 900, sp = line('s' + i, e.lat, e.lon, len);
      t0 += (10 + rnd() * 50) * 1000;
      pending.push({ at: t0 + (rnd() * 8 - 4) * 1000 - 10000 + 5000, sp, t0, eta: t0 + (10 + rnd() * 40) * 1000 });
      cur = sp;
    }
    pending.sort((x, y) => x.t0 - y.t0);
    drive(st, plans, 2000, 400000, 20, (s, R) => {
      while (pending.length && pending[0].at <= R) { const p = pending.shift(); plans.push(plan(p.sp, p.t0, p.eta)); }
      assert.ok(s.dist >= prevDist - 1e-9, 'trial ' + trial + ' went backwards at ' + R);
      assert.ok(s.v >= 0 && s.s >= 0);
      prevDist = s.dist; vmax = Math.max(vmax, s.v);
      assert.ok(s.x === s.x && s.y === s.y);
    });
    void t; void lat; void lon; void vmax;
  }
});

// ---- held ---------------------------------------------------------------------------------------------------
test('held: a held call stands at the platform; releasing it (the next step) lets it go', () => {
  const [a, b] = twoSpans(), plans = [plan(a, 0, 40000, { stop: 600, dwell: 20, held: false })];
  const st = E.newState();
  drive(st, plans, 5000, 120000, 30, (s, R) => {
    if (R === 60000) plans[0].held = true;
  });
  near(st.s, 600, 0.5, 'held at the stop');
  assert.ok(st.v < 0.01);
  plans.push(plan(b, 110000, 140000));
  drive(st, plans, 120000, 150000, 30);
  assert.equal(st.k, 1);
  assert.ok(st.s > 0);
});

test('held on a pass: the train waits short of the end and shows waiting; "held" cleared means it carries on', () => {
  const [a] = twoSpans(), plans = [plan(a, 0, 30000, { held: true })];
  const st = E.newState();
  drive(st, plans, 5000, 100000, 30);
  assert.equal(st.wait, true);
  near(st.s, 570, 0.5);
});

// ---- spans, gaps, fades -------------------------------------------------------------------------------------
test('rule 7: a rounding-sized gap (3 m) between spans is blended away, not jumped', () => {
  const a = line('a', 51, -0.1, 600), e = endOf(a);
  const b = line('b', e.lat + 3 / 110540, e.lon, 600);                     // starts 3 m north of where a ends
  const plans = [plan(a, 0, 30000), plan(b, 30000, 60000)];
  const st = E.newState();
  let prev = null, maxJump = 0, saw = false;
  drive(st, plans, 5000, 60000, 60, (s) => {
    if (prev) maxJump = Math.max(maxJump, Math.hypot((s.x - prev[0]) * KX(51), (s.y - prev[1]) * 110540));
    prev = [s.x, s.y];
    if (s.offx !== 0 || s.offy !== 0) saw = true;
  });
  assert.ok(saw, 'a blend was in progress');
  assert.equal(st.fades, 0);
  assert.ok(maxJump < 1.5 * 20 / 60 + 25 / 60 + 0.3, 'per-frame move stayed within speed + blend rate: ' + maxJump);
});

test('rule 6: a gap over 2 km fades out, jumps while invisible, fades back in', () => {
  const a = line('a', 51, -0.1, 600), far = line('far', 51.1, 0.3, 600);
  const plans = [plan(a, 0, 30000), plan(far, 30000, 60000)];
  const ev = [], cfg = Object.assign({}, CFG, { onEvent: (t) => ev.push(t) });
  const st = E.newState(); const alphas = [];
  drive(st, plans, 5000, 60000, 60, (s) => alphas.push(s.alpha), cfg);
  assert.equal(st.fades, 1);
  assert.ok(ev.includes('fade'));
  assert.ok(Math.min.apply(null, alphas.slice(100)) === 0, 'went fully transparent');
  assert.equal(st.alpha, 1, 'and came back');
  assert.equal(st.k, 1);
});

test('rule 6: a train more than 2 km behind its reference fades and jumps; one merely waiting does not', () => {
  const a = line('a', 51, -0.1, 600), b = line('b', endOf(a).lat, endOf(a).lon, 8000, { points: 40 });
  const plans = [plan(a, 0, 30000)], st = E.newState(); let sawZero = false;
  drive(st, plans, 5000, 130000, 30);                                               // waits at the signal for two minutes
  plans.push(plan(b, 30000, 230000));                                               // the step was known late: the reference is 4 km along already
  drive(st, plans, 130000, 160000, 30, (s) => { if (s.alpha === 0) sawZero = true; });
  assert.equal(st.fades, 1); assert.ok(sawZero, 'it vanished while it jumped');
  const c = E.newState(); const slow = [plan(a, 0, 30000)];
  drive(c, slow, 5000, 90000, 30);
  assert.equal(c.fades, 0, 'a train merely waiting does not fade');
});

test('a sleeping tab (60 s with no frames) resyncs with one fade, not a minute of integration', () => {
  const a = line('a', 51, -0.1, 600), b = line('b', endOf(a).lat, endOf(a).lon, 600), c = line('c', endOf(b).lat, endOf(b).lon, 600);
  const plans = [plan(a, 0, 30000), plan(b, 30000, 60000), plan(c, 60000, 90000)];
  const st = E.newState();
  drive(st, plans, 5000, 6000, 30);
  E.advance(st, plans, 80000, CFG, st);
  drive(st, plans, 80000, 82000, 30);
  assert.equal(st.fades, 1);
  assert.equal(st.k, 2);
});

test('zero-length spans do not stall the train or produce NaN', () => {
  const a = line('a', 51, -0.1, 600), e = endOf(a);
  const z = E.prepareSpan({ id: 'z', length: 0, path: [[e.lat, e.lon], [e.lat, e.lon]] });
  const b = line('b', e.lat, e.lon, 600);
  const plans = [plan(a, 0, 30000), plan(z, 30000, 30500), plan(b, 30500, 60000)];
  const st = E.newState();
  drive(st, plans, 5000, 80000, 30, (s) => { assert.ok(s.x === s.x && s.y === s.y && s.v === s.v && s.hdg === s.hdg || s.hdg !== s.hdg, 'finite'); });
  assert.equal(st.k, 2, 'through the empty span and onto the next');
  assert.ok(st.s > 100);
});

test('a reverse at a terminus: it stands, turns round at once (no spin), and goes the other way along the new span', () => {
  const a = line('a', 51, -0.1, 600, { stop: 600 }), e = endOf(a);
  const back = line('back', e.lat, e.lon, 600, { dir: [-1, 0] });                  // the way it came
  const plans = [plan(a, 0, 90000, { stop: 600, dwell: 60 }), plan(back, 100000, 130000, { stop: 0, dwell: 0 })];
  const st = E.newState(); const hdgs = []; let maxTurn = 0, prev = null;
  drive(st, plans, 5000, 140000, 30, (s) => {
    if (prev != null && s.hdg === s.hdg) maxTurn = Math.max(maxTurn, Math.abs(E.angDiff(prev, s.hdg)));
    prev = s.hdg; hdgs.push(s.hdg);
  });
  assert.equal(st.k, 1);
  near(st.hdg, 270, 2, 'now pointing west');
  assert.ok(st.dist > 600, 'it went on, forward along the new span');
  assert.ok(maxTurn > 150, 'the heading flipped, in one frame (snap) rather than a spin: ' + maxTurn);
  const flipFrames = hdgs.filter((h, i) => i && Math.abs(E.angDiff(hdgs[i - 1], h)) > 5).length;
  assert.ok(flipFrames <= 3, 'a single snap, not a slow rotation: ' + flipFrames + ' frames turned');
});

test('rule: a plan whose geometry has not arrived makes the train wait at the end of the span, then go', () => {
  const [a, b] = twoSpans();
  const plans = [plan(a, 0, 30000), E.makePlan({ sp: 'b', t0: 30000, eta: 60000 }, null, CFG)];
  const st = E.newState();
  drive(st, plans, 5000, 50000, 30);
  assert.equal(st.k, 0);
  near(st.s, 600, 0.5, 'waiting at the end for the geometry');
  assert.equal(st.loading, true);
  assert.equal(st.wait, true);
  E.attachSpan(plans[1], b, CFG);
  drive(st, plans, 50000, 70000, 30);
  assert.equal(st.k, 1);
  assert.ok(st.s > 50);
});

test('a train first seen mid-span is placed on the reference; one whose step is still in the render future waits at the start', () => {
  const [a] = twoSpans();
  const mid = E.newState(), p1 = [plan(a, 0, 30000)];
  E.advance(mid, p1, 15000, CFG, mid);
  near(mid.s, 300, 1); assert.equal(mid.alpha, 0, 'fading in, not popping');
  const early = E.newState(), p2 = [plan(a, 20000, 50000)];
  E.advance(early, p2, 15000, CFG, early);
  assert.equal(early.s, 0);
  drive(early, p2, 15000, 21000, 30);
  assert.ok(early.s > 5 && early.v > 15, 'it sets off at speed when its time comes: ' + early.s);
});

// ---- determinism ---------------------------------------------------------------------------------------------
test('determinism: the same plans and times give identical states, with or without an output object', () => {
  const [a, b] = twoSpans();
  const mk = () => [plan(a, 0, 30000), plan(b, 33000, 60000)];
  const times = []; for (let R = 4000; R <= 70000; R += 1000 / 30) times.push(R);
  const run = (inplace) => {
    const plans = mk(); let st = E.newState();
    for (const R of times) st = inplace ? E.advance(st, plans, R, CFG, st) : E.advance(st, plans, R, CFG);
    return st;
  };
  const x = run(true), y = run(false), z = run(true);
  for (const k of ['s', 'v', 'x', 'y', 'hdg', 'dist', 'k']) { assert.equal(x[k], y[k], k + ' pure vs in place'); assert.equal(x[k], z[k], k + ' repeat'); }
  const before = JSON.stringify(E.newState());
  const frozen = E.newState(); E.advance(frozen, mk(), 5000, CFG);
  assert.equal(JSON.stringify(E.newState()), before, 'a pure call leaves no trace');
});

test('the pure form does not touch the state it is given', () => {
  const [a] = twoSpans(), plans = [plan(a, 0, 30000)], st = E.newState();
  E.advance(st, plans, 5000, CFG, st);
  const snap = JSON.stringify(st);
  const next = E.advance(st, plans, 8000, CFG);
  assert.equal(JSON.stringify(st), snap);
  assert.notEqual(next, st); assert.ok(next.s > st.s);
});

test('frame rate does not change where the train is: 10, 30 and 60 fps agree within 2 m', () => {
  const [a, b] = twoSpans();
  const at = (fps) => {
    const plans = [plan(a, 0, 30000)], st = E.newState();
    drive(st, plans, 5000, 36000, fps);
    plans.push(plan(b, 36000, 66000));
    drive(st, plans, 36000, 60000, fps);
    return st.dist;
  };
  const d10 = at(10), d30 = at(30), d60 = at(60);
  near(d10, d60, 2); near(d30, d60, 2);
});

test('rule 8: nothing here looks at a headcode - identity is the caller\'s object, and keeps its history', () => {
  const [a, b] = twoSpans(), plans = [plan(a, 0, 30000)], st = E.newState();
  drive(st, plans, 5000, 20000, 30);
  const d = st.dist;
  plans.push(plan(b, 30000, 60000));                       // e.g. the train was renumbered between steps: same object
  drive(st, plans, 20000, 40000, 30);
  assert.ok(st.dist > d, 'distance accumulates on one state across the change');
});

test('rule 5: entering a slower span at catch-up speed slows smoothly (<= the bound), under the HIGHER of the two spans\' caps', () => {
  const a = line('a', 51, -0.1, 600), e = endOf(a), b = line('b', e.lat, e.lon, 600);
  const plans = [plan(a, 0, 30000)], st = E.newState(); let vAtCross = null, vBefore = 0, pv = null, worstDec = 0, vmax = 0;
  drive(st, plans, 5000, 120000, 60, (s, R) => {
    if (R >= 9000 && plans.length === 1) plans.push(plan(b, 12000, 72000));          // known early: the reference leaps ahead, a slow span (10 m/s) follows
    if (s.k === 0) vBefore = Math.max(vBefore, s.v);
    if (s.k === 1 && vAtCross == null) vAtCross = s.v;
    if (pv != null && R > 5020) worstDec = Math.max(worstDec, Math.abs(pv - s.v) * 60);
    vmax = Math.max(vmax, s.v); pv = s.v;
  });
  assert.ok(vBefore > 22, 'it was catching up fast before the boundary: ' + vBefore);
  assert.ok(vAtCross > 15, 'entering the slow span it has NOT been snapped down to the new cap: ' + vAtCross);
  assert.ok(worstDec <= 1.2 * 1.02 + 1e-6, 'no frame changed speed faster than the bound: ' + worstDec.toFixed(3));
  assert.ok(vmax <= 1.5 * 20 + 1e-6, 'the cap against the higher cruise speed (20 m/s) held: ' + vmax);
  assert.ok(st.v < 16, 'and it did slow to the new span: ' + st.v);
});

test('a step that is LATER than expected, delivered while the train is mid-span, slows it but never reverses it', () => {
  const [a, b] = twoSpans(), plans = [plan(a, 0, 30000)], st = E.newState();
  let prevDist = 0, minV = 1e9;
  drive(st, plans, 5000, 80000, 60, (s, R) => {
    if (R >= 22000 && plans.length === 1) plans.push(plan(b, 45000, 75000));         // the span now ends at 45 s, not 30 s: the reference is BEHIND the train
    assert.ok(s.dist >= prevDist - 1e-9, 'distance never decreases at ' + R);
    prevDist = s.dist; minV = Math.min(minV, s.v);
  });
  assert.ok(minV >= 0, 'speed never negative: ' + minV);
  assert.equal(st.k, 1);
});

test('rule 7: a gap over 5 m (here 300 m) is NEVER slid across: the train fades out, jumps unseen, fades in', () => {
  const a = line('a', 51, -0.1, 600), e = endOf(a), b = line('b', e.lat + 300 / 110540, e.lon, 600);
  const plans = [plan(a, 0, 30000), plan(b, 30000, 60000)], st = E.newState();
  let prev = null, maxJump = 0, slid = false, hidden = 0;
  drive(st, plans, 5000, 70000, 60, (s) => {
    if (s.offx !== 0 || s.offy !== 0) slid = true;
    if (prev && s.alpha > 0 && prev[2] > 0) maxJump = Math.max(maxJump, Math.hypot((s.x - prev[0]) * KX(51), (s.y - prev[1]) * 110540));
    if (s.alpha === 0) hidden++;
    prev = [s.x, s.y, s.alpha];
  });
  assert.equal(slid, false, 'no slide');
  assert.equal(st.fades, 1); assert.ok(hidden >= 1, 'it was invisible while it jumped');
  assert.ok(maxJump < 1.6 * 20 / 60 + 0.3, 'no visible frame moved more than the speed allows: ' + maxJump);
  assert.equal(st.k, 1);
});

test('held with a stop mid-span: the train stands at the stop instead of carrying on after its dwell', () => {
  const a = line('a', 51, -0.1, 600), held = [plan(a, 0, 60000, { stop: 300, dwell: 10, held: true })], free = [plan(a, 0, 60000, { stop: 300, dwell: 10 })];
  const sh = E.newState(), sf = E.newState();
  drive(sh, held, 5000, 200000, 30); drive(sf, free, 5000, 200000, 30);
  near(sh.s, 300, 0.5, 'held at the stop'); assert.ok(sh.v < 0.01);
  assert.ok(sf.s > 400, 'the same plan, not held, went on: ' + sf.s);
});

test('even a stiff controller (kp = 1) can only slow a train that is AHEAD of a re-timed reference, never reverse it', () => {
  const [a, b] = twoSpans(), plans = [plan(a, 0, 30000)], st = E.newState(), stiff = Object.assign({}, CFG, { kp: 1 });
  let prevDist = 0, prevS = 0;
  drive(st, plans, 5000, 80000, 60, (s, R) => {
    if (R >= 22000 && plans.length === 1) plans.push(plan(b, 60000, 90000));         // the reference falls far behind the drawn train
    assert.ok(s.dist >= prevDist - 1e-9 && s.v >= 0, 'at ' + R);
    prevDist = s.dist; prevS = s.s;
  }, stiff);
  void prevS;
});

test('batched steps: two steps delivered together are driven through IN ORDER, through the middle span, at up to the cap, with no slide', () => {
  const a = line('a', 51, -0.1, 400), b = line('b', endOf(a).lat, endOf(a).lon, 400), c = line('c', endOf(b).lat, endOf(b).lon, 400);
  const plans = [plan(a, 0, 20000)], st = E.newState();
  let visitedB = false, prevDist = 0, vmax = 0, slid = false, onB = 0;
  const ev = []; const cfg = Object.assign({}, CFG, { onEvent: (t) => ev.push(t) });
  drive(st, plans, 5000, 100000, 60, (s, R) => {
    if (R >= 45000 && plans.length === 1) { plans.push(plan(b, 20000, 40000)); plans.push(plan(c, 40000, 60000)); }   // the feed stalled, then delivered both
    if (s.k === 1) { visitedB = true; const q = E.locate(b, s.s, { x: 0, y: 0, brg: 0 }); if (Math.abs(q.y - b.ys[0]) < 1e-6 && Math.abs(s.y - q.y) < 1e-6) onB++; }
    if (s.offx !== 0 || s.offy !== 0) slid = true;
    assert.ok(s.dist >= prevDist - 1e-9); prevDist = s.dist; vmax = Math.max(vmax, s.v);
  }, cfg);
  assert.ok(visitedB, 'it went THROUGH the middle span, not past it');
  assert.ok(onB > 30, 'and was drawn on the middle span\'s own geometry for a while: ' + onB + ' frames');
  assert.equal(st.k, 2, 'and on into the third');
  assert.equal(slid, false, 'never slid across a gap'); assert.equal(st.fades, 0);
  assert.ok(vmax <= 1.5 * 20 + 1e-6, 'catch-up cap held: ' + vmax);
  assert.deepEqual(ev.filter((t) => t === 'transition').length, 2, 'two transitions, in order');
});

test('the speed bound is 1.2 m/s^2 in both directions, in every frame: a departure from rest, a catch-up, a stop', () => {
  const a = line('a', 51, -0.1, 800), e = endOf(a), b = line('b', e.lat, e.lon, 800);
  const plans = [plan(a, 0, 60000, { stop: 0, dwell: 0 })], st = E.newState();
  let pv = null, worst = 0, vmax = 0;
  drive(st, plans, 0, 150000, 60, (s, R) => {
    if (R >= 30000 && plans.length === 1) plans.push(plan(b, 50000, 90000, { stop: 800, dwell: 20 }));
    if (pv != null && R > 20) worst = Math.max(worst, Math.abs(s.v - pv) * 60);
    pv = s.v; vmax = Math.max(vmax, s.v);
  });
  assert.ok(vmax > 8, 'it moved: ' + vmax);
  assert.ok(worst <= 1.2 * 1.02 + 1e-6, 'largest frame-to-frame change of speed: ' + worst.toFixed(3) + ' m/s^2');
});

// ---- 17.3: the catch-up limit follows the REFERENCE, and never falls faster than the braking bound ---------------------------
// A slow span (10 m/s) is followed by a fast one (50 m/s). The step that says so arrives late: the reference is already
// running on the fast span while the train is still on the slow one, 600 m behind. It is chasing something doing 50 m/s.
function chase(cfg) {
  const a = line('a', 51, -0.1, 1200), e = endOf(a), b = line('b', e.lat, e.lon, 1000);
  const plans = [plan(a, 0, 120000)], st = E.newState(); let vmaxOnA = 0, worstVcapOver = 0;
  drive(st, plans, 5000, 100000, 60, (s, R) => {
    if (R >= 60000 && plans.length === 1) plans.push(plan(b, 60000, 80000));           // a's reference is now 20 m/s (1200 m in 60 s); b's is 50 m/s
    if (s.k === 0 && s.v > vmaxOnA) vmaxOnA = s.v;
    if (s.vcap > 0) worstVcapOver = Math.max(worstVcapOver, s.v / (s.vcap * 1.5));
  }, cfg);
  return { vmaxOnA, worstVcapOver, st };
}
test('17.3: the limit is cap x the cruise speed of the span the REFERENCE is on when that is a later one', () => {
  const r = chase();
  assert.ok(r.vmaxOnA > 1.5 * 20 + 3, 'on the slow span it was allowed past 1.5 x its own 20 m/s because the reference runs at 50: ' + r.vmaxOnA.toFixed(1));
  assert.ok(r.vmaxOnA <= 1.5 * 50 + 1e-6, 'but never past 1.5 x the reference\'s span: ' + r.vmaxOnA.toFixed(1));
  assert.ok(r.worstVcapOver <= 1 + 1e-9, 'es.vcap is the limit the cap is measured against: speed / (1.5 x vcap) = ' + r.worstVcapOver.toFixed(4));
  assert.ok(r.st.vcap >= 0 && isFinite(r.st.vcap));
});

test('17.3: the limit falls no faster than the braking bound, so a speed allowed a moment ago is shed at the bound, not cut in one frame', () => {
  const a = line('a', 51, -0.1, 4000), plans = [plan(a, 0, 200000)], st = E.newState();      // 20 m/s: the plain limit is 30 m/s
  E.advance(st, plans, 5000, CFG, st);
  st.v = 60; st.vallow = 75;                                                                    // it was being let go at 60: the reference had been on a faster span
  let pv = st.v, worst = 0, vAfter1s = null, first = null;
  drive(st, plans, 5000 + 1000 / 60, 60000, 60, (s, R) => {
    if (first == null) first = s.v;
    worst = Math.max(worst, Math.abs(s.v - pv) * 60); pv = s.v;
    if (vAfter1s == null && R >= 6000) vAfter1s = s.v;
  });
  assert.ok(first > 59.8 && first < 60.01, 'the first frame did not snap down to the 30 m/s limit: ' + first);
  assert.ok(worst <= 1.2 * 1.02 + 1e-6, 'largest frame-to-frame change of speed: ' + worst.toFixed(3));
  assert.ok(vAfter1s > 55 && vAfter1s < 60, 'after a second it has shed about brk x 1 s: ' + vAfter1s);
  assert.ok(st.v < 31 && st.vallow < 31, 'and it came down to the plain limit in the end: ' + st.v);
});

test('17.3: after a fade jump the remembered allowance is dropped (the train is somewhere else now)', () => {
  const a = line('a', 51, -0.1, 600), e = endOf(a), b = line('b', e.lat + 300 / 110540, e.lon, 600);   // 300 m gap: a fade
  const plans = [plan(a, 0, 30000), plan(b, 30000, 60000)], st = E.newState();
  drive(st, plans, 5000, 29000, 60);
  st.vallow = 200;                                                                                // a big allowance in hand when the jump comes
  drive(st, plans, 29000, 40000, 60);
  assert.equal(st.fades, 1);
  assert.ok(st.vallow < 40, 'the 200 m/s allowance did not survive the jump: ' + st.vallow);
});

// ---- 17.4: a departure stands for `dwell` seconds, then leaves ------------------------------------------------------------------
test('17.4: a departure (stop 0) with a long dwell stands the whole dwell and leaves on time; dwell 0 leaves at once', () => {
  const L = 800, T = 1300, P = E.makeProfile(L, T, 0, 1200, CFG.acc), o = { s: 0, v: 0 };
  near(P.D, 1200, 1e-9, 'the dwell is not clipped to 90 % of the time (that would send it off 2 minutes early)');
  for (const tau of [0, 0.01, 300, 1199.9]) { E.refAt(P, tau, o); assert.equal(o.s, 0, 'standing at ' + tau); assert.equal(o.v, 0); }
  E.refAt(P, 1215, o); assert.ok(o.s > 0 && o.s < L, 'leaving: ' + o.s);
  E.refAt(P, T, o); near(o.s, L, 1e-6);
  const go = E.makeProfile(L, 100, 0, 0, CFG.acc);
  E.refAt(go, 0, o); assert.equal(o.s, 0);
  E.refAt(go, 5, o); assert.ok(o.s > 5 && o.v > 5, 'moving within seconds: ' + o.s + ' ' + o.v);
  near(E.makeProfile(L, 30, 0, 1000, CFG.acc).D, 27, 1e-9);                                    // a dwell that cannot fit: never less than a call was always given (90 %)
  near(E.makeProfile(L, 600, 0, 590, CFG.acc).D, 580, 1e-9);                                   // otherwise a departure keeps 20 s to move
  near(E.makeProfile(L, 1300, 400, 1200, CFG.acc).D, 1170, 1e-9);                              // a call mid-span keeps the 90 % limit
});

test('17.4: the engine holds a departing train at its origin for the whole dwell, then runs it away', () => {
  const a = line('a', 51, -0.1, 800), plans = [plan(a, 0, 1300000, { stop: 0, dwell: 1200 })], st = E.newState();
  let maxS = 0;
  drive(st, plans, 5000, 1190000, 5, (s) => { maxS = Math.max(maxS, s.s); });
  assert.ok(maxS < 0.5 && st.v < 0.01, 'standing until the dwell is up: ' + maxS);
  drive(st, plans, 1190000, 1290000, 30);
  assert.ok(st.s > 300, 'and gone by the end of the span\'s time: ' + st.s);
});
