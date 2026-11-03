'use strict';

// Wiring: reference data -> berth graph -> occupancy model -> snapshot -> HTTP/SSE, fed by the TD
// connection. One process, one thread; a 1 Hz tick does the housekeeping and the batching.

const fs = require('fs');
const path = require('path');
const { BerthGraph } = require('./berth-graph');
const { TrainModel, ChangeSet } = require('./model');
const { Snapshot } = require('./snapshot');
const { SseHub } = require('./sse');
const { RefData } = require('./refdata');
const { TdIngest } = require('./td-ingest');
const { createServer } = require('./http');
const { loadEnvFile, feedCredentials, secretsFor } = require('./env');
const R = require('./reference');
const mem = require('./mem');
const log = require('./log');

const { performance } = require('perf_hooks');
const mb = n => Math.round(n / 1048576);

class App {
  /**
   * @param {object} o
   * @param {object} o.config
   * @param {string} o.dataDir
   * @param {string} [o.envFile]
   * @param {{host,port,refDir}} [o.fake]
   * @param {function} [o.now]
   * @param {object} [o.refUrls] / o.authHosts / o.downloadOpts   test seams for the downloader
   * @param {function} [o.openSession]                             test seam for STOMP
   */
  constructor({ config, dataDir, envFile = null, fake = null, now = Date.now, refUrls = {}, authHosts = null, downloadOpts = {}, openSession = null, tdSleep = null }) {
    this.config = config;
    this.dataDir = dataDir;
    this.envFile = envFile;
    this.fake = fake;
    this.now = now;
    this.startedAt = now();
    this.stateFile = path.join(dataDir, 'state', 'learned-graph.json');

    this.graph = new BerthGraph({
      maxHops: config.placement.maxHops, minEdgeCount: config.placement.minEdgeCount,
      maxKeys: config.model.maxBerthKeys, maxLearnedEdges: config.placement.maxLearnedEdges
    });
    this.model = new TrainModel({
      graph: this.graph, now,
      config: { ...config.model, ...config.placement, region: config.region },
      matcher: (t, ms) => this._match(t, ms)
    });
    this.changes = this.model.addChangeSet(new ChangeSet());
    this.snapshot = new Snapshot({ model: this.model, now, gzipCacheEntries: config.http.gzipCacheEntries });
    this.sse = new SseHub({ model: this.model, snapshot: this.snapshot, config: config.http, now });
    this.refdata = new RefData({ config, dataDir, refDir: fake ? fake.refDir : null, envFile, now, urls: refUrls, authHosts, downloadOpts });
    this.server = createServer(this);

    this.areaTiplocs = new Map();
    this.namer = t => t;
    this.namerVer = 0;
    this.stationList = [];
    this.svcCache = new WeakMap();
    this.derived = null;
    this._deriveQueued = false;
    this._timer = null;
    this.mono = () => performance.now();            // intervals use this; `now` only stamps data
    this._lastPrune = this.mono(); this._lastReplace = -Infinity; this._lastSave = this.mono(); this._lastSummary = this.mono(); this._lastGc = this.mono();
    this._firstTick = true;
    this._tickStats = { max: 0, slow: 0, n: 0 };
    this.td = null;
    this._openSession = openSession; this._tdSleep = tdSleep;
    this.listening = false;
    this.refdata.on('loaded', name => this._onLoaded(name));
  }

  // ---- reference data -> derived structures -------------------------------------------------------------

  _onLoaded(name) {
    if (name === 'cif') { this.model.invalidateServices(); return; }
    this._refLoads = (this._refLoads || 0) + 1;
    if (this._deriveQueued) return;
    this._deriveQueued = true;
    setImmediate(() => { this._deriveQueued = false; this._derive(); });
  }

  _derive() {
    const { smart, corpus, naptan } = this.refdata.data;
    if (!smart || !corpus) return;
    if (this._derivedLoads === (this._refLoads || 0) && this.derived) return;   // nothing new since the last build
    this._derivedLoads = this._refLoads || 0;
    try {
      const t0 = Date.now();
      const resolver = R.makeStanoxResolver({ corpus, naptan, stations: this.refdata.stations });
      const g = this.graph.loadSmart(smart, resolver);
      const at = new Map();
      for (let r = 0; r < smart.rows; r++) {
        const tl = corpus.stanoxTiplocs.get(smart.stanox[r]);
        if (!tl) continue;
        let s = at.get(smart.area[r]);
        if (!s) { s = new Set(); at.set(smart.area[r], s); }
        for (const t of tl) s.add(t);
      }
      this.areaTiplocs = at;
      this.namer = R.makeNamer({ corpus, naptan });
      this.namerVer++;
      this.stationList = R.buildStationList({ corpus, naptan, stations: this.refdata.stations });
      this.derived = { at: this.now(), ...g };
      this.model.invalidateServices();
      log.info(`placement: ${g.anchored} anchored berths, ${g.hinted} hinted, ${g.stations} stations, ${this.stationList.length} listed (${Date.now() - t0} ms)`);
    } catch (e) {
      log.error(`placement: could not build anchors (${log.errText(e)})`);
    }
  }

  _match(t, nowMs) {
    const cif = this.refdata.data.cif;
    if (!cif) return null;
    const m = cif.match(t.hc, this.graph.areaOf[t.keyId], nowMs, { areaTiplocs: this.areaTiplocs, window: this.config.service.matchWindowMins });
    if (!m) return null;
    let e = this.svcCache.get(m.rec);
    if (!e || e.ver !== this.namerVer) { e = { ver: this.namerVer, svc: cif.svc(m.rec, this.namer) }; this.svcCache.set(m.rec, e); }
    return { svc: e.svc, rec: m.rec, index: cif };
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------

  async start() {
    const cfg = this.config;
    try { fs.mkdirSync(path.join(this.dataDir, 'state'), { recursive: true }); } catch (e) { log.error(`start: cannot create ${this.dataDir} (${log.errText(e)})`); }
    const n = this.graph.loadLearnedFile(this.stateFile);
    if (n > 0) log.info(`placement: ${n} learned edges restored`);
    else if (n < 0) log.warn('placement: the saved graph could not be read; starting empty');

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(cfg.port, cfg.host, () => { this.server.removeListener('error', reject); resolve(); });
    });
    this.listening = true;
    this.port = this.server.address().port;
    log.info(`http: listening on ${cfg.host}:${this.port}`);

    await this.refdata.loadFromDisk();
    this._derive();
    this.refdata.start();

    let creds, host, port;
    if (this.fake) {
      creds = { user: 'fake-user', pass: 'fake-pass-word' }; host = this.fake.host; port = this.fake.port;
      log.info(`fake mode: TD from ${host}:${port}, reference files from ${this.fake.refDir}; no downloads`);
    } else {
      try {
        creds = feedCredentials(loadEnvFile(this.envFile), this.envFile);
        log.addSecrets(secretsFor(creds));
      } catch (e) { log.error(`td: no credentials (${log.errText(e)}); the map will have no live trains`); }
      host = 'publicdatafeeds.networkrail.co.uk'; port = 61618;
    }
    if (creds) {
      this.td = new TdIngest({
        config: cfg.td, creds, host, port, now: this.now, sleep: this._tdSleep,
        onEvent: ev => this.model.apply(ev), ...(this._openSession ? { open: this._openSession } : {})
      });
      this.td.start();
    }
    this._scheduleTick();
  }

  _scheduleTick() {
    this._timer = setTimeout(() => { this.tick(); this._scheduleTick(); }, this.config.http.batchMs);
    if (this._timer.unref) this._timer.unref();
  }

  /** One batch: housekeeping, snapshot, SSE. Never throws. */
  tick() {
    const t0 = Date.now();
    try {
      const pc = this.config.placement, t = this.mono();
      if (this.graph.version !== this.model.placedVersion && t - this._lastReplace >= pc.replaceMinIntervalSecs * 1000) {
        this.model.refreshPositions(); this._lastReplace = t;
      }
      this.model.refreshServices();
      if (t - this._lastPrune >= this.config.model.pruneIntervalSecs * 1000) { this.model.prune(); this._lastPrune = t; }
      const changes = this.changes.take();
      const stale = this.feedStale();
      if (changes.size || stale !== this.snapshot.feedStale || this._firstTick) { this.snapshot.rebuild(stale); this._firstTick = false; }
      this.sse.flush(changes);
      if (t - this._lastSave >= pc.saveIntervalSecs * 1000) { this._lastSave = t; this.saveGraph(); }
      if (t - this._lastGc >= this.config.model.gcIntervalSecs * 1000) { this._lastGc = t; mem.collect(); }
      if (t - this._lastSummary >= this.config.log.summarySecs * 1000) { this._lastSummary = t; this.summary(); }
    } catch (e) {
      log.error(`tick: failed (${log.errText(e)})`);
    }
    const ms = Date.now() - t0;
    this._tickStats.n++; this._tickStats.max = Math.max(this._tickStats.max, ms);
    if (ms > 500) this._tickStats.slow++;
  }

  feedStale() { return this.td ? this.td.isStale(this.config.http.feedStaleSecs) : true; }

  saveGraph() {
    const wrote = this.graph.saveLearned(this.stateFile);
    if (!wrote && this.graph.learnedDirty) log.warn(`placement: could not save the learned graph (${log.errText(this.graph.lastSaveError)})`);
    return wrote;
  }

  summary() {
    const c = this.model.counts(), td = this.td ? this.td.status() : null, m = process.memoryUsage();
    const ts = this._tickStats;
    log.info(`summary: td ${td ? `${td.connected ? 'up' : 'DOWN'} ${td.eventsPerMin}/min` : 'off'}; trains ${c.trains} (placed ${c.placed}, unplaced ${c.unplaced}); `
      + `new ${this.model.stats.newTrains} handovers ${this.model.stats.handovers} renumbered ${this.model.stats.renumbered}; sse ${this.sse.size}; `
      + `edges ${this.graph.learnedEdges} (keys ${this.graph.keyOf.length}, overflow ${this.graph.keyOverflow}/${this.graph.edgeOverflow}); rss ${mb(m.rss)}MB heap ${mb(m.heapUsed)}MB; tick max ${ts.max}ms slow ${ts.slow}`);
    this._tickStats = { max: 0, slow: 0, n: 0 };
  }

  async stop() {
    clearTimeout(this._timer);
    this.refdata.stop();
    if (this.td) await this.td.stop();
    this.sse.closeAll();
    this.saveGraph();
    if (this.listening) {
      await new Promise(resolve => { this.server.close(() => resolve()); if (this.server.closeAllConnections) this.server.closeAllConnections(); });
      this.listening = false;
    }
  }

  // ---- what the HTTP layer reads ---------------------------------------------------------------------------------

  health() {
    const c = this.model.counts(), m = process.memoryUsage();
    const td = this.td ? this.td.status() : { connected: false, lastMessageAt: null, staleSecs: null, messagesPerMin: 0 };
    const rs = this.refdata.status();
    let status;
    if (!this.refdata.placementReady || !this.derived) status = 'starting';
    else if (this.feedStale() || !this.refdata.data.naptan || !this.refdata.data.cif) status = 'degraded';
    else status = 'ok';
    const strip = o => { const { rows, schedules, loadedAt } = o; return schedules !== undefined ? { schedules, loadedAt } : { rows, loadedAt }; };
    const gs = this.graph.stats();
    return {
      status, uptimeSecs: Math.round((this.now() - this.startedAt) / 1000), rssMB: mb(m.rss), heapMB: mb(m.heapUsed),
      feeds: { td: { connected: td.connected, lastMessageAt: td.lastMessageAt, staleSecs: td.staleSecs, messagesPerMin: td.messagesPerMin } },
      reference: { smart: strip(rs.smart), corpus: strip(rs.corpus), naptan: strip(rs.naptan), cif: strip(rs.cif) },
      model: { trains: c.trains, placed: c.placed, unplaced: c.unplaced, anchoredBerths: gs.anchored, learnedEdges: gs.learnedEdges },
      clients: { sse: this.sse.size }
    };
  }

  trainDetail(id) {
    const d = this.model.detail(id);
    if (!d) return null;
    const ref = d.svcRef;
    return {
      train: d.train, previousHeadcodes: d.previousHeadcodes, firstSeenAt: d.firstSeenAt, recentBerths: d.recentBerths,
      trail: d.trail, service: ref ? ref.index.detail(ref.rec, this.namer) : null, place: d.place, speedMphEstimate: d.speedMphEstimate
    };
  }

  search(text) {
    const qU = text.toUpperCase(), qL = text.toLowerCase();
    const trains = [];
    for (const t of this.model.placed()) {
      if (t.hc.toUpperCase().startsWith(qU)) {
        trains.push({ id: t.id, hc: t.hc, o: t.svc ? t.svc.svc.o : null, d: t.svc ? t.svc.svc.d : null });
        if (trains.length >= 20) break;
      }
    }
    const scored = [];
    for (const s of this.stationList) {
      let rank = 9;
      if (s.crs === qU) rank = 0;
      else if (s.name.toLowerCase().startsWith(qL)) rank = 1;
      else if (qL.length >= 2 && s.crs.startsWith(qU)) rank = 2;
      else if (qL.length >= 2 && s.name.toLowerCase().includes(qL)) rank = 3;
      if (rank < 9) scored.push({ rank, s });
    }
    scored.sort((a, b) => a.rank - b.rank || (a.s.name < b.s.name ? -1 : 1));
    const stations = scored.map(x => ({ crs: x.s.crs, name: x.s.name, lat: x.s.lat, lon: x.s.lon }));
    const tCount = Math.min(trains.length, Math.max(10, 20 - stations.length));
    return { trains: trains.slice(0, tCount), stations: stations.slice(0, 20 - tCount) };
  }
}

module.exports = { App };
