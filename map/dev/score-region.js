#!/usr/bin/env node
'use strict';
// Scores every rolling-record segment of one region through the replay harness and prints ONE JSON line: the
// aggregate (motion-replay.js aggregate()) plus a per-file summary. Segments are scored one by one (each opens
// with a snapshot, so a train's first frame in a segment is not a fade) and summed.
//
//   node map/dev/score-region.js <dir of <region>-<start>.jsonl> <region> [lagMs, default 12000]
const fs = require('fs'), path = require('path');
const R = require('../test/motion-replay.js');
const [dir, region, lag] = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.startsWith(region + '-2') && f.endsWith('.jsonl')).sort();
const per = [];
for (const f of files) {
  try { const r = R.run(R.load(path.join(dir, f)), { lagMs: Number(lag || 12000) }); r.file = f; per.push(r); }
  catch (e) { console.error(f, e.message); }
}
const A = R.aggregate(per);
A.region = region;
A.perFile = per.map((r) => ({ f: r.file, th: r.trainHours, steps: r.steps, abs: +r.absorbed.toFixed(3), fades: r.fades, gap: r.fadeKinds.gap, behind: r.fadeKinds.behind, reapp: r.fadeKinds.reappearance, readded: r.fadeKinds.readded, cu: r.catchUpMaxRatio, back: r.backward, accelOver: r.accelOver }));
console.log(JSON.stringify(A));
