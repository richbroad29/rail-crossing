'use strict';

// The berth-first engine (docs/berth-first-design.md on main; docs/berth-first-v1-plan.md §2).
//
// STUB — v1 step 1, "the seam". It takes the same inputs as today's engine (crossing-state.js) and
// answers getApiState() in the same shape, so index.js can run it as a crossing's shadow and the
// page could one day be served by either. It predicts nothing yet: no closures, state OPEN. That is
// why crossing-definitions refuses it as a serving engine (SERVABLE_ENGINES) and allows it only as
// `shadowEngine` — a stub must never reach a page.
//
// Inputs are its own copies (engines.js), so it may keep them; it must never reach back into the
// serving engine. Its berth events are those of every area its routes cross (routes.areas), which
// is wider than the classic engine's single td.area.

class BerthFirstEngine {
  constructor(id, config, routes) {
    this.id = id;
    this.config = config;
    this.routes = routes || { areas: [] };
    this.areas = new Set(this.routes.areas || []);
    this.engine = 'berth-first';
    this.state = 'OPEN';
    this.ldbTrains = [];
    this.scheduleTrains = [];
    this.lastStateChange = new Date();
    // What the seam can be checked against: how many berth events of each kind, per area, it has
    // been handed (and kept — its own areas only).
    this.eventCounts = {};
  }

  ownsTdArea(area) {
    return this.areas.has(area);
  }

  updateLdbTrains(trains) {
    this.ldbTrains = trains || [];
  }

  updateScheduleTrains(trains) {
    this.scheduleTrains = trains || [];
  }

  // Every berth event the listener emits arrives here (index.js fans each one out to every engine);
  // only those from this engine's areas are kept.
  recordTdEvent(evt) {
    if (!evt || !this.ownsTdArea(evt.area)) return;
    const a = this.eventCounts[evt.area] || (this.eventCounts[evt.area] = {});
    a[evt.event] = (a[evt.event] || 0) + 1;
  }

  // Restart rebuild comes in step 5 (outage and restart); until then a restart starts cold.
  seedSightings() {
    return 0;
  }

  getApiState() {
    return {
      crossingId: this.id,
      name: this.config.name,
      road: this.config.road,
      state: this.state,
      lastStateChange: this.lastStateChange.toISOString(),
      currentClosure: null,
      nextClosure: null,
      upcomingClosures: [],
      closureCount: 0,
      nextCloseTime: null,
      nextOpenTime: null,
      trainSources: { ldb: this.ldbTrains.length, cif: this.scheduleTrains.length },
      lastRefresh: new Date().toISOString()
    };
  }

  // Extra fields for the shadow log line (engines.js), beyond the closures every engine logs.
  shadowDetail() {
    return { stub: true, eventCounts: this.eventCounts };
  }
}

module.exports = { BerthFirstEngine };
