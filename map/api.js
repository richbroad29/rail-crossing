// The ONLY module that talks to the map service. Everything else in the page asks this for data
// and listens to its events, so the transport (live stream vs polling) can change without touching
// the rest.
//
// Transport state machine
// -----------------------
//   idle ──start()──▶ connecting ──snapshot──▶ sse
//                         │ error before a snapshot, twice in a row (a full server answers 503,
//                         │ which an EventSource cannot tell us apart from any other failure)
//                         ▼
//                      polling  (GET /trains every 5 s; every 60 s one probe tries the stream again)
//                         │ probe gets a snapshot
//                         ▼
//                        sse
//   A live stream that drops reconnects once after 1 s; a second failure drops to polling.
//   While polling, two failed polls in a row set `reachable: false` (the page shows a banner);
//   polling carries on with a gentle backoff until the service answers again.
//
// Events: 'snapshot' {serverTime, feedStale, trains}   a complete picture for the current box
//         'update'   {serverTime, upsert, remove}      changes only (stream only)
//         'status'   state                             transport / reachable / feedStale changed
// Everything with a clock, a socket or a timer is injected so the machine is testable offline.
(function (root) {
  'use strict';

  var geo = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./geo.js') : root.RM.geo;

  function createApi(o) {
    o = o || {};
    var base = String(o.base || '').replace(/\/+$/, '');
    var G = (typeof globalThis !== 'undefined') ? globalThis : root;
    var ES = o.EventSource || G.EventSource;
    var doFetch = o.fetch || (G.fetch && G.fetch.bind(G));
    var setT = o.setTimeout || G.setTimeout.bind(G);
    var clearT = o.clearTimeout || G.clearTimeout.bind(G);
    var now = o.now || Date.now;
    var Abort = o.AbortController || G.AbortController;

    var cfg = {
      debounceMs: 400, pollMs: 5000, probeMs: 60000, stallMs: 45000, requestTimeoutMs: 12000,
      sseFailuresBeforePoll: 2, padFrac: 0.3, maxOversize: 6,
      backoffMs: [1000, 2000, 4000, 8000, 16000, 30000], maxPollDelayMs: 20000
    };
    if (o.config) Object.keys(o.config).forEach(function (k) { cfg[k] = o.config[k]; });

    var listeners = { snapshot: [], update: [], status: [] };
    var state = {
      transport: 'idle',          // idle | connecting | sse | polling
      reachable: true,
      feedStale: false,
      lastMessageAt: null,        // client clock, when anything last arrived (pings count)
      lastDataAt: null,           // client clock, when a snapshot or update last arrived
      serverTime: null,           // newest serverTime seen
      skewMs: 0,                  // server clock minus ours, so "seconds since" is not fooled
      sseFailures: 0, pollFailures: 0, resubscribes: 0, connects: 0
    };

    var running = false, paused = false;
    var view = null, sub = null;
    var es = null, live = false, probing = false;
    var reconnectTimer = null, pollTimer = null, probeTimer = null, debounceTimer = null, stallTimer = null;
    var pollSeq = 0, pollAbort = null;

    function emit(ev, payload) {
      listeners[ev].slice().forEach(function (fn) {
        try { fn(payload); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
      });
    }
    function snapshotState() {
      var s = {}; Object.keys(state).forEach(function (k) { s[k] = state[k]; }); return s;
    }
    function change(patch) {
      var changed = false;
      Object.keys(patch).forEach(function (k) {
        if (state[k] !== patch[k]) { state[k] = patch[k]; if (k === 'transport' || k === 'reachable' || k === 'feedStale') changed = true; }
      });
      if (changed) emit('status', snapshotState());
    }
    function touch(serverTime, isData) {
      var t = now();
      state.lastMessageAt = t;
      if (isData) state.lastDataAt = t;
      if (typeof serverTime === 'number') { state.serverTime = serverTime; state.skewMs = serverTime - t; }
    }

    function url(path, withBox) {
      return base + '/map/v1/' + path + (withBox && sub ? '?bbox=' + geo.bboxToString(sub) : '');
    }

    // ---- the stream ---------------------------------------------------------------------------
    function clearStall() { if (stallTimer) { clearT(stallTimer); stallTimer = null; } }
    function armStall(mine) {
      clearStall();
      stallTimer = setT(function () { if (es === mine) onSseError(true); }, cfg.stallMs);
    }
    function closeEs() {
      clearStall();
      if (es) {
        var dead = es; es = null;
        try { dead.close(); } catch (e) { /* already closed */ }
      }
    }
    function parse(e) { try { return JSON.parse(e.data); } catch (err) { return null; } }

    function connectSse() {
      if (!running || paused || !ES) { if (!ES) startPolling(); return; }
      if (reconnectTimer) { clearT(reconnectTimer); reconnectTimer = null; }
      closeEs();
      live = false;
      state.connects++;
      if (state.transport !== 'polling') change({ transport: 'connecting' });
      var mine;
      try { mine = new ES(url('stream', true)); } catch (e) { onSseError(false); return; }
      es = mine;
      mine.addEventListener('snapshot', function (e) {
        if (es !== mine) return;
        var d = parse(e); if (!d) return;
        live = true; probing = false;
        state.sseFailures = 0;
        stopPolling();
        touch(d.serverTime, true);
        change({ transport: 'sse', reachable: true, pollFailures: 0, feedStale: !!d.feedStale });
        armStall(mine);
        emit('snapshot', d);
      });
      mine.addEventListener('update', function (e) {
        if (es !== mine) return;
        var d = parse(e); if (!d) return;
        touch(d.serverTime, true);
        armStall(mine);
        emit('update', d);
      });
      mine.addEventListener('ping', function () {
        if (es !== mine) return;
        touch(null, false);
        armStall(mine);
      });
      mine.addEventListener('error', function () { if (es === mine) onSseError(live); });
    }

    function onSseError(wasLive) {
      closeEs();
      live = false;
      if (!running || paused) return;
      if (probing) {                         // a probe from polling failed: stay polling, try later
        probing = false;
        scheduleProbe();
        return;
      }
      state.sseFailures++;
      if (state.sseFailures >= cfg.sseFailuresBeforePoll) {
        startPolling();
        scheduleProbe();
      } else {
        change({ transport: state.transport === 'polling' ? 'polling' : 'connecting' });
        var d = cfg.backoffMs[Math.min(state.sseFailures - 1, cfg.backoffMs.length - 1)];
        reconnectTimer = setT(connectSse, d);
      }
    }

    // ---- polling ------------------------------------------------------------------------------
    function stopPolling() {
      if (pollTimer) { clearT(pollTimer); pollTimer = null; }
      pollSeq++;
      if (pollAbort) { try { pollAbort.abort(); } catch (e) { /* ignore */ } pollAbort = null; }
    }
    function startPolling() {
      if (!running || paused) return;
      if (reconnectTimer) { clearT(reconnectTimer); reconnectTimer = null; }
      closeEs();
      change({ transport: 'polling' });
      pollNow();
    }
    function pollNow() {
      if (pollTimer) { clearT(pollTimer); pollTimer = null; }
      if (!running || paused || state.transport !== 'polling') return;
      var seq = ++pollSeq;
      if (pollAbort) { try { pollAbort.abort(); } catch (e) { /* ignore */ } }
      pollAbort = Abort ? new Abort() : null;
      requestJson('trains' + (sub ? '?bbox=' + geo.bboxToString(sub) : ''), pollAbort && pollAbort.signal)
        .then(function (d) {
          if (seq !== pollSeq) return;
          state.pollFailures = 0;
          touch(d.serverTime, true);
          change({ reachable: true, feedStale: !!d.feedStale });
          emit('snapshot', d);
        })
        .catch(function () {
          if (seq !== pollSeq) return;
          state.pollFailures++;
          if (state.pollFailures >= 2) change({ reachable: false });
        })
        .then(function () {
          if (seq !== pollSeq || state.transport !== 'polling' || !running || paused) return;
          var f = state.pollFailures;
          var delay = f ? Math.min(cfg.pollMs * Math.pow(2, f - 1), cfg.maxPollDelayMs) : cfg.pollMs;
          pollTimer = setT(pollNow, delay);
        });
    }
    function scheduleProbe() {
      if (probeTimer) clearT(probeTimer);
      probeTimer = setT(function () {
        probeTimer = null;
        if (!running || paused || state.transport !== 'polling') return;
        probing = true;
        connectSse();
      }, cfg.probeMs);
    }

    // ---- requests -----------------------------------------------------------------------------
    function requestJson(path, signal) {
      var ctl = null, timer = null;
      var opts = { headers: { Accept: 'application/json' } };
      // Our own controller so every request has a deadline; a caller's signal is forwarded to it.
      if (Abort) {
        ctl = new Abort(); opts.signal = ctl.signal;
        timer = setT(function () { try { ctl.abort(); } catch (e) { /* ignore */ } }, cfg.requestTimeoutMs);
        if (signal) {
          if (signal.aborted) ctl.abort();
          else signal.addEventListener('abort', function () { try { ctl.abort(); } catch (e) { /* ignore */ } });
        }
      }
      return doFetch(base + '/map/v1/' + path, opts).then(function (r) {
        if (timer) clearT(timer);
        if (!r.ok) { var err = new Error('HTTP ' + r.status); err.status = r.status; throw err; }
        return r.json();
      }, function (e) { if (timer) clearT(timer); throw e; });
    }

    // ---- view box -----------------------------------------------------------------------------
    function applyBbox(v) {
      view = geo.clampBbox(v);
      if (!running) return false;
      if (sub && geo.bboxContains(sub, view) && geo.bboxArea(sub) <= cfg.maxOversize * geo.bboxArea(view)) return false;
      sub = geo.padBbox(view, cfg.padFrac);
      state.resubscribes++;
      if (paused) return true;
      if (state.transport === 'polling') pollNow();
      else { state.sseFailures = 0; connectSse(); }
      return true;
    }

    var self = {
      get state() { return snapshotState(); },
      get subscribedBbox() { return sub ? sub.slice() : null; },
      get config() { return cfg; },
      on: function (ev, fn) {
        if (!listeners[ev]) throw new Error('unknown event ' + ev);
        listeners[ev].push(fn);
        return function () { var i = listeners[ev].indexOf(fn); if (i >= 0) listeners[ev].splice(i, 1); };
      },
      start: function (bbox) {
        if (running) return;
        running = true; paused = false;
        view = geo.clampBbox(bbox || geo.GB_BBOX);
        sub = geo.padBbox(view, cfg.padFrac);
        state.resubscribes++;
        connectSse();
      },
      stop: function () {
        running = false;
        closeEs(); stopPolling();
        [reconnectTimer, probeTimer, debounceTimer].forEach(function (t) { if (t) clearT(t); });
        reconnectTimer = probeTimer = debounceTimer = null;
        change({ transport: 'idle' });
      },
      // Tab hidden: stop spending the service's connections on a page nobody is looking at.
      pause: function () {
        if (!running || paused) return;
        paused = true;
        closeEs(); stopPolling();
        [reconnectTimer, probeTimer].forEach(function (t) { if (t) clearT(t); });
        reconnectTimer = probeTimer = null;
        probing = false;
      },
      resume: function () {
        if (!running || !paused) return;
        paused = false;
        state.sseFailures = 0;
        if (state.transport === 'polling') { pollNow(); scheduleProbe(); }
        else connectSse();
      },
      // The map moved. Debounced; only resubscribes when the view has left the box we hold.
      setBbox: function (bbox) {
        if (debounceTimer) clearT(debounceTimer);
        debounceTimer = setT(function () { debounceTimer = null; applyBbox(bbox); }, cfg.debounceMs);
      },
      getTrain: function (id) {
        return requestJson('train/' + encodeURIComponent(id)).catch(function (e) {
          if (e && e.status === 404) return null;
          throw e;
        });
      },
      getStations: function () { return requestJson('stations'); },
      search: function (q, signal) { return requestJson('search?q=' + encodeURIComponent(q), signal); }
    };
    return self;
  }

  var api = { createApi: createApi };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.RM = root.RM || {}).api = api;
})(typeof self !== 'undefined' ? self : this);
