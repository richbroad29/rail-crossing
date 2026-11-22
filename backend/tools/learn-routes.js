#!/usr/bin/env node
'use strict';
/**
 * learn-routes.js — learn a crossing's routes and berth calibration from the logs
 * (docs/berth-first-design.md §5.1, §5.5-5.8, §5.11, §9.5-9.8; berth-first-v1-plan §4).
 *
 *   node tools/learn-routes.js <crossing> <from-date> <to-date> [options]
 *
 * Follows every train berth by berth across the areas it needs, and walks back from every clear step
 * over the berths that train used. Writes config/crossings/<crossing>.routes.json:
 *   areas                         every TD area the routes cross (the listener must hear them all)
 *   directions.<d>.routes         every route in, outermost berth first, with how often it is used
 *   directions.<d>.routes[].lastJunction   from which berth every train goes on to cross
 *   directions.<d>.routes[].outermost      first berth on our map, and its offset from the timetable
 *   directions.<d>.startingPlatforms       where trains start inside the covered areas
 *   directions.<d>.berths         normal time per berth per class, stall threshold, one train per
 *                                 berth (holds / exempt), share of trains that go on to cross
 *   directions.<d>.overtaking     trains that reached the crossing in a different order
 *   directions.<d>.runThrough     per station: what separates trains that stop from those that don't
 *   feedHealth.<area>             heartbeat and silence, for the outage message (§5.11)
 *   truth                         (crossings with barrier data) every clear step against the barrier
 * Every number carries n and the dates it came from.
 *
 * The crossing comes from config/crossings/<id>.json (td.area, td.<dir>.clear, schedule.*), or for a
 * crossing with no definition yet from config/crossings/<id>.seed.json (see the seeds beside it).
 * The seed's clear steps can be found from barrier data first:
 *   node tools/learn-routes.js <crossing> <from> <to> --find-clear
 *
 * Areas: starts from the crossing's own area and adds any neighbour that hands trains in less than
 * 30 min before the crossing (seen on days with the national log), until none is left.
 *
 * Options:
 *   --logs DIR      logs folder holding td-all/, sclass/ and td/   (default backend/data/logs)
 *   --td-all DIR, --sclass DIR, --td DIR     override one of them
 *   --cif FILE      a full CIF extract (default: newest data/schedule/archive/cif-full-*, else cif-latest)
 *   --out FILE      default config/crossings/<crossing>.routes.json
 *   --areas A,B     areas to read from the start, besides the crossing's own
 *   --no-discover   don't add neighbouring areas
 *   --find-clear    print the berth steps that best match the barrier going up, and stop
 *
 * On the VPS (952 MB): nice -n 19 node --max-old-space-size=600 tools/learn-routes.js ...
 * A long window over a busy area wants more; the Mac is the better place for 90 days.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');
const { catalogue, datesBetween, readDay } = require('./lib/td-sources');
const { RouteTracker, countSameSteps, chooseSameBerths } = require('./lib/route-tracker');
const { loadCif, link, classOf } = require('./lib/cif-link');
const { londonDateStamp } = require('../src/time-utils');

const HORIZON_CAP_MS = 60 * 60e3;   // a route is walked back at most 60 min from the clear step
const ADD_AREA_MINS = 30;           // a neighbour handing trains in closer than this is read too
const TARGET_MINS = 25;             // design D2
const MIN_ROUTE_RUNS = 3, MIN_ROUTE_SHARE = 0.005;
const FRESH_OCCUPANT_MS = 30 * 60e3;
const ONE_PER_BERTH_MAX_RATE = 0.001;
const DIVERGE_MAX_RATE = 0.005;

// ---------------------------------------------------------------- small statistics
const sorted = a => a.slice().sort((x, y) => x - y);
function q(a, p) { if (!a.length) return null; const s = sorted(a); return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]; }
const r1 = x => x === null || x === undefined ? null : Math.round(x * 10) / 10;
function dist(a) {
  if (!a.length) return { n: 0 };
  return { n: a.length, p10: r1(q(a, 0.1)), p50: r1(q(a, 0.5)), p90: r1(q(a, 0.9)), p95: r1(q(a, 0.95)), p99: r1(q(a, 0.99)), max: r1(q(a, 1)) };
}
function prov(runs) {
  const days = runs.map(r => r.day).filter(Boolean).sort();
  return { n: runs.length, from: days[0] || null, to: days[days.length - 1] || null };
}
const londonDay = t => londonDateStamp(new Date(t));

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['no-discover', 'find-clear'].includes(k)) opt[k] = true;
      else opt[k] = argv[++i];
    } else pos.push(a);
  }
  if (pos.length < 3) {
    console.error('usage: node tools/learn-routes.js <crossing> <from-date> <to-date> [--logs DIR] [--cif FILE] [--out FILE] [--areas A,B] [--no-discover] [--find-clear]');
    process.exit(2);
  }
  const [id, from, to] = pos;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    console.error('dates must be YYYY-MM-DD, from <= to'); process.exit(2);
  }
  return { id, from, to, opt };
}

// ---------------------------------------------------------------- the crossing
function loadSpec(id, configDir) {
  const defFile = path.join(configDir, `${id}.json`);
  const seedFile = path.join(configDir, `${id}.seed.json`);
  if (fs.existsSync(defFile)) {
    const def = JSON.parse(fs.readFileSync(defFile, 'utf8'));
    const area = def.td.area;
    const dirs = Object.keys(def.directions).filter(k => !k.startsWith('_'));
    return {
      id, source: `config/crossings/${id}.json`, area, dirs,
      clears: dirs.map(d => ({ dir: d, area: def.td[d].clear.area || area, from: def.td[d].clear.from, to: def.td[d].clear.to,
        provenance: `definition td.${d}.clear` })),
      point: { station: def.schedule.tiploc_station },
      before: def.schedule.tiplocsBefore,
      barrier: def.sclass && def.sclass.crossing ? { crossing: def.sclass.crossing } : null
    };
  }
  if (fs.existsSync(seedFile)) {
    const s = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    const dirs = Object.keys(s.directions);
    return {
      id, source: `config/crossings/${id}.seed.json`, area: s.area, dirs,
      clears: dirs.map(d => ({ dir: d, area: s.directions[d].clear.area || s.area, from: s.directions[d].clear.from,
        to: s.directions[d].clear.to, provenance: s.directions[d].clear._provenance || 'seed' })),
      point: s.schedule.station ? { station: s.schedule.station } : { between: s.schedule.between, fraction: s.schedule.fraction },
      before: s.schedule.before,
      barrier: s.barrier || null
    };
  }
  throw new Error(`no config/crossings/${id}.json or ${id}.seed.json`);
}

// ---------------------------------------------------------------- barrier truth
function readBarrier(sclassDir, crossing, dates) {
  const ev = [];
  for (const d of dates) {
    for (const f of [`barrier-${d}.jsonl.gz`, `barrier-${d}.jsonl`]) {
      const p = path.join(sclassDir, f);
      if (!fs.existsSync(p)) continue;
      const txt = f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(p)).toString() : fs.readFileSync(p, 'utf8');
      for (const l of txt.split('\n')) {
        if (!l) continue;
        let o; try { o = JSON.parse(l); } catch (e) { continue; }
        if (crossing && o.crossing !== crossing) continue;
        ev.push({ t: Date.parse(o.feedTime || o.ts), phase: o.phase, day: d });
      }
      break;
    }
  }
  ev.sort((a, b) => a.t - b.t);
  // Closures: LOWER_START .. RAISE_START.
  const closures = [];
  let open = null;
  for (const e of ev) {
    if (e.phase === 'LOWER_START') open = { start: e.t, day: e.day };
    else if (e.phase === 'RAISE_START' && open) { open.end = e.t; closures.push(open); open = null; }
  }
  return { events: ev, closures, days: [...new Set(ev.map(e => e.day))].sort() };
}

// ---------------------------------------------------------------- one tracking pass
async function trackPass(spec, cat, dates, areas, sameBerths = []) {
  const runs = [], ended = new Map(), occupied = [], nationalFrom = new Map();
  const coverage = {}, health = {};
  for (const a of areas) { coverage[a] = { days: 0, perArea: 0, tdAll: 0, missing: [] }; health[a] = { days: [] }; }
  const clearPairs = new Set(spec.clears.map(c => `${c.area}:${c.from}>${c.area}:${c.to}`));

  const tracker = new RouteTracker({
    clears: spec.clears, preferArea: spec.area, sameBerths,
    onRun: ({ dir, t, descr, entry }) => {
      const p = entry.path;
      const seg = [];
      const seen = new Set();
      let start = null;
      for (let i = p.length - 2; i >= 0; i--) {
        const [key, ti] = p[i];
        if (t - ti > HORIZON_CAP_MS) { start = { kind: 'horizonCap' }; break; }
        if (seen.has(key)) { start = { kind: 'loop' }; break; }
        if (i < p.length - 2 && clearPairs.has(`${key}>${p[i + 1][0]}`)) { start = { kind: 'previousCrossing' }; break; }
        seen.add(key);
        seg.push([key, ti]);
        if (i === 0) start = { ...entry.born };
      }
      seg.reverse();
      // A train that turned back (crossed, reversed at a terminus, and comes back re-described): its
      // route starts where it became this train, not at its previous crossing.
      if (start && (start.kind === 'previousCrossing' || start.kind === 'loop') && entry.relabelAt) {
        const cutAt = p.length - 1 - seg.length - 1;            // index of the berth we stopped before
        const rb = entry.relabelAt.filter(([i]) => i > cutAt && i <= p.length - 2).pop();
        if (rb) {
          const drop = rb[0] - (cutAt + 1);
          seg.splice(0, drop);
          seg[0] = [seg[0][0], rb[1]];
          start = { kind: 'turnback', key: seg[0][0], t: rb[1] };
        }
      }
      runs.push({ dir, t, descr, labels: entry.labels.slice(), entryId: entry.id, seg, start, day: londonDay(t),
        toKey: p[p.length - 1][0] });
    },
    onEnd: e => { ended.set(e.id, { path: e.path, born: e.born, end: e.end, descr: e.descr }); },
    onOccupied: ({ key, t, mover, occupants }) => {
      occupied.push({ key, t, moverId: mover.id, occ: occupants.map(o => ({ id: o.id, since: o.path[o.path.length - 1][1], stepped: o.path.length > 1 || o.born.kind !== 'interpose' })) });
    }
  });

  let lastT = 0;
  for (const date of dates) {
    const day = await readDay(cat, date, areas, { foreign: true });
    for (const a of areas) {
      const u = day.used.get(a);
      if (!u) { coverage[a].missing.push(date); continue; }
      coverage[a].days++; coverage[a][u.kind]++;
      coverage[a].from = coverage[a].from || date; coverage[a].to = date;
    }
    // Feed health from the national log's heartbeats.
    for (const a of areas) {
      const hb = day.heartbeats.get(a);
      if (!hb || hb.length < 100) continue;
      const all = hb.concat(day.events.filter(e => e.area === a).map(e => e.t)).sort((x, y) => x - y);
      const ct = []; for (let i = 1; i < hb.length; i++) ct.push((hb[i] - hb[i - 1]) / 1000);
      let maxSilence = 0, at = null;
      for (let i = 1; i < all.length; i++) { const g = (all[i] - all[i - 1]) / 1000; if (g > maxSilence) { maxSilence = g; at = all[i - 1]; } }
      const first = all[0], last = all[all.length - 1];
      health[a].days.push({ date, ct, maxSilence, maxSilenceAt: at && new Date(at).toISOString(), spanHours: r1((last - first) / 3600e3) });
    }
    if (day.tdAllFirst) nationalFrom.set(date, day.tdAllFirst);
    tracker.processDay(day.events, day.foreignMatches, day.tdAllFirst || null);
    if (day.events.length) lastT = day.events[day.events.length - 1].t;
    process.stderr.write(`  ${date}: ${day.events.length} events, ${runs.length} runs so far\r`);
  }
  tracker.flush(lastT);
  process.stderr.write('\n');
  return { runs, ended, occupied, coverage, health, stats: tracker.stats, nationalFrom, arrivals: tracker.arrivals, sameBerths: tracker.equivalences() };
}

// Neighbours that hand trains in close to the crossing.
function discover(pass, areas, dirs) {
  const add = new Map();
  for (const d of dirs) {
    const rs = pass.runs.filter(r => r.dir === d);
    // Headcodes repeat across the country in the same minutes (insight 3), so a lone match with a far
    // area is a coincidence. A real neighbour hands trains over at the same pair of berths again and again.
    const pairs = new Map();
    for (const r of rs) {
      if (!r.start || r.start.kind !== 'handover' || areas.includes(r.start.fromArea)) continue;
      const mins = r.seg.length ? (r.t - r.seg[0][1]) / 60000 : 0;
      if (mins >= ADD_AREA_MINS) continue;
      const k = `${r.start.fromArea}:${r.start.fromBerth}>${r.seg[0][0]}`;
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
    const by = new Map();
    for (const [k, n] of pairs) if (n >= MIN_ROUTE_RUNS) { const a = k.slice(0, 2); if (!by.has(a)) by.set(a, { n: 0, at: [] }); by.get(a).n += n; by.get(a).at.push(`${k} (${n})`); }
    for (const [a, x] of by) if (x.n >= 0.02 * rs.length) add.set(a, `${d}: ${x.n} of ${rs.length} trains handed in from ${a} under ${ADD_AREA_MINS} min out, at ${x.at.join(', ')}`);
  }
  return add;
}

// ---------------------------------------------------------------- analyses
function buildTrie(runs, rootKey) {
  const root = { key: rootKey, n: 0, children: new Map(), starts: [] };
  for (const r of runs) {
    let node = root; root.n++;
    const s = r.seg;
    if (!s.length || s[s.length - 1][0] !== rootKey) { r.offRoot = true; continue; }
    for (let i = s.length - 2; i >= 0; i--) {
      const k = s[i][0];
      if (!node.children.has(k)) node.children.set(k, { key: k, n: 0, children: new Map(), starts: [], parent: node });
      node = node.children.get(k); node.n++;
    }
    // A train first seen more than an hour out has no "start" here: it is simply well covered.
    if (r.start && r.start.kind === 'horizonCap') { root.capped = (root.capped || 0) + 1; continue; }
    node.starts.push(r);
  }
  return root;
}

function pathToRoot(node) { const out = []; for (let x = node; x; x = x.parent) out.push(x.key); return out; }

function startKind(r, fringe) {
  if (!r.start) return 'unknown';
  if ((r.start.kind === 'interpose' || r.start.kind === 'stepFromEmpty') && fringe.has(r.seg[0] && r.seg[0][0])) return 'handoverInferred';
  return r.start.kind;
}
const isPlatformStart = k => k === 'interpose' || k === 'turnback';

function analyseDirection(spec, d, pass, cif, fringe, barrier) {
  const clear = spec.clears.find(c => c.dir === d);
  const rootKey = `${clear.area}:${clear.from}`;
  const runs = pass.runs.filter(r => r.dir === d);
  const out = { clear: { area: clear.area, from: clear.from, to: clear.to, provenance: clear.provenance }, runs: prov(runs) };
  if (!runs.length) { out.note = 'no clear steps seen in the window'; return out; }

  // Link to the timetable.
  let linked = 0;
  for (const r of runs) {
    r.link = cif ? link(cif, { descr: r.descr, dir: d, t: r.t }) : null;
    if (r.link) linked++;
    r.cls = classOf(r.link && r.link.sched.category, r.descr);
  }
  out.runs.linkedToTimetable = linked;

  // ---- routes
  const trie = buildTrie(runs, rootKey);
  const leaves = [];
  (function walk(node) {
    if (node.starts.length) leaves.push(node);
    for (const c of node.children.values()) walk(c);
  })(trie);
  // Share is over the days on which the route's outermost area was read.
  const daysWith = area => new Set((pass.coverage[area] ? datesOf(pass, area) : []));
  const routes = [], minor = [], midRoute = [];
  for (const leaf of leaves) {
    const area = leaf.key.slice(0, 2);
    const okDays = daysWith(area);
    const denom = runs.filter(r => okDays.has(r.day)).length || runs.length;
    const kinds = {};
    for (const r of leaf.starts) { const k = startKind(r, fringe); kinds[k] = (kinds[k] || 0) + 1; }
    const item = { leaf, n: leaf.starts.length, share: leaf.starts.length / denom, kinds };
    const unseenStart = (kinds.handoverInferred || 0) + (kinds.stepFromEmpty || 0);
    if (leaf.children.size && unseenStart >= item.n / 2) midRoute.push(item);       // the same trains, seen from part-way in
    else if (item.n >= MIN_ROUTE_RUNS && item.share >= MIN_ROUTE_SHARE) routes.push(item); else minor.push(item);
  }
  routes.sort((a, b) => b.n - a.n);

  // ---- per-berth inward graph: which berth a train goes to next on the way in
  const inward = new Map();   // key → Set(next key toward the crossing)
  for (const r of runs) {
    const s = r.seg;
    for (let i = 0; i < s.length; i++) {
      const next = i + 1 < s.length ? s[i + 1][0] : `${clear.area}:${clear.to}`;
      if (!inward.has(s[i][0])) inward.set(s[i][0], new Set());
      inward.get(s[i][0]).add(next);
    }
  }
  const routeKeys = new Set();
  for (const rt of routes) for (const k of pathToRoot(rt.leaf)) routeKeys.add(k);

  // ---- what happens to every train that enters a route berth heading in (shared berths)
  const fate = new Map(); for (const k of routeKeys) fate.set(k, { entered: 0, crossed: 0, left: {}, ended: {} });
  const clearTo = `${clear.area}:${clear.to}`;
  for (const e of pass.ended.values()) {
    const p = e.path;
    for (let i = 0; i < p.length; i++) {
      const k = p[i][0];
      if (!routeKeys.has(k)) continue;
      const prev = i > 0 ? p[i - 1][0] : null;
      const headingIn = i === 0 || (inward.has(prev) && inward.get(prev).has(k));
      if (!headingIn) continue;
      const f = fate.get(k); f.entered++;
      // Follow it in.
      let j = i, outcome = null;
      while (true) {
        const cur = p[j][0];
        if (j + 1 >= p.length) { outcome = { ended: e.end ? e.end.kind : 'open' }; break; }
        const nxt = p[j + 1][0];
        if (cur === rootKey && nxt === clearTo) { outcome = { crossed: true }; break; }
        if (!inward.has(cur) || !inward.get(cur).has(nxt)) { outcome = { left: nxt }; break; }
        if (p[j + 1][1] - p[i][1] > HORIZON_CAP_MS) { outcome = { ended: 'tookOver60min' }; break; }
        j++;
      }
      if (outcome.crossed) f.crossed++;
      else if (outcome.left) f.left[outcome.left] = (f.left[outcome.left] || 0) + 1;
      else f.ended[outcome.ended] = (f.ended[outcome.ended] || 0) + 1;
    }
  }

  // ---- time in each berth, per class (stopping vs not where a station is inside the berth)
  const times = new Map();      // key → [{secs, run}]
  for (const r of runs) {
    const s = r.seg;
    for (let i = 0; i < s.length; i++) {
      if (i === 0 && r.start && isPlatformStart(r.start.kind) && !fringe.has(s[0][0])) continue;  // a start, not a running time
      if (i === 0 && r.start && ['stepFromEmpty', 'horizonCap', 'loop', 'previousCrossing'].includes(r.start.kind)) continue;
      const tOut = i + 1 < s.length ? s[i + 1][1] : r.t;
      const secs = (tOut - s[i][1]) / 1000;
      if (!times.has(s[i][0])) times.set(s[i][0], []);
      times.get(s[i][0]).push({ secs, run: r, tIn: s[i][1], tOut });
    }
  }
  const stationIn = new Map();  // key → { tiploc, sepSecs, stop:[], pass:[] }
  for (const [k, list] of times) {
    const pax = list.filter(x => x.run.cls === 'passenger' && x.run.link);
    if (pax.length < 20) continue;
    // Candidate stations: where some trains call close to when they are in this berth. Trains that
    // don't call there often have no record of it at all (only timing points are listed), so every
    // other linked passenger train in the berth counts as passing.
    const byX = new Map();
    const callsNear = new Map();     // x → Set(tiploc)
    for (const x of pax) {
      const late = x.run.link.lateSecs * 1000;
      const near = new Set();
      for (const l of x.run.link.locs) {
        // booked there (adjusted by its lateness at the crossing) while it was in this berth, ±90 s
        if (l.ms === null || !l.stop || l.ms + late < x.tIn - 90e3 || l.ms + late > x.tOut + 90e3) continue;
        near.add(l.tiploc);
      }
      callsNear.set(x, near);
      for (const X of near) if (!byX.has(X)) byX.set(X, { stop: [], pass: [] });
    }
    for (const [X, g] of byX) for (const x of pax) {
      const callsAnywhere = x.run.link.locs.some(l => l.tiploc === X && l.stop);
      if (callsNear.get(x).has(X)) g.stop.push(x);
      else if (!callsAnywhere) g.pass.push(x);
    }
    let best = null;
    if (q(list.map(x => x.secs), 0.5) < 10) continue;      // a berth trains cross in seconds holds no station
    for (const [X, g] of byX) {
      // enough of both, and the stoppers a real share of the trains (not a stray timetable coincidence)
      if (g.stop.length < 10 || g.pass.length < 10 || g.stop.length < 0.2 * pax.length) continue;
      const sep = q(g.stop.map(x => x.secs), 0.5) - q(g.pass.map(x => x.secs), 0.5);
      if (sep >= 20 && (!best || sep > best.sepSecs)) best = { tiploc: X, sepSecs: sep, stop: g.stop, pass: g.pass, stopSet: new Set(g.stop), passSet: new Set(g.pass) };
    }
    if (best) stationIn.set(k, best);
  }
  const classKey = (x, k) => {
    if (x.run.cls !== 'passenger') return x.run.cls;
    if (!x.run.link) return 'passengerUnlinked';
    const st = stationIn.get(k);
    if (!st) return 'passenger';
    if (st.stopSet.has(x)) return `stopsAt${st.tiploc}`;
    if (st.passSet.has(x)) return `passes${st.tiploc}`;
    return 'passenger';
  };

  // ---- one train per berth
  const stepsInto = new Map();
  for (const e of pass.ended.values()) for (let i = 1; i < e.path.length; i++) {
    const k = e.path[i][0]; if (routeKeys.has(k)) stepsInto.set(k, (stepsInto.get(k) || 0) + 1);
  }
  const opb = new Map(); for (const k of routeKeys) opb.set(k, { genuine: 0, labelOnly: 0, stale: 0, sameDescription: 0, examples: [] });
  for (const ev of pass.occupied) {
    if (!routeKeys.has(ev.key)) continue;
    const o = opb.get(ev.key);
    const me = pass.ended.get(ev.moverId);
    for (const occ of ev.occ) {
      if (ev.t - occ.since > FRESH_OCCUPANT_MS) { o.stale++; continue; }
      const oe0 = pass.ended.get(occ.id);
      // the same headcode in the same berth within 30 min is one train the tracker followed twice
      if (me && oe0 && me.descr === oe0.descr) { o.sameDescription++; continue; }
      if (!occ.stepped) { o.labelOnly++; continue; }
      // Genuine only if the occupant really was a train that later stepped out of this berth.
      const oe = pass.ended.get(occ.id);
      let leftByStep = false;
      if (oe) {
        const idx = oe.path.findIndex(([k, t]) => k === ev.key && t === occ.since);
        leftByStep = idx >= 0 && idx + 1 < oe.path.length;
      }
      if (!leftByStep) { o.labelOnly++; continue; }
      o.genuine++;
      if (o.examples.length < 5) {
        o.examples.push(`${new Date(ev.t).toISOString().slice(0, 19)}Z ${me ? me.descr : '?'} in behind ${oe.descr}`);
      }
    }
  }

  // ---- berths block
  const berths = {};
  const routeDays = prov(runs);
  for (const k of [...routeKeys].sort()) {
    const list = times.get(k) || [];
    const byCls = {};
    for (const x of list) { const c = classKey(x, k); (byCls[c] = byCls[c] || []).push(x); }
    const timeInBerth = {}, stall = {};
    for (const [c, xs] of Object.entries(byCls)) {
      const secs = xs.map(x => x.secs);
      timeInBerth[c] = { ...dist(secs), ...prov(xs.map(x => x.run)) };
      if (secs.length >= 20) stall[c] = { thresholdSecs: Math.ceil(q(secs, 0.95)), basis: 'p95 of normal time in berth (design §5.6 "e.g. p95"); set finally in replay', n: secs.length };
      else stall[c] = { thresholdSecs: null, basis: `only ${secs.length} trains; use the berth's all-class figure`, n: secs.length };
    }
    const all = list.map(x => x.secs);
    if (all.length >= 20) stall.all = { thresholdSecs: Math.ceil(q(all, 0.95)), basis: 'p95, every class together', n: all.length };
    const o = opb.get(k), n = stepsInto.get(k) || 0;
    const f = fate.get(k);
    const leftN = Object.values(f.left).reduce((a, b) => a + b, 0);
    berths[k] = {
      station: stationIn.has(k) ? { tiploc: stationIn.get(k).tiploc, stopMinusPassSecs: r1(stationIn.get(k).sepSecs),
        basis: 'booked stoppers vs booked passers at this timing point, median time in this berth' } : null,
      timeInBerth, stall,
      onePerBerth: {
        value: !n ? 'notApplicable' : o.genuine / n <= ONE_PER_BERTH_MAX_RATE ? 'holds' : 'exempt',
        stepsInto: n, trainsInBehind: o.genuine, rate: n ? Math.round(o.genuine / n * 1e5) / 1e5 : null,
        ignored: { labelOnly: o.labelOnly, occupantOver30min: o.stale, sameDescription: o.sameDescription },
        ...(!n ? { note: 'trains are only ever described into this berth, never step in: nothing is projected into it' } : {}),
        rule: `holds if a train steps in behind another (that later steps out) at most ${ONE_PER_BERTH_MAX_RATE * 100}% of steps`,
        examples: o.examples, from: routeDays.from, to: routeDays.to
      },
      fate: { enteredHeadingIn: f.entered, crossed: f.crossed, leftRoute: leftN, leftTo: f.left, endedInside: f.ended,
        shared: leftN > 0, from: routeDays.from, to: routeDays.to }
    };
  }

  out.berths = berths;

  // ---- routes block (with last junction, outermost offset, horizon)
  const fmtRoute = (rt, idx) => {
    const keys = pathToRoot(rt.leaf);                 // outermost first … root
    const rs = rt.leaf.starts;
    // Last junction: the outermost berth from which no train leaves the route.
    // keys run outermost first; walk out from the crossing until a berth that trains leave.
    let certain = keys.length - 1;
    for (let i = keys.length - 1; i >= 0; i--) {
      const f = fate.get(keys[i]);
      const leftN = Object.values(f.left).reduce((a, b) => a + b, 0);
      if (f.entered && leftN / f.entered > DIVERGE_MAX_RATE) break;
      certain = i;
    }
    const divergeAt = certain > 0 ? keys[certain - 1] : null;
    const certainKey = keys[certain];
    const fromCertain = runs.filter(r => r.seg.some(s => s[0] === certainKey)).map(r => (r.t - r.seg.find(s => s[0] === certainKey)[1]) / 60000);
    const kind = Object.entries(rt.kinds).sort((a, b) => b[1] - a[1])[0][0];
    const isStart = isPlatformStart(kind);
    const horizon = rs.map(r => (r.t - r.seg[0][1]) / 60000);
    const fromDeparture = isStart ? rs.filter(r => r.seg.length > 1).map(r => (r.t - r.seg[1][1]) / 60000) : null;
    const item = {
      id: `${d}-${idx + 1}`,
      berths: keys.concat([`${clear.area}:${clear.to}`]),
      trains: rt.n, share: r1(rt.share * 100), startedAs: rt.kinds, ...prov(rs),
      horizonMins: { ...dist(horizon), atLeast25pct: r1(horizon.filter(m => m >= TARGET_MINS).length / horizon.length * 100) },
      lastJunction: { certainFrom: certainKey, divergeAt, minsToCrossing: dist(fromCertain),
        rule: `outermost berth from which at most ${DIVERGE_MAX_RATE * 100}% of trains heading in leave the route; divergeAt = the berth outside it where they do`
          + (divergeAt ? '' : ' (none: no train left this route on our berths)') }
    };
    if (isStart) item.startingPlatform = { berth: keys[0], minsFromDeparture: dist(fromDeparture) };
    item.outermost = outermostOffset(keys[0], rs, isStart);
    return item;
  };
  out.routes = routes.map(fmtRoute);
  out.startsPartWayIn = midRoute.sort((a, b) => b.n - a.n).map(m => ({ berth: m.leaf.key, trains: m.n, startedAs: m.kinds,
    note: 'trains first seen part-way along a longer route: a day the outer area was not read, a lost interpose, or the start of the data' }));
  out.minorStarts = minor.sort((a, b) => b.n - a.n).slice(0, 25).map(m => ({ berth: m.leaf.key, trains: m.n, startedAs: m.kinds, toCrossing: pathToRoot(m.leaf).length }));
  out.seenMoreThan60minOut = { trains: trie.capped || 0, note: 'walked back 60 min without reaching where they were first seen: well covered, no start berth' };
  const offRoot = runs.filter(r => r.offRoot).length;
  if (offRoot) out.runsNotThroughClearFrom = offRoot;

  // ---- merges: berths reached from more than one berth on the routes
  out.merges = [...routeKeys].map(k => {
    const from = [...inward.entries()].filter(([a, s]) => routeKeys.has(a) && s.has(k)).map(([a]) => a);
    return from.length > 1 ? { berth: k, from } : null;
  }).filter(Boolean);

  // ---- starting platforms (any interpose start that went on to cross within the routes)
  const plat = new Map();
  for (const r of runs) {
    if (!r.start || !isPlatformStart(r.start.kind) || fringe.has(r.seg[0] && r.seg[0][0]) || r.seg.length < 2) continue;
    const k = r.seg[0][0];
    if (!plat.has(k)) plat.set(k, []);
    plat.get(k).push(r);
  }
  out.startingPlatforms = [...plat.entries()].filter(([, rs]) => rs.length >= MIN_ROUTE_RUNS).sort((a, b) => b[1].length - a[1].length).map(([k, rs]) => {
    const origins = {};
    for (const r of rs) if (r.link) { const o = r.link.locs[0].tiploc; origins[o] = (origins[o] || 0) + 1; }
    return {
      berth: k, trains: rs.length, ...prov(rs), startedAs: rs.reduce((a, r) => (a[r.start.kind] = (a[r.start.kind] || 0) + 1, a), {}),
      timetableOrigin: Object.entries(origins).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([o, n]) => `${o} (${n})`),
      describedBeforeDepartureMins: dist(rs.map(r => (r.seg[1][1] - r.seg[0][1]) / 60000)),
      departureToCrossingMins: dist(rs.map(r => (r.t - r.seg[1][1]) / 60000)),
      departureVsBookedSecs: dist(rs.filter(r => r.link).map(r => (r.seg[1][1] - r.link.locs[0].ms) / 1000))
    };
  });

  // ---- overtaking
  const byT = runs.slice().sort((a, b) => a.t - b.t);
  // A crossed before B, but B was ahead at a berth both used. If both used the same berths from
  // there to the crossing, A passed B on the same track (what §5.7 says must not happen); otherwise
  // they ran on different tracks or routes between (a loop, a platform, a detour via another line).
  const sameTrack = [], otherPath = new Map(); let pairs = 0;
  for (let i = 0; i < byT.length; i++) {
    const A = byT[i];
    const ia = new Map(A.seg.map(([k], n) => [k, n]));
    for (let j = i + 1; j < byT.length && byT[j].t - A.t < 30 * 60e3; j++) {
      const B = byT[j];
      let common = 0, flipIdxB = -1;
      B.seg.forEach(([k, tb], n) => { if (!ia.has(k)) return; common++; if (tb < A.seg[ia.get(k)][1]) flipIdxB = n; });
      if (!common) continue;
      pairs++;
      if (flipIdxB < 0) continue;
      const k = B.seg[flipIdxB][0];
      const restB = B.seg.slice(flipIdxB).map(x => x[0]).join(' '), restA = A.seg.slice(ia.get(k)).map(x => x[0]).join(' ');
      const ex = { at: new Date(A.t).toISOString().slice(0, 19) + 'Z', overtook: A.descr, overtaken: B.descr, lastAheadAt: k };
      if (restA === restB) sameTrack.push(ex);
      else {
        const viaB = B.seg.slice(flipIdxB).map(x => x[0]).find(x => !ia.has(x)) || null;
        const viaA = A.seg.slice(ia.get(k)).map(x => x[0]).find(x => !B.seg.some(y => y[0] === x)) || null;
        const key = `${k} | overtaker via ${viaA} | overtaken via ${viaB}`;
        if (!otherPath.has(key)) otherPath.set(key, { n: 0, example: ex });
        otherPath.get(key).n++;
      }
    }
  }
  out.overtaking = {
    sameTrack: { count: sameTrack.length, examples: sameTrack.slice(0, 10) },
    differentTracks: { count: [...otherPath.values()].reduce((a, b) => a + b.n, 0),
      where: [...otherPath.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([k, v]) => ({ split: k, n: v.n, example: v.example })) },
    pairsCompared: pairs, ...prov(runs),
    rule: 'pairs crossing within 30 min that shared a berth: the one that crossed second was ahead at a shared berth. Same track = identical berths from there to the crossing'
  };

  // ---- run-through: per station, what separates trains that stop from those that run through
  const byStation = new Map();
  for (const [k, st] of stationIn) {
    const prevBest = byStation.get(st.tiploc);
    if (!prevBest || st.sepSecs > prevBest.st.sepSecs) byStation.set(st.tiploc, { k, st });
  }
  out.runThrough = [...byStation.values()].map(({ k, st }) => {
    const s = st.stop.map(x => x.secs), p = st.pass.map(x => x.secs);
    const p90pass = q(p, 0.9), p10stop = q(s, 0.1);
    const separable = p90pass < p10stop;
    const thr = separable ? Math.round((p90pass + p10stop) / 2) : null;
    const ranThrough = thr === null ? [] : st.stop.filter(x => x.secs < thr);
    return {
      station: st.tiploc, berth: k,
      bookedToStop: dist(s), bookedToPass: dist(p),
      thresholdSecs: thr,
      rule: separable ? 'midpoint between p90 of passers and p10 of stoppers; less time than this in the berth = running through'
        : 'the two groups overlap: time in this berth alone does not separate them',
      bookedStoppersBelowThreshold: { count: ranThrough.length, examples: ranThrough.slice(0, 5).map(x => `${new Date(x.run.t).toISOString().slice(0, 16)}Z ${x.run.descr} ${Math.round(x.secs)}s`) },
      ...prov(st.stop.concat(st.pass).map(x => x.run))
    };
  });

  // ---- truth: every clear step against the barrier
  if (barrier) out.truth = clearVsBarrier(runs, barrier);
  return out;

  function outermostOffset(key, rs, isStart) {
    const linkedRs = rs.filter(r => r.link);
    if (linkedRs.length < MIN_ROUTE_RUNS) return { berth: key, note: `only ${linkedRs.length} of ${rs.length} trains linked to the timetable` };
    const tAt = r => isStart ? r.seg[1][1] : r.seg[0][1];      // a starting train: when it leaves
    // The timing point whose booked time best predicts the step (least spread), before the crossing.
    const byX = new Map();
    for (const r of linkedRs) for (const l of r.link.locs) {
      if (l.ms === null || l.ms > r.link.xMs) continue;
      if (!byX.has(l.tiploc)) byX.set(l.tiploc, []);
      byX.get(l.tiploc).push({ off: (tAt(r) - l.ms) / 1000, r });
    }
    let best = null;
    for (const [X, xs] of byX) {
      if (xs.length < 0.8 * linkedRs.length) continue;
      const offs = xs.map(x => x.off);
      const iqr = q(offs, 0.75) - q(offs, 0.25);
      if (!best || iqr < best.iqr) best = { X, xs, iqr };
    }
    if (!best) return { berth: key, note: 'no timing point common to 80% of the linked trains' };
    const byCls = {};
    for (const x of best.xs) (byCls[x.r.cls] = byCls[x.r.cls] || []).push(x.off);
    return {
      berth: key, event: isStart ? 'first step out of the platform' : 'step into the berth',
      timingPoint: best.X, offsetSecs: { ...dist(best.xs.map(x => x.off)), ...prov(best.xs.map(x => x.r)) },
      byClass: Object.fromEntries(Object.entries(byCls).map(([c, a]) => [c, dist(a)])),
      linked: `${linkedRs.length} of ${rs.length}`,
      note: 'offset = actual - booked, so it includes lateness: its spread is the lateness the deadline buffer must allow (§5.8)'
    };
  }
}

function datesOf(pass, area) {
  const c = pass.coverage[area];
  if (!c) return [];
  return datesBetween(c.from, c.to).filter(d => !c.missing.includes(d));
}

function clearVsBarrier(runs, barrier) {
  const cl = barrier.closures;
  const inside = t => { let lo = 0, hi = cl.length; while (lo < hi) { const m = (lo + hi) >> 1; if (cl[m].start <= t) lo = m + 1; else hi = m; } const c = cl[lo - 1]; return c && t <= c.end + 5000 ? c : null; };
  let down = 0; const toRaise = [];
  const days = new Set(barrier.days);
  const rs = runs.filter(r => days.has(r.day));
  for (const r of rs) {
    const c = inside(r.t);
    if (c) { down++; const s = (c.end - r.t) / 1000; if (s >= 0 && s <= 60) toRaise.push(s); }
  }
  return {
    clearStepsWhileBarrierDown: { count: down, of: rs.length, pct: rs.length ? r1(down / rs.length * 100) : null },
    clearStepToRaiseStartSecs: { ...dist(toRaise), note: 'last train of a closure only (raise within 60 s)' },
    ...prov(rs)
  };
}

// Barrier closures with no clear step in either direction: a route or a train we don't see.
function unexplained(allRuns, barrier) {
  const ts = allRuns.map(r => r.t).sort((a, b) => a - b);
  const has = (a, b) => { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < a) lo = m + 1; else hi = m; } return lo < ts.length && ts[lo] <= b; };
  const none = barrier.closures.filter(c => !has(c.start, c.end + 5000));
  return { closures: barrier.closures.length, withNoClearStep: none.length,
    examples: none.slice(0, 15).map(c => `${new Date(c.start).toISOString().slice(0, 19)}Z for ${Math.round((c.end - c.start) / 1000)}s`),
    from: barrier.days[0], to: barrier.days[barrier.days.length - 1] };
}

function feedHealth(pass) {
  const out = {};
  for (const [a, h] of Object.entries(pass.health)) {
    if (!h.days.length) { out[a] = { note: 'no national-log day with this area\'s heartbeats in the window' }; continue; }
    const ct = h.days.flatMap(x => x.ct);
    const p99 = q(ct, 0.99);
    out[a] = {
      heartbeatSecs: dist(ct),
      longestSilencePerDay: h.days.map(x => ({ date: x.date, secs: r1(x.maxSilence), at: x.maxSilenceAt, spanHours: x.spanHours })),
      maxSilenceSecs: Math.max(120, Math.ceil(3 * p99 / 30) * 30),
      basis: `3 x the 99th-percentile heartbeat gap, at least 120 s; from ${h.days.length} day(s)` + (h.days.length < 14 ? ' — GUESS until 14 days' : ''),
      from: h.days[0].date, to: h.days[h.days.length - 1].date
    };
  }
  return out;
}

// ---------------------------------------------------------------- find-clear mode
async function findClear(spec, cat, dates, barrier) {
  const steps = new Map();
  const raises = barrier.events.filter(e => e.phase === 'RAISE_START').map(e => e.t);
  for (const date of dates) {
    const day = await readDay(cat, date, [spec.area], { foreign: false });
    for (const e of day.events) {
      if (e.kind !== 'step') continue;
      const k = `${e.from}>${e.to}`;
      let lo = 0, hi = raises.length; while (lo < hi) { const m = (lo + hi) >> 1; if (raises[m] < e.t) lo = m + 1; else hi = m; }
      const s = lo < raises.length ? (raises[lo] - e.t) / 1000 : null;
      if (!steps.has(k)) steps.set(k, { n: 0, off: [] });
      const x = steps.get(k); x.n++;
      if (s !== null && s <= 60) x.off.push(s);
    }
  }
  const rows = [...steps.entries()].filter(([, v]) => v.n >= 20).map(([k, v]) => ({ step: k, n: v.n, raiseWithin60s: v.off.length,
    pct: r1(v.off.length / v.n * 100), secsToRaise: dist(v.off) })).sort((a, b) => b.raiseWithin60s - a.raiseWithin60s);
  console.log(`Berth steps in ${spec.area} followed by the barrier starting up within 60 s (${dates[0]}..${dates[dates.length - 1]}, ${raises.length} raises):`);
  for (const r of rows.slice(0, 12)) console.log(`  ${r.step.padEnd(10)} n ${String(r.n).padStart(6)}  raise<=60s ${String(r.raiseWithin60s).padStart(6)} (${r.pct}%)  median ${r.secsToRaise.p50}s p10 ${r.secsToRaise.p10}s p90 ${r.secsToRaise.p90}s`);
  console.log('The clear step of each direction is the step most often followed closely by the raise; the rest of a closure\'s trains are followed by a later train.');
}

// ---------------------------------------------------------------- main
async function main() {
  const { id, from, to, opt } = parseArgs(process.argv.slice(2));
  const root = path.join(__dirname, '..');
  const configDir = path.join(root, 'config', 'crossings');
  const logs = opt.logs || path.join(root, 'data', 'logs');
  const dirs = { tdAllDir: opt['td-all'] || path.join(logs, 'td-all'), sclassDir: opt.sclass || path.join(logs, 'sclass'), tdDir: opt.td || path.join(logs, 'td') };
  if (opt['find-clear']) {
    const spec = loadSpec(id, configDir);
    const dates = datesBetween(from, to);
    const barrier = spec.barrier ? readBarrier(dirs.sclassDir, spec.barrier.crossing, dates) : null;
    if (!barrier || !barrier.events.length) throw new Error('no barrier data for this crossing in the window');
    await findClear(spec, catalogue(dirs), dates, barrier);
    return;
  }
  const out = await learn({ id, from, to, configDir, dirs, cifFile: opt.cif || newestCif(root), extraAreas: opt.areas ? opt.areas.split(',') : [],
    discoverAreas: !opt['no-discover'], command: `node tools/learn-routes.js ${process.argv.slice(2).join(' ')}`.split(require('os').homedir()).join('~'), commit: gitHead(root) });
  const outFile = opt.out || path.join(configDir, `${id}.routes.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');
  console.log(`wrote ${outFile}`);
  summary(out);
}

async function learn({ id, from, to, configDir, dirs, cifFile = null, extraAreas = [], discoverAreas = true, command = null, commit = null }) {
  const spec = loadSpec(id, configDir);
  const cat = catalogue(dirs);
  const dates = datesBetween(from, to);
  const barrier = spec.barrier ? readBarrier(dirs.sclassDir, spec.barrier.crossing, dates) : null;

  // 1. Areas: grow from the crossing's own over the national-log days.
  let areas = [...new Set([spec.area, ...spec.clears.map(c => c.area), ...extraAreas])];
  const why = { [spec.area]: 'the crossing\'s own area' };
  const tdAllDates = dates.filter(d => cat.tdAll.has(d));
  const handedInto = new Map();          // berth → hand-overs seen in any pass (see fringe below)
  const noteArrivals = p => { for (const [k, c] of p.arrivals) { const h = handedInto.get(k) || { handover: 0, interpose: 0 }; h.handover += c.handover; h.interpose += c.interpose; handedInto.set(k, h); } };
  if (discoverAreas && tdAllDates.length) {
    for (let iter = 0; iter < 4; iter++) {
      process.stderr.write(`discovering areas, pass ${iter + 1} over ${tdAllDates.length} national-log day(s): ${areas.join('+')}\n`);
      const p = await trackPass(spec, cat, tdAllDates, areas);
      noteArrivals(p);
      const add = discover(p, areas, spec.dirs);
      if (!add.size) break;
      for (const [a, w] of add) { areas.push(a); why[a] = w; }
    }
  }

  // 2. Berths that two of our areas both describe, from the national-log days.
  const votes = new Map();
  for (const d of tdAllDates) countSameSteps((await readDay(cat, d, areas, { foreign: false })).events, votes);
  const same = chooseSameBerths(votes);
  const sameBerths = same.map(x => x.berths);

  // 3. The full window.
  process.stderr.write(`tracking ${dates.length} day(s) over ${areas.join('+')}\n`);
  const pass = await trackPass(spec, cat, dates, areas, sameBerths);

  // Berths that trains are handed into (from any area): on a day without the national log a
  // hand-over from an area we can't read looks like a plain interpose, so it is recognised by berth.
  // A berth counts once trains were seen handed into it in any pass, including the discovery passes
  // that read fewer areas (where the hand-over came from an area not yet added).
  noteArrivals(pass);
  const fringe = new Set([...handedInto.entries()].filter(([, c]) => c.handover > 0 && c.handover >= c.interpose).map(([k]) => k));

  // 3. Timetable.
  let cif = null;
  if (cifFile) {
    process.stderr.write(`reading timetable ${cifFile}\n`);
    cif = await loadCif(cifFile, { point: spec.point, before: spec.before });
  } else process.stderr.write('no timetable extract found: offsets and classes from headcodes only\n');

  // 4. Analyses.
  const out = {
    _comment: 'Generated by tools/learn-routes.js — do not edit by hand; re-run the tool. Berth keys are AREA:BERTH. Every figure carries n and the dates it came from. Read by the berth-first engine (src/berth-first/routes.js, v1 step 3+).',
    crossing: id,
    generated: { at: new Date().toISOString(), by: 'tools/learn-routes.js', commit, command,
      window: { from, to }, crossingFrom: spec.source, timetable: cif ? { file: path.basename(cif.file), extract: cif.header && cif.header.Metadata,
        note: 'one full extract: days before it fall back to permanent schedules where an expired one-day overlay ran' } : null },
    areas,
    areaSources: Object.fromEntries(areas.map(a => [a, { why: why[a] || 'given with --areas', daysRead: pass.coverage[a].days,
      fromPerAreaLog: pass.coverage[a].perArea, fromNationalLog: pass.coverage[a].tdAll, from: pass.coverage[a].from || null, to: pass.coverage[a].to || null,
      missingDays: pass.coverage[a].missing.length }])),
    fringeBerths: [...fringe].sort(),
    sameBerths: { list: pass.sameBerths, evidence: same.map(x => `${x.berths.join(' = ')} (${x.votes} votes)`),
      rule: 'steps by the same train in two areas within 1 s vote from=from and to=to (1 vote same second, 0.5 a second apart); each berth the other\'s favourite with at least 5 votes and twice the runner-up\'s score, a matching berth number counting double (national-log days only)',
      note: 'berths two areas both describe; routes name them by the crossing\'s own area where it has a name' },
    trackerStats: pass.stats,
    directions: {}
  };
  for (const d of spec.dirs) out.directions[d] = analyseDirection(spec, d, pass, cif, fringe, barrier);
  out.feedHealth = feedHealth(pass);
  if (barrier) out.truth = { source: `sclass/barrier-<date> crossing ${spec.barrier.crossing}`, closuresWithNoClearStep: unexplained(pass.runs, barrier) };
  return out;
}

function newestCif(root) {
  const arch = path.join(root, 'data', 'schedule', 'archive');
  if (fs.existsSync(arch)) {
    const f = fs.readdirSync(arch).filter(x => /^cif-full-.*\.json\.gz$/.test(x)).sort().pop();
    if (f) return path.join(arch, f);
  }
  const latest = path.join(root, 'data', 'schedule', 'cif-latest.json.gz');
  return fs.existsSync(latest) ? latest : null;
}

function gitHead(root) { try { return execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return null; } }

function summary(out) {
  console.log(`areas: ${out.areas.join(', ')}`);
  for (const [d, x] of Object.entries(out.directions)) {
    console.log(`\n${d}: ${x.runs.n} trains crossed (${x.runs.from}..${x.runs.to}), ${x.runs.linkedToTimetable} linked to the timetable`);
    for (const r of x.routes || []) {
      const lj = r.lastJunction;
      console.log(`  ${r.id}: ${r.trains} trains (${r.share}%) from ${r.berths[0]} (${Object.keys(r.startedAs).join('/')}), ${r.berths.length} berths, ` +
        `horizon median ${r.horizonMins.p50} min; certain from ${lj.certainFrom} (${lj.minsToCrossing.p50} min out)${lj.divergeAt ? `, trains leave at ${lj.divergeAt}` : ''}`);
    }
    for (const p of x.startingPlatforms || []) console.log(`  starts at ${p.berth}: ${p.trains} trains, ${p.timetableOrigin.join(', ')}, departure→crossing median ${p.departureToCrossingMins.p50} min`);
    const ex = Object.entries(x.berths || {}).filter(([, b]) => b.onePerBerth.value === 'exempt').map(([k]) => k);
    console.log(`  one train per berth: exempt at ${ex.length ? ex.join(', ') : 'none'}; overtakes on the same track ${x.overtaking ? x.overtaking.sameTrack.count : '-'}, on different tracks ${x.overtaking ? x.overtaking.differentTracks.count : '-'}`);
    if (x.seenMoreThan60minOut) console.log(`  first seen more than 60 min out: ${x.seenMoreThan60minOut.trains}`);
    for (const rt of x.runThrough || []) console.log(`  run-through ${rt.station} (${rt.berth}): stop p10 ${rt.bookedToStop.p10}s / pass p90 ${rt.bookedToPass.p90}s → threshold ${rt.thresholdSecs}`);
    if (x.truth) console.log(`  truth: ${x.truth.clearStepsWhileBarrierDown.pct}% of clear steps with the barrier down; raise ${x.truth.clearStepToRaiseStartSecs.p50}s after`);
  }
  if (out.truth) console.log(`\nbarrier closures with no clear step: ${out.truth.closuresWithNoClearStep.withNoClearStep} of ${out.truth.closuresWithNoClearStep.closures}`);
}

if (require.main === module) main().catch(e => { console.error(e.stack || e.message); process.exit(1); });

module.exports = { learn, loadSpec, trackPass, discover, analyseDirection, buildTrie, clearVsBarrier, unexplained, feedHealth, readBarrier };
