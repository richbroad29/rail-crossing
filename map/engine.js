// The motion engine (CONTRACT section 12): where a train is drawn along the track, as a function of
// the plans the service has sent, the render time, and the state the train was in a moment ago.
// Pure: no DOM, no clock, no network, no randomness. advance(prev, plans, R) gives the same answer
// every time it is asked the same question (it can also write into a state object it is handed, so
// the page allocates nothing per frame; the answer is identical either way).
//
// THE RULES (each one has tests, and tests/mutation-check.js proves they fail when it is broken)
//   1. The render clock R runs 10 s behind the server clock, so a berth step that happened a few
//      seconds "in the future" of the drawing is usually already known when the train gets there.
//   2. Within a span the train follows a reference profile: constant speed for a pass; decelerate,
//      dwell, accelerate for a call. The drawn train tracks that reference with a bounded
//      acceleration, so its speed never lurches.
//   3. It never passes the end of a span before the next step is known. With no step it brakes to a
//      stop HOLD_M short of the end and waits ("waiting at a signal").
//   4. When the step arrives the span's reference is re-timed to end at the step's t0, and the
//      train follows it: a gentle speed change when the step is inside the window.
//   5. A step known late (the train is drawn behind where it should be) is caught up at no more
//      than CAP x the span's cruise speed. Speed is never negative, so it never moves backwards.
//   6. More than FADE_M off, it fades out, jumps and fades in rather than racing across the map.
//   7. A small gap between the end of one span and the start of the next is blended away, not jumped.
//   8. Identity is the caller's: the same train keeps the same state object across renumbering
//      and handovers, which is why nothing in here looks at a headcode.
(function (root) {
  'use strict';

  var DEFAULTS = {
    lagMs: 10000,        // render clock behind server clock
    holdM: 30,           // stop this far short of a span end when no step has come
    cap: 1.5,            // catch-up speed limit, x the span's cruise speed
    acc: 2.0,            // m/s^2 the drawn train may speed up by
    brk: 2.5,            // m/s^2 it may slow by
    kp: 0.04,            // 1/s: how hard lag is pulled in (extra m/s per metre behind)
    fadeM: 2000,         // further than this off: fade out, jump, fade in
    fadeSecs: 0.3,
    blendM: 0.2,         // gaps between spans smaller than this are ignored (the service rounds to 5 dp: ~1 m)
    blendSecs: 0.9,      // time constant of the gap blend
    blendRate: 25,       // m/s: the fastest a gap is slid away
    maxStep: 0.05,       // integration step, seconds
    headingRate: 120,    // degrees per second the body may turn
    chordM: 12,          // heading is the chord of the track +- this far
    dwellDefault: 30,    // seconds, for a call with no dwell given
    appearSecs: 0.4      // fade-in of a train the page has just started drawing
  };

  // ---- geometry: a span as arrays, measured in metres ---------------------------------------------
  // The service sends [lat, lon] pairs; we keep lon/lat and cumulative metres. Local equirectangular
  // maths: a span is a few hundred metres to a few km, where it is good to well under a metre.
  function prepareSpan(raw) {
    var p = raw && raw.path;
    if (!p || p.length < 1) return null;
    var n = p.length, xs = new Float64Array(n), ys = new Float64Array(n), cum = new Float64Array(n);
    var lat0 = p[0][0], kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    xs[0] = p[0][1]; ys[0] = p[0][0];
    for (var i = 1; i < n; i++) {
      xs[i] = p[i][1]; ys[i] = p[i][0];
      var dx = (xs[i] - xs[i - 1]) * kx, dy = (ys[i] - ys[i - 1]) * ky;
      cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy);
    }
    var len = cum[n - 1];
    // The service's own length is authoritative for timing; stretch the geometry to match it.
    if (typeof raw.length === 'number' && raw.length > 0 && len > 0 && Math.abs(raw.length - len) / raw.length > 0.001) {
      var f = raw.length / len;
      for (i = 1; i < n; i++) cum[i] *= f;
      len = raw.length;
    }
    return { id: raw.id, n: n, xs: xs, ys: ys, cum: cum, length: len, kx: kx, ky: ky,
      stop: typeof raw.stop === 'number' ? raw.stop : null };
  }

  // Position and the bearing of the segment at s metres along the span. Writes into out.
  function locate(span, s, out) {
    var n = span.n, cum = span.cum;
    if (n === 1 || !(span.length > 0)) { out.x = span.xs[0]; out.y = span.ys[0]; out.brg = NaN; return out; }
    if (s < 0) s = 0; else if (s > span.length) s = span.length;
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    var seg = cum[hi] - cum[lo], f = seg > 0 ? (s - cum[lo]) / seg : 0;
    out.x = span.xs[lo] + (span.xs[hi] - span.xs[lo]) * f;
    out.y = span.ys[lo] + (span.ys[hi] - span.ys[lo]) * f;
    var dx = (span.xs[hi] - span.xs[lo]) * span.kx, dy = (span.ys[hi] - span.ys[lo]) * span.ky;
    out.brg = dx === 0 && dy === 0 ? NaN : (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    return out;
  }
  var tmpA = { x: 0, y: 0, brg: 0 }, tmpB = { x: 0, y: 0, brg: 0 };
  // The direction the body points: the chord of the track either side of s, which is what a rigid
  // vehicle on a curve actually does (and does not flicker at every vertex).
  function bearingAt(span, s, half) {
    if (!(span.length > 0)) return NaN;
    var a = s - half, b = s + half;
    if (a < 0) { b = Math.min(span.length, b - a); a = 0; }
    if (b > span.length) { a = Math.max(0, a - (b - span.length)); b = span.length; }
    locate(span, a, tmpA); locate(span, b, tmpB);
    var dx = (tmpB.x - tmpA.x) * span.kx, dy = (tmpB.y - tmpA.y) * span.ky;
    if (dx === 0 && dy === 0) return locate(span, s, tmpA).brg;
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  }
  // The points of the span between s0 and s1, appended to `out` as [lon, lat].
  function sliceSpan(span, s0, s1, out) {
    if (s0 > s1) { var t = s0; s0 = s1; s1 = t; }
    s0 = Math.max(0, s0); s1 = Math.min(span.length, s1);
    var p = locate(span, s0, { x: 0, y: 0, brg: 0 });
    out.push([p.x, p.y]);
    for (var i = 0; i < span.n; i++) if (span.cum[i] > s0 && span.cum[i] < s1) out.push([span.xs[i], span.ys[i]]);
    p = locate(span, s1, p);
    out.push([p.x, p.y]);
    return out;
  }
  function metresBetween(x1, y1, x2, y2, span) {
    var dx = (x2 - x1) * span.kx, dy = (y2 - y1) * span.ky;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ---- reference profiles --------------------------------------------------------------------------
  // rampUp: from rest, accelerate at (at most) a to a cruise speed vc, then cruise, covering d metres
  // in exactly t seconds. If a is too gentle for that, accelerate uniformly the whole way instead.
  function ramp(d, t, a) {
    if (!(d > 0) || !(t > 0)) return { d: 0, t: 0, vc: 0, ta: 0 };
    var disc = t * t - 2 * d / a;
    if (disc >= 0) { var vc = a * (t - Math.sqrt(disc)); return { d: d, t: t, vc: vc, ta: vc / a, a: a }; }
    var v2 = 2 * d / t;
    return { d: d, t: t, vc: v2, ta: t, a: v2 / t };
  }
  function rampAt(r, tau, out) {                 // distance and speed tau seconds into the ramp-up
    if (tau <= 0) { out.s = 0; out.v = 0; return; }
    if (tau >= r.t) { out.s = r.d; out.v = r.vc; return; }
    if (tau <= r.ta) { out.s = r.a * tau * tau / 2; out.v = r.a * tau; return; }
    out.s = r.vc * r.ta / 2 + r.vc * (tau - r.ta); out.v = r.vc;
  }
  var rtmp = { s: 0, v: 0 };

  // L metres in T seconds. stop = metres along where it stands (null: it does not stop), dwell = seconds.
  function makeProfile(L, T, stop, dwell, accel) {
    if (!(T > 0)) T = 0.001;
    if (!(L > 0)) L = 0;
    var P = { L: L, T: T, call: false, vc: L / T, S: 0, D: 0, Ta: 0, Td: 0, up: null, down: null };
    if (stop == null) return P;
    var S = Math.min(L, Math.max(0, stop)), D = dwell == null ? DEFAULTS.dwellDefault : Math.max(0, dwell);
    if (D > T * 0.9) D = T * 0.9;
    var Tm = T - D, Ta = L > 0 ? Tm * S / L : 0, Td = Tm - Ta;
    P.call = true; P.S = S; P.D = D; P.Ta = Ta; P.Td = Td;
    P.down = ramp(S, Ta, accel);                    // approach: the time-reverse of a ramp-up
    P.up = ramp(L - S, Td, accel);
    P.vc = Math.max(P.down.vc, P.up.vc, 0.001);
    return P;
  }
  // Reference distance and speed tau seconds after entering the span.
  function refAt(P, tau, out) {
    if (tau <= 0) {
      if (P.call && P.S === 0 && P.Ta === 0) { out.s = 0; out.v = 0; return out; }
      out.s = 0; out.v = P.call ? P.down.vc : P.vc; return out;
    }
    if (tau >= P.T) { out.s = P.L; out.v = P.call && P.up.d > 0 ? P.up.vc : P.call ? 0 : P.vc; return out; }
    if (!P.call) { out.s = P.L * tau / P.T; out.v = P.vc; return out; }
    if (tau < P.Ta) {                                              // approaching the stop
      rampAt(P.down, P.Ta - tau, rtmp);
      out.s = P.S - rtmp.s; out.v = rtmp.v; return out;
    }
    if (tau < P.Ta + P.D) { out.s = P.S; out.v = 0; return out; }  // dwelling
    var u = tau - P.Ta - P.D;                                      // leaving
    rampAt(P.up, u, rtmp);
    out.s = P.S + rtmp.s; out.v = rtmp.v;
    return out;
  }

  // ---- plans ---------------------------------------------------------------------------------------
  // A plan is one berth's motion, from the wire's mv plus the span geometry when it has arrived.
  function makePlan(mv, span, cfg) {
    var p = { sp: mv.sp, t0: mv.t0, eta: mv.eta, stop: mv.stop == null ? null : mv.stop,
      dwell: mv.dwell == null ? null : mv.dwell, held: !!mv.held, span: null, L: 0, prof: null, profT: -1,
      hold: 0, recvAt: mv.recvAt == null ? null : mv.recvAt };
    if (span) attachSpan(p, span, cfg);
    return p;
  }
  function attachSpan(p, span, cfg) {
    p.span = span; p.L = span.length; p.prof = null; p.profT = -1;
    var hm = (cfg || DEFAULTS).holdM, m = Math.min(hm, p.L / 2);
    p.hold = p.stop != null && p.stop > p.L - m - 0.5 ? Math.min(p.L, p.stop) : p.L - m;
  }
  // Seconds this plan is meant to take: to the next step if it is known, else to the expected exit.
  function planSecs(p, next) {
    var t = ((next ? next.t0 : p.eta) - p.t0) / 1000;
    return t > 0.001 ? t : 0.001;
  }
  function profileOf(p, next, cfg) {
    var T = planSecs(p, next);
    if (!p.prof || p.profT !== T) { p.prof = makeProfile(p.L, T, p.stop, p.dwell, cfg.acc); p.profT = T; }
    return p.prof;
  }

  // ---- state ---------------------------------------------------------------------------------------
  function newState() {
    return { init: false, k: 0, s: 0, v: 0, t: 0, dist: 0, x: NaN, y: NaN, hdg: NaN, alpha: 1,
      fade: 0, fadeA: 0, tgtK: 0, tgtS: 0, offx: 0, offy: 0, wait: false, loading: false, ready: false, stopped: true,
      pw: false, pc: false, fades: 0, capFrames: 0, frames: 0, maxRatio: 0, snap: false, lastRef: 0 };
  }
  function copyState(a) { var o = newState(); for (var k in a) o[k] = a[k]; return o; }

  var refOut = { s: 0, v: 0 };
  // The reference position and speed at render time tR, in the coordinates of plan o.k.
  // Returns via r: c (metres from the start of plan k), v, clamped (held short of the end), dwelling,
  // j (the plan the reference is on), over (the reference is past the plan's expected time).
  function reference(o, plans, tR, cfg, r) {
    var j = o.k, base = 0;
    while (j + 1 < plans.length && plans[j + 1].t0 <= tR && plans[j + 1].span && plans[j].span) { base += plans[j].L; j++; }
    var p = plans[j], next = plans[j + 1] || null;
    var P = profileOf(p, next, cfg), tau = (tR - p.t0) / 1000;
    refAt(P, tau, refOut);
    var c = refOut.s, v = refOut.v, clamped = false;
    if (!next) {
      var H = p.held && p.stop != null ? Math.min(p.hold, p.stop) : p.hold;
      if (c >= H) { c = H; v = 0; clamped = true; }
    }
    r.c = base + c; r.v = v; r.clamped = clamped; r.j = j; r.tau = tau; r.T = P.T;
    r.dwelling = P.call && tau >= P.Ta && tau < P.Ta + P.D;
    r.vc = P.vc;
    return r;
  }
  var ref = { c: 0, v: 0, clamped: false, j: 0, tau: 0, T: 0, dwelling: false, vc: 0 };
  var posTmp = { x: 0, y: 0, brg: 0 }, posTmp2 = { x: 0, y: 0, brg: 0 };

  function emit(cfg, type, o, info) { if (cfg.onEvent) cfg.onEvent(type, o, info); }

  // Put the train where the reference is, with no history (first sight, or after a fade-out).
  function placeAtReference(o, plans, tR, cfg) {
    reference(o, plans, tR, cfg, ref);
    var j = ref.j, base = ref.c;
    for (var i = o.k; i < j; i++) base -= plans[i].L;      // position within plan j
    o.k = j; o.s = Math.max(0, Math.min(plans[j].L, base)); o.v = ref.v;
  }

  function startFade(o, plans, tR, cfg) {
    reference(o, plans, tR, cfg, ref);
    var base = ref.c;
    for (var i = o.k; i < ref.j; i++) base -= plans[i].L;
    o.fade = 1; o.tgtK = ref.j; o.tgtS = Math.max(0, Math.min(plans[ref.j].L, base));
    o.fades++;
    emit(cfg, 'fade', o, { tR: tR });
  }

  // Cross from plan k into k+1, carrying the overshoot, blending any gap and noting how it went.
  function transition(o, plans, tR, cfg) {
    var a = plans[o.k], b = plans[o.k + 1];
    var carry = o.s - a.L;
    locate(a.span, a.L, posTmp); locate(b.span, 0, posTmp2);
    var gap = metresBetween(posTmp.x, posTmp.y, posTmp2.x, posTmp2.y, a.span);
    var info = { k: o.k, tR: tR, late: (tR - b.t0) / 1000, waited: o.pw, capped: o.pc, gap: gap };
    if (gap > cfg.fadeM) {                         // not the same stretch of railway: do not race across
      o.k++; o.s = 0; o.fade = 1; o.tgtK = o.k; o.tgtS = 0; o.fades++; emit(cfg, 'fade', o, { tR: tR, gap: gap });
    } else {
      if (gap > cfg.blendM) {
        var dx = (posTmp.x - posTmp2.x) * a.span.kx, dy = (posTmp.y - posTmp2.y) * a.span.ky;
        // keep any blend still in progress: it is added to, not replaced (so no jump on a double step)
        o.offx += dx / a.span.kx; o.offy += dy / a.span.ky;
      }
      o.k++; o.s = Math.max(0, carry);
    }
    if (o.v < 0.3) o.snap = true;                  // reversing at a terminus: turn at once, standing still
    o.pw = false; o.pc = false;
    emit(cfg, 'transition', o, info);
  }

  // ---- the integrator ------------------------------------------------------------------------------
  function step(o, plans, h, tR, cfg) {
    // A fade is a three-beat: out, jump, in. The train keeps its way meanwhile.
    if (o.fade === 1) {
      o.alpha -= h / cfg.fadeSecs;
      if (o.alpha <= 0) { o.alpha = 0; o.k = o.tgtK; o.s = o.tgtS; reference(o, plans, tR, cfg, ref); o.v = ref.v; o.offx = o.offy = 0; o.fade = 2; o.snap = true; }
    } else if (o.fade === 2) {
      o.alpha += h / cfg.fadeSecs;
      if (o.alpha >= 1) { o.alpha = 1; o.fade = 0; }
    }
    if (o.k >= plans.length) o.k = plans.length - 1;
    var p = plans[o.k];
    if (!p || !p.span) return;
    var next = plans[o.k + 1] || null;
    reference(o, plans, tR, cfg, ref);
    var cur = ref, vc = Math.max(profileOf(p, next, cfg).vc, 0.5);
    if (cur.tau < 0 && cur.j === o.k) {             // not yet in this span at render time: wait at its start, speed kept
      o.s = 0; o.stopped = false; o.wait = false; o.loading = false;
      return;
    }
    var e = cur.c - o.s;
    if (e > cfg.fadeM && o.fade === 0) { startFade(o, plans, tR, cfg); return; }
    var vdes = cur.v + e * cfg.kp;
    if (vdes < 0) vdes = 0;
    if (e > 0.02 && vdes < 0.25) vdes = Math.min(0.25, e * 2);     // the last few centimetres: creep onto the mark rather than stop short of it
    var vmax = cfg.cap * vc;
    if (vdes > vmax) { vdes = vmax; if (e > 0) { o.pc = true; o.capFrames++; } }
    // The end of the span is a wall until the next step is known and its geometry has arrived.
    var open = next && next.span, wall = -1;
    if (!open) wall = next ? p.L : p.hold;
    o.loading = !!next && !next.span;
    var dv = vdes - o.v;
    if (dv > cfg.acc * h) dv = cfg.acc * h; else if (dv < -cfg.brk * h) dv = -cfg.brk * h;
    o.v += dv; if (o.v < 0) o.v = 0;
    if (o.v > vmax) o.v = vmax;                     // the catch-up limit is a limit: never exceeded, even entering a slower span
    if (!open) {                                    // the stopping curve to the wall: constant braking, so it stops ON it
      var room = wall - o.s; if (room < 0) room = 0;
      var vb = Math.sqrt(2 * cfg.brk * room);
      if (o.v > vb) o.v = vb;
    }
    var ds = o.v * h;
    o.s += ds; o.dist += ds;
    if (!open && o.s > wall) { o.dist -= o.s - wall; o.s = wall; o.v = 0; }
    if (open && o.s >= p.L) {
      var guard = 0;
      while (o.k + 1 < plans.length && plans[o.k + 1].span && o.s >= plans[o.k].L && guard++ < 8) transition(o, plans, tR, cfg);
      var vcap2 = cfg.cap * Math.max(profileOf(plans[o.k], plans[o.k + 1] || null, cfg).vc, 0.5);
      if (o.v > vcap2) o.v = vcap2;
    }
    // Waiting: stopped at the wall with the reference wanting to be past the expected time.
    // Waiting is a stop that was NOT planned: short of a span end (at a signal). Standing at the platform
    // it called at, a little past its dwell, is just a train that has not left yet.
    var atWall = !open && o.s >= wall - 0.5 && o.v < 0.3;
    var atPlatform = p.stop != null && Math.abs(wall - p.stop) < 1;
    o.wait = (atWall && !atPlatform && (cur.tau > cur.T || p.held)) || (!!next && !next.span && next.t0 <= tR && o.s >= p.L - 1 && o.v < 0.3);
    if (o.wait) o.pw = true;
    o.stopped = o.v < 0.3;
    o.lastRef = e;
    var ratio = o.v / vc; if (ratio > o.maxRatio) o.maxRatio = ratio;
  }

  function angDiff(a, b) { return ((b - a + 540) % 360) - 180; }

  // advance(prev, plans, R [, cfg [, out]]): the state at render time R (ms). `plans` is the train's
  // plan list, oldest first; prev.k indexes it. Returns the new state (written into `out` if given).
  function advance(prev, plans, R, cfgIn, out) {
    var cfg = cfgIn || DEFAULTS;
    var o = out || copyState(prev);
    if (out && out !== prev) { for (var key in prev) o[key] = prev[key]; }
    if (!plans.length) return o;
    if (!o.init) {
      var first = plans[o.k] || plans[0];
      if (!first.span) { o.ready = false; return o; }
      o.init = true; o.ready = true; o.t = R; o.alpha = 0; o.fade = 2; o.fades = 0; o.k = Math.min(o.k, plans.length - 1);
      if (!plans[o.k].span) o.k = 0;
      placeAtReference(o, plans, R, cfg);
      o.dist = 0; o.snap = true;
      emit(cfg, 'init', o, { tR: R });
    }
    var dt = (R - o.t) / 1000;
    if (dt > 0) {
      if (dt > 20) {                                  // the tab slept: resync rather than integrate minutes
        o.pw = false; o.pc = false;
        if (o.fade === 0) startFade(o, plans, R, cfg);
        o.t = R - 700; dt = 0.7;
      }
      var maxStep = dt > 8 ? 0.25 : cfg.maxStep;
      var n = Math.ceil(dt / maxStep), h = dt / n, t0 = o.t;
      for (var i = 1; i <= n; i++) {
        var tR = t0 + h * i * 1000;
        step(o, plans, h, tR, cfg);
        if (o.offx !== 0 || o.offy !== 0) {            // a gap between spans is slid away, never faster than blendRate
          var kxm = 111320 * Math.cos((o.y || 51) * Math.PI / 180), dm = Math.hypot(o.offx * kxm, o.offy * 110540);
          var shrink = Math.min(dm * (1 - Math.exp(-h / cfg.blendSecs)), cfg.blendRate * h);
          if (dm - shrink < 0.01) { o.offx = 0; o.offy = 0; } else { var fs = (dm - shrink) / dm; o.offx *= fs; o.offy *= fs; }
        }
      }
      o.t = R; o.frames++;
    }
    var p = plans[o.k];
    if (p && p.span) {
      locate(p.span, o.s, posTmp);
      o.x = posTmp.x + o.offx; o.y = posTmp.y + o.offy;
      var tgt = bearingAt(p.span, o.s, cfg.chordM);
      if (tgt !== tgt) tgt = o.hdg;
      if (o.hdg !== o.hdg || o.snap || tgt !== tgt) { o.hdg = tgt; o.snap = false; }
      else if (Math.abs(angDiff(o.hdg, tgt)) > 100) o.hdg = tgt;      // about-turn: only possible standing still (end of a line), so turn at once
      else if (dt > 0) {
        var d = angDiff(o.hdg, tgt), m = cfg.headingRate * dt;
        o.hdg = (o.hdg + (d > m ? m : d < -m ? -m : d) + 360) % 360;
      }
    }
    return o;
  }

  // ---- the render clock ----------------------------------------------------------------------------
  // Server time as the page sees it. Each message gives serverTime and our receive time; the
  // difference is the true offset MINUS the network delay, so the largest offset seen recently is the
  // best estimate. Changes are slewed (a few ms per second) so the render clock never lurches.
  function createClock(opts) {
    opts = opts || {};
    var lag = opts.lagMs == null ? DEFAULTS.lagMs : opts.lagMs;
    var slew = opts.slewMsPerSec == null ? 40 : opts.slewMsPerSec;
    var offset = null, target = null, lastT = null;
    var recent = [];                                 // [clientTime, offset] over the last 60 s
    return {
      observe: function (serverTime, clientNow) {
        var off = serverTime - clientNow;
        recent.push([clientNow, off]);
        while (recent.length && recent[0][0] < clientNow - 60000) recent.shift();
        var best = -Infinity;
        for (var i = 0; i < recent.length; i++) if (recent[i][1] > best) best = recent[i][1];
        target = best;
        if (offset == null) { offset = target; lastT = clientNow; }
      },
      // The estimated server time at client time `clientNow`.
      server: function (clientNow) {
        if (offset == null) return clientNow;
        var dt = lastT == null ? 0 : Math.max(0, clientNow - lastT) / 1000;
        lastT = clientNow;
        var d = target - offset, m = slew * dt;
        offset += d > m ? m : d < -m ? -m : d;
        return clientNow + offset;
      },
      render: function (clientNow) { return this.server(clientNow) - lag; },
      get lagMs() { return lag; },
      get offset() { return offset; }
    };
  }

  var api = {
    DEFAULTS: DEFAULTS, prepareSpan: prepareSpan, locate: locate, bearingAt: bearingAt, sliceSpan: sliceSpan,
    makeProfile: makeProfile, refAt: refAt, ramp: ramp, makePlan: makePlan, attachSpan: attachSpan, planSecs: planSecs,
    newState: newState, copyState: copyState, advance: advance, reference: reference, createClock: createClock,
    angDiff: angDiff
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.RM = root.RM || {}).engine = api;
})(typeof self !== 'undefined' ? self : this);
