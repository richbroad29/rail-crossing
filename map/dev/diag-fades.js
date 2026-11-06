#!/usr/bin/env node
'use strict';
// Says WHY a region's trains fade: one JSON line per fade (kind gap | behind, the berth and plan it happened on,
// how far the reference was ahead) and per HOLE (a train whose updates lost their mv between two that had one:
// it passed through berths with no span, left track mode and re-appears further on). Group by `at` / berths[0]:
// on the live recordings of 2026-11-06 the top five berths made 44-74 % of each region's fades.
//
//   node map/dev/diag-fades.js <dir> <region> > fades.jsonl
const fs = require('fs'), path = require('path');
const R = require('../test/motion-replay.js');
const [dir, region] = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.startsWith(region + '-2') && f.endsWith('.jsonl')).sort();
const out = [];
for (const f of files) {
  const rec = R.load(path.join(dir, f));
  const owner = new Map();
  R.run(rec, {
    trace(r, es) { owner.set(es, r); },
    onEvent(type, es, info) {
      if (type !== 'fade') return;
      const r = owner.get(es); if (!r) { out.push({ f, kind: info.gap != null ? 'gap' : 'behind', unknown: true }); return; }
      const p = r.plans[es.k] || {}, q = r.plans[es.k + 1] || {};
      out.push({ f, kind: typeof info.gap === 'number' ? 'gap' : 'behind', id: r.id, hc: r.hc, at: r.area + ':' + r.berth,
        sp: p.drawSp || p.sp, L: Math.round(p.L || 0), nextSp: q.drawSp || q.sp, nextL: Math.round(q.L || 0), gap: info.gap != null ? Math.round(info.gap) : null,
        lastRef: Math.round(es.lastRef), sinceT: Math.round((info.tR - es.t) / 1000), s: Math.round(es.s), wait: es.wait, plans: r.plans.length, k: es.k, dwell: p.dwell, stop: p.stop,
        lateS: p.t0 != null ? Math.round((info.tR - p.t0) / 1000) : null, etaS: p.eta != null ? Math.round((p.eta - p.t0) / 1000) : null });
    }
  });
  // holes: per train, upserts with mv absent between upserts with mv
  const st = new Map();
  for (const e of rec.events) {
    const ups = e.event === 'snapshot' ? (e.data.trains || []) : (e.data.upsert || []);
    for (const t of ups) {
      const has = !!(t.mv && typeof t.mv.sp === 'string');
      let s = st.get(t.id); if (!s) st.set(t.id, s = { had: false, hole: null });
      if (!has && s.had && !s.hole) s.hole = { from: e.t, berths: [], pl: new Set() };
      if (!has && s.hole) { const b = t.area + ':' + t.berth; if (s.hole.berths[s.hole.berths.length - 1] !== b) s.hole.berths.push(b); s.hole.pl.add(t.pl); }
      if (has && s.hole) { out.push({ f, kind: 'hole', id: t.id, hc: t.hc, secs: Math.round((e.t - s.hole.from) / 1000), berths: s.hole.berths, pl: [...s.hole.pl].join('') }); s.hole = null; }
      if (has) s.had = true;
    }
  }
}
out.forEach((o) => console.log(JSON.stringify(o)));
