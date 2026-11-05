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
  { name: 'area filter ignored (any timing point)', file: 'cif-index.js', from: 'if (rec.tip ? !(areaSet && areaSet.has(rec.tip[v])) : !ids.has(v)) continue;', to: '', tests: ['cif'] },
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
  { name: 'an unplaceable berth is drawn at 0,0 instead of counted', file: 'model.js', from: 'if (!p) { t.placed = false; t.pl = null; t.place = null; return; }', to: "if (!p) { t.placed = true; t.lat = 0; t.lon = 0; t.pl = 'a'; t.place = { pl: 'a', station: '?' }; return; }", tests: ['api'] },
  // phase 2: dependencies and feeds
  { name: 'missing dependency is retried forever in the TD loop', file: 'td-ingest.js', from: "if (e && e.kind === 'missing-dependency') {", to: 'if (false) {', tests: ['deps'] },
  { name: 'App.start() does not check dependencies', file: 'app.js', from: 'requireDeps();                                   // a missing package fails here, at once, not as a hang later', to: '', tests: ['deps'] },
  { name: 'a refused extra topic is retried at once (not switched off)', file: 'td-ingest.js', from: 'x.refused++; x.disabledUntil = this.now() + x.cooldownMs;', to: 'x.refused++;', tests: ['feeds'] },
  { name: 'an extra handler error is not counted against its subscription', file: 'td-ingest.js', from: 'x.errors++; if (x.firstError === null) x.firstError = log.errText(e);', to: 'void e;', tests: ['feeds'] },
  // TRUST
  { name: 'TRUST: the TD area is not required to cover the activation', file: 'trust.js', from: 'if (!areaSet.has(ctx.stanoxOf(ctx.cif.tiplocAt(rec, i)))) continue;', to: '', tests: ['trust'] },
  { name: 'TRUST: ambiguity guard removed', file: 'trust.js', from: "if (second && second.act !== best.act && second.rec.uid !== best.rec.uid && second.tier === best.tier && Math.abs(second.dist - best.dist) < (this.cfg.ambiguityMins || 2)) return null;", to: '', tests: ['trust'] },
  { name: 'TRUST: time window ignored', file: 'trust.js', from: 'if (!(dist <= window)) continue;', to: '', tests: ['trust'] },
  { name: 'TRUST: headcode taken from the wrong slice of train_id', file: 'trust.js', from: "act = { id, hc: id.slice(2, 6), uid: '', runDay", to: "act = { id, hc: id.slice(1, 5), uid: '', runDay", tests: ['trust'] },
  { name: 'TRUST: EARLY is not negative', file: 'trust.js', from: 'else if (e.status === ST_EARLY) act.lateMins = -e.variation;', to: 'else if (e.status === ST_EARLY) act.lateMins = e.variation;', tests: ['trust'] },
  { name: 'TRUST: an out-of-order report overwrites lateness', file: 'trust.js', from: 'if (!act.last || actualSec >= act.last.actualSec) {', to: 'if (true) {', tests: ['trust'] },
  { name: 'TRUST: a corrected movement is added, not replaced', file: 'trust.js', from: 'if (act.ev[b] === e.stanox && (act.ev[b + 3] & F_DEP) === (e.dep ? F_DEP : 0) && act.ev[b + 1] === plannedSec) { slot = i; break; }', to: '', tests: ['trust'] },
  { name: 'TRUST: movements before the activation are dropped', file: 'trust.js', from: 'for (const e of o.evs) this._apply(act, e); c.orphansReplayed += o.evs.length;', to: '', tests: ['trust'] },
  { name: 'TRUST: activations never expire', file: 'trust.js', from: 'if (nowMs > a.expireAt || finished) {', to: 'if (finished) {', tests: ['trust'] },
  { name: 'TRUST: the activation cap evicts nothing', file: 'trust.js', from: 'if (w) { this._drop(w); this.counts.evicted++; }', to: 'if (w) { this.counts.evicted++; }', tests: ['trust'] },
  { name: 'TRUST: events per train unbounded', file: 'trust.js', from: 'if (act.evN >= 400) return;                      // a pathological train: bounded', to: '', tests: ['trust'] },
  { name: 'TRUST: a change of identity does not re-key the headcode', file: 'trust.js', from: 'act.id = neu; act.hc = neu.slice(2, 6);', to: 'act.id = neu;', tests: ['trust', 'feeds'] },
  { name: 'TRUST: inference after a restart disabled', file: 'trust.js', from: 'if (!act && TRAIN_ID.test(id)) act = this._infer(id, ev, nowMs);', to: '', tests: ['trust'] },
  { name: 'TRUST: a negative inference is retried every time', file: 'trust.js', from: 'if (neg && nowMs < neg) return null;', to: '', tests: ['trust'] },
  // journey derivation
  { name: 'next station: passes count as stations', file: 'progress.js', from: 'if (c.cancelled || (p.arr < 0 && p.dep < 0)) continue;', to: 'if (c.cancelled) continue;', tests: ['trust'] },
  { name: 'next station: cancelled calls are not skipped', file: 'progress.js', from: 'if (c.cancelled || (p.arr < 0 && p.dep < 0)) continue;', to: 'if (p.arr < 0 && p.dep < 0) continue;', tests: ['trust'] },
  { name: 'expected time may be earlier than now', file: 'progress.js', from: 'c.expDep = hhmm(Math.max(p.dep + late, nowMin));', to: 'c.expDep = hhmm(p.dep + late);', tests: ['trust', 'feeds'] },
  { name: 'cancellation includes the cancellation point itself', file: 'progress.js', from: 'else for (let i = ci + 1; i < n; i++) calls[i].cancelled = true;', to: 'else for (let i = ci; i < n; i++) calls[i].cancelled = true;', tests: ['trust'] },
  { name: 'a pass report is stored as a departure', file: 'progress.js', from: 'if (passOnly) { c.actualPass = hm; c._pass = sec; } else', to: 'if (false) { c.actualPass = hm; c._pass = sec; } else', tests: ['trust'] },
  // VSTP
  { name: 'VSTP: the later message wins whatever its STP', file: 'vstp.js', from: 'if (STP_RANK[r.stp] >= curRank) winners.set(', to: 'if (true) winners.set(', tests: ['vstp'] },
  { name: 'VSTP: Delete removes nothing', file: 'vstp.js', from: 'this.recs = keep; this.counts.deletedRecords += n;', to: 'this.counts.deletedRecords += n;', tests: ['vstp'] },
  { name: 'VSTP: a cancel does not suppress the CIF schedule', file: 'vstp.js', from: "const rank = w === CANCELLED ? 3 : STP_RANK[w.stp];", to: "const rank = w === CANCELLED ? -1 : STP_RANK[w.stp];", tests: ['vstp'] },
  { name: 'VSTP: days-of-week ignored', file: 'vstp.js', from: "return dayNum >= r.start && dayNum <= r.end && r.runs[dow(dayNum)] === '1';", to: 'return dayNum >= r.start && dayNum <= r.end;', tests: ['vstp'] },
  { name: 'VSTP: the schedule cap not enforced', file: 'vstp.js', from: 'if (this.recs.length >= this.maxSchedules) this._evict();', to: '', tests: ['vstp'] },
  // transit times
  { name: 'transit: outliers over 30 minutes kept', file: 'transit.js', from: 'if (!(secs >= 0) || secs > this.maxSeconds) {', to: 'if (!(secs >= 0)) {', tests: ['transit'] },
  { name: 'transit: median is the 60th percentile', file: 'transit.js', from: 'median: percentile(a, 0.5)', to: 'median: percentile(a, 0.6)', tests: ['transit'] },
  { name: 'transit: p90 is the p80', file: 'transit.js', from: 'p90: percentile(a, 0.9)', to: 'p90: percentile(a, 0.8)', tests: ['transit'] },
  { name: 'transit: the entry cap not enforced', file: 'transit.js', from: 'if (this.map.size >= this.maxEntries) { this.stats.dropped++; return false; }', to: '', tests: ['transit'] },
  { name: 'transit: a berth entered by interposing is timed anyway', file: 'model.js', from: 't.keyId === fromId && t.enteredStep && ts > t.at', to: 't.keyId === fromId && ts > t.at', tests: ['transit'] },
  // motion plans
  { name: 'motion: held at exactly the threshold', file: 'motion.js', from: 'held: nowMs > heldAt', to: 'held: nowMs >= heldAt', tests: ['transit'] },
  { name: 'motion: no 30 s floor on the held grace', file: 'motion.js', from: 'Math.max((this.cfg.heldMinGraceSecs || 30), spread)', to: 'spread', tests: ['transit'] },
  { name: 'motion: dwell not added to a passing median', file: 'motion.js', from: 'medianSecs = pass.median + dwell;', to: 'medianSecs = pass.median;', tests: ['transit'] },
  { name: 'motion: t0 is the receive time, not the signalling time', file: 'motion.js', from: 'const mv = { sp: sp.id, t0: t.at,', to: 'const mv = { sp: sp.id, t0: nowMs,', tests: ['transit'] },
  { name: 'motion: the clock never flips held by itself', file: 'model.js', from: 'if (nowMs >= t.timeDepAt) { this.timeDep.delete(t); this._touch(t); n++; }', to: '', tests: ['transit'] },
  // spans
  { name: 'spans: always equal shares', file: 'spans.js', from: 'const w = learned ? meds : meds.map(() => 1);', to: 'const w = meds.map(() => 1);', tests: ['spans'] },
  { name: 'spans: no stop point on arrival and departure berths', file: 'spans.js', from: 'const stop = last ? len : first ? 0 : null;', to: 'const stop = null;', tests: ['spans'] },
  { name: 'spans: never re-cut', file: 'spans.js', from: 'const moved = Math.abs(len - old.length)', to: 'const moved = false; const _m = Math.abs(len - old.length)', tests: ['spans'] },
  { name: 'spans: always re-cut (ids churn)', file: 'spans.js', from: 'if (!moved) { this.stats.kept++; continue; }', to: '', tests: ['spans'] },
  { name: 'spans: superseded ids forgotten', file: 'spans.js', from: 'this.retired.set(old.id, old);', to: '', tests: ['spans'] },
  // recording
  { name: 'record: proxy headers not refused', file: 'record.js', from: 'for (const h of PROXY_HEADERS) if (req.headers[h] !== undefined) return false;', to: '', tests: ['record'] },
  { name: 'record: Host not checked', file: 'record.js', from: "return LOOPBACK_HOST.test(String(req.headers.host || ''));", to: 'return true;', tests: ['record'] },
  { name: 'record: remote socket allowed', file: 'record.js', from: 'if (!LOOPBACK_ADDR.has(addr)) return false;', to: '', tests: ['record'] },
  { name: 'record: segment size cap ignored', file: 'record.js', from: 'if (this.bytes + line.length > max) {', to: 'if (false) {', tests: ['record'] },
  { name: 'record: old segments never deleted', file: 'record.js', from: 'for (const n of names.slice(0, Math.max(0, names.length - keep))) {', to: 'for (const n of []) {', tests: ['record'] },
  { name: 'record: a write error is thrown into the tick', file: 'record.js', from: '} catch (e) { this._fail(e); }', to: '} catch (e) { throw e; }', tests: ['record'] },
  // round 2: the real track library, spans, the pack on the server, downloads
  { name: 'download: temp file removed without waiting for the write stream (the flake)', file: 'download.js', from: '      await closed(out);\n      removeQuietly(tmp);', to: '      removeQuietly(tmp);', tests: ['download'] },
  { name: 'spans: station snaps not filtered by the SMART platform', file: 'spans.js', from: 'const pr = go(pa || a, pb || b);', to: 'const pr = go(a, b);', tests: ['spans'] },
  { name: 'spans: a wild platform detour is accepted', file: 'spans.js', from: 'if (pr && pr.length <= r.length * (this.cfg.platformDetour || 1.3) + 200) {', to: 'if (pr) {', tests: ['spans'] },
  { name: 'spans: signals need not be on the route', file: 'spans.js', from: 'if (r) on.push({ s, d: r.d, reversed: r.reversed });', to: 'on.push({ s, d: r ? r.d : 0, reversed: r ? r.reversed : false });', tests: ['spans'] },
  { name: 'spans: signal direction ignored', file: 'spans.js', from: "const facing = on.filter(c => !(c.s.onWay && ((c.s.direction === 'forward' && c.reversed) || (c.s.direction === 'backward' && !c.reversed))));", to: 'const facing = on;', tests: ['spans'] },
  { name: 'spans: ambiguous signals pinned anyway', file: 'spans.js', from: 'if (facing[facing.length - 1].d - facing[0].d > 30) {', to: 'if (false) {', tests: ['spans'] },
  { name: 'spans: implausible signal pins accepted', file: 'spans.js', from: 'if (Math.abs(sg.d - prop) > slack) {', to: 'if (false) {', tests: ['spans'] },
  { name: 'spans: out-of-order pins all trusted', file: 'spans.js', from: 'if (pins[j].d + 5 < pins[i].d && best[j] + 1 > best[i]) {', to: 'if (best[j] + 1 > best[i]) {', tests: ['spans'] },
  { name: 'spans: the signal is read at the START of the berth', file: 'spans.js', from: "const berthIx = this.signalAt === 'end' ? k - 1 : k;", to: 'const berthIx = k;', tests: ['spans'] },
  { name: 'spans: a berth id matches only by exact text, not by signal number', file: 'spans.js', from: "if (/^\\d{1,5}$/.test(berth)) keys.push('n' + parseInt(berth, 10));", to: '', tests: ['spans'] },
  { name: 'track pack: the manifest hash is not checked', file: 'track-manager.js', from: 'if (!mf.sha256 || String(mf.sha256).toLowerCase() !== sha) throw', to: 'if (false) throw', tests: ['track-manager'] },
  { name: 'track pack: the manifest size is not checked', file: 'track-manager.js', from: 'if (mf.bytes !== undefined && mf.bytes !== st.size) throw', to: 'if (false) throw', tests: ['track-manager'] },
  { name: 'track pack: a pack without a manifest is trusted', file: 'track-manager.js', from: '} else if (requireManifest) {', to: '} else if (false) {', tests: ['track-manager'] },
  { name: 'track pack: a bad download is left in place', file: 'track-manager.js', from: "for (const f of [target, mtarget, target + '.check', mtarget + '.check', target + '.new', mtarget + '.new']) { try { fs.unlinkSync(f); } catch (_) { /* not there */ } }", to: '', tests: ['track-manager'] },
  { name: 'track pack: drafts and other tags are considered', file: 'track-manager.js', from: "if (!r || r.draft || typeof r.tag_name !== 'string' || !r.tag_name.startsWith(prefix)) continue;", to: "if (!r || typeof r.tag_name !== 'string') continue;", tests: ['track-manager'] },
  { name: 'track pack: an older release replaces a newer pack', file: 'track-manager.js', from: 'if (this.info && this.info.packDate && pick.date <= this.info.packDate) {', to: 'if (false) {', tests: ['track-manager'] },
  { name: 'track pack: old packs never pruned', file: 'track-manager.js', from: 'for (const n of names.slice(0, Math.max(0, names.length - keep))) {', to: 'for (const n of []) {', tests: ['track-manager'] },
  { name: 'track pack: --track-pack still downloads', file: 'track-manager.js', from: 'this.fixedFile = fixedFile; this.download = download && !fixedFile;', to: 'this.fixedFile = fixedFile; this.download = download;', tests: ['track-manager'] },
  { name: 'track format: the stored derived index is ignored (recomputed at load)', file: 'track/pack.js', from: 'const pre = s.VCUM && s.EBST && s.EBEN && s.GKEY && s.GOFF && s.GSEG && s.GSEGE;', to: 'const pre = false;', tests: ['track'] },
  { name: 'track format: format 1 refused', file: 'track/pack.js', from: 'if (version < F.MIN_VERSION || version > F.VERSION) throw', to: 'if (version !== F.VERSION) throw', tests: ['track'] },
  { name: 'track format: the writer does not store the derived index', file: '../track/lib/assemble.js', from: 'if (version >= 2 && !sections.GKEY) sections = Object.assign({}, sections, deriveSections(sections.VLAT, sections.VLON, sections.EVO));', to: '', tests: ['track'] },
  // station boards
  { name: 'board: sorted by booked time, not expected', file: 'station-board.js', from: 'board.sort((a, b) => a.k - b.k ||', to: 'board.sort((a, b) => a.b - b.b ||', tests: ['feeds'] },
  { name: 'board: the past window not applied', file: 'station-board.js', from: 'if (expMin < nowMin - GRACE_MIN || expMin > nowMin + AHEAD_MIN) continue;', to: 'if (expMin > nowMin + AHEAD_MIN) continue;', tests: ['feeds'] },
  { name: 'board: the 2 h window not applied', file: 'station-board.js', from: 'if (expMin < nowMin - GRACE_MIN || expMin > nowMin + AHEAD_MIN) continue;', to: 'if (expMin < nowMin - GRACE_MIN) continue;', tests: ['feeds'] },
  { name: 'board: the 30 min recent window not applied', file: 'station-board.js', from: 'if (mins >= nowMin - BEHIND_MIN && mins <= nowMin + 1) {', to: 'if (mins <= nowMin + 1) {', tests: ['feeds'] }
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
