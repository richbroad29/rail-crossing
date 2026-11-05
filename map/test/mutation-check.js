#!/usr/bin/env node
'use strict';
// "Prove the tests bite." Breaks the motion engine one rule at a time, in a scratch copy, and requires
// engine.test.js to FAIL for each break. A mutation that survives means a rule has no test behind it.
//
//   node map/test/mutation-check.js            (about 30 s)
//
// Not matched by `node --test map/test/*.test.js`; exits non-zero if any mutation survives.
if (process.env.NODE_TEST_CONTEXT) { console.log('mutation-check is not a unit test; run: node map/test/mutation-check.js'); process.exit(0); }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = fs.readFileSync(path.join(__dirname, '../engine.js'), 'utf8');
const TEST = fs.readFileSync(path.join(__dirname, 'engine.test.js'), 'utf8');

const MUTATIONS = [
  ['rule 5: the catch-up limit is 3x, not 1.5x', 'cap: 1.5,', 'cap: 3,'],
  ['rule 5: the catch-up limit is not enforced', 'var vmax = cfg.cap * Math.max(vc, o.vcp);', 'var vmax = 1e9;'],
  ['rule 5: the cap ignores the span we are leaving (speed snapped down on entering a slower one)', 'var vmax = cfg.cap * Math.max(vc, o.vcp);', 'var vmax = cfg.cap * vc; o.vcp = 0;'],
  ['bound: speed may rise faster than 1.2 m/s^2', 'acc: 1.2,', 'acc: 3,'],
  ['bound: speed may fall faster than 1.2 m/s^2', 'brk: 1.2,', 'brk: 3,'],
  ['batched steps / jumps: a gap is slid across instead of faded', 'if (gap > cfg.slideM) {', 'if (false) {'],
  ['rule 3: the hold margin is 0 (it does not stop short)', 'holdM: 30,', 'holdM: 0,'],
  ['rule 3: the train may run onto the end with no step', 'var wall = before + (m + 1 < plans.length ? plans[m].L : plans[m].hold);', 'var wall = 1e9;'],
  ['rule 3: no stopping lookahead across known spans', 'while (m + 1 < plans.length && plans[m + 1].span) { before += plans[m].L; m++; }', ''],
  ['rule 1: the render clock is not behind the server clock', 'lagMs: 12000,', 'lagMs: 0,'],
  ['rule 4: a step does not re-time the span (it keeps the expected exit)', '((next ? next.t0 : p.eta) - p.t0) / 1000', '(p.eta - p.t0) / 1000'],
  ['rule 5: neither floor on speed (the train can move backwards)', 'if (vdes < 0) vdes = 0;', '', 'o.v += dv; if (o.v < 0) o.v = 0;', 'o.v += dv;'],
  ['rule 6: nothing ever fades (the 2 km rule is gone)', 'fadeM: 2000,', 'fadeM: 2e9,'],
  ['rule 6: a sleeping tab is integrated, not resynced', 'if (dt > 20) {', 'if (dt > 2000000) {'],
  ['rule 7: a rounding-sized gap between spans is jumped, not blended', 'if (gap > cfg.blendM) {', 'if (false) {'],
  ['reverse: an about-turn rotates slowly instead of at once', 'else if (Math.abs(angDiff(o.hdg, tgt)) > 100) o.hdg = tgt;', ''],
  ['rule 2: a call has no dwell', 'D = dwell == null ? DEFAULTS.dwellDefault : Math.max(0, dwell);', 'D = 0;'],
  ['rule 2: a pass is not constant speed (it eases in)', 'if (!P.call) { out.s = P.L * tau / P.T; out.v = P.vc; return out; }', 'if (!P.call) { var f = tau / P.T; out.s = P.L * f * f; out.v = 2 * P.vc * f; return out; }'],
  ['determinism: the integration step is random', 'var maxStep = dt > 8 ? 0.25 : cfg.maxStep;', 'var maxStep = dt > 8 ? 0.25 : cfg.maxStep * (0.3 + Math.random());'],
  ['geometry not arrived: the train drives into a span it has not got', 'plans[o.k + 1].span && o.s >= plans[o.k].L', 'o.s >= plans[o.k].L', 'var open = next && next.span, wall = -1;', 'var open = !!next, wall = -1;'],
  ['the train does not wait for a held flag', 'var H = p.held && p.stop != null ? Math.min(p.hold, p.stop) : p.hold;', 'var H = p.hold;'],
  ['the waiting state never shows', 'o.wait = (atWall && !atPlatform && (cur.tau > cur.T || p.held))', 'o.wait = (false && atWall && !atPlatform && (cur.tau > cur.T || p.held))'],
  ['first sight: the train pops in instead of fading in', 'o.init = true; o.ready = true; o.t = R; o.alpha = 0; o.fade = 2;', 'o.init = true; o.ready = true; o.t = R; o.alpha = 1; o.fade = 0;'],
  ['the render clock jumps instead of slewing', 'offset += d > m ? m : d < -m ? -m : d;', 'offset += d;']
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-mut-'));
fs.mkdirSync(path.join(dir, 'test'));
fs.writeFileSync(path.join(dir, 'test', 'engine.test.js'), TEST);
let survived = 0;
console.log('baseline: ' + (run(SRC).status === 0 ? 'engine tests pass' : 'ENGINE TESTS FAIL ON THE REAL CODE'));
for (const [name, from, to, from2, to2] of MUTATIONS) {
  if (!SRC.includes(from) || (from2 && !SRC.includes(from2))) { console.log('SKIP  (mutation text not found, update this list): ' + name); survived++; continue; }
  let code = SRC.replace(from, to); if (from2) code = code.replace(from2, to2);
  const r = run(code);
  const failed = (r.stdout.match(/^not ok \d+ - .*/gm) || []).map((l) => l.replace(/^not ok \d+ - /, ''));
  if (r.status !== 0) console.log('killed   ' + name + '\n           by: ' + (failed[0] || 'a crash') + (failed.length > 1 ? '  (+' + (failed.length - 1) + ' more)' : ''));
  else { survived++; console.log('SURVIVED ' + name); }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + (MUTATIONS.length - survived) + ' of ' + MUTATIONS.length + ' mutations killed' + (survived ? '; ' + survived + ' survived' : ''));
process.exit(survived ? 1 : 0);

function run(code) {
  fs.writeFileSync(path.join(dir, 'engine.js'), code);
  return spawnSync(process.execPath, ['--test', path.join(dir, 'test', 'engine.test.js')], { encoding: 'utf8', timeout: 120000 });
}
