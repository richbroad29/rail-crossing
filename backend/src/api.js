const http = require('http');

function createApi(crossingStates, port = 3000) {
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
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'ok',
          uptime: process.uptime(),
          crossings: Object.keys(crossingStates).length,
          memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
          time: new Date().toISOString()
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
