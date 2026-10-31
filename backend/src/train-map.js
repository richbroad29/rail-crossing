'use strict';

// Live train map (proof of concept) — every train in the region's TD areas, placed on the map.
//
// State is BERTH OCCUPANCY, which is what TD actually describes: berth → the description in it.
// A train is an occupied berth. That is deliberately not "a headcode and where it was last seen":
// TD has no snapshot, so occupancy is the only state that the three C-Class messages keep exact —
//   CA  step       the description moves from `from` to `to`
//   CB  cancel     the description in `from` is removed       (carries `from` only)
//   CC  interpose  a description is written into `to`          (carries `to` only)
// CB/CC are as verified against the real feed on 2026-10-25 (see CLAUDE.md, item 0b); this
// module does not share td-listener's older comment that has them the other way round.
//
// Consequence worth knowing: a train standing still when the service starts is invisible until
// it next steps or is interposed. TD will not tell us about it any sooner.
//
// Positions come from berth-geo. A train whose berth cannot be placed yet (the graph is still
// learning that stretch) is counted, not drawn — it is never guessed onto the map.
//
// Kept apart from the crossing prediction path on purpose: it reads the same feed through its
// own event and is wrapped so that nothing thrown here can reach the Portslade code.

const { bearingDeg, haversineM, berthKey } = require('./berth-geo');

const HANDOVER_MS = 90 * 1000;       // cancel in one area → interpose in the next
const RECENT_TTL_MS = 10 * 60 * 1000;
const SAME_TRAIN_M = 10000;          // one description in two berths this close = one train
const FEED_CLOCK_TOLERANCE_MS = 15 * 60 * 1000;

class TrainMap {
  /**
   * @param {object} opts
   * @param {object} opts.config     config/map.json
   * @param {BerthGeo} opts.geo
   * @param {object} [opts.services] map-services instance (origin/destination), optional
   * @param {function} [opts.now]
   */
  constructor({ config, geo, services = null, now = () => Date.now() }) {
    this.config = config;
    this.geo = geo;
    this.services = services;
    this.now = now;
    const [s, w, n, e] = config.region.bbox;
    this.bbox = { s, w, n, e };
    this.maxAgeMs = (config.maxAgeSecs || 2700) * 1000;
    this.areas = new Set();

    this.occupancy = new Map(); // "AREA:BERTH" → { descr, at, fromKey, how }
    this.recent = new Map();    // descr → { key, at }   last place each description was seen
    this.headings = new Map();  // descr → { deg, at }   last known heading, for a step that doesn't move it
    this.counts = { CA: 0, CB: 0, CC: 0, handovers: 0, errors: 0 };
    this.startedAt = now();
  }

  setAreas(areas) { this.areas = new Set(areas); }

  _ts(msg) {
    const now = this.now();
    const ms = Number(msg.time);
    // Feed time when it is sane (it is the signalling system's own clock, as the LA log uses);
    // receive time when it is missing or wildly off, so one bad stamp can't age a train out.
    return Number.isFinite(ms) && Math.abs(ms - now) < FEED_CLOCK_TOLERANCE_MS ? ms : now;
  }

  /** One raw C-Class message from td-listener ('CA_MSG' etc., and its body). */
  handle(type, msg) {
    if (!msg || !this.areas.has(msg.area_id)) return;
    try {
      this._handle((msg.msg_type || String(type).replace('_MSG', '')), msg);
    } catch (e) {
      this.counts.errors++;
      if (this.counts.errors <= 5) console.error('Train map: event failed:', e.message);
    }
  }

  _handle(kind, msg) {
    const area = msg.area_id;
    const descr = (msg.descr || '').trim();
    const at = this._ts(msg);

    if (kind === 'CA') {
      if (!msg.from || !msg.to || !descr) return;
      this.counts.CA++;
      const fromKey = berthKey(area, msg.from);
      const toKey = berthKey(area, msg.to);
      this.occupancy.delete(fromKey);
      this.occupancy.set(toKey, { descr, at, fromKey, how: 'step' });
      this.geo.observeEdge(fromKey, toKey);
      this.recent.set(descr, { key: toKey, at });
      return;
    }

    if (kind === 'CB') {
      if (!msg.from) return;
      this.counts.CB++;
      const fromKey = berthKey(area, msg.from);
      const held = this.occupancy.get(fromKey);
      this.occupancy.delete(fromKey);
      const d = descr || (held && held.descr);
      if (d) this.recent.set(d, { key: fromKey, at });
      return;
    }

    if (kind === 'CC') {
      if (!msg.to || !descr) return;
      this.counts.CC++;
      const toKey = berthKey(area, msg.to);
      const prior = this.recent.get(descr);
      let fromKey = null;
      // A description arriving from ANOTHER area moments after it was last seen there is a
      // handover between describers — the only way the graph can learn to cross an area edge.
      if (prior && prior.key.split(':')[0] !== area && at - prior.at <= HANDOVER_MS && at >= prior.at) {
        fromKey = prior.key;
        this.geo.observeEdge(prior.key, toKey);
        this.counts.handovers++;
      }
      this.occupancy.set(toKey, { descr, at, fromKey, how: 'interpose' });
      this.recent.set(descr, { key: toKey, at });
    }
  }

  _inRegion(p) {
    const b = this.bbox;
    return p.lat >= b.s && p.lat <= b.n && p.lon >= b.w && p.lon <= b.e;
  }

  _prune(now) {
    for (const [k, o] of this.occupancy) if (now - o.at > this.maxAgeMs) this.occupancy.delete(k);
    for (const [d, r] of this.recent) if (now - r.at > RECENT_TTL_MS) this.recent.delete(d);
    for (const [d, h] of this.headings) if (now - h.at > this.maxAgeMs) this.headings.delete(d);
  }

  /** Everything the map endpoint serves. */
  snapshot() {
    const now = this.now();
    this._prune(now);

    const stats = {
      occupied: this.occupancy.size, placed: 0, unplaced: 0, outsideRegion: 0, merged: 0,
      byPlacement: { station: 0, interpolated: 0, approx: 0 }
    };
    const byDescr = new Map();
    for (const [k, o] of this.occupancy) {
      const i = k.indexOf(':');
      const area = k.slice(0, i), berth = k.slice(i + 1);
      const pos = this.geo.position(area, berth);
      if (!pos) { stats.unplaced++; continue; }
      if (!this._inRegion(pos)) { stats.outsideRegion++; continue; }
      if (!byDescr.has(o.descr)) byDescr.set(o.descr, []);
      byDescr.get(o.descr).push({ k, area, berth, o, pos });
    }

    const trains = [];
    for (const [descr, list] of byDescr) {
      list.sort((a, b) => b.o.at - a.o.at);
      // The same description in two berths is usually ONE train caught mid-step or mid-handover
      // (keep the newest); far apart it is two trains sharing a headcode, and both are shown.
      const kept = [];
      for (const c of list) {
        if (kept.some(x => haversineM(x.pos, c.pos) < SAME_TRAIN_M)) { stats.merged++; continue; }
        kept.push(c);
      }
      kept.forEach((c, idx) => {
        const id = idx === 0 ? descr : `${descr}#${idx + 1}`;
        let heading = null;
        if (c.o.fromKey) {
          const fi = c.o.fromKey.indexOf(':');
          const fromPos = this.geo.position(c.o.fromKey.slice(0, fi), c.o.fromKey.slice(fi + 1));
          heading = bearingDeg(fromPos, c.pos);
        }
        if (heading !== null) this.headings.set(id, { deg: heading, at: c.o.at });
        else if (this.headings.has(id)) heading = this.headings.get(id).deg;

        stats.placed++;
        stats.byPlacement[c.pos.placement] = (stats.byPlacement[c.pos.placement] || 0) + 1;
        const t = {
          id,
          headcode: descr,
          lat: +c.pos.lat.toFixed(5),
          lon: +c.pos.lon.toFixed(5),
          heading: heading === null ? null : Math.round(heading),
          area: c.area,
          berth: c.berth,
          lastStepAt: c.o.at,
          placement: c.pos.placement
        };
        if (c.pos.station) t.station = c.pos.station;
        if (c.pos.between) t.between = c.pos.between;
        const svc = this.services ? this.services.lookup(descr, now) : null;
        if (svc) t.service = svc;
        trains.push(t);
      });
    }
    trains.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { trains, stats };
  }

  counters() {
    return { ...this.counts, followingSince: new Date(this.startedAt).toISOString() };
  }
}

module.exports = { TrainMap };
