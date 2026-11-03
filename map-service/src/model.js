'use strict';

// Occupancy and identity (contract section 4).
//
// The state is OCCUPANCY: berth -> train. TD has no snapshot, so occupancy is all that the C-Class
// messages keep exact:
//
//   CA  step       the description moves from `from` to `to`
//   CB  cancel     the description in `from` is cleared             (carries `from` only)
//   CC  interpose  a description is written into `to`               (carries `to` only)
//
// A train is an object with a stable, opaque `id` (not its headcode). Identity rules:
//   * CA moves the train from `from` to `to` (no train at `from`: a new one starts at `to`).
//   * CB clears the berth; the train is kept for `cancelledKeepSecs` as "recently cancelled".
//   * CC creates or re-attaches a train:
//       - same berth as a recently cancelled train               -> RENUMBERING: same id, new headcode,
//         the old one appended to previousHeadcodes;
//       - another area, same headcode, cancelled or last stepped
//         within `handoverSecs`                                    -> HANDOVER: same id, and the berth
//         graph learns the edge (refused if the two places are further apart than `handoverMaxKm`);
//       - otherwise a new id.
//   * No event for `maxIdleSecs` drops the train.
//
// A train stepping into an occupied berth overwrites its occupant (that is what the describer does).
// A CA whose `from` holds a DIFFERENT headcode means we missed an event: the stale occupant is dropped
// and a new train starts at `to` (renumbering needs the CB+CC pair, so it is never assumed).
//
// Everything bounded: trains, recently cancelled, per-train rings (berths, trail, previous headcodes).
//
// Changes are reported to ChangeSets as (id, position before the first change): exactly what the
// SSE hub needs to say "upsert" or "remove" per client box without remembering what each client knows.

const { haversineKm, bearingDeg, round5 } = require('./geo');

const BERTH_RE = /^[A-Z0-9_\-]{1,6}$/;
const AREA_RE = /^[A-Z0-9]{1,4}$/;

class ChangeSet {
  constructor() { this.map = new Map(); }
  note(id, olat, olon) { if (!this.map.has(id)) this.map.set(id, { olat, olon }); }
  take() { const m = this.map; this.map = new Map(); return m; }
  get size() { return this.map.size; }
}

class TrainModel {
  /**
   * @param {object} o
   * @param {BerthGraph} o.graph
   * @param {object} o.config  config.model + config.placement + config.region
   * @param {function} [o.now]
   * @param {function(Train, number):object|null} [o.matcher]  returns {svc, rec, index} or null
   */
  constructor({ graph, config, now = Date.now, matcher = null }) {
    this.graph = graph;
    this.cfg = config;
    this.now = now;
    this.matcher = matcher;
    this.occ = new Map();             // keyId -> Train
    this.byId = new Map();            // id -> Train
    this.byHc = new Map();            // headcode -> Set<Train>
    this.cancelledByKey = new Map();  // keyId -> { train, at }
    this.cancelledByHc = new Map();   // headcode -> { train, at }
    this.changeSets = [];
    this.counter = 0;
    this.boot = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
    this.placedVersion = -1;
    this.svcGen = 0;
    this.stats = {
      CA: 0, CB: 0, CC: 0, newTrains: 0, renumbered: 0, handovers: 0, handoversRefused: 0,
      overwritten: 0, staleOccupant: 0, cbMiss: 0, malformed: 0, idleDropped: 0, capEvicted: 0, keyOverflow: 0
    };
    const [s, w, n, e] = (config.region && config.region.bbox) || [-90, -180, 90, 180];
    this.region = { s, w, n, e };
  }

  addChangeSet(cs) { this.changeSets.push(cs); return cs; }

  // ---- plumbing -------------------------------------------------------------------------------------

  _touch(t) {
    const lat = t.placed ? t.lat : NaN, lon = t.placed ? t.lon : NaN;
    for (const cs of this.changeSets) cs.note(t.id, lat, lon);
    t.json = null;
  }

  _newId() { return 't' + this.boot + (++this.counter).toString(36); }

  _hcAdd(t) { let s = this.byHc.get(t.hc); if (!s) { s = new Set(); this.byHc.set(t.hc, s); } s.add(t); }
  _hcDel(t) { const s = this.byHc.get(t.hc); if (s) { s.delete(t); if (!s.size) this.byHc.delete(t.hc); } }

  _inRegion(p) { const r = this.region; return p.lat >= r.s && p.lat <= r.n && p.lon >= r.w && p.lon <= r.e; }

  _positionOf(keyId) {
    const p = this.graph.position(keyId);
    return p && this._inRegion(p) ? p : null;
  }

  _setPos(t, p, { step }) {
    const was = t.placed;
    const prevPos = was ? { lat: t.lat, lon: t.lon } : null;
    if (!p) { t.placed = false; t.pl = null; t.place = null; return; }
    t.placed = true; t.lat = p.lat; t.lon = p.lon; t.pl = p.pl; t.place = p;
    if (step && prevPos) {
      const h = bearingDeg(prevPos, p, this.cfg.minHeadingMetres || 20);
      if (h !== null) t.hdg = Math.round(h);
    }
    if (step || !was) this._trail(t);
  }

  _trail(t) {
    const tr = t.trail;
    tr.push(round5(t.lat), round5(t.lon), t.lastEventAt);
    const max = (this.cfg.trailMax || 40) * 3;
    const cut = t.lastEventAt - (this.cfg.trailWindowSecs || 900) * 1000;
    let drop = 0;
    while (tr.length - drop > 3 && (tr[drop + 2] < cut || tr.length - drop > max)) drop += 3;
    if (drop) tr.splice(0, drop);
  }

  _recent(t, keyId, at) {
    t.recentKeys.push(keyId); t.recentAts.push(at);
    const max = this.cfg.recentBerths || 20;
    if (t.recentKeys.length > max) { t.recentKeys.shift(); t.recentAts.shift(); }
  }

  _rematch(t) {
    if (!this.matcher) return;
    const nowMs = this.now();
    let r = null;
    try { r = this.matcher(t, nowMs); } catch (_) { r = null; }
    const oldUid = t.svc ? t.svc.svc.uid : null;
    t.svc = r;
    t.svcArea = this.graph.areaOf[t.keyId];
    t.svcHc = t.hc;
    t.svcGen = this.svcGen;
    t.svcCheckAt = nowMs + (r ? 600000 : (this.cfg.svcRecheckSecs || 120) * 1000);
    if (oldUid !== (r ? r.svc.uid : null)) { this._touch(t); }
  }

  _create(keyId, hc, ts) {
    const t = {
      id: this._newId(), hc, prevHc: null, keyId, at: ts, lastEventAt: ts, firstSeenAt: ts,
      lat: 0, lon: 0, pl: null, place: null, hdg: null, placed: false,
      recentKeys: [], recentAts: [], trail: [], svc: null, svcArea: null, svcHc: null, svcGen: 0, svcCheckAt: 0, json: null
    };
    this.stats.newTrains++;
    return t;
  }

  _attach(t, keyId, ts, { step }) {
    // Enter berth keyId (the caller has already taken the train out of its old berth, if any).
    this._touch(t);
    const old = this.occ.get(keyId);
    if (old && old !== t) { this._evict(old); this.stats.overwritten++; }
    t.keyId = keyId; t.at = ts; t.lastEventAt = ts;
    this.occ.set(keyId, t);
    if (!this.byId.has(t.id)) this.byId.set(t.id, t);
    this._hcAdd(t);
    this._recent(t, keyId, ts);
    this._setPos(t, this._positionOf(keyId), { step });
    if (!t.svc || t.svcArea !== this.graph.areaOf[keyId] || t.svcHc !== t.hc || t.svcGen !== this.svcGen) this._rematch(t);
    this._touch(t);
  }

  /** Take a train out of the visible state (touches first, so the change set keeps its last position). */
  _evict(t) {
    this._touch(t);
    if (this.occ.get(t.keyId) === t) this.occ.delete(t.keyId);
    this.byId.delete(t.id);
    this._hcDel(t);
  }

  _consume(rec) {
    if (this.cancelledByKey.get(rec.keyId) === rec) this.cancelledByKey.delete(rec.keyId);
    if (this.cancelledByHc.get(rec.train.hc) === rec) this.cancelledByHc.delete(rec.train.hc);
  }

  // ---- messages -------------------------------------------------------------------------------------

  /** One C-Class message: { type: 'CA'|'CB'|'CC', area, descr, from, to, ts }. Never throws. */
  apply(ev) {
    try {
      if (!ev || typeof ev !== 'object') { this.stats.malformed++; return; }
      const area = typeof ev.area === 'string' ? ev.area.trim().toUpperCase() : '';
      const descr = typeof ev.descr === 'string' ? ev.descr.trim() : '';
      const norm = b => (typeof b === 'string' ? b.trim().toUpperCase() : '');
      const from = norm(ev.from), to = norm(ev.to);
      const ts = Number.isFinite(ev.ts) ? ev.ts : this.now();
      if (!AREA_RE.test(area) || descr.length < 1 || descr.length > 8) { this.stats.malformed++; return; }
      if (ev.type === 'CA') {
        if (!BERTH_RE.test(from) || !BERTH_RE.test(to) || from === to) { this.stats.malformed++; return; }
        this._ca(area, descr, from, to, ts);
      } else if (ev.type === 'CB') {
        if (!BERTH_RE.test(from)) { this.stats.malformed++; return; }
        this._cb(area, descr, from, ts);
      } else if (ev.type === 'CC') {
        if (!BERTH_RE.test(to)) { this.stats.malformed++; return; }
        this._cc(area, descr, to, ts);
      } else this.stats.malformed++;
    } catch (_) { this.stats.malformed++; }
  }

  _ca(area, descr, from, to, ts) {
    this.stats.CA++;
    const fromId = this.graph.keyId(area, from), toId = this.graph.keyId(area, to);
    if (fromId < 0 || toId < 0) { this.stats.keyOverflow++; return; }
    let t = this.occ.get(fromId);
    if (t && t.hc !== descr) { this._evict(t); this.stats.staleOccupant++; t = null; }
    if (!t) {
      const there = this.occ.get(toId);
      if (there && there.hc === descr) t = there;       // the step was already applied (or its `from` missed)
    }
    if (t && t.keyId === toId) {                         // already there: refresh only
      t.lastEventAt = ts; this.graph.observeEdge(fromId, toId); return;
    }
    if (!t) { t = this._create(toId, descr, ts); }
    else {
      if (this.occ.get(t.keyId) === t) this.occ.delete(t.keyId);
      this.graph.observeEdge(fromId, toId);
    }
    this._attach(t, toId, ts, { step: true });
  }

  _cb(area, descr, from, ts) {
    this.stats.CB++;
    const id = this.graph.lookup(area, from);
    const t = id < 0 ? undefined : this.occ.get(id);
    if (!t) { this.stats.cbMiss++; return; }
    this._evict(t);
    t.lastEventAt = ts;
    const rec = { train: t, at: ts, keyId: id };
    const prevK = this.cancelledByKey.get(id); if (prevK) this._consume(prevK);
    const prevH = this.cancelledByHc.get(t.hc); if (prevH) this._consume(prevH);
    this.cancelledByKey.delete(id); this.cancelledByKey.set(id, rec);
    this.cancelledByHc.delete(t.hc); this.cancelledByHc.set(t.hc, rec);
  }

  _cc(area, descr, to, ts) {
    this.stats.CC++;
    const toId = this.graph.keyId(area, to);
    if (toId < 0) { this.stats.keyOverflow++; return; }
    const there = this.occ.get(toId);
    if (there && there.hc === descr) { there.lastEventAt = ts; return; }      // duplicate interpose

    const keep = (this.cfg.cancelledKeepSecs || 120) * 1000;
    let t = null;

    // 1. Renumbering: the same berth, a recently cancelled train.
    const rec = this.cancelledByKey.get(toId);
    if (rec && ts - rec.at <= keep && ts >= rec.at - 5000) {
      t = rec.train;
      this._consume(rec);
      if (t.hc !== descr) {
        t.prevHc = t.prevHc || [];
        if (t.prevHc[t.prevHc.length - 1] !== t.hc) t.prevHc.push(t.hc);
        if (t.prevHc.length > 5) t.prevHc.shift();
        t.hc = descr;
        this.stats.renumbered++;
      }
      this._attach(t, toId, ts, { step: false });
      return;
    }

    // 2. Handover: another area, the same headcode, cancelled or last stepped recently.
    const cand = this._handoverCandidate(area, descr, toId, ts);
    if (cand) {
      t = cand.train;
      const fromId = cand.keyId;
      if (cand.rec) this._consume(cand.rec);
      else { this._evict(t); }
      this._attach(t, toId, ts, { step: false });
      this.graph.observeEdge(fromId, toId);
      this.stats.handovers++;
      // The new area's position replaces the old; heading from the old place if both are known.
      return;
    }

    // 3. A new train.
    t = this._create(toId, descr, ts);
    this._attach(t, toId, ts, { step: false });
  }

  _handoverCandidate(area, descr, toId, ts) {
    const window = (this.cfg.handoverSecs || 90) * 1000;
    const maxKm = this.cfg.handoverMaxKm || 40;
    let best = null;
    const consider = (train, keyId, at, rec) => {
      if (this.graph.areaOf[keyId] === area) return;
      if (ts - at > window || ts < at - 5000) return;
      if (best && best.at >= at) return;
      const a = this.graph.position(keyId), b = this.graph.position(toId);
      if (a && b && haversineKm(a, b) > maxKm) { this.stats.handoversRefused++; return; }
      best = { train, keyId, at, rec };
    };
    const c = this.cancelledByHc.get(descr);
    if (c) consider(c.train, c.keyId, c.at, c);
    const live = this.byHc.get(descr);
    if (live) for (const t of live) consider(t, t.keyId, t.lastEventAt, null);
    return best;
  }

  // ---- housekeeping ---------------------------------------------------------------------------------

  /** Called every few seconds. */
  prune() {
    const now = this.now();
    const idle = (this.cfg.maxIdleSecs || 2700) * 1000;
    for (const t of [...this.byId.values()]) {
      if (now - t.lastEventAt > idle) { this._evict(t); this.stats.idleDropped++; }
    }
    const keep = (this.cfg.cancelledKeepSecs || 120) * 1000;
    for (const [k, rec] of this.cancelledByKey) { if (now - rec.at > keep) this._consume(rec); }
    for (const [k, rec] of this.cancelledByHc) { if (now - rec.at > keep) this._consume(rec); }
    const capC = this.cfg.maxCancelled || 20000;
    for (const m of [this.cancelledByKey, this.cancelledByHc]) {
      while (m.size > capC) m.delete(m.keys().next().value);
    }
    const cap = this.cfg.maxTrains || 30000;
    if (this.byId.size > cap) {
      // Least recently active first, until back at the cap.
      const sorted = [...this.byId.values()].sort((a, b) => a.lastEventAt - b.lastEventAt);
      for (let j = 0; this.byId.size > cap && j < sorted.length; j++) { this._evict(sorted[j]); this.stats.capEvicted++; }
    }
  }

  /** Recompute every position if the graph changed. Returns how many trains moved. */
  refreshPositions() {
    if (this.placedVersion === this.graph.version) return 0;
    this.placedVersion = this.graph.version;
    let moved = 0;
    for (const t of this.byId.values()) {
      const p = this._positionOf(t.keyId);
      const same = (!p && !t.placed) || (p && t.placed && p.lat === t.lat && p.lon === t.lon && p.pl === t.pl);
      if (same) continue;
      this._touch(t);
      this._setPos(t, p, { step: false });
      moved++;
    }
    return moved;
  }

  /** Re-run the service match for trains whose answer is due (bounded per call), or all after a reference reload. */
  refreshServices(limit = 300) {
    if (!this.matcher) return 0;
    const now = this.now();
    let n = 0;
    for (const t of this.byId.values()) {
      if (t.svcGen === this.svcGen && t.svcCheckAt > now) continue;
      this._rematch(t);
      if (++n >= limit) break;
    }
    return n;
  }

  /** Reference data changed: every cached match is stale. */
  invalidateServices() { this.svcGen++; }

  // ---- reading --------------------------------------------------------------------------------------

  /** The compact Train JSON string (cached on the train until it changes). null if not placed. */
  trainJson(t) {
    if (!t.placed) return null;
    if (t.json) return t.json;
    const o = {
      id: t.id, hc: t.hc, lat: round5(t.lat), lon: round5(t.lon), hdg: t.hdg, area: this.graph.areaOf[t.keyId],
      berth: this.graph.berth(t.keyId), at: t.at, pl: t.pl
    };
    if (t.svc) o.svc = t.svc.svc;
    t.json = JSON.stringify(o);
    return t.json;
  }

  /** Visible, placed trains. */
  *placed() { for (const t of this.byId.values()) if (t.placed) yield t; }

  counts() {
    let placed = 0;
    for (const t of this.byId.values()) if (t.placed) placed++;
    return { trains: this.byId.size, placed, unplaced: this.byId.size - placed, cancelled: this.cancelledByKey.size };
  }

  /** Everything /train/:id needs except the timetable detail (the caller owns the CIF index). */
  detail(id) {
    const t = this.byId.get(id);
    if (!t || !t.placed) return null;
    const g = this.graph;
    const recentBerths = t.recentKeys.map((k, i) => ({ area: g.areaOf[k], berth: g.berth(k), at: t.recentAts[i] }));
    const cut = this.now() - (this.cfg.trailWindowSecs || 900) * 1000;
    const trail = [];
    for (let i = 0; i < t.trail.length; i += 3) if (t.trail[i + 2] >= cut) trail.push([t.trail[i], t.trail[i + 1], t.trail[i + 2]]);
    const p = t.place;
    const place = p.pl === 's' ? { kind: 'station', station: p.station }
      : p.pl === 'i' ? { kind: 'between', between: p.between } : { kind: 'near', station: p.station };
    return {
      train: JSON.parse(this.trainJson(t)), previousHeadcodes: t.prevHc ? t.prevHc.slice() : [], firstSeenAt: t.firstSeenAt,
      recentBerths, trail, place, speedMphEstimate: this._speed(trail), svcRef: t.svc
    };
  }

  _speed(trail) {
    const win = this.now() - 300000;
    const pts = trail.filter(p => p[2] >= win);
    if (pts.length < 2) return null;
    let km = 0;
    for (let i = 1; i < pts.length; i++) km += haversineKm({ lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] });
    const hours = (pts[pts.length - 1][2] - pts[0][2]) / 3600000;
    if (hours < 60 / 3600) return null;
    const mph = (km / hours) * 0.621371;
    return mph >= 0 && mph <= 140 ? Math.round(mph) : null;
  }
}

module.exports = { TrainModel, ChangeSet };
