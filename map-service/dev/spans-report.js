#!/usr/bin/env node
'use strict';

// Spans on REAL data: replays a real TD day through the real service (so the berth graph has learned its live edges and
// the transit-time store its samples), with the REAL track pack, then reports
//
//   * span coverage for the berths of one TD area (default LA): how many berths exist, how many were on a TD step that day,
//     how many have a span, and by which rule fixed their boundaries (stop / signal) and how they were cut (learned / equal);
//   * the whole country: chains, spans, no-route and no-snap counts;
//   * rule 3 (signals): per TD area, how many berth boundaries were tried, had a same-id signal anywhere, had one ON THE ROUTE,
//     had exactly one, and were pinned; and which end of the berth the signal is at, by comparing how far each hypothesis
//     ('end' / 'start') pulls the boundary from the proportional cut.
//
//   node dev/spans-report.js --ref-dir=DIR --pack=track-pack.bin --td=td.jsonl [--area=LA] [--dump=DIR]
//
// --dump writes <DIR>/spans-<area>.json (every span of the area with its path, for dev/render-spans.js).

const fs = require('fs');
const path = require('path');
const { loadPack } = require('../src/track');
const readline = require('readline');
const os = require('os');
const { App } = require('../src/app');
const { loadConfig } = require('../src/config');
const log = require('../src/log');
const { SpanBuilder } = require('../src/spans');


/**
 * The real TD day through the real model on a VIRTUAL clock (each event at its own signalling time), not through STOMP: the fake
 * feed rewrites event times to 'now', which would make every berth transit a few milliseconds long and the learned medians
 * meaningless. Everything else is the real App: reference data, placement, timetable matching, transit learning, spans.
 */
async function offlineReplay({ file, refDir, pack }) {
  log.setSink(() => {});
  const { config } = loadConfig({ env: {}, argv: [], overrides: { port: 0, spans: { logPins: true } } });
  const clock = { now: Date.parse('2026-11-01T00:00:01Z') };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spans-'));
  const app = new App({ config, dataDir, fake: { host: '127.0.0.1', port: 1, refDir }, now: () => clock.now, track: pack });
  await app.refdata.loadFromDisk();
  app._derive();
  app._setTrack(pack);
  const visited = new Set();
  const orig = app.model._attach.bind(app.model);
  app.model._attach = (t, keyId, ts, o) => { visited.add(keyId); return orig(t, keyId, ts, o); };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    const ts = Date.parse(r.ts);
    if (!['CA', 'CB', 'CC'].includes(r.event) || !Number.isFinite(ts)) continue;
    clock.now = ts;
    app.model.apply({ type: r.event, area: r.area, descr: r.desc, from: r.from, to: r.to, ts });
    if (++n % 400 === 0) { app.model.refreshServices(); app.model.prune(); if (app.graph.version !== app.model.placedVersion) app.model.refreshPositions(); }
  }
  return { res: { visited, stop: () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) { /* best effort */ } log.setSink(null); } }, app, g: app.graph, events: n };
}

const opt = {};
for (const a of process.argv.slice(2)) { const m = /^--([a-z-]+)=(.*)$/.exec(a); if (m) opt[m[1]] = m[2]; }
if (!opt['ref-dir'] || !opt.pack || !opt.td) { console.error('usage: spans-report.js --ref-dir=DIR --pack=PACK --td=TD.jsonl [--area=LA] [--dump=DIR]'); process.exit(2); }
const AREA = opt.area || 'LA';
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : 'n/a');
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

(async () => {
  const t0 = Date.now();
  const pack = loadPack(opt.pack);
  const loadMs = Date.now() - t0;
  const { res, app, g } = await offlineReplay({ file: opt.td, refDir: opt['ref-dir'], pack });
  const sbCfg = app.config.spans;
  try {
    const t1 = Date.now();
    app.spans.settle();
    const buildSecs = (Date.now() - t1) / 1000;
    const sb = app.spans;

    // ---- the area ------------------------------------------------------------------------------------------------
    const berths = [];
    for (let k = 0; k < g.keyOf.length; k++) if (g.areaOf[k] === AREA) berths.push(k);
    const visited = berths.filter(k => res.visited.has(k));
    const kind = k => (g.anchorKind.has(k) ? g.anchorKind.get(k) : 'unanchored');
    const tally = list => {
      const out = { berths: list.length, withSpan: 0, byKind: {}, rule: { stopPinned: 0, signalPinned: 0, cutLearned: 0, cutEqual: 0 } };
      for (const k of list) {
        const r = sb.byBerth.get(k);
        const b = out.byKind[kind(k)] || (out.byKind[kind(k)] = { berths: 0, withSpan: 0 });
        b.berths++;
        if (!r) continue;
        out.withSpan++; b.withSpan++;
        if (r.rule.start === 'stop' || r.rule.end === 'stop') out.rule.stopPinned++;
        if (r.rule.start === 'signal' || r.rule.end === 'signal') out.rule.signalPinned++;
        if (r.rule.cutBy === 'learned') out.rule.cutLearned++; else out.rule.cutEqual++;
      }
      out.coverage = pct(out.withSpan, out.berths);
      return out;
    };
    const area = { area: AREA, allKnownBerths: tally(berths), berthsOnATdStepThatDay: tally(visited) };

    // Why a berth has no span: it is on no chain between two anchored stations (junction, siding, depot, bay, or a stretch SMART does not connect).
    const chained = new Set();
    for (const c of sb.chains.values()) for (const b of c.berths) chained.add(b);
    area.noSpanBecause = { notOnAnyStationToStationChain: berths.filter(k => !sb.byBerth.has(k) && !chained.has(k)).length, onAChainButNoRoute: berths.filter(k => !sb.byBerth.has(k) && chained.has(k)).length };

    // ---- the whole country -------------------------------------------------------------------------------------------
    const st = sb.status();
    const national = { chains: st.chains, berthsWithSpans: st.berthsWithSpans, noRoute: st.noRoute, noSnapStations: st.noSnap, sharedBerthsSkipped: st.sharedBerths, rules: st.rules, buildSecs };

    // ---- signals by area -----------------------------------------------------------------------------------------------
    const rows = Object.entries(st.signals.byArea || {}).map(([a, v]) => ({ area: a, berthBoundaries: v.berths, sameIdSignalAnywhere: v.idMatch, onTheRoute: v.onRoute, unique: v.unique, pinned: v.pinned, rejected: v.rejected, pinRate: v.rate }));
    rows.sort((a, b) => b.berthBoundaries - a.berthBoundaries);
    const sum = k => rows.reduce((n, r) => n + r[k], 0);
    const signals = {
      totals: { berthBoundaries: sum('berthBoundaries'), sameIdSignalAnywhere: sum('sameIdSignalAnywhere'), onTheRoute: sum('onTheRoute'), unique: sum('unique'), pinned: sum('pinned') },
      areasWithAtLeastOnePin: rows.filter(r => r.pinned > 0).length, areasTotal: rows.length,
      topAreasByPins: rows.filter(r => r.pinned > 0).sort((a, b) => b.pinned - a.pinned).slice(0, 15),
      thisArea: rows.find(r => r.area === AREA) || null
    };
    const dev = log => {
      const d = log.map(p => Math.abs(p.d - p.prop) / (p.L / p.n));
      return { pins: log.length, medianDeviationInBerthLengths: d.length ? +median(d).toFixed(2) : null, meanDeviationInBerthLengths: d.length ? +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2) : null, pinsWhereChainWasLearned: log.filter(p => p.learned).length };
    };
    const endLog = sb.pinLog.slice();
    const alt = new SpanBuilder({ track: pack, graph: g, transit: app.transit, config: { ...sbCfg, signalAt: 'start', logPins: true }, now: app.now });
    alt.settle();
    signals.whichEndOfTheBerth = { end: dev(endLog), start: dev(alt.pinLog), note: 'distance of the pinned boundary from the proportional cut, in berth lengths: the lower is the more plausible reading' };

    if (opt.dump) {
      fs.mkdirSync(opt.dump, { recursive: true });
      const out = [];
      for (const k of berths) {
        const r = sb.byBerth.get(k);
        if (!r) continue;
        const sp = sb.get(r.id);
        if (!sp) continue;
        out.push({ berth: g.berth(k), id: r.id, length: sp.length, stop: sp.stop, rule: r.rule, chain: r.chainKey, path: sp.path, visited: res.visited.has(k) });
      }
      fs.writeFileSync(path.join(opt.dump, `spans-${AREA}.json`), JSON.stringify(out));
    }

    console.log(JSON.stringify({ pack: { file: path.basename(opt.pack), loadMs, edges: pack.nEdges, derivedFromPack: pack.derivedFromPack }, area, national, signals }, null, 1));
  } finally { res.stop(); }
  process.exit(0);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
