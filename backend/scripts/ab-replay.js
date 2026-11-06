'use strict';
// A/B day replay: two copies of the engine (crossing-state.js), the same recorded day, the same
// frozen clock — and every difference between them. The proof that a refactor changes nothing at
// Portslade, or exactly what a deliberate change moves.
//
//   node scripts/ab-replay.js <day YYYY-MM-DD> <dataDir> <definition.json> <rootA> <rootB> [tickSecs]
//
//   dataDir   holds td-<day>.jsonl (data/logs/td, unzipped) and <day>.jsonl (data/logs, the state
//             log). Optional sched-<day>.json: the day's timetable trains as production parses them
//             (schedule-parser output for the crossing). Without it, the timetable is rebuilt from
//             the state log's last `schedule` entry — fewer fields (no calling pattern), but the same
//             input to both engines, which is all an A/B needs.
//   rootA/B   folders each holding backend/src and backend/data/transits.json, e.g.
//             `git archive <sha> backend/src backend/config backend/data/transits.json | tar -x -C A`.
//   Prints one JSON summary line, then up to 5 example differences. ticksDiffering 0 = identical.
//   Always run a control (a deliberate change that SHOULD differ) before trusting a zero.
//
// First used 2026-11-06 for the merged close algorithm: 4 days, 2.78M per-train predictions, 0 diffs.
//
// Feeds both CrossingState instances the day's real TD berth steps (as recordTdEvent), the
// departure-board snapshots from the state log (as updateLdbTrains), and the timetable trains
// (as updateScheduleTrains), then at every tick recomputes both and compares the full API
// state (closures, state, held flags, reasons) and every train's predicted close.

const fs = require('fs');
const path = require('path');
const [day, dataDir, defFile, rootA, rootB, tickArg] = process.argv.slice(2);
const TICK = (Number(tickArg) || 15) * 1000;

// ---- frozen clock shared by both engines ----
const RealDate = Date;
let NOW = 0;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}
global.Date = FakeDate;

function engine(root) {
  const logger = require(path.join(root, 'backend/src/logger'));
  for (const k of Object.keys(logger)) if (typeof logger[k] === 'function') logger[k] = () => {};
  const CS = require(path.join(root, 'backend/src/crossing-state'));
  CS.prototype._markDirty = function () {};               // recompute only when we say so
  return CS;
}
const A = engine(rootA), B = engine(rootB);
const def = JSON.parse(fs.readFileSync(defFile, 'utf8'));
const silence = fn => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return fn(); } finally { console.warn = w; console.log = l; } };

// ---- inputs ----
const td = fs.readFileSync(path.join(dataDir, `td-${day}.jsonl`), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  .filter(r => r.desc && (r.event === 'CA' || r.event === 'CB'))
  .map(r => ({ headcode: r.desc, ts: r.ts, area: r.area, event: r.event, from: r.from, to: r.to, ms: RealDate.parse(r.ts) }))
  .sort((a, b) => a.ms - b.ms);
const ldb = [];
for (const line of fs.readFileSync(path.join(dataDir, `${day}.jsonl`), 'utf8').split('\n')) {
  if (!line.includes('"cat":"ldb"')) continue;
  const r = JSON.parse(line);
  if (r.crossing !== 'portslade') continue;
  ldb.push({ ms: RealDate.parse(r.ts), trains: r.trains.map(t => ({
    origin: t.origin, destination: t.dest, operator: '?', scheduledTime: t.sch, bestTime: t.best,
    direction: t.dir, delayMins: t.delay || 0, isUncertain: false, timeSource: t.src || 'forecast',
    etaText: '', headcode: t.headcode, uid: null,
    trainType: /^[67]/.test(t.headcode || '') ? 'freight' : /^5/.test(t.headcode || '') ? 'ecs' : 'passenger',
    source: 'ldbsv', schedArr: '', schedDep: '', liveArr: '', liveDep: '', dedupKey: `${t.sch}|${t.dest}`
  })) });
}
const schedFile = path.join(dataDir, `sched-${day}.json`);
let sched;
if (fs.existsSync(schedFile)) sched = JSON.parse(fs.readFileSync(schedFile, 'utf8'));
else {
  let last = null;
  for (const line of fs.readFileSync(path.join(dataDir, `${day}.jsonl`), 'utf8').split('\n')) {
    if (!line.includes('"cat":"schedule"')) continue;
    const r = JSON.parse(line); if (r.crossing === 'portslade') last = r;
  }
  sched = (last ? last.trains : []).map(t => { const [h, m] = t.estTime.split(':').map(Number); return {
    uid: t.uid, headcode: t.headcode, category: t.category, operator: t.operator,
    trainType: t.category === 'EE' ? 'ecs' : /^[67]/.test(t.headcode || '') ? 'freight' : 'passenger',
    direction: t.dir, estimatedCrossingMins: h * 60 + m, source: 'cif', legIndex: 0, legCount: 1,
    callsAtStation: null, callsAtApproach: null, runsAsRequired: false, origin: null, destination: null }; });
}

// ---- run ----
const start = Math.max(RealDate.parse(`${day}T00:30:00Z`), td.length ? td[0].ms : 0);
const end = Math.min(td.length ? td[td.length - 1].ms : 0, ldb.length ? ldb[ldb.length - 1].ms : 0);
NOW = start;
const a = new A('portslade', JSON.parse(JSON.stringify(def)));
const b = new B('portslade', JSON.parse(JSON.stringify(def)));
silence(() => { a.updateScheduleTrains(JSON.parse(JSON.stringify(sched))); b.updateScheduleTrains(JSON.parse(JSON.stringify(sched))); });

let ti = 0, li = -1, ticks = 0, diffs = 0, closures = 0, held = 0, trainsCompared = 0;
const examples = [];
const norm = s => { const o = JSON.parse(JSON.stringify(s)); delete o.lastRefresh; return JSON.stringify(o); };
for (let t = start; t <= end; t += TICK) {
  NOW = t;
  while (ti < td.length && td[ti].ms <= t) { const e = td[ti++]; a.recordTdEvent(e); b.recordTdEvent(e); }
  let changed = false;
  while (li + 1 < ldb.length && ldb[li + 1].ms <= t) { li++; changed = true; }
  if (changed) { const tr = ldb[li].trains; silence(() => { a.updateLdbTrains(JSON.parse(JSON.stringify(tr))); b.updateLdbTrains(JSON.parse(JSON.stringify(tr))); }); }
  silence(() => { a._recompute(); b._recompute(); });
  const sa = norm(a.getApiState(6)), sb = norm(b.getApiState(6));
  ticks++;
  const st = JSON.parse(sa); closures += (st.upcomingClosures || []).length;
  held += (st.upcomingClosures || []).filter(c => c.closePending || c.holdingOpen || (c.trains || []).some(x => x.held)).length;
  // every merged train's predicted close, through each engine's own function
  const ma = silence(() => a._mergeTrains(new Date(t))), mb = silence(() => b._mergeTrains(new Date(t)));
  const ca = JSON.stringify(ma.map(x => [x.headcode, x.direction, a._closeTimeInfo(x, new Date(t))]));
  const cb = JSON.stringify(mb.map(x => [x.headcode, x.direction, b._closeTimeInfo(x, new Date(t))]));
  trainsCompared += ma.length;
  if (sa !== sb || ca !== cb) {
    diffs++;
    if (examples.length < 5) examples.push({ at: new RealDate(t).toISOString(), api: sa !== sb, perTrain: ca !== cb, a: ca.slice(0, 300), b: cb.slice(0, 300) });
  }
}
global.Date = RealDate;
console.log(JSON.stringify({ day, ticks, tdEvents: ti, ldbSnapshots: li + 1, timetableTrains: sched.length,
  closuresSeen: closures, heldClosures: held, trainPredictionsCompared: trainsCompared, ticksDiffering: diffs }));
for (const e of examples) console.log('DIFF', JSON.stringify(e));
