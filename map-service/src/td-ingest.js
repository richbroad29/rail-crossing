'use strict';

// The TD feed: one STOMP connection to /topic/TD_ALL_SIG_AREA, every area, C-Class messages only.
//
//   * Connect is bounded (stomp.js), and there is exactly ONE reconnect loop (single-flight): a
//     failure, a close or the watchdog all just end the current attempt, and the loop alone decides
//     when to try again (exponential backoff with jitter, reset after a connection that delivered).
//   * Silence watchdog: no frame for `silenceMs` (5 min) while "connected" means the link is dead
//     in the way the crossing service's td-listener once was for 4.5 days (register #21) -> the
//     session is killed and the loop reconnects. Nothing else notices a socket that stays open.
//   * Handler failures never leave this module: a malformed body, a non-array, an odd element.
//   * Logs TRANSITIONS only (connected, lost, stale, recovered). Never per frame.

const { EventEmitter } = require('events');
const stomp = require('./stomp');
const log = require('./log');

class RateWindow {
  constructor(bucketMs = 5000, buckets = 12, now = Date.now) {
    this.bucketMs = bucketMs; this.n = buckets; this.now = now;
    this.counts = new Array(buckets).fill(0); this.stamp = new Array(buckets).fill(-1);
  }
  add(k = 1) {
    const b = Math.floor(this.now() / this.bucketMs), i = b % this.n;
    if (this.stamp[i] !== b) { this.stamp[i] = b; this.counts[i] = 0; }
    this.counts[i] += k;
  }
  /** Events in the last window, scaled to per minute. */
  perMin() {
    const b = Math.floor(this.now() / this.bucketMs);
    let sum = 0;
    for (let i = 0; i < this.n; i++) if (b - this.stamp[i] < this.n && this.stamp[i] >= 0) sum += this.counts[i];
    return Math.round(sum * 60000 / (this.n * this.bucketMs));
  }
}

class TdIngest extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.config       config.td
   * @param {{user,pass}} o.creds
   * @param {string} o.host / o.port
   * @param {function(object):void} o.onEvent  receives {type, area, descr, from, to, ts}
   * @param {function} [o.open]     openSession stand-in
   * @param {function} [o.now]
   * @param {function} [o.sleep]    (ms)=>Promise stand-in for backoff (tests)
   */
  constructor({ config, creds, host, port, onEvent, open = stomp.openSession, now = Date.now, sleep = null, extras = [] }) {
    super();
    // Extra subscriptions on the same connection (TRUST, VSTP). Each is isolated: its handler's
    // failures are counted against it alone and never reach the TD path, and a topic the login may
    // not read is switched off for a while (the broker closes the connection on that error, so the
    // reconnect simply leaves it out) instead of taking the TD feed down with it.
    this.extras = extras.map(x => ({
      name: x.name, topic: x.topic, onBody: x.onBody, enabled: x.enabled !== false, disabledUntil: 0, cooldownMs: (x.cooldownSecs || 3600) * 1000,
      frames: 0, errors: 0, lastMessageAt: null, firstError: null, rate: new RateWindow(5000, 12, now), subscribed: false, refused: 0
    }));
    this.cfg = config;
    this.creds = creds; this.host = host; this.port = port;
    this.onEvent = onEvent;
    this.open = open;
    this.now = now;
    this._sleep = sleep;
    this.session = null;
    this.running = false;
    this.connected = false;
    this.lastMessageAt = null;
    this.connectedAt = null;
    this.frames = new RateWindow(5000, 12, now);
    this.events = new RateWindow(5000, 12, now);
    this.counts = { frames: 0, events: 0, c: 0, other: 0, badBodies: 0, badItems: 0, reconnects: 0, watchdogKills: 0, connectFailures: 0 };
    this.lastError = null;
    this._timer = null;
    this._wake = null;
    this._stale = false;
    this._loopPromise = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._watch = setInterval(() => this._watchdog(), Math.min(10000, Math.max(50, Math.floor(this.cfg.silenceMs / 4))));
    if (this._watch.unref) this._watch.unref();
    this._loopPromise = this._loop();
  }

  async stop() {
    this.running = false;
    clearInterval(this._watch);
    if (this._wake) this._wake();
    const s = this.session;
    if (s) { try { await s.close({ timeoutMs: 3000 }); } catch (_) { try { s.kill(); } catch (__) { /* gone */ } } }
    if (this._loopPromise) { try { await this._loopPromise; } catch (_) { /* logged inside */ } }
    this.connected = false;
  }

  status() {
    const last = this.lastMessageAt;
    return {
      connected: this.connected,
      lastMessageAt: last,
      staleSecs: last === null ? null : Math.max(0, Math.round((this.now() - last) / 1000)),
      messagesPerMin: this.frames.perMin(),
      eventsPerMin: this.events.perMin()
    };
  }

  /** Is the feed stale: not connected, or silent for longer than `secs`. */
  isStale(secs) {
    if (!this.connected) return true;
    const ref = this.lastMessageAt === null ? this.connectedAt : this.lastMessageAt;
    return ref === null || this.now() - ref > secs * 1000;
  }

  // ---- the one reconnect loop ---------------------------------------------------------------------

  async _delay(ms) {
    if (this._sleep) return this._sleep(ms);
    return new Promise(resolve => {
      this._wake = () => { clearTimeout(this._timer); this._wake = null; resolve(); };
      this._timer = setTimeout(() => { this._wake = null; resolve(); }, ms);
    });
  }

  async _loop() {
    let attempt = 0;
    while (this.running) {
      let delivered = false;
      try {
        delivered = await this._oneConnection();
      } catch (e) {
        this.counts.connectFailures++;
        this.lastError = log.errText(e);
        if (e && e.kind === 'missing-dependency') {        // retrying cannot fix a missing package: stop, loudly
          this.fatal = this.lastError;
          this.running = false;
          log.error(`td: ${this.lastError}; the live feed is OFF`);
          this.emit('fatal', e);
          break;
        }
        if (!this._failLogged) { log.warn(`td: connect failed (${this.lastError}); retrying with backoff`); this._failLogged = true; }
      }
      if (!this.running) break;
      attempt = delivered ? 0 : attempt + 1;
      this.counts.reconnects++;
      const base = Math.min(this.cfg.backoffMaxMs, this.cfg.backoffMinMs * 2 ** Math.min(Math.max(attempt - 1, 0), 16));
      await this._delay(Math.round(base * (0.5 + Math.random() * 0.5)));
    }
  }

  async _oneConnection() {
    const session = await this.open({
      creds: this.creds, host: this.host, port: this.port, now: this.now,
      connectTimeoutMs: this.cfg.connectTimeoutMs, heartbeat: this.cfg.heartbeat
    });
    this.session = session;
    this.connected = true;
    this.connectedAt = this.now();
    this._failLogged = false;
    this._stale = false;
    const before = this.counts.frames;
    log.info(`td: connected to ${this.host}:${this.port}, subscribing to ${this.cfg.topic}`);
    this.emit('connected');
    const closed = new Promise(resolve => {
      if (!session.isOpen) resolve(session.closedInfo); else session.once('closed', resolve);
    });
    try { session.subscribe(this.cfg.topic, (body, headers, t) => this._onBody(body, t)); }
    catch (e) { session.kill(); throw e; }
    for (const x of this.extras) {
      x.subscribed = false;
      if (!x.enabled || this.now() < x.disabledUntil) continue;
      try {
        session.subscribe(x.topic, (body, headers, t) => this._onExtra(x, body, t));
        x.subscribed = true;
      } catch (_) { /* the session closed under us: the loop below reconnects */ }
    }
    const info = await closed;
    for (const x of this.extras) x.subscribed = false;
    const err = info && info.error;
    if (err && err.kind === 'not-authorised' && err.info && err.info.topic) {
      const x = this.extras.find(e => e.topic === err.info.topic);
      if (x) {
        x.refused++; x.disabledUntil = this.now() + x.cooldownMs;
        log.warn(`${x.name}: this login may not read ${x.topic}; running without it for ${Math.round(x.cooldownMs / 60000)} min (TD is unaffected)`);
      }
    }
    this.session = null;
    this.connected = false;
    const why = info && info.error ? `${info.error.kind || 'error'}: ${log.errText(info.error)}` : 'closed';
    if (this.running) log.warn(`td: connection lost (${why}); reconnecting`);
    this.emit('disconnected');
    return this.counts.frames > before;
  }

  _onExtra(x, body, receivedAt) {
    x.frames++; x.rate.add(1); x.lastMessageAt = receivedAt;
    try { x.onBody(body, receivedAt); }
    catch (e) { x.errors++; if (x.firstError === null) x.firstError = log.errText(e); }
  }

  /** Per extra subscription: {connected, lastMessageAt, staleSecs, messagesPerMin, ...}. */
  extraStatus(name) {
    const x = this.extras.find(e => e.name === name);
    if (!x) return null;
    return {
      connected: this.connected && x.subscribed, lastMessageAt: x.lastMessageAt,
      staleSecs: x.lastMessageAt === null ? null : Math.max(0, Math.round((this.now() - x.lastMessageAt) / 1000)),
      messagesPerMin: x.rate.perMin(), handlerErrors: x.errors, refused: x.refused, disabled: this.now() < x.disabledUntil
    };
  }

  _watchdog() {
    if (!this.connected || !this.session) return;
    const ref = this.lastMessageAt === null ? this.connectedAt : this.lastMessageAt;
    const silent = this.now() - ref;
    if (silent > this.cfg.silenceMs) {
      this.counts.watchdogKills++;
      log.warn(`td: no message for ${Math.round(silent / 1000)}s while connected; dropping the connection to reconnect`);
      this.session.kill();       // emits 'closed'; the loop reconnects
    }
  }

  // ---- messages -----------------------------------------------------------------------------------

  _ts(msg, receivedAt) {
    const ms = Number(msg && msg.time);
    // Feed time when it is sane (the signalling system's own clock), receive time otherwise: one
    // bad stamp must not age a train out or fake a handover.
    return Number.isFinite(ms) && Math.abs(ms - receivedAt) < this.cfg.clockToleranceMs ? ms : receivedAt;
  }

  _onBody(body, receivedAt) {
    this.counts.frames++;
    this.frames.add(1);
    this.lastMessageAt = receivedAt;
    if (this._stale) { this._stale = false; }
    if (typeof body !== 'string' || body.length > 8 * 1024 * 1024) { this.counts.badBodies++; return; }
    let arr;
    try { arr = JSON.parse(body); } catch (_) { this.counts.badBodies++; return; }
    if (!Array.isArray(arr)) { this.counts.badBodies++; return; }
    let n = 0;
    for (const item of arr) {
      if (!item || typeof item !== 'object') { this.counts.badItems++; continue; }
      let matched = false;
      for (const key of ['CA_MSG', 'CB_MSG', 'CC_MSG']) {
        const msg = item[key];
        if (msg === undefined) continue;
        matched = true;
        if (!msg || typeof msg !== 'object') { this.counts.badItems++; continue; }
        n++;
        try {
          this.onEvent({
            type: key.slice(0, 2), area: msg.area_id, descr: msg.descr, from: msg.from, to: msg.to,
            ts: this._ts(msg, receivedAt)
          });
        } catch (_) { this.counts.badItems++; }
      }
      if (!matched) this.counts.other++;
    }
    this.counts.events += n; this.counts.c += n;
    this.events.add(n);
  }
}

module.exports = { TdIngest, RateWindow };
