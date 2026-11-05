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

test('replay: no frame-to-frame acceleration or deceleration above 1.2 m/s^2 anywhere in either recording', () => {
  [iid, pers].forEach((rec, i) => {
    const r = R.run(rec, { fps: 60 });                               // the finest time step: the bound must hold at 60 fps too
    assert.equal(r.accelOver, 0, 'frames over the bound (recording ' + i + ')');
    assert.ok(r.maxAccel <= 1.2 * 1.02 && r.maxDecel <= 1.2 * 1.02, 'max ' + r.maxAccel + ' / ' + r.maxDecel);
    assert.ok(r.maxAccel > 1.0 || r.maxDecel > 1.0, 'and the bound is actually reached (the check is not vacuous): ' + r.maxAccel + ' / ' + r.maxDecel);
  });
});

test('replay: the recordings contain batched steps (two steps for one train in one update) and they are replayed without a jump', () => {
  let batched = 0;
  iid.events.forEach((e) => { if (e.event !== 'update') return; const seen = {}; e.data.upsert.forEach((t) => { seen[t.id] = (seen[t.id] || 0) + 1; if (seen[t.id] === 2) batched++; }); });
  assert.ok(batched >= 3, 'batched steps in the iid recording: ' + batched);
  const r = R.run(iid, { fps: 20 });
  assert.equal(r.teleports, 0); assert.equal(r.fades, 0);
});

test('replay reads CONTRACT section 16 recordings as the real /debug/record writes them: gzip or plain, unknown events and bad lines skipped, t as the clock', () => {
  const fs = require('fs'), os = require('os'), zlib = require('zlib');
  const lines = fs.readFileSync ? zlib.gunzipSync(fs.readFileSync(FIX('sussex-10min-iid.jsonl.gz'))).toString().trim().split('\n') : [];
  const mangled = lines.map((l, i) => {
    if (i % 50 === 7) return 'not json at all';
    const o = JSON.parse(l);
    if (o.event === 'update') delete o.data.serverTime;                    // the clock comes from t
    return JSON.stringify(o);
  });
  mangled.splice(3, 0, JSON.stringify({ t: 1, event: 'ping', data: {} }), '');
  const plain = path.join(os.tmpdir(), 'rm-sec16-' + process.pid + '.jsonl');
  fs.writeFileSync(plain, mangled.join('\n'));
  const rec = R.load(plain);                                                // plain text, no .gz
  fs.unlinkSync(plain);
  assert.ok(rec.skipped.bad >= 5 && rec.skipped.unknown === 1, JSON.stringify(rec.skipped));
  const r = R.run(rec, { fps: 10 });
  assert.ok(r.steps > 300 && r.backward === 0, r.steps + ' steps');
  const text = R.report(r);
  assert.match(text, /skipped \d+ unreadable, 1 of unknown kind/);
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
  assert.ok(a.absorbed >= 0.88, 'noisy (iid +-25 %) recording: ' + (a.absorbed * 100).toFixed(1) + ' %');
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
