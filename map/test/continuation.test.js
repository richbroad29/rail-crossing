'use strict';
// CONTRACT 17.1 on the page: continuation spans. Where one span ends more than 2 m from where the next starts, the
// page asks for `span/<new>?after=<the id it drew the last berth on>` through the span cache, draws the plan on the
// answer, and the harness replays the same thing from a recording's `span` lines carrying {id, after, of}.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../motion.js');
const E = require('../engine.js');
const S = require('../spans.js');
const R = require('./motion-replay.js');
const { createApi } = require('../api.js');

const KX = (lat) => 111320 * Math.cos(lat * Math.PI / 180);
// A straight span of `len` metres from (lat, lon), as a wire span ({id, length, path, stop}) and prepared.
function wireSpan(id, lat, lon, len, dir, stop) {
  dir = dir || [1, 0];
  const path = []; for (let i = 0; i <= 6; i++) path.push([+(lat + dir[1] * len * i / 6 / 110540).toFixed(6), +(lon + dir[0] * len * i / 6 / KX(lat)).toFixed(6)]);
  return { id, length: len, path, stop: stop == null ? null : stop };
}
const prep = (w) => E.prepareSpan(w);
const endOf = (w) => w.path[w.path.length - 1];
const startOf = (w) => w.path[0];
const wire = (id, extra) => Object.assign({ id, hc: '2A12', lat: 51, lon: -0.1, hdg: 90, area: 'LA', berth: '0004', at: 1, pl: 'i' }, extra);
const mv = (sp, t0, eta, extra) => Object.assign({ sp, t0, eta }, extra || {});
const tick = () => new Promise((r) => setImmediate(r));

// ---- the cache -------------------------------------------------------------------------------------------------------
test('span cache: a continuation is fetched as (after, of), cached by that pair, and carries its OWN id', async () => {
  const calls = [];
  const c = S.createSpanCache({
    fetchSpan: (id) => { calls.push('plain ' + id); return Promise.resolve(wireSpan(id, 51, 0, 100)); },
    fetchSpanAfter: (after, of) => { calls.push('after ' + after + ' of ' + of); return Promise.resolve(wireSpan('sp_cont' + calls.length, 51, 0, 100)); }
  });
  const k = c.contKey('sp_a', 'sp_b');
  assert.equal(k, 'sp_a>sp_b');
  c.need(k); c.need(k); await tick();
  assert.deepEqual(calls, ['after sp_a of sp_b'], 'asked once');
  assert.equal(c.peek(k).id, 'sp_cont1', 'the prepared span is named by the continuation id: it is what the next `after` must say');
  assert.equal(c.peek('sp_b'), null, 'and it does not pretend to be the plain span');
  c.need(c.contKey('sp_cont1', 'sp_c')); await tick();
  assert.equal(calls[1], 'after sp_cont1 of sp_c', 'a chain: the next request names the continuation id');
  c.need(c.contKey('sp_x', 'sp_b')); await tick();
  assert.equal(calls.length, 3, 'a different `after` is a different answer');
  assert.equal(c.contKey('../x', 'b'), null); assert.equal(c.contKey('a', 'b c'), null); assert.equal(c.contKey(null, 'b'), null);
  c.need('a>b>c'); c.need('>b'); c.need('a>'); assert.equal(calls.length, 3, 'malformed keys are never requested');
});

test('span cache: a continuation that errors or is unknown is remembered as failed, like any span; no fetchSpanAfter at all fails quietly', async () => {
  let t = 0, n = 0;
  const c = S.createSpanCache({ retryMs: 1000, now: () => t, fetchSpan: () => Promise.resolve(null), fetchSpanAfter: () => { n++; return Promise.reject(new Error('503')); } });
  c.need('a>b'); await tick();
  assert.equal(c.hasFailed('a>b'), true); c.need('a>b'); assert.equal(n, 1);
  t = 2000; c.need('a>b'); assert.equal(n, 2, 'retried after the delay');
  const d = S.createSpanCache({ fetchSpan: () => Promise.resolve(null) });
  d.need('a>b'); await tick(); assert.equal(d.hasFailed('a>b'), true);
});

test('span cache: continuations and plain spans share one bound', async () => {
  const c = S.createSpanCache({ maxCached: 5, fetchSpan: (id) => Promise.resolve(wireSpan(id, 51, 0, 100)), fetchSpanAfter: (a, o) => Promise.resolve(wireSpan('c_' + a + '_' + o, 51, 0, 100)) });
  for (let i = 0; i < 20; i++) { c.need('p' + i); c.need('q' + i + '>p' + i); }
  for (let i = 0; i < 40; i++) await tick();
  assert.ok(c.size <= 5, 'bounded: ' + c.size);
});

test('api: getSpanAfter asks span/<id>?after=<prev> and turns a 404 into null', async () => {
  const urls = []; let status = 200;
  const api = createApi({ base: 'https://api.example.test/', fetch: (u) => { urls.push(u); return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve({ id: 'sp_x' }) }); }, EventSource: function () {} });
  assert.deepEqual(await api.getSpanAfter('sp_prev', 'sp_new'), { id: 'sp_x' });
  assert.equal(urls[0], 'https://api.example.test/map/v1/span/sp_new?after=sp_prev');
  status = 404; assert.equal(await api.getSpanAfter('sp_prev', 'sp_new'), null);
});

// ---- the store -------------------------------------------------------------------------------------------------------
// A span cache that answers on demand, so a test decides when (and whether) a continuation arrives.
function manualCache(plain) {
  const m = new Map(plain.map((w) => [w.id, prep(w)])), asked = [], failed = new Set();
  return {
    contKey: S.contKey, asked, failed,
    peek: (k) => m.get(k) || null, hasFailed: (k) => failed.has(k),
    need: (k) => { if (!asked.includes(k)) asked.push(k); },
    answer: (k, w) => m.set(k, prep(w))
  };
}
const identityClock = { render: (now) => now };
function store(spans) { const s = M.createStore({ spans, clock: identityClock }); s.setView(true, null); return s; }

test('store: a gap over 2 m asks for a continuation; the plan is NOT ready until it arrives, then it is drawn on the continuation', () => {
  const A = wireSpan('A', 51, -0.1, 600), B = wireSpan('B', endOf(A)[0] + 150 / 110540, endOf(A)[1], 600);   // B starts 150 m north of where A ends
  const C = wireSpan('AB', endOf(A)[0], endOf(A)[1], 600);                                             // the continuation: starts where A ends
  const spans = manualCache([A, B]), s = store(spans);
  s.applySnapshot([wire('t', { mv: mv('A', 0, 30000) })], 1000);
  s.fill(5000, null);
  s.applyUpdate([wire('t', { mv: mv('B', 30000, 60000) })], [], 20000);
  s.fill(20000, null);
  const r = s.get('t');
  assert.deepEqual(spans.asked, ['A>B'], 'asked for B after A: the id the page drew the last berth on');
  assert.equal(r.plans[1].span, null, 'not ready: the canonical span is NOT used meanwhile');
  assert.equal(r.missing, 1);
  s.fill(31000, null); assert.ok(r.es.k === 0 && r.es.loading, 'the train waits at the end of A');
  spans.answer('A>B', Object.assign({}, C, { id: 'sp_cont' }));
  s.fill(33000, null);
  assert.equal(r.missing, 0); assert.equal(r.plans[1].drawSp, 'sp_cont'); assert.equal(r.plans[1].span.id, 'sp_cont');
  assert.equal(r.plans[1].sp, 'B', 'the wire id is still the berth\'s own');
  s.fill(36000, null);
  assert.equal(r.es.k, 1); assert.equal(r.es.fades, 0, 'no fade at the join');
});

test('store: when the continuation request fails, the canonical span is kept (and the engine fades across the gap as before)', () => {
  const A = wireSpan('A', 51, -0.1, 600), B = wireSpan('B', endOf(A)[0] + 150 / 110540, endOf(A)[1], 600);
  const spans = manualCache([A, B]), s = store(spans);
  s.applySnapshot([wire('t', { mv: mv('A', 0, 30000) })], 1000);
  s.applyUpdate([wire('t', { mv: mv('B', 30000, 60000) })], [], 20000);
  s.fill(20000, null);
  const r = s.get('t'); assert.equal(r.plans[1].span, null);
  spans.failed.add('A>B');
  s.fill(21000, null);
  assert.equal(r.plans[1].span.id, 'B'); assert.equal(r.plans[1].drawSp, 'B'); assert.equal(r.missing, 0);
});

test('store: spans that meet within 2 m need no continuation; a cache with no continuation support is never asked', () => {
  const A = wireSpan('A', 51, -0.1, 600), B = wireSpan('B', endOf(A)[0] + 1.5 / 110540, endOf(A)[1], 600);   // 1.5 m apart
  const spans = manualCache([A, B]), s = store(spans);
  s.applySnapshot([wire('t', { mv: mv('A', 0, 30000) })], 1000);
  s.applyUpdate([wire('t', { mv: mv('B', 30000, 60000) })], [], 20000);
  s.fill(20000, null);
  assert.deepEqual(spans.asked, []); assert.equal(s.get('t').plans[1].span.id, 'B');
  const far = wireSpan('F', endOf(A)[0] + 150 / 110540, endOf(A)[1], 600), old = manualCache([A, far]);
  delete old.contKey;                                                                                      // an older cache: no continuations
  const s2 = store(old);
  s2.applySnapshot([wire('t', { mv: mv('A', 0, 30000) })], 1000);
  s2.applyUpdate([wire('t', { mv: mv('F', 30000, 60000) })], [], 20000);
  s2.fill(20000, null);
  assert.deepEqual(old.asked, []); assert.equal(s2.get('t').plans[1].span.id, 'F');
});

test('store: the `after` of a chain is the id the previous berth was DRAWN on, not its wire id', () => {
  const A = wireSpan('A', 51, -0.1, 600);
  const B = wireSpan('B', endOf(A)[0] + 150 / 110540, endOf(A)[1], 600), Bc = wireSpan('sp_AB', endOf(A)[0], endOf(A)[1], 600);
  const C = wireSpan('C', endOf(Bc)[0] + 150 / 110540, endOf(Bc)[1], 600), Cc = wireSpan('sp_ABC', endOf(Bc)[0], endOf(Bc)[1], 600);
  const spans = manualCache([A, B, C]), s = store(spans);
  s.applySnapshot([wire('t', { mv: mv('A', 0, 30000) })], 1000);
  s.applyUpdate([wire('t', { mv: mv('B', 30000, 60000) })], [], 20000);
  s.applyUpdate([wire('t', { mv: mv('C', 60000, 90000) })], [], 20500);
  s.fill(21000, null);
  assert.deepEqual(spans.asked, ['A>B'], 'C waits behind B: B\'s drawn id is not known yet');
  spans.answer('A>B', Bc);
  s.fill(22000, null);
  assert.deepEqual(spans.asked, ['A>B', 'sp_AB>C'], 'C is asked after sp_AB, the continuation B was drawn on');
  spans.answer('sp_AB>C', Cc); s.fill(23000, null);
  const r = s.get('t'); assert.equal(r.missing, 0); assert.deepEqual(r.plans.map((p) => p.drawSp), ['A', 'sp_AB', 'sp_ABC']);
});

// ---- the replay harness, on a synthetic recording ----------------------------------------------------------------------
// Three berths, 600 m each, 24 s apart, each starting 150 m (two parallel ways) from where the last one ended. The
// recording either carries the continuation lines the recorder would write, or does not.
function fixture(withContinuations) {
  const A = wireSpan('sp_A', 51, -0.1, 600);
  const B = wireSpan('sp_B', endOf(A)[0] + 150 / 110540, endOf(A)[1], 600);
  const Bc = wireSpan('sp_AB', endOf(A)[0], endOf(A)[1], 600);                                  // after A, of B: starts where A ends
  const C = wireSpan('sp_C', endOf(B)[0] + 150 / 110540, endOf(B)[1], 600);                    // 150 m beyond where B ends
  const Cc = wireSpan('sp_BC', endOf(Bc)[0], endOf(Bc)[1], 600);                                // after B, of C (as recorded: B is the CANONICAL id)
  const T0 = 1800000000000, line = (t, event, data) => JSON.stringify({ t, event, data });
  const out = [];
  [A, B, C].forEach((w) => out.push(line(T0, 'span', w)));
  if (withContinuations) {
    out.push(line(T0, 'span', Object.assign({}, Bc, { after: 'sp_A', of: 'sp_B' })));
    out.push(line(T0, 'span', Object.assign({}, Cc, { after: 'sp_B', of: 'sp_C' })));
  }
  const train = (sp, t0, eta) => wire('tr1', { mv: mv(sp, t0, eta) });
  out.push(line(T0 + 1000, 'snapshot', { serverTime: T0 + 1000, trains: [train('sp_A', T0, T0 + 24000)] }));
  out.push(line(T0 + 25000, 'update', { serverTime: T0 + 25000, upsert: [train('sp_B', T0 + 24000, T0 + 48000)], remove: [] }));
  out.push(line(T0 + 49000, 'update', { serverTime: T0 + 49000, upsert: [train('sp_C', T0 + 48000, T0 + 72000)], remove: [] }));
  out.push(line(T0 + 100000, 'update', { serverTime: T0 + 100000, upsert: [], remove: ['tr1'] }));
  const f = path.join(os.tmpdir(), 'rm-cont-' + process.pid + '-' + (withContinuations ? 'with' : 'without') + '.jsonl');
  fs.writeFileSync(f, out.join('\n'));
  const rec = R.load(f); fs.unlinkSync(f);
  return rec;
}
function replay(rec) {
  const drawn = new Set(), gaps = [];
  const r = R.run(rec, { fps: 30, warmupSecs: 0, trace: (rr) => { const p = rr.plans && rr.plans[rr.es.k]; if (p) drawn.add(p.drawSp); }, onEvent: (type, es, info) => { if (type === 'transition') gaps.push(info.gap); } });
  return { r, drawn, gaps };
}

test('replay: with the continuation lines the train never fades at a join between spans that do not meet, and it is drawn on them', () => {
  const rec = fixture(true);
  assert.equal(rec.conts.size, 2); assert.equal(rec.spans.size, 3, 'plain and continuation lines are kept apart');
  const { r, drawn, gaps } = replay(rec);
  assert.equal(r.fades, 0, 'no fade');
  assert.equal(r.steps, 2); assert.ok(gaps.every((g) => g < 3), 'both joins meet: ' + gaps.join());
  assert.equal(r.teleports, 0); assert.equal(r.backward, 0);
  assert.ok(drawn.has('sp_AB') && drawn.has('sp_BC'), 'drawn on the continuations: ' + [...drawn].join());
  assert.ok(!drawn.has('sp_B') && !drawn.has('sp_C'), 'never on the canonical spans that start elsewhere');
  assert.equal(r.recording.continuations, 2);
});

test('replay: the same recording WITHOUT the lines fades at each join, as before; the missing answer is an error, not a hang', () => {
  const { r, drawn, gaps } = replay(fixture(false));
  assert.equal(r.fades, 2, 'one fade per gap');
  assert.ok(gaps.every((g) => g > 100));
  assert.ok(drawn.has('sp_B') && drawn.has('sp_C') && !drawn.has('sp_AB'));
});

test('replay: continuation answers take the same simulated latency as plain spans, and the train waits for them meanwhile', () => {
  const rec = fixture(true);
  const waits = (spanLatencyMs) => { let w = 0; R.run(rec, { fps: 30, warmupSecs: 0, spanLatencyMs, trace: (rr, es) => { if (es.loading && es.stopped) w++; } }); return w; };
  assert.equal(waits(150), 0, 'quick spans: the answer is there before the train needs it');
  assert.ok(waits(20000) > 100, 'a slow answer holds the train at the end of the span: it is not drawn on the canonical span meanwhile');
});

test('replay: a continuation id the page drew can be the `after` of the next request (resolved through the recording\'s canonical ids)', () => {
  const { drawn } = replay(fixture(true));
  assert.ok(drawn.has('sp_BC'), 'the third berth\'s continuation was found although the page asked after sp_AB, and the line says after sp_B');
});

test('replay: recordings with no continuation lines at all replay as before (the committed ones)', () => {
  const rec = R.load(R.DEFAULT);
  assert.equal(rec.conts.size, 0);
  const r = R.run(rec, { fps: 10 });
  assert.ok(r.steps > 300 && r.backward === 0);
});
