#!/usr/bin/env node
'use strict';

// "Do the tests bite?" Breaks one key rule at a time in src/, runs the tests that should notice, and
// reports whether they failed (KILLED) or passed anyway (SURVIVED - a hole in the tests).
//
//   node dev/mutation-check.js [--node=/path/to/node] [--only=substring]
//
// Every file is restored from an in-memory copy after each run, and on Ctrl-C.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');
const ROOT = path.join(__dirname, '..');

const MUTATIONS = [
  // identity
  { name: 'renumbering never matches', file: 'model.js', from: 'if (rec && ts - rec.at <= keep && ts >= rec.at - 5000) {', to: 'if (false) {', tests: ['model'] },
  { name: 'renumbering window ignored (any age)', file: 'model.js', from: 'if (rec && ts - rec.at <= keep && ts >= rec.at - 5000) {', to: 'if (rec) {', tests: ['model'] },
  { name: 'handover window ignored', file: 'model.js', from: 'if (ts - at > window || ts < at - 5000) return;', to: 'if (ts < at - 5000) return;', tests: ['model'] },
  { name: 'handover allowed within one area', file: 'model.js', from: 'if (this.graph.areaOf[keyId] === area) return;', to: '', tests: ['model'] },
  { name: 'handover distance gate removed', file: 'model.js', from: 'if (a && b && haversineKm(a, b) > maxKm) { this.stats.handoversRefused++; return; }', to: '', tests: ['model'] },
  { name: 'handover does not teach the graph', file: 'model.js', from: 'this.graph.observeEdge(fromId, toId);\n      this.stats.handovers++;', to: 'this.stats.handovers++;', tests: ['model'] },
  { name: 'idle drop disabled', file: 'model.js', from: 'if (now - t.lastEventAt > idle) {', to: 'if (false) {', tests: ['model'] },
  { name: 'CC accepted with `from` instead of `to`', file: 'model.js', from: "if (!BERTH_RE.test(to)) { this.stats.malformed++; return; }\n        this._cc(", to: "this._cc(", tests: ['model'] },
  { name: 'CB forgets the cancelled train', file: 'model.js', from: 'this.cancelledByKey.delete(id); this.cancelledByKey.set(id, rec);', to: '', tests: ['model'] },
  { name: 'train cap not enforced', file: 'model.js', from: 'if (this.byId.size > cap) {', to: 'if (false) {', tests: ['model'] },
  // placement
  { name: 'arrival anchors FROMBERTH (reading reversed)', file: 'berth-graph.js', from: 'if (ARRIVE.has(ev)) { strong = tid; weak = fid; } else if (DEPART.has(ev)) { strong = fid; weak = tid; } else continue;', to: 'if (ARRIVE.has(ev)) { strong = fid; weak = tid; } else if (DEPART.has(ev)) { strong = tid; weak = fid; } else continue;', tests: ['placement'] },
  { name: 'learned edges usable after 1 sighting', file: 'berth-graph.js', from: '_usableEdge(e) { return this.eCnt[e] >= this.minEdgeCount ||', to: '_usableEdge(e) { return this.eCnt[e] >= 1 ||', tests: ['placement'] },
  { name: 'interpolation weights swapped', file: 'berth-graph.js', from: 'const t = best.b.hops / best.total;', to: 'const t = best.f.hops / best.total;', tests: ['placement'] },
  { name: 'interpolates between a station and itself', file: 'berth-graph.js', from: "if (b.st.key === f.st.key) continue;", to: '', tests: ['placement'] },
  { name: 'SMART edges not trusted', file: 'berth-graph.js', from: '|| (this.eFlag[e] & SMART) !== 0; }', to: '; }', tests: ['placement'] },
  // timetable
  { name: 'STP cancel does not outrank', file: 'cif-index.js', from: 'const STP_RANK = { P: 0, O: 1, N: 2, C: 3 };', to: 'const STP_RANK = { P: 0, O: 1, N: 2, C: -1 };', tests: ['cif'] },
  { name: 'midnight not unwrapped', file: 'cif-index.js', from: 'if (prev >= 0 && v < prev - 720) { offset += 1440; v = t + offset; }', to: '', tests: ['cif'] },
  { name: 'match window ignored', file: 'cif-index.js', from: 'if (d > window) continue;', to: '', tests: ['cif'] },
  { name: 'ambiguity guard removed', file: 'cif-index.js', from: 'if (second && second.rec.uid !== best.rec.uid && Math.abs(second.dist - best.dist) < 0.5) return null;', to: '', tests: ['cif'] },
  { name: 'area filter ignored (any timing point)', file: 'cif-index.js', from: 'if (!ids.has(this.pool[rec.off + i * STRIDE])) continue;', to: '', tests: ['cif'] },
  { name: 'days_runs ignored', file: 'cif-index.js', from: "if (runs[dowOfDayNum(dn)] !== '1') continue;", to: '', tests: ['cif'] },
  // downloads and reference data
  { name: 'login sent on every hop', file: 'download.js', from: 'if (hop === 0 && o.auth) {', to: 'if (o.auth) {', tests: ['download'] },
  { name: 'login allowed to any host', file: 'download.js', from: "if (o.auth && !(o.authHosts || NROD_AUTH_HOSTS).includes(current.hostname)) {", to: 'if (false) {', tests: ['download'] },
  { name: 'row-count sanity check removed', file: 'refdata.js', from: 'if (rows < min) throw new Error(', to: 'if (false) throw new Error(', tests: ['download'] },
  { name: 'file replaced before it is validated', file: 'refdata.js', from: "      const { data, rows } = await this._loadFile(name, fresh);\n      fs.renameSync(fresh, target);", to: "      fs.renameSync(fresh, target);\n      const { data, rows } = await this._loadFile(name, target);", tests: ['download'] },
  { name: 'failed refresh unloads the data', file: 'refdata.js', from: 'st.failures++;', to: 'st.failures++; delete this.data[name];', tests: ['download'] },
  // TD connection
  { name: 'silence watchdog disabled', file: 'td-ingest.js', from: 'if (silent > this.cfg.silenceMs) {', to: 'if (false) {', tests: ['td-ingest'] },
  { name: 'ERROR-frame crash workaround removed', file: 'stomp.js', from: "if (!client || typeof client.setCommandHandlers !== 'function') return; // a test stand-in", to: 'return;', tests: ['td-ingest'] },
  { name: 'no backoff cap', file: 'td-ingest.js', from: 'Math.min(this.cfg.backoffMaxMs, this.cfg.backoffMinMs', to: '(this.cfg.backoffMinMs', tests: ['td-ingest'] },
  { name: 'secrets not redacted in logs', file: 'log.js', from: 'let s = redact(String(text), secrets);', to: 'let s = String(text);', tests: ['misc', 'td-ingest', 'download'] },
  // HTTP / SSE
  { name: 'SSE ignores the client box', file: 'sse.js', from: 'const isIn = cur && (!bbox || inBbox(cur.lat, cur.lon, bbox));', to: 'const isIn = !!cur;', tests: ['sse'] },
  { name: 'SSE never sends removals', file: 'sse.js', from: 'else if (wasIn) remove.push(id);', to: '', tests: ['sse'] },
  { name: 'SSE client cap not enforced', file: 'sse.js', from: 'get full() { return this.clients.size >= this.cfg.maxSseClients; }', to: 'get full() { return false; }', tests: ['sse'] },
  { name: 'SSE sends every change at once (no batching of coarse clients)', file: 'sse.js', from: 'if (!c.coarse) this._emit(c, changes, wall);', to: 'this._emit(c, changes, wall);', tests: ['sse'] },
  { name: 'SSE buffer cap ignored', file: 'sse.js', from: 'if (res.writableLength > this.cfg.sseMaxBufferBytes) {', to: 'if (false) {', tests: ['sse'] },
  { name: 'gzip never used', file: 'http.js', from: 'if (wantsGzip(req) && (gzBuf || text.length > 1024)) {', to: 'if (false) {', tests: ['api'] },
  { name: 'bbox not validated', file: 'geo.js', from: 'if (s < -90 || n > 90 || w < -180 || e > 180 || s > n || w > e) return null;', to: '', tests: ['api', 'misc'] },
  { name: 'stack trace leaks in a 500', file: 'http.js', from: "sendJson(req, res, 500, { error: 'Something went wrong on the server.' })", to: "sendJson(req, res, 500, { error: String(e && e.stack) })", tests: ['api'] },
  { name: 'an unplaceable berth is drawn at 0,0 instead of counted', file: 'model.js', from: 'if (!p) { t.placed = false; t.pl = null; t.place = null; return; }', to: "if (!p) { t.placed = true; t.lat = 0; t.lon = 0; t.pl = 'a'; t.place = { pl: 'a', station: '?' }; return; }", tests: ['api'] }
];

function run(nodeBin, tests) {
  const files = tests.map(t => path.join(ROOT, 'test', `${t}.test.js`));
  const r = spawnSync(nodeBin, ['--test', '--test-timeout=60000', ...files], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
  return r.status;
}

function main() {
  const opt = {};
  for (const a of process.argv.slice(2)) { const m = /^--([a-z]+)=(.*)$/.exec(a); if (m) opt[m[1]] = m[2]; }
  const nodeBin = opt.node || process.execPath;
  const originals = new Map();
  const restore = () => { for (const [f, text] of originals) fs.writeFileSync(f, text); originals.clear(); };
  process.on('SIGINT', () => { restore(); process.exit(130); });
  process.on('exit', restore);

  // The baseline must be green, or "failed" proves nothing.
  const base = run(nodeBin, [...new Set(MUTATIONS.flatMap(m => m.tests))]);
  if (base !== 0) { console.error('The unmodified tests do not pass; fix that first.'); process.exit(2); }

  let survived = 0, killed = 0;
  for (const m of MUTATIONS) {
    if (opt.only && !m.name.includes(opt.only)) continue;
    const file = path.join(SRC, m.file);
    const text = fs.readFileSync(file, 'utf8');
    const n = text.split(m.from).length - 1;
    if (n !== 1) { console.log(`SKIPPED   ${m.name}: the target text occurs ${n} times in ${m.file}`); survived++; continue; }
    originals.set(file, text);
    fs.writeFileSync(file, text.replace(m.from, () => m.to));
    let status;
    try { status = run(nodeBin, m.tests); } finally { fs.writeFileSync(file, text); originals.delete(file); }
    if (status === 0) { survived++; console.log(`SURVIVED  ${m.name}   (${m.file}; ran ${m.tests.join(', ')})`); }
    else { killed++; console.log(`killed    ${m.name}   (${m.file}; ${m.tests.join(', ')})`); }
  }
  console.log(`\n${killed} killed, ${survived} survived or skipped, of ${killed + survived}`);
  process.exit(survived ? 1 : 0);
}

main();
