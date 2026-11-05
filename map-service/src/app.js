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
const { requireDeps } = require('./deps');
const { VstpOverlay } = require('./vstp');
const { TrustState } = require('./trust');
const { TransitStore, classOf } = require('./transit');
const { MotionPlanner } = require('./motion');
const { SpanBuilder } = require('./spans');
const { Recorder } = require('./record');
const { TrackManager } = require('./track-manager');
const { derive } = require('./progress');
const { buildBoard } = require('./station-board');
const { hhmm } = require('./time');
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
  constructor({ config, dataDir, envFile = null, fake = null, now = Date.now, refUrls = {}, authHosts = null, downloadOpts = {}, openSession = null, tdSleep = null, track = null, trackPack = null, trackUrls = {}, trackDownloadOpts = {} }) {
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
    this.vstp = new VstpOverlay({ maxSchedules: config.vstp.maxSchedules, maxPoints: config.vstp.maxPoints, now, onChange: () => this.model && this.model.invalidateServices() });
    this.transit = new TransitStore(config.transit);
    this.trust = new TrustState({ config: config.trust, now, context: () => this.ctx(), onChange: (act, kind) => this._onTrust(act, kind) });
    this._ctxBase = { areaStanox: new Map(), stanoxOf: () => 0, tiplocsOfStanox: () => [], isStation: () => false };
    this.spans = null;
    this.track = null;                  // the loaded TrackPack (src/track), once there is one
    this._injectedTrack = track; this._trackPackFile = trackPack; this._trackUrls = trackUrls; this._trackDownloadOpts = trackDownloadOpts;
    this.trackManager = null;
    this.motion = new MotionPlanner({
      spans: { forBerth: id => (this.spans ? this.spans.forBerth(id) : null) }, transit: this.transit,
      berthInfo: (t, keyId) => this._berthInfo(t, keyId), config: config.motion
    });
    this.model = new TrainModel({
      graph: this.graph, now,
      config: { ...config.model, ...config.placement, region: config.region },
      matcher: (t, ms) => this._match(t, ms),
      decorate: t => this._decorate(t),
      motion: this.motion,
      onTransit: (t, keyId, secs) => this._learnTransit(t, keyId, secs)
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
    this.recorder = null; this.debugTaps = 0;
    this.stationByCrsMap = new Map(); this._stationTiplocs = new Map(); this._boardCache = new Map();
    this._lastTrustPrune = this.mono(); this._lastVstpPrune = this.mono(); this._lastVstpSave = this.mono(); this._lastTransitSave = this.mono();
    this.vstpFile = path.join(dataDir, 'state', 'vstp-overlay.json');
    this.transitFile = path.join(dataDir, 'state', 'transit-times.json');
    this._openSession = openSession; this._tdSleep = tdSleep;
    this.listening = false;
    this.refdata.on('loaded', name => this._onLoaded(name));
  }

  // ---- reference data -> derived structures -------------------------------------------------------------

  _onLoaded(name) {
    if (name === 'cif') {
      this.refdata.data.cif.overlay = this.vstp;       // VSTP is merged over every new index
      this.model.invalidateServices();
      return;
    }
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
      const areaStanox = new Map();
      for (let r = 0; r < smart.rows; r++) {
        const sx = parseInt(smart.stanox[r], 10);
        if (!sx) continue;
        let set = areaStanox.get(smart.area[r]);
        if (!set) { set = new Set(); areaStanox.set(smart.area[r], set); }
        set.add(sx);
      }
      this._ctxBase = {
        areaStanox,
        stanoxOf: tl => { const c = corpus.byTiploc.get(tl); return c && c.stanox ? parseInt(c.stanox, 10) || 0 : 0; },
        tiplocsOfStanox: sx => corpus.stanoxTiplocs.get(String(sx).padStart(5, '0')) || [],
        isStation: tl => { const c = corpus.byTiploc.get(tl); return !!(c && c.crs); }
      };
      this._stationTiplocs.clear(); this._boardCache.clear();
      this.namer = R.makeNamer({ corpus, naptan });
      this.namerVer++;
      this.stationList = R.buildStationList({ corpus, naptan, stations: this.refdata.stations });
      this.stationByCrsMap = new Map(this.stationList.filter(x => x.crs).map(x => [x.crs, x]));
      this.derived = { at: this.now(), ...g };
      this.model.invalidateServices();
      log.info(`placement: ${g.anchored} anchored berths, ${g.hinted} hinted, ${g.stations} stations, ${this.stationList.length} listed (${Date.now() - t0} ms)`);
    } catch (e) {
      log.error(`placement: could not build anchors (${log.errText(e)})`);
    }
  }

  /** What the TRUST, VSTP and timetable code needs to know about the reference data (cheap; the CIF index is looked up live). */
  ctx() { const c = this._ctxBase; c.cif = this.refdata.data.cif || null; return c; }

  stationByCrs(crs) { return this.stationByCrsMap.get(crs) || null; }

  /** Every TIPLOC that is this station: its CRS's TIPLOCs, plus siblings sharing a STANOX. */
  stationTiplocs(st) {
    let set = this._stationTiplocs.get(st.crs);
    if (set) return set;
    set = new Set();
    const corpus = this.refdata.data.corpus;
    if (st.tiploc) set.add(st.tiploc);
    if (corpus) {
      for (const t of corpus.crsTiplocs.get(st.crs) || []) set.add(t);
      for (const t of [...set]) { const c = corpus.byTiploc.get(t); if (c && c.stanox) for (const u of corpus.stanoxTiplocs.get(c.stanox) || []) set.add(u); }
    }
    this._stationTiplocs.set(st.crs, set);
    return set;
  }

  _match(t, nowMs) {
    const cif = this.refdata.data.cif;
    if (!cif) return null;
    const area = this.graph.areaOf[t.keyId];
    let rec, act = null, dayNum, exact = false;
    // TRUST first: an exact activation beats the time match.
    const tm = this.trust.match(t.hc, area, nowMs, this.ctx());
    if (tm) { rec = tm.rec; act = tm.act; dayNum = tm.dayNum; exact = true; }
    else {
      const m = cif.match(t.hc, area, nowMs, { areaTiplocs: this.areaTiplocs, window: this.config.service.matchWindowMins });
      if (!m) return null;
      rec = m.rec; dayNum = m.dayNum;
      act = this.trust.actFor(rec.uid, dayNum);          // an activation for the same schedule still supplies lateness
    }
    let e = this.svcCache.get(rec);
    if (!e || e.ver !== this.namerVer) { e = { ver: this.namerVer, svc: cif.svc(rec, this.namer) }; this.svcCache.set(rec, e); }
    return { svc: e.svc, rec, index: cif, act, dayNum, exact };
  }

  /** The svc object as sent: the match's own, plus `late` and `next` once TRUST has an activation for it. */
  _decorate(t) {
    const m = t.svc;
    if (!m.act) return m.svc;
    const now = this.now();
    const d = derive(this.ctx(), m.rec, m.act, this.trust, now, m.act.runDay);
    const out = { ...m.svc };
    if (d.late !== null) out.late = d.late;
    if (d.next) {
      out.next = { name: this.namer(d.next.tiploc), time: d.next.time, exp: d.next.exp };
      if (d.next.clamped) t.svcDueAt = (Math.floor(now / 60000) + 1) * 60000;      // "never earlier than now" changes every minute
    }
    return out;
  }

  /** A track pack is (re)loaded: spans are rebuilt against it, incrementally, from the next tick. */
  _setTrack(pack) {
    this.track = pack;
    this.spans = this.config.spans.enabled ? new SpanBuilder({ track: pack, graph: this.graph, transit: this.transit, config: this.config.spans, now: this.now }) : null;
    this.model.invalidateServices();
  }

  /** GET /network: the overview GeoJSON (gzipped) and its ETag, or null without a pack. */
  network(level) {
    if (!this.track || (level !== 'lo' && level !== 'hi')) return null;
    const buf = this.track.network(level), tag = this.track.sha256();
    return buf ? { buf, etag: `"${tag.slice(0, 16)}-${level}"` } : null;
  }

  _onTrust(act, kind) {
    if (kind === 'activation') { this.model.rematchHeadcode(act.hc); return; }
    if (kind === 'identity') { this.model.rematchHeadcode(act.hc); if (act.previousHc) this.model.rematchHeadcode(act.previousHc); return; }
    this.model.touchAct(act);
  }

  /** Does this train call at the berth's station, and for how long? (sections 10 and 11) */
  _berthInfo(t, keyId) {
    const a = this.graph.anchors.get(keyId);
    if (a === undefined) return { beh: 'passes', dwellSecs: null };
    const m = t.svc;
    if (!m) return { beh: null, dwellSecs: null };
    const st = this.graph.stations[a];
    const set = this.stationTiplocs({ crs: st.crs || st.key, tiploc: st.key });
    for (let i = 0; i < m.rec.n; i++) {
      if (!set.has(m.index.tiplocAt(m.rec, i))) continue;
      const p = m.index.point(m.rec, i);
      if (p.arr >= 0 || p.dep >= 0) return { beh: 'calls', dwellSecs: p.arr >= 0 && p.dep >= 0 ? (p.dep - p.arr) * 60 : null };
      return { beh: 'passes', dwellSecs: null };
    }
    return { beh: null, dwellSecs: null };
  }

  _learnTransit(t, keyId, secs) {
    const info = this._berthInfo(t, keyId);
    if (info.beh) this.transit.add(keyId, classOf(t.hc), info.beh, secs);
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------

  async start() {
    requireDeps();                                   // a missing package fails here, at once, not as a hang later
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

    const nv = this.vstp.loadFile(this.vstpFile);
    if (nv > 0) log.info(`vstp: ${nv} schedules restored`);
    const nt = this.transit.loadFile(this.transitFile, this.graph);
    if (nt > 0) log.info(`transit: ${nt} series restored`);

    await this.refdata.loadFromDisk();
    this._derive();
    this.refdata.start();
    if (this._injectedTrack) this._setTrack(this._injectedTrack);
    else if (cfg.track.enabled) {
      this.trackManager = new TrackManager({ config: cfg.track, dataDir: this.dataDir, fixedFile: this._trackPackFile, download: !this.fake, urls: this._trackUrls, downloadOpts: this._trackDownloadOpts, now: this.now });
      this.trackManager.on('loaded', pack => this._setTrack(pack));
      await this.trackManager.start();
    }
    if (cfg.record.enabled) { this.recorder = new Recorder({ config: cfg.record, dataDir: this.dataDir, sse: this.sse, snapshot: this.snapshot, now: this.now }); this.recorder.start(); }

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
        onEvent: ev => this.model.apply(ev), ...(this._openSession ? { open: this._openSession } : {}),
        extras: [
          { name: 'trust', topic: cfg.trust.topic, enabled: cfg.trust.enabled, cooldownSecs: cfg.trust.disableOnRefusedSecs, onBody: (body, t) => this.trust.onBody(body, t) },
          { name: 'vstp', topic: cfg.vstp.topic, enabled: cfg.vstp.enabled, cooldownSecs: cfg.trust.disableOnRefusedSecs, onBody: body => this.vstp.onBody(body) }
        ]
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
      this.model.tickTime(this.now());
      if (this.spans) this.spans.step();
      if (t - this._lastPrune >= this.config.model.pruneIntervalSecs * 1000) { this.model.prune(); this._lastPrune = t; }
      const changes = this.changes.take();
      const stale = this.feedStale();
      if (changes.size || stale !== this.snapshot.feedStale || this._firstTick) { this.snapshot.rebuild(stale); this._firstTick = false; }
      this.sse.flush(changes);
      if (t - this._lastSave >= pc.saveIntervalSecs * 1000) { this._lastSave = t; this.saveGraph(); }
      if (t - this._lastTrustPrune >= 60000) { this._lastTrustPrune = t; this.trust.prune(this.now()); }
      if (t - this._lastVstpPrune >= 3600000) { this._lastVstpPrune = t; this.vstp.prune(this.now()); }
      if (t - this._lastVstpSave >= this.config.vstp.saveIntervalSecs * 1000) { this._lastVstpSave = t; this.vstp.saveFile(this.vstpFile); }
      if (t - this._lastTransitSave >= this.config.transit.saveIntervalSecs * 1000) { this._lastTransitSave = t; this.transit.saveFile(this.transitFile, this.graph); }
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
    if (this.recorder) this.recorder.stop();
    if (this.trackManager) this.trackManager.stop();
    this.saveGraph();
    this.vstp.saveFile(this.vstpFile);
    this.transit.saveFile(this.transitFile, this.graph);
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
      feeds: {
        td: { connected: td.connected, lastMessageAt: td.lastMessageAt, staleSecs: td.staleSecs, messagesPerMin: td.messagesPerMin },
        trust: this._feedStatus('trust', { activations: this.trust.acts.size }),
        vstp: this._feedStatus('vstp', { schedules: this.vstp.size })
      },
      reference: { smart: strip(rs.smart), corpus: strip(rs.corpus), naptan: strip(rs.naptan), cif: strip(rs.cif) },
      model: { trains: c.trains, placed: c.placed, unplaced: c.unplaced, anchoredBerths: gs.anchored, learnedEdges: gs.learnedEdges },
      clients: { sse: this.sse.size },
      diagnostics: {
        trust: this.trust.status(), vstp: this.vstp.status(), transit: { series: this.transit.size, ...this.transit.stats },
        spans: this.spans ? this.spans.status() : 'no track pack loaded', track: this.trackManager ? this.trackManager.status() : { loaded: !!this.track }, record: this.recorder ? this.recorder.status() : null
      }
    };
  }

  _feedStatus(name, extra) {
    const x = this.td ? this.td.extraStatus(name) : null;
    return { connected: x ? x.connected : false, lastMessageAt: x ? x.lastMessageAt : null, staleSecs: x ? x.staleSecs : null, messagesPerMin: x ? x.messagesPerMin : 0, ...extra };
  }

  trainDetail(id) {
    const d = this.model.detail(id);
    if (!d) return null;
    const ref = d.svcRef;
    return {
      train: d.train, previousHeadcodes: d.previousHeadcodes, firstSeenAt: d.firstSeenAt, recentBerths: d.recentBerths,
      trail: d.trail, service: ref ? this._serviceDetail(ref) : null, place: d.place, speedMphEstimate: d.speedMphEstimate
    };
  }

  /** The schedule detail with what TRUST knows laid over each calling point (every key always present; null = unknown). */
  _serviceDetail(ref) {
    const det = ref.index.detail(ref.rec, this.namer);
    const now = this.now();
    const d = derive(this.ctx(), ref.rec, ref.act || null, this.trust, now, ref.dayNum);
    det.calls.forEach((c, i) => {
      const x = d.calls[i];
      c.actualArr = x.actualArr; c.actualDep = x.actualDep; c.actualPass = x.actualPass; c.variation = x.variation;
      c.expArr = x.expArr; c.expDep = x.expDep; c.platformActual = x.platformActual; c.cancelled = x.cancelled;
    });
    let lastReport = null;
    const last = ref.act && ref.act.last;
    if (last && d.lastIdx >= 0) {
      const x = d.calls[d.lastIdx];
      lastReport = { name: det.calls[d.lastIdx].name, event: x.actualPass && !x.actualDep && !x.actualArr ? 'pass' : last.dep ? 'dep' : 'arr', time: hhmm(Math.floor(last.actualSec / 60)), at: last.actual };
    }
    det.lastReport = lastReport;
    return det;
  }

  stationBoard(crs) {
    const now = this.now();
    const hit = this._boardCache.get(crs);
    if (hit && now - hit.at < 5000) return hit.board;
    const board = buildBoard(this, crs, now);
    if (this._boardCache.size >= 64) this._boardCache.delete(this._boardCache.keys().next().value);
    this._boardCache.set(crs, { at: now, board });
    return board;
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
