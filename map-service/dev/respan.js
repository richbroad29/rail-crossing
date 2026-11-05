#!/usr/bin/env node
'use strict';

// Re-span a recording: rewrite the spans in recorded service output with THIS build's, so a change to spans.js (cuts, joins) can be
// scored on real recordings, offline, before it is deployed.
//
//   node dev/respan.js --state=DIR --out=DIR [--pack=FILE] [--drawn] recording.jsonl [more.jsonl ...]
//
// --state  a folder of saved VPS state: learned-graph.json, transit-times.json, smart-latest.json.gz, corpus-latest.json.gz,
//          naptan-rail.csv and a track pack (track-pack-*.bin, or --pack=FILE). The learned graph and the learned transit times are
//          what the live service had, so spans are cut the way it would cut them now.
// --out    where the rewritten files go (same file names).
//
// What it does: loads the REAL App offline (fake ref dir, virtual clock, no network), builds every span to completion, then for each
// recording line rewrites every train's mv.sp and mv.stop from the berth's canonical span in this build (mv.t0, mv.eta, mv.dwell and
// mv.held stay as recorded: this scores the SPANS, not the timing), and writes the lines the recorder would: the `span` line for each
// canonical span the first time it is used in the file, and, per train, the section 17.1 continuation `span` line
// {id, after, of, length, path, stop} where the train's new span does not start where the span it was DRAWN on ends, `after` being
// the drawn id of the previous berth (a continuation id when one was issued). It uses the recorder's own LineMaker, so the output is
// what a recording made by this build would contain. A berth with no span now loses its `mv` (phase-1 position only), as it would.
//
// --drawn  also writes <out>/drawn/<name>: the same recording seen the way a PAGE that fetches continuations would draw it, each train's
//          mv.sp replaced by the span id it is drawn on (the continuation's id where one applies; the continuation span lines
//          resolved from the file itself, exactly as the page resolves (after, of)). A harness that does not know `after`/`of` yet
//          (the page's motion-replay before the page builder lands) can score that file and shows what the page will see.
//
// Prints, per file, trains seen / re-spanned / left without a span and the continuation lines written, and the join counts by how.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPack } = require('../src/track');
const { App } = require('../src/app');
const { loadConfig } = require('../src/config');
const log = require('../src/log');
const { LineMaker } = require('../src/record');

/**
 * The file as a page would draw it: per train, a new mv.sp S after drawn span P takes the continuation line {after: P, of: S} if the
 * file has one (its id is the new drawn id), else S itself.
 */
function drawnView(text) {
  const cont = new Map();                                       // 'after|of' -> continuation id
  const state = new Map();                                      // train id -> {sp, drawn}
  const fix = t => {
    if (!t.mv || typeof t.mv.sp !== 'string') { state.delete(t.id); return t; }
    const st = state.get(t.id);
    let drawn = t.mv.sp;
    if (st && st.sp === t.mv.sp) drawn = st.drawn;
    else if (st && cont.has(`${st.drawn}|${t.mv.sp}`)) drawn = cont.get(`${st.drawn}|${t.mv.sp}`);
    state.delete(t.id); state.set(t.id, { sp: t.mv.sp, drawn });
    t.mv.sp = drawn;
    return t;
  };
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line);
    if (e.event === 'span' && e.data.after) cont.set(`${e.data.after}|${e.data.of}`, e.data.id);
    else if (e.event === 'snapshot') { state.clear(); e.data.trains = e.data.trains.map(fix); }
    else if (e.event === 'update') { e.data.upsert = e.data.upsert.map(fix); for (const id of e.data.remove || []) state.delete(id); }
    out.push(JSON.stringify(e));
  }
  return out.join('\n') + '\n';
}

const opt = {}, files = [];
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z-]+)=(.*)$/.exec(a);
  if (m) opt[m[1]] = m[2]; else if (a === '--drawn') opt.drawn = true; else if (!a.startsWith('--')) files.push(a);
}
if (!opt.state || !opt.out || !files.length) { console.error('usage: respan.js --state=DIR --out=DIR [--pack=FILE] [--drawn] recording.jsonl [...]'); process.exit(2); }

async function buildApp(stateDir, packFile) {
  log.setSink(() => {});
  const { config } = loadConfig({ env: {}, argv: [], overrides: { port: 0 } });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'respan-'));
  const clock = { now: Date.parse('2026-11-05T19:57:00Z') };                       // virtual: only stamps data, nothing here waits on it
  const pack = loadPack(packFile);
  const app = new App({ config, dataDir, fake: { host: '127.0.0.1', port: 1, refDir: stateDir }, now: () => clock.now, track: pack });
  await app.refdata.loadFromDisk();
  app._derive();
  const edges = app.graph.loadLearnedFile(path.join(stateDir, 'learned-graph.json'));
  const series = app.transit.loadFile(path.join(stateDir, 'transit-times.json'), app.graph);
  app._setTrack(pack);
  const t0 = Date.now();
  app.spans.settle();
  return { app, dataDir, edges, series, settleMs: Date.now() - t0 };
}

/** One train as the recording has it, with its span replaced by this build's canonical one. Returns the JSON string, or null to leave it. */
function respanTrain(app, t, tally) {
  tally.trains++;
  if (!t.mv) return JSON.stringify(t);
  const k = app.graph.lookup(t.area, t.berth);
  const sp = k >= 0 ? app.spans.forBerth(k) : null;
  if (!sp) { delete t.mv; tally.noSpan++; return JSON.stringify(t); }
  const calls = t.mv.stop !== null && t.mv.stop !== undefined;
  t.mv.sp = sp.id;
  t.mv.stop = calls && sp.stop !== null ? Math.round(sp.stop) : null;
  if (calls && sp.stop === 0 && (t.mv.dwell === null || t.mv.dwell === undefined)) t.mv.dwell = 0;
  tally.respanned++;
  return JSON.stringify(t);
}

(async () => {
  const packFile = opt.pack || path.join(opt.state, fs.readdirSync(opt.state).filter(n => /^track-pack-.*\.bin$/.test(n)).sort().pop() || '');
  const { app, dataDir, edges, series, settleMs } = await buildApp(opt.state, packFile);
  const sb = app.spans;
  console.error(`state: ${edges} learned edges, ${series} transit series, ${sb.size} berths with spans (settled in ${settleMs} ms), pack ${path.basename(packFile)}`);
  fs.mkdirSync(opt.out, { recursive: true });
  const maker = new LineMaker(id => sb.get(id), (after, of) => sb.continuationBody(after, of), app.config.record.maxTrainState || 20000);
  const total = { trains: 0, respanned: 0, noSpan: 0, continuations: 0, spanLines: 0 };
  for (const f of files) {
    const out = [];
    const write = text => { out.push(text); return true; };
    const tally = { trains: 0, respanned: 0, noSpan: 0 };
    maker.reset();                                                               // each file replays on its own, like a recorded segment
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch (_) { continue; }
      if (e.event === 'span') continue;                                          // this build's own span lines replace them
      if (e.event === 'snapshot') {
        e.data.trains = e.data.trains.map(t => JSON.parse(respanTrain(app, t, tally)));
        maker.snapshot(JSON.stringify(e.data), e.t, write);
      } else if (e.event === 'update') {
        maker.update({ serverTime: e.t, upsert: e.data.upsert.map(t => respanTrain(app, t, tally)), remove: e.data.remove || [] }, write);
      } else write(`${JSON.stringify(e)}\n`);
    }
    const text = out.join('');
    const spans = (text.match(/"event":"span"/g) || []).length, conts = (text.match(/"after":"sp_/g) || []).length;
    fs.writeFileSync(path.join(opt.out, path.basename(f)), text);
    if (opt.drawn) { fs.mkdirSync(path.join(opt.out, 'drawn'), { recursive: true }); fs.writeFileSync(path.join(opt.out, 'drawn', path.basename(f)), drawnView(text)); }
    console.error(`${path.basename(f)}: ${tally.trains} train sightings, ${tally.respanned} re-spanned, ${tally.noSpan} lost their span, ${spans} span lines (${conts} continuations)`);
    for (const k of ['trains', 'respanned', 'noSpan']) total[k] += tally[k];
    total.spanLines += spans; total.continuations += conts;
  }
  console.error(`total: ${JSON.stringify(total)}`);
  console.error(`joins by how: ${JSON.stringify(sb.status().joins)}  store: ${JSON.stringify(sb.status().joinStore)}`);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  process.exit(0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
