'use strict';
// The motion replay (map/test/motion-replay.js) run as a test over the committed recordings, so a change
// that makes trains jump, run backwards or race to catch up fails `npm test`. The harness is also shown to
// be able to see a problem: the same recording under a sabotaged setting must report one.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const R = require('./motion-replay.js');

const FIX = (n) => path.join(__dirname, 'fixtures', n);
const iid = R.load(FIX('sussex-10min-iid.jsonl.gz'));
const pers = R.load(FIX('sussex-10min-persistent.jsonl.gz'));

test('replay: the recordings are real: steps, spans, many trains', () => {
  const r = R.run(iid, { fps: 15 });
  assert.ok(r.steps > 400 && r.trainHours > 5, r.steps + ' steps over ' + r.trainHours + ' train-hours');
  assert.ok(r.recording.spans > 300);
});

test('replay targets that the engine meets on both recordings: catch-up <= 1.5x, no backward moves, no fades, no teleports', () => {
  [iid, pers].forEach((rec, i) => {
    const r = R.run(rec, { fps: 20 });
    assert.ok(r.catchUpMaxRatio <= R.TARGETS.catchUp + 1e-6, 'catch-up ' + r.catchUpMaxRatio + ' (recording ' + i + ')');
    assert.equal(r.backward, 0, 'backward moves');
    assert.ok(r.fadesPerTrainHour < R.TARGETS.fadesPerHour, 'fades ' + r.fadesPerTrainHour);
    assert.equal(r.teleports, 0, 'teleports');
    assert.ok(r.maxJumpM === 0);
  });
});

test('replay: share absorbed by re-timing alone (regression bar; the 90 % target itself is reported by the CLI)', () => {
  const a = R.run(iid, { fps: 15 }), b = R.run(pers, { fps: 15 });
  assert.ok(a.absorbed >= 0.84, 'noisy (iid +-25 %) recording: ' + (a.absorbed * 100).toFixed(1) + ' %');
  assert.ok(b.absorbed >= 0.90, 'persistent-pace recording: ' + (b.absorbed * 100).toFixed(1) + ' %');
});

test('the harness can see a problem: with the render clock only 1 s behind, far fewer steps are absorbed', () => {
  const ok = R.run(iid, { fps: 10, lagMs: 10000 }), bad = R.run(iid, { fps: 10, lagMs: 1000 });
  assert.ok(ok.absorbed - bad.absorbed > 0.25, (ok.absorbed * 100).toFixed(0) + ' % vs ' + (bad.absorbed * 100).toFixed(0) + ' %');
});

test('the harness can see a problem: a train allowed to fade at 50 m reports fades and misses the target', () => {
  const r = R.run(iid, { fps: 10, engine: { fadeM: 50 } });
  assert.ok(r.fades > 0 && r.fadesPerTrainHour >= R.TARGETS.fadesPerHour);
  assert.equal(r.pass, false);
});

test('the report prints the four numbers and a verdict', () => {
  const text = R.report(R.run(pers, { fps: 10 }));
  assert.match(text, /absorbed by re-timing alone/);
  assert.match(text, /catch-up speed, max/);
  assert.match(text, /backward moves/);
  assert.match(text, /fades per train-hour/);
  assert.match(text, /ALL TARGETS MET|TARGETS MISSED/);
});
