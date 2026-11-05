#!/usr/bin/env node
'use strict';
// The motion replay harness (CONTRACT section 12). Feeds RECORDED service output (section 13's JSONL)
// through the page's real motion code (map/motion.js + map/engine.js: the same files the browser
// loads, no copy) on a virtual clock, frame by frame, with no browser, and reports the four numbers
// the contract sets targets for. Exit status is non-zero if any target is missed.
//
//   node map/test/motion-replay.js [recording.jsonl[.gz]] [--fps 30] [--lag 10000] [--latency 100]
//        [--span-latency 150] [--warmup 60] [--json] [--no-fail]
//
// Default recording: map/test/fixtures/sussex-10min-iid.jsonl.gz (made by map/dev/record-fixture.js).
//
// THE FOUR METRICS (targets from the contract)
//   absorbed     share of berth steps absorbed by re-timing alone: between the step arriving and the drawn
//                train crossing into the new span it never stopped to wait for the step and never needed
//                the catch-up limit, so the whole correction was a gentle change of speed.   target >= 90 %
//   catch-up     the highest speed, as a multiple of the span's cruise speed, in any frame where the
//                catch-up limit was in force.                                                target <= 1.5x
//   backward     frames in which a train moved backwards along its own heading by more than 2.5 m (spans are
//                rounded to 5 dp, so adjacent span ends differ by up to ~2 m), or in which the distance
//                travelled along the track decreased.                                              target 0
//   fades        position fades (a jump of more than 2 km) per train-hour.                    target < 0.1
// and, not targets but what the viewer sees: teleports (a frame-to-frame move bigger than the train
// could have made), peak acceleration, the share of train-time spent waiting at a signal, and how far
// behind the signalled position the drawn trains run.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const motion = require('../motion.js');
const engine = require('../engine.js');

const TARGETS = { absorbed: 0.9, catchUp: 1.5, backward: 0, fadesPerHour: 0.1, accel: 1.2 };
const DEFAULT = path.join(__dirname, 'fixtures', 'sussex-10min-iid.jsonl.gz');

// Reads CONTRACT section 16's recording format (the mock recorder's and the real /debug/record's): JSONL, one
// {t, event, data} per line, event = snapshot | update | span. Unknown events and unreadable lines are skipped
// and counted, not fatal. `t` is the server time the event was emitted; data.serverTime is used when present.
function load(file) {
  let buf = file === '-' ? fs.readFileSync(0) : fs.readFileSync(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);        // gzip by content, not by name
  const ev = [], spans = new Map(), conts = new Map(), canonOf = new Map(), skipped = { bad: 0, unknown: 0 };
  buf.toString('utf8').split('\n').forEach((l) => {
    if (!l.trim()) return;
    let o;
    try { o = JSON.parse(l); } catch (e) { skipped.bad++; return; }
    if (!o || typeof o !== 'object' || !o.data) { skipped.bad++; return; }
    if (o.event === 'span') {
      if (!(o.data.id && o.data.path)) skipped.bad++;
      // CONTRACT 17.1: a continuation line {id, after, of, ...} is what GET span/<of>?after=<after> returned; plain lines are GET span/<id>.
      else if (o.data.after && o.data.of) { conts.set(o.data.after + '>' + o.data.of, o.data); canonOf.set(o.data.id, o.data.of); }
      else spans.set(o.data.id, o.data);
    }
    else if (o.event === 'snapshot' || o.event === 'update') {
      if (typeof o.t !== 'number') o.t = o.data.serverTime;
      if (typeof o.t !== 'number') { skipped.bad++; return; }
      ev.push(o);
    } else skipped.unknown++;
  });
  ev.sort((a, b) => a.t - b.t);
  return { events: ev, spans, conts, canonOf, skipped };
}

function run(rec, opt) {
  opt = Object.assign({ fps: 30, lagMs: 12000, latencyMs: 100, spanLatencyMs: 150, warmupSecs: 60, engine: {} }, opt || {});
  const ev = rec.events;
  if (!ev.length) throw new Error('empty recording');
  // the page's clock: it learns the server offset from message timestamps, like the real page does
  const clock = engine.createClock({ lagMs: opt.lagMs });
  // spans arrive a little after they are first asked for
  const asked = new Map(), prepared = new Map();
  // A continuation key is `after>of`. The recording holds the answers the page would have got, keyed by the recorded
  // canonical ids; the page may ask `after` a continuation id it drew (a chain), which ends exactly where the canonical
  // span it continues ends, so it is looked up by that span. No line = the service errored: hasFailed, canonical kept.
  const contRaw = (key) => {
    const raw = rec.conts && rec.conts.get(key);
    if (raw || !rec.canonOf) return raw || null;
    const cut = key.indexOf('>'), c = rec.canonOf.get(key.slice(0, cut));
    return c ? rec.conts.get(c + '>' + key.slice(cut + 1)) || null : null;
  };
  const spans = {
    contKey: require('../spans.js').contKey,
    peek(id) {
      const at = asked.get(id);
      if (at == null || now < at) return null;
      let p = prepared.get(id);
      if (!p) {
        const raw = id.indexOf('>') < 0 ? rec.spans.get(id) : contRaw(id);
        if (!raw) return null;
        p = engine.prepareSpan(raw); p.id = raw.id; prepared.set(id, p);
      }
      return p;
    },
    hasFailed(id) { const at = asked.get(id); return at != null && now >= at && id.indexOf('>') >= 0 && !contRaw(id); },
    need(id) { if (!asked.has(id)) asked.set(id, now + opt.spanLatencyMs); }
  };
  const M = { steps: 0, absorbed: 0, waited: 0, capped: 0, late: [], fades: 0, inits: 0 };
  let measuring = false;
  const cfg = Object.assign({ lagMs: opt.lagMs }, opt.engine, {
    onEvent(type, es, info) {
      if (!measuring) return;
      if (opt.onEvent) opt.onEvent(type, es, info);
      if (type === 'transition') {
        M.steps++;
        if (info.waited) M.waited++;
        if (info.capped) M.capped++;
        M.late.push(info.late);
        if (!info.waited && !info.capped) M.absorbed++;
      } else if (type === 'fade') M.fades++;
      else if (type === 'init') M.inits++;
    }
  });
  const store = motion.createStore({ spans, clock, engine: cfg, trackAlways: true });
  store.setView(true, null);
  store.setFan(false);

  let now = ev[0].t;
  const t0 = now, tEnd = ev[ev.length - 1].t + 30000, dtMs = 1000 / opt.fps;
  let next = 0;
  const S = { frames: 0, trainFrames: 0, maxRatioCapped: 0, maxRatio: 0, capFrames: 0, backward: 0, teleports: 0, maxJump: 0, maxAcc: 0, maxDec: 0, accOver: 0, waitFrames: 0, lagSum: 0, lagN: 0, lagMax: 0, stops: 0 };
  const prev = new Map();                                     // id -> {x, y, v, cx, cy, dist, fades}
  const kx = 111320 * Math.cos(51 * Math.PI / 180), ky = 110540;
  const cpuStart = process.hrtime.bigint();
  let engineNs = 0n;

  for (; now <= tEnd; now += dtMs) {
    while (next < ev.length && ev[next].t + opt.latencyMs <= now) {
      const e = ev[next++], recv = e.t + opt.latencyMs;
      clock.observe(typeof e.data.serverTime === 'number' ? e.data.serverTime : e.t, recv);
      if (e.event === 'snapshot') store.applySnapshot(e.data.trains || [], recv, null);
      else store.applyUpdate(e.data.upsert, e.data.remove, recv);
    }
    if (!measuring && now - t0 >= opt.warmupSecs * 1000) { measuring = true; prev.clear(); }
    const a = process.hrtime.bigint();
    store.fill(now, null);
    engineNs += process.hrtime.bigint() - a;
    S.frames++;
    if (!measuring) continue;
    store.forEach((r) => {
      const es = r.es;
      if (r.mode !== 'track' || !es || !es.init) return;
      S.trainFrames++;
      if (opt.trace) opt.trace(r, es, now);
      const p = prev.get(r.id), dt = dtMs / 1000;
      if (p && p.t === now - dtMs && es.fades === p.fades && es.alpha === 1 && p.alpha === 1) {
        const dx = (r.cx - p.x) * kx, dy = (r.cy - p.y) * ky, d = Math.hypot(dx, dy);
        const brg = r.ch * Math.PI / 180, along = dx * Math.sin(brg) + dy * Math.cos(brg);
        if (es.dist < p.dist - 1e-9) { S.backward++; if (opt.debug) opt.debug('dist', r, es, p, 0, now); }
        else if (d > 0.5 && es.offx === 0 && es.offy === 0 && p.noff && along < -2.5 && p.stopped === false && Math.abs(engine.angDiff(r.ch, p.h)) < 20) { S.backward++; if (opt.debug) opt.debug('back', r, es, p, along, now); }
        const allowed = Math.max(es.v, p.v) * dt * 1.2 + 0.6 + (es.offx !== 0 || p.offx !== 0 ? 6 : 0);
        if (d > allowed) { S.teleports++; if (d > S.maxJump) S.maxJump = d; if (opt.debug) opt.debug('teleport', r, es, p, d, now); }
        const acc = (es.v - p.v) / dt;
        if (acc > S.maxAcc) S.maxAcc = acc; if (-acc > S.maxDec) S.maxDec = -acc;
        if (Math.abs(acc) > TARGETS.accel * 1.02 + 1e-6) { S.accOver++; if (opt.debug) opt.debug('accbound', r, es, p, acc, now); }
        if (opt.debug && (acc > 3 || -acc > 3)) opt.debug('acc', r, es, p, acc, now);
      }
      if (es.v > S.maxRatio * 0 && es.maxRatio > S.maxRatio) S.maxRatio = es.maxRatio;
      if (es.wait) S.waitFrames++;
      const pl = r.plans && r.plans[es.k];
      if (pl && p) {
        // lag: how far the drawn train is behind the reference (positive = behind), metres
        if (es.lastRef > 0) { S.lagSum += es.lastRef; S.lagMax = Math.max(S.lagMax, es.lastRef); }
        S.lagN++;
      }
      if (p && p.capFrames < es.capFrames) {
        S.capFrames++;
        const vc = pl ? Math.max(pl.prof ? pl.prof.vc : 0.5, 0.5, es.vcp, es.vcap || 0) : 1;     // the cap is against es.vcap: the highest cruise speed in play (own span, span just left, span the reference is on), CONTRACT 17.3
        const ratio = es.v / vc;
        if (ratio > S.maxRatioCapped) S.maxRatioCapped = ratio;
        if (opt.debug && ratio > 1.55) opt.debug('ratio', r, es, p, ratio, now);
      }
      const q = p || {};
      q.t = now; q.x = r.cx; q.y = r.cy; q.v = es.v; q.dist = es.dist; q.fades = es.fades; q.capFrames = es.capFrames;
      q.alpha = es.alpha; q.offx = es.offx; q.noff = es.offx === 0 && es.offy === 0; q.stopped = es.stopped; q.h = r.ch;
      prev.set(r.id, q);
    });
  }
  const cpuMs = Number(process.hrtime.bigint() - cpuStart) / 1e6;
  const trainHours = S.trainFrames * (dtMs / 1000) / 3600;
  const out = {
    recording: { events: ev.length, spans: rec.spans.size, continuations: rec.conts ? rec.conts.size : 0, seconds: Math.round((tEnd - t0) / 1000), fps: opt.fps, lagMs: opt.lagMs, latencyMs: opt.latencyMs },
    skipped: rec.skipped, trainHours: +trainHours.toFixed(2), steps: M.steps,
    absorbed: M.steps ? M.absorbed / M.steps : 1,
    notAbsorbed: { waited: M.waited, capped: M.capped, bothOrLate: M.steps - M.absorbed - Math.max(M.waited, M.capped) },
    lateSecs: pct(M.late),
    catchUpMaxRatio: S.maxRatioCapped, anyFrameMaxRatio: S.maxRatio, catchUpFrames: S.capFrames,
    backward: S.backward,
    fades: M.fades, fadesPerTrainHour: trainHours ? M.fades / trainHours : 0,
    teleports: S.teleports, maxJumpM: +S.maxJump.toFixed(2), maxAccel: +S.maxAcc.toFixed(3), maxDecel: +S.maxDec.toFixed(3), accelOver: S.accOver,
    waitShare: S.trainFrames ? S.waitFrames / S.trainFrames : 0,
    meanLagM: S.lagN ? S.lagSum / S.lagN : 0, maxLagM: S.lagMax,
    cpu: { totalMs: +cpuMs.toFixed(0), fillMsPerFrame: +(Number(engineNs) / 1e6 / S.frames).toFixed(3), trainFrames: S.trainFrames }
  };
  out.pass = out.absorbed >= TARGETS.absorbed && out.catchUpMaxRatio <= TARGETS.catchUp + 1e-6 && out.backward === 0 && out.fadesPerTrainHour < TARGETS.fadesPerHour && out.accelOver === 0;
  return out;
}
function pct(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), q = (p) => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2);
  return { p5: q(0.05), p50: q(0.5), p95: q(0.95), max: q(1) };
}

function report(r) {
  const P = (v) => (v * 100).toFixed(1) + ' %', tick = (ok) => (ok ? 'PASS' : 'FAIL');
  const lines = [
    'recording: ' + r.recording.events + ' events' + (r.skipped && (r.skipped.bad || r.skipped.unknown) ? ' (skipped ' + r.skipped.bad + ' unreadable, ' + r.skipped.unknown + ' of unknown kind)' : '') + ', ' + r.recording.spans + ' spans' + (r.recording.continuations ? ' + ' + r.recording.continuations + ' continuations' : '') + ', ' + r.recording.seconds + ' s; ' + r.recording.fps + ' fps, render lag ' + r.recording.lagMs / 1000 + ' s, network ' + r.recording.latencyMs + ' ms',
    r.trainHours + ' train-hours measured, ' + r.steps + ' berth steps',
    '',
    'absorbed by re-timing alone   ' + P(r.absorbed).padStart(8) + '   target >= 90 %      ' + tick(r.absorbed >= TARGETS.absorbed),
    '  (steps that waited at a signal: ' + r.notAbsorbed.waited + ', that hit the catch-up cap: ' + r.notAbsorbed.capped + '; seconds the drawn train crossed after the step p5/p50/p95/max: ' +
      (r.lateSecs ? [r.lateSecs.p5, r.lateSecs.p50, r.lateSecs.p95, r.lateSecs.max].join('/') : 'n/a') + ')',
    'catch-up speed, max           ' + (r.catchUpMaxRatio.toFixed(3) + 'x').padStart(8) + '   target <= 1.5x      ' + tick(r.catchUpMaxRatio <= TARGETS.catchUp + 1e-6) + '   (' + r.catchUpFrames + ' capped frames)',
    'backward moves                ' + String(r.backward).padStart(8) + '   target 0            ' + tick(r.backward === 0),
    'fades per train-hour          ' + r.fadesPerTrainHour.toFixed(3).padStart(8) + '   target < 0.1        ' + tick(r.fadesPerTrainHour < TARGETS.fadesPerHour) + '   (' + r.fades + ' fades)',
    '',
    'teleports (a move bigger than possible): ' + r.teleports + ' (largest ' + r.maxJumpM + ' m)',
    'acceleration / deceleration, max   ' + (r.maxAccel + ' / ' + r.maxDecel).padStart(8) + ' m/s^2   bound 1.2   ' + tick(r.accelOver === 0) + '   (' + r.accelOver + ' frames over)',
    'waiting at a signal: ' + P(r.waitShare) + ' of train-time;  drawn behind signalled position: mean ' + r.meanLagM.toFixed(1) + ' m, max ' + r.maxLagM.toFixed(0) + ' m',
    'cost: ' + r.cpu.fillMsPerFrame + ' ms per frame in store.fill (' + r.cpu.trainFrames + ' train-frames in ' + r.cpu.totalMs + ' ms)',
    '', r.pass ? 'ALL TARGETS MET' : 'TARGETS MISSED'
  ];
  return lines.join('\n');
}

function arg(n, d) { const i = process.argv.indexOf('--' + n); if (i < 0) return d; const v = process.argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; }
if (require.main === module) {
  const file = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : DEFAULT;
  const r = run(load(file), {
    fps: Number(arg('fps', 30)), lagMs: Number(arg('lag', 12000)), latencyMs: Number(arg('latency', 100)),
    spanLatencyMs: Number(arg('span-latency', 150)), warmupSecs: Number(arg('warmup', 60)),
    engine: arg('engine', null) ? JSON.parse(arg('engine')) : {}
  });
  console.log(arg('json', false) ? JSON.stringify(r, null, 2) : report(r));
  process.exit(r.pass || arg('no-fail', false) ? 0 : 1);
}
module.exports = { run, load, report, TARGETS, DEFAULT };
