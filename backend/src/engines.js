'use strict';

// Each crossing's engines: the one that serves its page, and optionally a shadow fed the same inputs
// and only logged (docs/berth-first-design.md D22; docs/berth-first-v1-plan.md §3).
//
// The rules that keep a shadow from ever touching what a user sees:
//   - it gets its OWN COPY of every input (board, timetable, berth event), so nothing it keeps or
//     changes is shared with the serving engine;
//   - every call into it is caught: a shadow fault is logged (rate-limited) and never thrown into
//     the serving path;
//   - the API is handed `serving` only, and nothing here reads a shadow's answer back.
// With no shadow configured, every method below makes exactly the calls index.js made before.

const v8 = require('v8');
const CrossingState = require('./crossing-state');
const { BerthFirstEngine } = require('./berth-first/engine');
const { engineOf, shadowEngineOf } = require('./crossing-definitions');

const FACTORIES = {
  classic: (id, def) => new CrossingState(id, def),
  'berth-first': (id, def, routes) => new BerthFirstEngine(id, def, routes)
};

// A deep copy that keeps Dates and Maps (unlike JSON), on every Node version we run.
const copy = x => v8.deserialize(v8.serialize(x));

const FAULT_LOG_LIMIT = 20;   // per crossing, so a shadow failing on every event cannot flood the journal

// One closure list in the shape both engines publish, reduced to what the comparison needs. The page
// works from start (CLOSED gate), predictedStart (countdown), end and the held flags (shared/predict.js).
function closureSummary(c) {
  return {
    start: c.start, predictedStart: c.predictedStart || null, end: c.end,
    trains: (c.trains || []).map(t => `${t.headcode || '?'}${(t.direction || '?')[0]}`),
    closePending: !!c.closePending, holdingOpen: !!c.holdingOpen
  };
}

class CrossingEngines {
  // opts.factories and opts.log are test seams.
  constructor(crossingsConfig, routesById = {}, opts = {}) {
    const factories = opts.factories || FACTORIES;
    this._log = opts.log || require('./logger').log;
    this.serving = {};
    this.shadows = {};
    this.faults = {};
    this._lastSig = {};
    for (const [id, def] of Object.entries(crossingsConfig)) {
      this.serving[id] = factories[engineOf(def)](id, def, routesById[id]);
      const sh = shadowEngineOf(def);
      if (sh) {
        this.shadows[id] = factories[sh](id, def, routesById[id]);
        this.faults[id] = 0;
      }
    }
  }

  shadowIds() { return Object.keys(this.shadows); }

  _toShadow(id, what, fn) {
    const sh = this.shadows[id];
    if (!sh) return;
    try {
      fn(sh);
    } catch (e) {
      this.faults[id]++;
      if (this.faults[id] <= FAULT_LOG_LIMIT) {
        console.error(`[${id}] shadow ${sh.engine || 'classic'} fault in ${what} (#${this.faults[id]}): ${e && e.stack || e}`);
      }
    }
  }

  // `cancelled` (optional): the same poll's cancelled services. Only an engine with updateLdbCancelled reads them
  // (berth-first's run-through); the classic engine has none, so it is handed nothing new. Given before the trains,
  // so the recompute the trains trigger already sees them.
  ldb(id, trains, cancelled) {
    const st = this.serving[id];
    if (cancelled && typeof st.updateLdbCancelled === 'function') st.updateLdbCancelled(cancelled);
    st.updateLdbTrains(trains);
    this._toShadow(id, 'ldb', sh => {
      if (cancelled && typeof sh.updateLdbCancelled === 'function') sh.updateLdbCancelled(copy(cancelled));
      sh.updateLdbTrains(copy(trains));
    });
  }

  schedule(id, trains) {
    this.serving[id].updateScheduleTrains(trains);
    this._toShadow(id, 'schedule', sh => sh.updateScheduleTrains(copy(trains)));
  }

  // One berth event to every engine; each keeps only its own areas (ownsTdArea).
  berth(evt) {
    for (const st of Object.values(this.serving)) st.recordTdEvent(evt);
    for (const id of Object.keys(this.shadows)) this._toShadow(id, 'berth', sh => sh.recordTdEvent({ ...evt }));
  }

  // An area's heartbeat (td-listener 'heartbeat') to every engine that watches feed health (berth-first); the
  // classic engine has no such method and is handed nothing.
  heartbeat(hb) {
    for (const st of Object.values(this.serving)) if (typeof st.recordTdHeartbeat === 'function') st.recordTdHeartbeat(hb);
    for (const id of Object.keys(this.shadows)) this._toShadow(id, 'heartbeat', sh => {
      if (typeof sh.recordTdHeartbeat === 'function') sh.recordTdHeartbeat({ ...hb });
    });
  }

  // fn(shadow) for each crossing's shadow, under the shadow fault guard.
  forShadows(what, fn) { for (const id of Object.keys(this.shadows)) this._toShadow(id, what, fn); }

  // Every engine, serving and shadow, as [id, role, engine].
  all() {
    const out = Object.entries(this.serving).map(([id, e]) => [id, 'serving', e]);
    for (const [id, e] of Object.entries(this.shadows)) out.push([id, 'shadow', e]);
    return out;
  }

  // Restart (berth-first design §5.12): each engine that rebuilds from the log (restoreFromLog) is handed the
  // logged berth events of the last hour for its areas, read by `read` (berth-first/restart-log.js), before the
  // feed starts. One read per distinct set of areas. A shadow's failure is caught as any shadow call is.
  restoreFromLogs(read) {
    const cache = new Map();
    for (const [id, role, eng] of this.all()) {
      if (typeof eng.restoreFromLog !== 'function') continue;
      const go = e => {
        const areas = e.restoreAreas();
        const key = areas.slice().sort().join('+');
        if (!cache.has(key)) cache.set(key, read({ areas }));
        const r = cache.get(key);
        const got = e.restoreFromLog(r.events, { lastRxMs: r.lastRxMs, sources: r.sources, fromMs: r.fromMs, toMs: r.toMs });
        console.log(`[${id}] ${role} ${e.engine}: restored ${got.events} berth events of the last hour (` +
          Object.entries(r.sources).map(([a, s]) => `${a} from its ${s}`).join(', ') + `); feed last heard ` +
          (got.lastRx ? new Date(got.lastRx).toISOString() : 'unknown') + (r.notes.length ? `; ${r.notes.join('; ')}` : ''));
      };
      if (role === 'serving') {
        try { go(eng); } catch (e) { console.error(`[${id}] restore failed: ${e && e.stack || e}`); eng.restoreFromLog([]); }
      } else this._toShadow(id, 'restore', sh => { try { go(sh); } catch (e) { sh.restoreFromLog([]); throw e; } });
    }
  }

  // For GET /health: each berth-first engine's feed state (design §5.11), by crossing and role.
  feedHealth() {
    const out = {};
    for (const [id, role, eng] of this.all()) {
      if (typeof eng.feedHealth !== 'function') continue;
      try { (out[id] = out[id] || {})[role] = eng.feedHealth(); }
      catch (e) { (out[id] = out[id] || {})[role] = { error: e && e.message }; }
    }
    return out;
  }

  // Shadow logging (berth-first-v1-plan §3): for each crossing that HAS a shadow, both engines'
  // published closures go into the daily log as cat:"closures" whenever they change, with an
  // `engine` and `role` field, so the two can be compared from logs alone. The page state is derived
  // offline from these with the page's own predict.js — never from an engine's `state` field. A
  // crossing without a shadow logs nothing new. Called on a timer by index.js.
  logClosureChanges() {
    for (const id of Object.keys(this.shadows)) {
      // Runs on a timer: a throw here would be uncaught and stop the process, so even the serving
      // side is caught. Reading getApiState has no side effects (it derives, it does not recompute).
      try { this._logIfChanged(id, 'serving', this.serving[id]); }
      catch (e) { console.error(`[${id}] closure log (serving) failed: ${e && e.message}`); }
      this._toShadow(id, 'closure log', sh => this._logIfChanged(id, 'shadow', sh));
    }
  }

  // What is logged is what the page is given: getApiState() with the engine's own default limit (6, api.js), the
  // closures a phone receives without Show More. Measured on 23 Nov through this code with a berth-first shadow
  // (fixab/why/s6cost.js, 24 Nov): 40 closures a line made 9,814 lines / 34.4 MB a day, 6 make 9,551 lines / 12.0 MB,
  // in a log kept plain for 90 days. (The daily log is ~6 MB a day without them.)
  _logIfChanged(id, role, engine) {
    const api = engine.getApiState();
    const closures = (api.upcomingClosures || []).map(closureSummary);
    // An engine that cannot predict (berth-first outage or restart) publishes no closures: logged as its own change.
    const unavailable = api.unavailable ? api.unavailable.reason : null;
    const sig = JSON.stringify([closures, unavailable]);
    const key = `${id}|${role}`;
    if (this._lastSig[key] === sig) return;
    this._lastSig[key] = sig;
    this._log('closures', {
      crossing: id, role, engine: engine.engine || 'classic', state: api.state, closures,
      ...(api.unavailable ? { unavailable: { reason: api.unavailable.reason, since: api.unavailable.since, ...(api.unavailable.areas ? { areas: api.unavailable.areas } : {}) } } : {}),
      ...(role === 'shadow' && typeof engine.shadowDetail === 'function' ? { detail: engine.shadowDetail() } : {})
    });
  }

  // An hourly line per shadow, so a shadow that publishes nothing (the stub) is still visibly alive.
  logShadowSummary() {
    for (const id of Object.keys(this.shadows)) {
      this._toShadow(id, 'summary', s => this._log('shadowSummary', {
        crossing: id, engine: s.engine || 'classic', faults: this.faults[id],
        ...(typeof s.shadowDetail === 'function' ? { detail: s.shadowDetail() } : {})
      }));
    }
  }
}

module.exports = { CrossingEngines, closureSummary, FACTORIES, _copyForTest: copy };
