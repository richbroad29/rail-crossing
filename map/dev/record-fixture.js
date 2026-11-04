#!/usr/bin/env node
'use strict';
// Record what the mock service would send a client watching a box, as JSONL, on a VIRTUAL clock (an
// hour of railway in a few seconds). This is the stand-in for CONTRACT section 13's
// GET /map/v1/debug/record, in the same shape, so map/test/motion-replay.js runs on either.
//
//   node map/dev/record-fixture.js --secs 3600 --out /tmp/sussex-1h.jsonl
//   options: --noise iid|persistent  --count 60  --seed 12345  --bbox S,W,N,E  --gzip
//
// One JSON object per line:
//   {"t":<server time ms>, "event":"snapshot"|"update", "data":{...the SSE payload...}}
//   {"t":<server time ms>, "event":"span", "data":{id,length,path,stop}}   (the first time a span id is sent;
//    the real recorder would have the replay fetch /span/:id instead, see motion-replay.js --spans)
const fs = require('fs');
const zlib = require('zlib');
const geo = require('../geo.js');
const { createSim } = require('./mock-sim.js');

function arg(n, d) { const i = process.argv.indexOf('--' + n); if (i < 0) return d; const v = process.argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; }

function record(o) {
  const secs = o.secs || 600, bbox = o.bbox || [50.6, -1.3, 51.6, 0.6];
  const sim = createSim({ count: o.count || 60, seed: o.seed || 12345, noise: { mode: o.noise || 'iid' } });
  let now = Date.UTC(2026, 10, 3, 9, 0, 0);
  sim.init(now);
  const inBox = (w) => w.lat >= bbox[0] && w.lat <= bbox[2] && w.lon >= bbox[1] && w.lon <= bbox[3];
  const lines = [], sentSpan = new Set(), known = new Set();
  let sentVer = sim.ver;
  const spans = (w) => {
    if (w.mv && !sentSpan.has(w.mv.sp)) { sentSpan.add(w.mv.sp); lines.push(JSON.stringify({ t: now, event: 'span', data: sim.span(w.mv.sp) })); }
  };
  const list = [];
  sim.TRAINS.forEach((t) => { const w = sim.wireOf(t); if (inBox(w)) { spans(w); list.push(w); known.add(t.id); } });
  lines.push(JSON.stringify({ t: now, event: 'snapshot', data: { serverTime: now, feedStale: false, trains: list } }));
  const end = now + secs * 1000;
  while (now < end) {
    now += 1000;
    sim.tick(now);
    const rem = sim.takeRemoved(), up = [], remove = [];
    sim.TRAINS.forEach((t) => {
      if (t.ver <= sentVer) return;
      const w = sim.wireOf(t);
      if (inBox(w)) { spans(w); up.push(w); known.add(t.id); } else if (known.has(t.id)) { remove.push(t.id); known.delete(t.id); }
    });
    rem.forEach((id) => { if (known.delete(id)) remove.push(id); });
    sentVer = sim.ver;
    if (up.length || remove.length) lines.push(JSON.stringify({ t: now, event: 'update', data: { serverTime: now, upsert: up, remove } }));
  }
  return lines.join('\n') + '\n';
}

if (require.main === module) {
  const out = arg('out', null);
  const text = record({ secs: Number(arg('secs', 600)), noise: arg('noise', 'iid'), count: Number(arg('count', 60)), seed: Number(arg('seed', 12345)),
    bbox: arg('bbox', null) ? String(arg('bbox')).split(',').map(Number) : null });
  const buf = arg('gzip', false) || (out && /\.gz$/.test(out)) ? zlib.gzipSync(text, { level: 9 }) : Buffer.from(text);
  if (out) { fs.writeFileSync(out, buf); process.stderr.write('wrote ' + out + ' (' + buf.length + ' bytes, ' + text.split('\n').length + ' lines)\n'); }
  else process.stdout.write(buf);
}
module.exports = { record };
void geo;
