'use strict';
// CONTRACT 18.1: the harness's absorbed metric and fade count, on synthetic recordings with a planted answer.
//   - a step that left the berth later than the plan's eta by MORE than the render delay, and waited, is "slower than
//     predicted": counted, and out of the headline's denominator;
//   - one later than eta but within the render delay that waits is NOT excluded (the delay could have absorbed it);
//   - a train that leaves track mode and comes back counts one fade (a re-appearance); a first appearance counts none.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./motion-replay.js');
const E = require('../engine.js');

const KX = (lat) => 111320 * Math.cos(lat * Math.PI / 180);
function wireSpan(id, lat, lon, len) {
  const p = []; for (let i = 0; i <= 6; i++) p.push([+lat.toFixed(6), +(lon + len * i / 6 / KX(lat)).toFixed(6)]);
  return { id, length: len, path: p, stop: null };
}
const endOf = (w) => w.path[w.path.length - 1];
const T0 = 1800000000000;
const line = (t, event, data) => JSON.stringify({ t, event, data });
const wire = (extra) => Object.assign({ id: 'tr1', hc: '2A12', lat: 51, lon: -0.1, hdg: 90, area: 'LA', berth: '0004', at: 1, pl: 'i' }, extra);
const mvOf = (sp, t0, eta) => ({ sp, t0, eta });
function load(lines) {
  const f = path.join(os.tmpdir(), 'rm-metric-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.jsonl');
  fs.writeFileSync(f, lines.join('\n')); const rec = R.load(f); fs.unlinkSync(f); return rec;
}
const run = (rec, o) => R.run(rec, Object.assign({ fps: 20, warmupSecs: 0 }, o || {}));

// Two contiguous 600 m spans. The train is on A from T0 (eta T0 + 24 s); the step into B has t0 = T0 + 24 s + `lateBy`, and
// the update carrying it is emitted `emitAfter` ms after that t0 (the feed, or a long outage: how late the page learns of it).
function slowFixture(lateBy, emitAfter) {
  const A = wireSpan('sp_A', 51, -0.1, 600), B = wireSpan('sp_B', endOf(A)[0], endOf(A)[1], 600);
  const stepT0 = T0 + 24000 + lateBy;
  return load([
    line(T0, 'span', A), line(T0, 'span', B),
    line(T0 + 1000, 'snapshot', { serverTime: T0 + 1000, trains: [wire({ mv: mvOf('sp_A', T0, T0 + 24000) })] }),
    line(stepT0 + emitAfter, 'update', { serverTime: stepT0 + emitAfter, upsert: [wire({ mv: mvOf('sp_B', stepT0, stepT0 + 24000) })], remove: [] }),
    line(stepT0 + emitAfter + 90000, 'update', { serverTime: stepT0 + emitAfter + 90000, upsert: [], remove: ['tr1'] })
  ]);
}

test('18.1: a step more than the render delay slower than predicted that waited is counted and left out of the headline', () => {
  const r = run(slowFixture(90000, 1000));
  assert.equal(r.steps, 1);
  assert.equal(r.notAbsorbed.waited, 1, 'the train did stand at the wall for it');
  assert.deepEqual([r.slowerThanPredicted.steps, r.slowerThanPredicted.waited], [1, 1]);
  assert.equal(r.absorbedRaw, 0, 'raw: the one step was not absorbed');
  assert.equal(r.absorbed, 1, 'headline: it is out of the denominator (no steps left, so nothing failed)');
  assert.equal(r.pass, true, 'and pass uses the headline');
  assert.match(R.report(r), /slower than predicted.*1 steps, 1 of them waited/);
  assert.ok(!/held/i.test(R.report(r).split('\n').filter((l) => /slower than predicted/.test(l)).join('')), 'never "held"');
});

test('18.1: a step later than eta but within the render delay that waits is NOT excluded', () => {
  const r = run(slowFixture(8000, 60000));                                  // 8 s later than eta (< 12 s), but the page only hears 60 s after
  assert.equal(r.steps, 1);
  assert.equal(r.notAbsorbed.waited, 1, 'it waited, because the update came so late');
  assert.deepEqual([r.slowerThanPredicted.steps, r.slowerThanPredicted.waited], [0, 0], 'not slower than predicted: the delay was enough');
  assert.equal(r.absorbed, 0, 'it stays in the headline, as a failure');
  assert.equal(r.absorbedRaw, 0);
  assert.equal(r.pass, false);
});

test('18.1: the threshold is the render delay in use', () => {
  const rec = slowFixture(8000, 60000);
  assert.equal(run(rec, { lagMs: 12000 }).slowerThanPredicted.steps, 0);
  assert.equal(run(rec, { lagMs: 5000 }).slowerThanPredicted.steps, 1, 'with a 5 s delay the same 8 s is slower than predicted');
});

test('18.1: a slower-than-predicted step that did not wait is counted but changes nothing in the headline', () => {
  const r = run(slowFixture(30000, 1000));                                  // 30 s over, heard at once: the train slows and crawls to the step but never stands at the wall
  assert.deepEqual([r.slowerThanPredicted.steps, r.slowerThanPredicted.waited], [1, 0]);
  assert.equal(r.absorbed, r.absorbedRaw, 'nothing waited, so nothing leaves the denominator');
});

// A train on A, then the service stops giving it a plan (leaves track mode), then it comes back on `again` (a span far away).
function reappearFixture(leave, nearAgain) {
  const A = wireSpan('sp_A', 51, -0.1, 600), C = wireSpan('sp_C', 51.1, -0.1, 600);
  const out = [line(T0, 'span', A), line(T0, 'span', C),
    line(T0 + 1000, 'snapshot', { serverTime: T0 + 1000, trains: [wire({ mv: mvOf('sp_A', T0, T0 + 60000) })] })];
  if (leave) {
    out.push(line(T0 + 30000, 'update', { serverTime: T0 + 30000, upsert: [wire({})], remove: [] }));               // no mv: out of track mode
    out.push(line(T0 + 40000, 'update', { serverTime: T0 + 40000, upsert: [wire(nearAgain ? { mv: mvOf('sp_A', T0 + 40000, T0 + 100000) } : { lat: 51.1, mv: mvOf('sp_C', T0 + 40000, T0 + 100000) })], remove: [] }));
  }
  out.push(line(T0 + 120000, 'update', { serverTime: T0 + 120000, upsert: [], remove: ['tr1'] }));
  return load(out);
}

test('18.1: a train that leaves track mode and re-initialises counts one fade; its first appearance counts none', () => {
  const once = run(reappearFixture(false));
  assert.equal(once.fades, 0, 'a first appearance is not a fade');
  assert.deepEqual(once.fadeKinds, { gap: 0, behind: 0, reappearance: 0, reappearancesSlid: 0, readded: 0 });
  const twice = run(reappearFixture(true));
  assert.equal(twice.fadeKinds.reappearance, 1, 'one re-appearance');
  assert.equal(twice.fades, 1, 'and it is a fade');
  assert.equal(twice.fadeKinds.gap + twice.fadeKinds.behind, 0, 'the engine itself reported none');
  assert.ok(twice.fadesPerTrainHour > 0 && twice.pass === false, 'it counts in fades per train-hour');
  assert.equal(twice.fadeKinds.reappearancesSlid, 0, 'it came back far from where it was drawn: it fades in');
  assert.match(R.report(twice), /1 re-appearance/);
});

test('18.1: a re-appearance near where the train was drawn slides in (still counted, and said so)', () => {
  const r = run(reappearFixture(true, true));
  assert.equal(r.fadeKinds.reappearance, 1);
  assert.equal(r.fadeKinds.reappearancesSlid, 1);
});

test('18.1: a train the service removed and added again is a new record, not a re-appearance', () => {
  const A = wireSpan('sp_A', 51, -0.1, 600);
  const rec = load([line(T0, 'span', A),
    line(T0 + 1000, 'snapshot', { serverTime: T0 + 1000, trains: [wire({ mv: mvOf('sp_A', T0, T0 + 60000) })] }),
    line(T0 + 20000, 'update', { serverTime: T0 + 20000, upsert: [], remove: ['tr1'] }),
    line(T0 + 30000, 'update', { serverTime: T0 + 30000, upsert: [wire({ mv: mvOf('sp_A', T0 + 30000, T0 + 90000) })], remove: [] }),
    line(T0 + 120000, 'update', { serverTime: T0 + 120000, upsert: [], remove: ['tr1'] })]);
  const r = run(rec);
  assert.equal(r.fadeKinds.reappearance, 0);
  assert.equal(r.fadeKinds.readded, 1);
  assert.equal(r.fades, 0);
});

test('aggregate sums raw counts, and the headline is recomputed from them', () => {
  const a = run(slowFixture(90000, 1000)), b = run(slowFixture(8000, 60000));
  const g = R.aggregate([a, b]);
  assert.equal(g.steps, 2); assert.equal(g.slower, 1); assert.equal(g.slowerWaited, 1);
  assert.equal(g.absorbedRaw, 0);
  assert.equal(g.absorbed, 0, '0 absorbed of (2 - 1) steps');
});

test('run() puts engine.advance back (the wrapper that lets the harness see the plans is not left behind)', () => {
  const before = E.advance; run(slowFixture(90000, 1000)); assert.equal(E.advance, before);
});
