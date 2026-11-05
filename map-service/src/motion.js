'use strict';

// Motion plans on the wire (contract section 11). A Train whose berth has a span gets
//
//   mv: { sp, t0, eta, stop, dwell, held }
//
//   t0     the SIGNALLING time of the step into the berth (TD time), not receive time;
//   eta    t0 + the learned median for this train's class and behaviour at this berth. A train that
//          calls includes its dwell: from the learned "calls" median when there is one, else the
//          learned "passes" median plus the booked dwell. With nothing learned yet: span length over a
//          per-class fallback speed (plus the booked dwell), so the page always has a plan;
//   stop   metres along the span where it stops (calls only), else null (a constant-speed pass). A DEPARTURE berth
//          (its span starts at the stop) gives stop 0 and dwell 0: the train starts standing there, never null;
//   dwell  the booked dwell in seconds when it calls (0 on a departure berth), else null;
//   held   true once  now > eta + max(30 s, p90 - median)  with no step: the train is waiting.
//
// `held` depends on the clock, so plan() also returns the instant it will flip: the model re-issues
// the train then, instead of the client having to guess.

const { classOf } = require('./transit');

class MotionPlanner {
  /**
   * @param {object} o
   * @param {{forBerth(keyId):{id,length,stop}|null}} o.spans
   * @param {TransitStore} o.transit
   * @param {function(Train, number):{beh:'calls'|'passes'|null, dwellSecs:number|null}} o.berthInfo
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
    const dwell = calls && info.dwellSecs !== null && info.dwellSecs >= 0 ? Math.round(info.dwellSecs) : null;
    let medianSecs = null, spread = 0;
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
    const departure = calls && sp.stop === 0;
    const stop = calls && sp.stop !== null && sp.stop !== undefined ? sp.stop : null;
    const mv = { sp: sp.id, t0: t.at, eta, stop, dwell: departure ? 0 : dwell, held: nowMs > heldAt };
    return { mv, heldAt };
  }
}

module.exports = { MotionPlanner };
