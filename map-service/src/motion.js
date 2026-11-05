'use strict';

// Motion plans on the wire (contract section 11). A Train whose berth has a span gets
//
//   mv: { sp, t0, eta, stop, dwell, held }
//
//   t0     the SIGNALLING time of the step into the berth (TD time), not receive time;
//   eta    t0 + the learned median for this train's class and behaviour at this berth. A train that
//          calls includes its dwell: from the learned "calls" median when there is one, else the
//          learned "passes" median plus the booked dwell. With nothing learned yet: span length over a
//          per-class fallback speed (plus the booked dwell), so the page always has a plan. On a departure berth with a known expected
//          departure: t0 + dwell + the learned RUN time, which is the PASS median (the 'calls' median there includes the standing
//          time, which `dwell` already counts) or, with none learned, span length over the class speed;
//   stop   metres along the span where it stops (calls only), else null (a constant-speed pass). A DEPARTURE berth
//          (its span starts at the stop) gives stop 0: the train starts standing there, never null;
//   dwell  the booked dwell in seconds when it calls, else null. On a DEPARTURE berth (section 17.4) it is the seconds from t0
//          until the train's expected departure from that station (booked departure plus TRUST lateness when known), never
//          negative, at most `maxDepartDwellSecs` (3600); 0 means due to leave now. Without a booked departure it is 0, as before;
//   held   true once  now > eta + max(30 s, p90 - median)  with no step: the train is waiting.
//
// STAYING AT THE PLATFORM (section 18.3). A departure plan must not run out of the platform on the clock alone: with neither a TRUST
// departure report from the station (`info.departedAt`) nor a step out of the berth, the expected departure is pushed back in steps
// of `departExtendSecs` (30), and each step is issued `departExtendLeadSecs` (5) BEFORE the departure it replaces falls due (the page
// draws about 12 s behind, so it has the extension long before the train would have moved). With departure D0 = t0 + the booked
// dwell, the k-th extension is issued at D0 - lead + (k-1) x step, so the plan at any instant is a pure function of the clock:
// k = 0 until D0 - lead, then 1 + floor((now - (D0 - lead)) / step). A TRUST departure report ends it: dwell = reported departure - t0.
// A step ends it too: the train is then in a new berth and has a new plan. Extension stops `departExtendMaxSecs` (900) past D0, so a
// train whose departure nobody ever reports, or whose step was missed, does not stand at the platform for ever; from there `held`
// takes over as before. An extended eta is always later than now + lead + run, and `held` needs now > eta + grace, so extending can
// neither flip `held` early nor loop: every `extendAt` is strictly in the future.
//
// `held` and the extension depend on the clock, so plan() also returns the instants they change: `heldAt` (when held flips) and
// `extendAt` (the next extension, or null). The model re-issues the train at the earlier of the two, instead of the client guessing.

const { classOf } = require('./transit');

class MotionPlanner {
  /**
   * @param {object} o
   * @param {{forBerth(keyId):{id,length,stop}|null}} o.spans
   * @param {TransitStore} o.transit
   * @param {function(Train, number):{beh:'calls'|'passes'|null, dwellSecs:number|null, departAt?:number|null}} o.berthInfo
   *        departAt: epoch ms of the expected departure from this berth's station (booked + lateness), when known
   * @param {object} o.config   config.motion
   */
  constructor({ spans, transit, berthInfo, config }) {
    this.spans = spans; this.transit = transit; this.berthInfo = berthInfo; this.cfg = config;
  }

  /** @returns {{mv:object, heldAt:number}|null} */
  plan(t, nowMs) {
    const sp = this.spans && this.spans.forBerth(t.keyId);
    if (!sp) return null;
    const cls = classOf(t.hc);
    const info = this.berthInfo(t, t.keyId) || { beh: null, dwellSecs: null };
    const calls = info.beh === 'calls';
    const departure = calls && sp.stop === 0;
    const dwell = calls && info.dwellSecs !== null && info.dwellSecs >= 0 ? Math.round(info.dwellSecs) : null;
    let medianSecs = null, spread = 0;
    // A train standing at its departure berth (section 17.4): wait until it is due to go, then run the span.
    const maxDwell = this.cfg.maxDepartDwellSecs || 3600;
    const dwellTo = ms => Math.max(0, Math.min(maxDwell, Math.round((ms - t.at) / 1000)));
    const reported = departure && Number.isFinite(info.departedAt);
    let departDwell = reported ? dwellTo(info.departedAt) : departure && Number.isFinite(info.departAt) ? dwellTo(info.departAt) : null;
    let extendAt = null;
    if (departDwell !== null && !reported) {
      const step = (this.cfg.departExtendSecs === undefined ? 30 : this.cfg.departExtendSecs) * 1000;
      const lead = (this.cfg.departExtendLeadSecs === undefined ? 5 : this.cfg.departExtendLeadSecs) * 1000;
      const limit = (this.cfg.departExtendMaxSecs === undefined ? 900 : this.cfg.departExtendMaxSecs) * 1000;
      if (step > 0) {
        const d0 = t.at + departDwell * 1000;                 // the departure the clock alone would give
        const first = d0 - lead;                              // the first extension is issued here
        const lastAt = d0 + limit - lead;                     // none is issued after this: past it the departure stands
        let k = nowMs >= first ? 1 + Math.floor((nowMs - first) / step) : 0;
        const kMax = Math.floor((lastAt - first) / step) + 1;           // extensions issued by lastAt, the last one included
        if (k > kMax) k = kMax;
        departDwell = Math.round((d0 + k * step - t.at) / 1000);
        const next = first + k * step;
        extendAt = k < kMax && next > nowMs ? next : null;
      }
    }
    if (departDwell !== null) {
      const pass = this.transit.estimate(t.keyId, cls, 'passes');
      let run = pass ? pass.median : this.transit.passMedian(t.keyId);
      if (pass) spread = pass.p90 - pass.median;
      if (run === null) run = sp.length / ((this.cfg.fallbackSpeedMps || {})[cls] || 15);
      const eta = Math.round(t.at + (departDwell + run) * 1000);
      const heldAt = eta + Math.max((this.cfg.heldMinGraceSecs || 30), spread) * 1000;
      return { mv: { sp: sp.id, t0: t.at, eta, stop: 0, dwell: departDwell, held: nowMs > heldAt }, heldAt, extendAt };
    }
    const own = this.transit.estimate(t.keyId, cls, calls ? 'calls' : 'passes');
    if (own) { medianSecs = own.median; spread = own.p90 - own.median; }
    else if (calls) {
      const pass = this.transit.estimate(t.keyId, cls, 'passes');
      if (pass && dwell !== null) { medianSecs = pass.median + dwell; spread = pass.p90 - pass.median; }
    }
    if (medianSecs === null) {
      const speeds = this.cfg.fallbackSpeedMps || {};
      const v = speeds[cls] || 15;
      medianSecs = sp.length / v + (calls && dwell !== null ? dwell : 0);
    }
    const eta = Math.round(t.at + medianSecs * 1000);
    const grace = Math.max((this.cfg.heldMinGraceSecs || 30), spread) * 1000;
    const heldAt = eta + grace;
    // A train that CALLS: on an arrival berth `stop` is the platform stop point; on a departure berth (the span starts at the stop,
    // sp.stop === 0) it "starts standing here": stop 0 and dwell 0, never null (contract section 16). `stop: null` is a constant-speed pass.
    const stop = calls && sp.stop !== null && sp.stop !== undefined ? sp.stop : null;
    const mv = { sp: sp.id, t0: t.at, eta, stop, dwell: departure ? 0 : dwell, held: nowMs > heldAt };
    return { mv, heldAt, extendAt: null };
  }
}

module.exports = { MotionPlanner };
