#!/usr/bin/env node
'use strict';
/**
 * track-days.js — replay whole days of berth logs through the real td-listener into the berth tracker
 * (src/berth-first/tracker.js), and report how well it followed the trains that crossed
 * (berth-first-v1-plan §6 step 3: proof on real data, before the engine is built on it).
 *
 *   node tools/track-days.js <crossing> <from-date> <to-date> [--logs DIR]
 *
 * Reads config/crossings/<crossing>.routes.json for the areas, the shared berths and the clear steps.
 * Per direction it counts every clear step the tracker saw and asks of the train that made it:
 *   - was it a train before it reached the crossing (it had stepped on the approach), or did it appear
 *     from nowhere at the last berth (tracking lost);
 *   - how long before the crossing the tracker had it (minutes from its first sighting, path kept 90 min);
 *   - was another entry with the same label on the approach at the same time (a duplicate).
 * And it checks the count against the raw log: every clear step in the messages, the same step reported
 * by two areas counted once. At each day's end: trains on the routes that have not moved for 30 min
 * (left-over labels a stall rule would show as "Delayed").
 * Days are replayed back to back, so trains carry over midnight.
 */

const fs = require('fs');
const path = require('path');
const { dayFrames } = require('./lib/replay-feed');
const { catalogue, datesBetween } = require('./lib/td-sources');
const { BerthTracker } = require('../src/berth-first/tracker');
const { compileRoutes } = require('../src/berth-first/routes');

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i]; else pos.push(argv[i]); }
  if (pos.length < 3) { console.error('usage: node tools/track-days.js <crossing> <from> <to> [--logs DIR]'); process.exit(2); }
  return { id: pos[0], from: pos[1], to: pos[2], opt };
}

const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.round((s.length - 1) * p))] * 10) / 10; };

async function main() {
  const { id, from, to, opt } = parseArgs(process.argv.slice(2));
  const root = path.join(__dirname, '..');
  const routes = compileRoutes(JSON.parse(fs.readFileSync(path.join(root, 'config', 'crossings', `${id}.routes.json`), 'utf8')));
  const logs = opt.logs || path.join(root, 'data', 'logs');
  const cat = catalogue({ tdAllDir: path.join(logs, 'td-all'), sclassDir: path.join(logs, 'sclass'), tdDir: path.join(logs, 'td') });

  // The real listener, its log writes sent nowhere.
  const realAppend = fs.appendFile;
  fs.appendFile = (f, d, o, cb) => { const c = typeof o === 'function' ? o : cb; if (c) c(null); };
  const td = require('../src/td-listener');
  td._setCrossingAreasForTest(routes.areas);

  const clearByStep = new Map(routes.clears.map(c => [`${c.from}>${c.to}`, c.dir]));
  const stats = {};
  for (const d of routes.dirs) stats[d] = { clears: 0, wasTrain: 0, fromNowhere: 0, duplicate: 0, mins: [], rawClears: 0, examples: { fromNowhere: [], duplicate: [] } };
  const tr = new BerthTracker({ sameBerths: routes.sameBerths, preferArea: routes.preferArea, knownSteps: routes.steps, onEvent: ev => {
    if (ev.type !== 'move') return;
    const dir = clearByStep.get(`${ev.from}>${ev.to}`);
    if (!dir) return;
    const s = stats[dir], e = ev.entry;
    s.clears++;
    const steppedBefore = e.path.length >= 3 && e.born.kind !== 'stepFromEmpty' || e.path.length >= 4;
    if (steppedBefore) s.wasTrain++;
    else { s.fromNowhere++; if (s.examples.fromNowhere.length < 6) s.examples.fromNowhere.push(`${new Date(ev.t).toISOString().slice(0, 19)}Z ${e.label}`); }
    s.mins.push((ev.t - e.path[0][1]) / 60000);
    const dup = tr.trains().filter(x => x !== e && x.label === e.label && routes.onRoute(x.key)[dir] !== undefined && ev.t - x.lastMove < 10 * 60e3);
    if (dup.length) { s.duplicate++; if (s.examples.duplicate.length < 6) s.examples.duplicate.push(`${new Date(ev.t).toISOString().slice(0, 19)}Z ${e.label} also at ${dup.map(x => x.key).join(',')}`); }
  } });
  td.on('berth', e => tr.event(e));

  const ghosts = [];
  const sources = {};
  const quiet = console.log;
  for (const d of datesBetween(from, to)) {
    const day = await dayFrames(cat, d, routes.areas);
    for (const [a, u] of Object.entries(day.used)) { sources[a] = sources[a] || {}; sources[a][u || 'none'] = (sources[a][u || 'none'] || 0) + 1; }
    // The raw count: clear steps in the messages, one per train however many areas report it.
    // Two areas' reports of one step are a few seconds apart: one step per train within 5 s.
    const lastAt = new Map();
    for (const f of day.frames) for (const w of JSON.parse(f.body)) for (const m of Object.values(w)) {
      if (!m.from || !m.to) continue;
      const k = `${routes.canon(`${m.area_id}:${m.from}`)}>${routes.canon(`${m.area_id}:${m.to}`)}`;
      const dir = clearByStep.get(k);
      if (!dir) continue;
      const key = `${dir}|${m.descr}`, t = +m.time;
      if (lastAt.has(key) && Math.abs(t - lastAt.get(key)) <= 5000) continue;
      lastAt.set(key, t); stats[dir].rawClears++;
    }
    console.log = () => {};
    try { for (const f of day.frames) td._processMessageForTest(f.body); } finally { console.log = quiet; }
    // Trains on the routes that have not moved for 30 min at the end of the day.
    const end = day.frames.length ? day.frames[day.frames.length - 1].ms : 0;
    for (const e of tr.trains()) {
      const on = routes.onRoute(e.key);
      if (Object.keys(on).length && end - e.lastMove > 30 * 60e3) ghosts.push(`${d} ${e.label} at ${e.key} since ${new Date(e.lastMove).toISOString().slice(11, 16)}Z`);
    }
    process.stderr.write(`  ${d}: ${day.frames.length} frames\n`);
  }
  fs.appendFile = realAppend;

  console.log(`${id} ${from}..${to}: areas ${routes.areas.join('+')}; sources ${JSON.stringify(sources)}`);
  for (const [d, s] of Object.entries(stats)) {
    console.log(`${d}: ${s.clears} clear steps tracked (raw log ${s.rawClears}); a train before the crossing ${s.wasTrain} (${Math.round(s.wasTrain / s.clears * 1000) / 10}%), ` +
      `from nowhere ${s.fromNowhere}, a duplicate on the approach ${s.duplicate}; had it for median ${q(s.mins, 0.5)} min (p10 ${q(s.mins, 0.1)})`);
    if (s.examples.fromNowhere.length) console.log(`  from nowhere e.g. ${s.examples.fromNowhere.join('; ')}`);
    if (s.examples.duplicate.length) console.log(`  duplicate e.g. ${s.examples.duplicate.join('; ')}`);
  }
  console.log(`tracker: ${JSON.stringify(tr.stats)}`);
  console.log(`still on the routes, unmoved 30+ min at a day's end: ${ghosts.length}${ghosts.length ? ' e.g. ' + ghosts.slice(0, 8).join('; ') : ''}`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
