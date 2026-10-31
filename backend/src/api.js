const http = require('http');
const tdListener = require('./td-listener');

// `extras.trainMap` (optional): the live train map — { trainMap, geo, config, services }.
// Absent ⇒ the /map routes 404 like any unknown path.
function createApi(crossingStates, port = 3000, extras = {}) {
  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;
    // How many closure periods to return. Omitted ⇒ the state's own default (6, enough for
    // both apps' visible lists); the frontend asks for more only when "Show More" is used.
    // Clamped so a client cannot ask for an unbounded response.
    const limitParam = parseInt(url.searchParams.get('limit') || '', 10);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(200, limitParam))
      : undefined;

    try {
      // Health check
      if (path === '/health') {
        // Register #21 — the 2026-09-22 outage was invisible from here. The process was up,
        // LDB was polling and /health said "ok" for four and a half days while the berth feed
        // that anchors every close and open was dead. `td.staleSecs` is the number that was
        // missing; `status` degrades with it so an external check does not have to know the
        // threshold. Deliberately still HTTP 200 — this reports on a dependency, and a
        // non-200 would read as "the API is down", which it is not.
        const td = tdListener.feedHealth();
        res.writeHead(200);
        res.end(JSON.stringify({
          status: td.started && td.stale ? 'degraded' : 'ok',
          uptime: process.uptime(),
          crossings: Object.keys(crossingStates).length,
          memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
          time: new Date().toISOString(),
          td
        }));
        return;
      }

      // List all crossings
      if (path === '/crossings' || path === '/') {
        const summary = {};
        for (const [id, state] of Object.entries(crossingStates)) {
          const api = state.getApiState();
          summary[id] = {
            name: api.name,
            road: api.road,
            state: api.state,
            nextCloseTime: api.nextCloseTime,
            nextOpenTime: api.nextOpenTime
          };
        }
        res.writeHead(200);
        res.end(JSON.stringify(summary));
        return;
      }

      // Single crossing state: /crossing/:id
      const crossingMatch = path.match(/^\/crossing\/([^/]+)$/);
      if (crossingMatch) {
        const id = crossingMatch[1];
        const state = crossingStates[id];
        if (!state) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Unknown crossing: ${id}` }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(state.getApiState(limit)));
        return;
      }

      // Closures for a crossing: /crossing/:id/closures
      const closuresMatch = path.match(/^\/crossing\/([^/]+)\/closures$/);
      if (closuresMatch) {
        const id = closuresMatch[1];
        const state = crossingStates[id];
        if (!state) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Unknown crossing: ${id}` }));
          return;
        }
        // This endpoint's whole purpose is the closure list, so it defaults to everything
        // rather than to the state's display-sized default.
        const apiState = state.getApiState(limit || 200);
        res.writeHead(200);
        res.end(JSON.stringify({
          crossingId: id,
          state: apiState.state,
          closures: apiState.upcomingClosures
        }));
        return;
      }

      // B1: live train positions for a crossing: /crossing/:id/live
      // Read-only feed for the observer app. `serverTime` lets the client
      // measure device clock skew on every poll (no separate time endpoint).
      const liveMatch = path.match(/^\/crossing\/([^/]+)\/live$/);
      if (liveMatch) {
        const id = liveMatch[1];
        const state = crossingStates[id];
        if (!state) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Unknown crossing: ${id}` }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({
          crossingId: id,
          area: state.config.td ? state.config.td.area || null : null,
          serverTime: Date.now(),
          ttlSecs: Math.round(state._getLiveTtlMs() / 1000),
          trains: state.getLiveTrains()
        }));
        return;
      }

      // Close/open TRIGGERS and where they sit on the approach chain: /crossing/:id/triggers
      // Static per deploy (it describes config + the measured transit table, not live
      // trains), so the observer fetches it once at startup. Placement is computed
      // server-side so the map can't drift from the rule it is drawing — see getTriggers.
      const triggersMatch = path.match(/^\/crossing\/([^/]+)\/triggers$/);
      if (triggersMatch) {
        const id = triggersMatch[1];
        const state = crossingStates[id];
        if (!state) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Unknown crossing: ${id}` }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(state.getTriggers()));
        return;
      }

      // Live train map (proof of concept): every train in the region, placed from TD berths.
      // See src/train-map.js. Polled by /map/ every few seconds, so it stays compact: the
      // client decodes the train class from the headcode itself.
      const map = extras.trainMap;
      if (map && path === '/map/live') {
        const snap = map.trainMap.snapshot();
        const td = tdListener.feedHealth();
        res.writeHead(200);
        res.end(JSON.stringify({
          region: { id: map.config.region.id, name: map.config.region.name, bbox: map.config.region.bbox },
          serverTime: Date.now(),
          staleSecs: map.config.staleSecs || 600,
          feed: { connected: td.connected, stale: td.stale, staleSecs: td.staleSecs },
          areas: [...map.trainMap.areas].sort(),
          stats: snap.stats,
          trains: snap.trains
        }));
        return;
      }

      // Every berth the map knows and where it puts it — for checking coverage, not for polling.
      if (map && path === '/map/berths') {
        const berths = map.geo.listBerths().map(b => b.pos
          ? { area: b.area, berth: b.berth, lat: +b.pos.lat.toFixed(5), lon: +b.pos.lon.toFixed(5),
              placement: b.pos.placement, station: b.pos.station || null }
          : { area: b.area, berth: b.berth, lat: null, lon: null, placement: null, station: null });
        res.writeHead(200);
        res.end(JSON.stringify({
          serverTime: Date.now(),
          graph: map.geo.stats(),
          counters: map.trainMap.counters(),
          services: map.services ? { indexed: map.services.size(), builtAt: map.services.builtAt } : null,
          berths
        }));
        return;
      }

      // Legacy compatibility: /api?station=PLD (for existing frontend)
      if (path === '/api') {
        const station = url.searchParams.get('station');
        if (!station) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing station parameter' }));
          return;
        }
        // Find crossing by station code
        const entry = Object.entries(crossingStates).find(([_, s]) =>
          s.config.ldb.station === station
        );
        if (!entry) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `No crossing for station ${station}` }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(entry[1].getApiState(limit)));
        return;
      }

      // 404
      res.writeHead(404);
      res.end(JSON.stringify({
        error: 'Not found',
        endpoints: [
          'GET /health',
          'GET /crossings',
          'GET /crossing/:id',
          'GET /crossing/:id/closures',
          'GET /crossing/:id/live',
          'GET /crossing/:id/triggers',
          'GET /map/live',
          'GET /map/berths',
          'GET /api?station=PLD  (legacy compat)'
        ]
      }));

    } catch (err) {
      console.error('API error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  server.listen(port, () => {
    console.log(`API server listening on port ${port}`);
  });

  return server;
}

module.exports = { createApi };
