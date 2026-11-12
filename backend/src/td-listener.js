// Required lazily, inside connect(). Nothing above the socket needs it, and deferring it
// means this module — including the feed-liveness logic that register #21 turns on — can be
// loaded and tested without the dependency present. It had no tests at all before 2026-10-27,
// which is part of how a four-and-a-half-day outage went unnoticed.
let stompit = null;
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { londonDateStamp } = require('./time-utils');
const { SClassDecoder, parseDataBytes } = require('./sclass-decoder');
const { TD_LOG_ROOT, tdLogDir, tdLogFile, isValidArea } = require('./td-paths');

// Single shared emitter — index.js wires its 'sighting' events into each
// crossing-state's recordTdSighting method.
const emitter = new EventEmitter();

// NROD's public feed is plain STOMP — they do not expose a TLS endpoint.
// Credentials travel in the clear; this is the documented NROD design.
const HOST = 'publicdatafeeds.networkrail.co.uk';
const PORT = 61618;
// Where connect() goes. Only `_setEndpointForTest` changes it, so a test can point the real stompit
// at a fake STOMP server on this machine.
let endpoint = { host: HOST, port: PORT };
const TOPIC = '/topic/TD_ALL_SIG_AREA';
// The areas whose C-Class berth steps drive crossing predictions: logged to the td log and
// emitted as 'sighting'. Set by start() from crossings.json (td-paths.crossingTdAreas) — it
// used to be a hard-coded 'LA', which meant a crossing in any other area got no berth steps
// at all (multi-crossing-readiness.md, blocker 1). Empty until start(): nothing is assumed.
let crossingAreas = new Set();
const LOG_DIR = TD_LOG_ROOT;

const RELEVANT_MSG_TYPES = new Set(['CA_MSG', 'CB_MSG', 'CC_MSG']);

// --- S-Class (additive) — barrier-state capture for the configured describer
// areas (e.g. BM/Yapton), decoded ALONGSIDE (never instead of) the LA C-Class
// path. S-Class types are disjoint from C-Class, so the two never interfere.
const S_CLASS_MSG_TYPES = new Set(['SF_MSG', 'SG_MSG', 'SH_MSG']);
const SCLASS_LOG_DIR = path.join(__dirname, '..', 'data', 'logs', 'sclass');

let decoder = null; // null => S-Class disabled (no/invalid config); LA path unaffected
let sclassConfig = null;
try {
  sclassConfig = require('../config/sclass.json');
  const d = new SClassDecoder(sclassConfig);
  const areas = Object.keys(d.areas);
  if (areas.length) { decoder = d; console.log(`S-Class decode enabled for area(s): ${areas.join(', ')}`); }
  else console.log('S-Class config has no areas — decode disabled');
} catch (e) {
  console.warn('S-Class decode disabled (config load failed):', e.message);
}

// ---- S-Class survey: every area, for a bounded window ----
// The feed carries S-Class for EVERY describer in Britain; the decoder keeps only the areas in
// sclass.json. A survey also banks the raw S-Class of every OTHER area, to survey-<date>.jsonl,
// so the barrier-bit scan (crossing-directory-refresh skill) can find barrier data in areas we
// don't collect yet. On only while sclass.json `survey.until` is in the future; it switches
// itself off at that instant with no restart. Capped at SURVEY_MAX_DAYS from startup so a
// forgotten date can't grow the disk without limit. Raw logging only: nothing is decoded,
// emitted or fed to predictions, and configured areas are logged exactly as before.
const SURVEY_MAX_DAYS = 14;
function surveyUntilFrom(cfg, now) {
  const until = cfg && cfg.survey && cfg.survey.until ? Date.parse(cfg.survey.until) : NaN;
  if (!Number.isFinite(until) || until <= now) return null;
  return Math.min(until, now + SURVEY_MAX_DAYS * 86400000);
}
let surveyUntil = surveyUntilFrom(sclassConfig, Date.now());
if (surveyUntil) console.log(`S-Class survey: banking raw S-Class from every area until ${new Date(surveyUntil).toISOString()}`);

// C-Class berth steps for the S-Class areas (BM) are captured too: we need the
// BM berth chain to confirm YN and for the Phase 2 join, and the real-time feed
// cannot be backfilled — so it must start with this window. Captured to a
// SEPARATE, area-tagged log (never the LA td log) and NEVER emitted as a
// 'sighting' from this path. If an S-Class area is ALSO a crossing area, its
// steps are written here AND go down the crossing path below (see processMessage)
// — the crossing path is never diverted, and the S-Class tooling keeps its log.
const CCLASS_EXTRA_AREAS = new Set(decoder ? Object.keys(decoder.areas) : []);

let messagesReceived = 0;
let eventsLogged = 0;
let cclassExtraLogged = 0;
let sclassRawLogged = 0;
let sclassEventsLogged = 0;
let surveyLogged = 0;
let connectAttempts = 0;
let lastSummaryAt = Date.now();

// ---- feed liveness (register #21) --------------------------------------------------------
//
// On 2026-09-22 the feed stopped and nothing noticed for FOUR AND A HALF DAYS. The journal
// shows exactly how: 22:28:08 "TD STOMP error: connection timed out" and "TD subscribe
// failed", and then no TD line ever again, while the process stayed up and healthy —
// LDB polling, log rotation and the schedule load all carried on as normal. Closures
// anchored to berth strikes were simply missing for the duration (goal 1).
//
// Three faults behind it, all addressed here:
//   1. `client.subscribe`'s error callback only logged and returned, with NO retry at all.
//   2. Nothing bounded `stompit.connect`: if it neither connects nor errors, the retry chain
//      ends silently. That is consistent with the journal — the 2s reconnect scheduled by the
//      error handler produced no "connected" and no "connect failed" line afterwards.
//   3. Both error paths could schedule reconnects concurrently, so recovery could also mean
//      several sockets racing.
//
// The watchdog is the backstop for all three and for whatever else does this next: it does
// not care WHY the feed went quiet, only that it did.
//
// STALE_MS = 5 min, measured not guessed. The subscription is the whole national feed
// (/topic/TD_ALL_SIG_AREA), which is never quiet: over 2,261 five-minute summary windows
// from 2026-10-20 onward the QUIETEST was 97 messages, about one every three seconds at
// 02:00. Five minutes of total silence is therefore far outside anything observed.
//
// Note this must count ALL messages, not area-LA events. LA alone goes genuinely quiet
// overnight — measured maxima of 151 and 78 minutes between consecutive LA events on
// 2026-10-22 and 23 — so a watchdog keyed on LA would either fire constantly or need a
// threshold hours long, which is how this went unnoticed for days in the first place.
const STALE_MS = 5 * 60 * 1000;
const WATCHDOG_TICK_MS = 60 * 1000;
// Bounds a connect that neither succeeds nor fails (fault 2). Generous: the observed healthy
// connect takes under a second, and a slow-but-working connect must not be cut off.
const CONNECT_TIMEOUT_MS = 30 * 1000;

let lastMessageAt = null;     // null until the first message; start() seeds the baseline
let feedStartedAt = null;
let currentClient = null;
let reconnectPending = false; // single-flight: see scheduleReconnect
let watchdogTimer = null;
let forcedReconnects = 0;
let lastForcedAt = null;

// One reconnect at a time, whichever path asks for it. Without this the error handler and
// the watchdog could both fire and leave two live sockets delivering duplicate messages.
function scheduleReconnect(delayMs, why) {
  if (reconnectPending) return;
  reconnectPending = true;
  console.error(`TD reconnecting in ${Math.round(delayMs / 1000)}s (${why})`);
  setTimeout(() => { reconnectPending = false; connect(); }, delayMs);
}

function dropClient() {
  if (!currentClient) return;
  const c = currentClient;
  currentClient = null;
  try { c.destroy ? c.destroy() : c.disconnect(); } catch (_) { /* already gone */ }
}

function checkFeedLiveness(now = Date.now()) {
  const since = lastMessageAt || feedStartedAt;
  if (since === null) return false;                  // not started
  if (now - since <= STALE_MS) return false;
  forcedReconnects++;
  lastForcedAt = new Date(now).toISOString();
  console.error(`TD feed silent for ${Math.round((now - since) / 1000)}s `
    + `(threshold ${STALE_MS / 1000}s) — forcing a reconnect [#21 watchdog]`);
  dropClient();
  // Reset the clock so a reconnect that is slow to deliver does not re-trigger every tick.
  lastMessageAt = now;
  reconnectPending = false;                          // a hung attempt must not block this one
  scheduleReconnect(0, 'watchdog: feed silent');
  return true;
}

// What /health reports. `staleSecs` is the number that matters — it is what was unbounded.
function feedHealth(now = Date.now()) {
  const since = lastMessageAt || feedStartedAt;
  return {
    started: feedStartedAt !== null,
    connected: currentClient !== null,
    lastMessageAt: lastMessageAt ? new Date(lastMessageAt).toISOString() : null,
    staleSecs: since === null ? null : Math.round((now - since) / 1000),
    stale: since === null ? false : (now - since) > STALE_MS,
    messagesReceived,
    forcedReconnects,
    lastForcedReconnectAt: lastForcedAt
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Each crossing area to its own log (td-paths): LA at the top level exactly as before,
// any other area in its own subfolder. Indirected only so a test can write elsewhere.
let tdFileFor = area => tdLogFile(area, londonDateStamp());
function writeEvent(evt) {
  const file = tdFileFor(evt.area);
  ensureDir(path.dirname(file));
  fs.appendFile(file, JSON.stringify(evt) + '\n', err => {
    if (err) console.error('TD log write failed:', err.message);
  });
}

// ---- S-Class capture (additive) ----
function sclassRawFile() { return path.join(SCLASS_LOG_DIR, `sclass-${londonDateStamp()}.jsonl`); }
function barrierFile() { return path.join(SCLASS_LOG_DIR, `barrier-${londonDateStamp()}.jsonl`); }
let cclassFile = area => path.join(SCLASS_LOG_DIR, `cclass-${area}-${londonDateStamp()}.jsonl`);
let surveyFile = () => path.join(SCLASS_LOG_DIR, `survey-${londonDateStamp()}.jsonl`);

function appendJsonl(file, obj, label) {
  ensureDir(path.dirname(file));
  fs.appendFile(file, JSON.stringify(obj) + '\n', err => {
    if (err) console.error(`${label} write failed:`, err.message);
  });
}

// Decode one S-Class message into barrier phase events: log the raw message (for
// re-derivation and hunting L() functions not yet in the map), log/emit any
// decoded CLOSE/OPEN events, and emit 'barrier' for downstream consumers.
// Bounded to areas present in config (BM). Does not touch the C-Class path.
function handleSClass(type, msg) {
  const area = msg && msg.area_id;
  if (!area) return;
  if (!decoder || !decoder.hasArea(area)) { handleSurvey(type, msg, area); return; }
  const addrHex = msg.address;
  const dataHex = msg.data;
  if (addrHex == null || dataHex == null) return;
  const msgType = msg.msg_type || type.replace('_MSG', '');

  // Server-receive time is authoritative for the barrier event; feedTime keeps
  // the signalling-system time too, so the join to C-Class (which logs feed
  // time) can use a common clock when needed.
  const ts = new Date().toISOString();
  const fms = Number(msg.time);
  const feedTime = Number.isFinite(fms) && fms > 0 ? new Date(fms).toISOString() : null;

  const bytes = parseDataBytes(dataHex);
  const startAddr = parseInt(addrHex, 16);
  if (Number.isInteger(startAddr) && bytes && decoder.shouldLogRaw(area, startAddr, bytes.length)) {
    appendJsonl(sclassRawFile(), { ts, feedTime, area, msgType, address: addrHex, data: dataHex }, 'S-Class raw log');
    sclassRawLogged++;
  }

  const events = decoder.apply(area, msgType, addrHex, dataHex, { ts, feedTime });
  for (const ev of events) {
    appendJsonl(barrierFile(), ev, 'Barrier log');
    sclassEventsLogged++;
    emitter.emit('barrier', ev);
    if (ev.kind === 'CLOSE' || ev.kind === 'OPEN') {
      console.log(`S-Class ${ev.area}/${ev.crossing} ${ev.kind} (${ev.phase})${ev.recovered ? ' [recovered]' : ''} @ ${ev.ts}`);
    }
  }
}

// Survey capture for an area NOT in sclass.json: the raw message only, in the same shape as the
// sclass-<date> log so the scan reads both alike. A no-op outside a survey window.
function handleSurvey(type, msg, area) {
  if (!surveyUntil || Date.now() >= surveyUntil) return;
  if (!isValidArea(area) || msg.address == null || msg.data == null) return;
  const fms = Number(msg.time);
  appendJsonl(surveyFile(), {
    ts: new Date().toISOString(),
    feedTime: Number.isFinite(fms) && fms > 0 ? new Date(fms).toISOString() : null,
    area, msgType: msg.msg_type || type.replace('_MSG', ''), address: msg.address, data: msg.data
  }, 'S-Class survey log');
  surveyLogged++;
}

// Capture a C-Class berth step for an extra (S-Class) area — e.g. BM — to a
// separate, area-tagged log. Builds the SAME event shape as the LA path (so the
// BM log is format-compatible for the Phase 2 join, using feed time as the LA
// td log does), but writes only to cclass-<area>-<date>.jsonl and emits no
// 'sighting'. The LA path's own statements are left exactly as they were.
function handleCClassExtra(type, msg) {
  const ms = Number(msg.time);
  const ts = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
  const evt = {
    ts,
    area: msg.area_id,
    event: msg.msg_type || type.replace('_MSG', ''),
    desc: msg.descr || null,
    from: msg.from || null,
    to: msg.to || null,
    trust_uid: null
  };
  appendJsonl(cclassFile(msg.area_id), evt, `${msg.area_id} C-Class log`);
  cclassExtraLogged++;
}

function processMessage(body) {
  let parsed;
  try { parsed = JSON.parse(body); }
  catch (e) { console.error('TD JSON parse failed:', e.message); return; }
  if (!Array.isArray(parsed)) return;

  messagesReceived++;
  lastMessageAt = Date.now();     // feed liveness — see STALE_MS (register #21)
  for (const wrapper of parsed) {
    for (const [type, msg] of Object.entries(wrapper)) {
      // S-Class (additive; configured areas only). Handled independently of the
      // C-Class path below — SF/SG/SH never overlap CA/CB/CC, so this leaves the
      // LA C-Class capture/sighting flow exactly as it was.
      if (S_CLASS_MSG_TYPES.has(type)) { handleSClass(type, msg); continue; }

      // C-Class berth steps for the extra S-Class areas (BM): separate, area-
      // tagged log, no 'sighting'. An area that is ALSO a crossing area falls
      // through to the crossing block too, so being in the S-Class map never
      // takes berth steps away from a crossing.
      if (RELEVANT_MSG_TYPES.has(type) && msg && CCLASS_EXTRA_AREAS.has(msg.area_id)) {
        handleCClassExtra(type, msg);
        if (!crossingAreas.has(msg.area_id)) continue;
      }

      if (!RELEVANT_MSG_TYPES.has(type)) continue;
      if (!msg || !crossingAreas.has(msg.area_id)) continue;
      const ms = Number(msg.time);
      const ts = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
      const evt = {
        ts,
        area: msg.area_id,
        event: msg.msg_type || type.replace('_MSG', ''),
        desc: msg.descr || null,
        from: msg.from || null,
        to: msg.to || null,
        trust_uid: null
      };
      writeEvent(evt);
      eventsLogged++;

      // Emit a sighting for downstream prediction state. CA = berth step,
      // CB = interpose (headcode first appearing). Both confirm the train is
      // physically here. Skip CC (cancel) — those carry the cleared headcode.
      // Payload now carries the berth (from/to/event) too — recordTdSighting
      // ignores the extra fields, while the live-position map (B1) needs them.
      if (evt.desc && (evt.event === 'CA' || evt.event === 'CB')) {
        emitter.emit('sighting', {
          headcode: evt.desc, ts: evt.ts, area: evt.area,
          event: evt.event, from: evt.from, to: evt.to
        });
      }
    }
  }

  const now = Date.now();
  if (now - lastSummaryAt > 300000) {
    console.log(`TD listener: ${messagesReceived} msgs received, ${eventsLogged} ${areasLabel()} events logged` +
      (decoder ? `, ${cclassExtraLogged} BM C-Class + ${sclassRawLogged} S-Class raw + ${sclassEventsLogged} barrier events` : '') +
      (surveyUntil && now < surveyUntil + 300000 ? ` + ${surveyLogged} survey` : '') +
      ` (last 5 min)`);
    surveyLogged = 0;
    messagesReceived = 0;
    eventsLogged = 0;
    cclassExtraLogged = 0;
    sclassRawLogged = 0;
    sclassEventsLogged = 0;
    lastSummaryAt = now;
  }
}

// ---- stompit 1.0.0 ERROR-frame crash -----------------------------------------------------------
//
// stompit's own ERROR handler, for a frame with `content-type: text/plain` and a body of 4096 bytes
// or less, reads the body and then calls `this.destroy(error)` inside a plain-function stream
// callback, where `this` is the FRAME, not the client. The error is emitted on the frame, which has no
// listener, so Node throws it as an uncaught exception and THIS PROCESS EXITS. The connect callback
// and `client.on('error')` below never see it. NROD answers a rejected login and a topic the account
// is not subscribed to with ERROR frames, so before this a password change or a revoked subscription
// could take the crossing service down, followed by a ~90 s timetable reparse on restart (goal 1).
// Reproduced against the real stompit in test/td-stomp-error.test.js.
//
// The fix uses only stompit's public API. It sets its command handlers through `setCommandHandlers`,
// at CONNECT and again at CONNECTED, so wrapping that method on each new client substitutes this
// handler every time. It does what stompit meant to do: read the body (bounded) and destroy the
// CLIENT with the error, which reaches the connect callback or `client.on('error')` and so the
// ordinary reconnect path. A longer or non-text body already took stompit's working branch; this
// handles both shapes the same way.
const ERROR_BODY_MAX = 4096;

function safeErrorHandler(frame) {
  const client = this;                                 // stompit calls handlers with the client as `this`
  const message = (frame.headers && frame.headers.message) || 'server sent ERROR frame';
  const error = client.createApplicationError(message);
  let done = false;
  const finish = text => {
    if (done) return;
    done = true;
    if (text) error.longMessage = text;
    client.destroy(error);
  };
  const chunks = [];
  let size = 0;
  frame.on('data', c => { if (size < ERROR_BODY_MAX) { chunks.push(c); size += c.length; } });
  frame.on('end', () => finish(Buffer.concat(chunks).toString('utf8').slice(0, ERROR_BODY_MAX)));
  frame.on('error', () => finish(''));
}

function hardenClient(client) {
  if (!client || typeof client.setCommandHandlers !== 'function') return;   // a test stand-in
  const original = client.setCommandHandlers.bind(client);
  client.setCommandHandlers = handlers =>
    original(handlers && handlers.ERROR ? { ...handlers, ERROR: safeErrorHandler } : handlers);
}

function connect() {
  const connectOptions = {
    host: endpoint.host,
    port: endpoint.port,
    connectHeaders: {
      'host': '/',
      'login': process.env.NR_FEED_USER,
      'passcode': process.env.NR_FEED_PASS,
      'heart-beat': '15000,15000',
      'client-id': `rail-crossing-${process.pid}`
    }
  };

  if (!stompit) stompit = require('stompit');

  // `settled` bounds the attempt. stompit.connect can in principle neither call back nor
  // error — which is what the 2026-09-22 journal looks like, a reconnect scheduled at 22:28:10
  // that produced no "connected" and no "connect failed" line, ever. A callback arriving after
  // the timeout must then NOT also be handled, or one attempt becomes two clients.
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    connectAttempts++;
    const backoff = Math.min(60000, 1000 * Math.pow(2, connectAttempts));
    console.error(`TD STOMP connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s`);
    scheduleReconnect(backoff, 'connect timeout');
  }, CONNECT_TIMEOUT_MS);

  // stompit returns the client synchronously and only sends CONNECT once the socket is up, so
  // hardening it here is in time for the very first frame (see safeErrorHandler).
  const pending = stompit.connect(connectOptions, (err, client) => {
    if (settled) { try { client && client.destroy(); } catch (_) {} return; }
    settled = true;
    clearTimeout(timer);
    if (err) {
      const backoff = Math.min(60000, 1000 * Math.pow(2, connectAttempts));
      connectAttempts++;
      console.error(`TD STOMP connect failed: ${err.message}`);
      scheduleReconnect(backoff, 'connect failed');
      return;
    }
    connectAttempts = 0;
    currentClient = client;
    console.log(`TD STOMP connected to ${HOST}:${PORT}, subscribing to ${TOPIC}`);

    client.subscribe({ destination: TOPIC, ack: 'auto' }, (subErr, message) => {
      if (subErr) {
        // Previously this logged and returned, with no retry — so a subscribe that failed on
        // an otherwise-live socket left the process connected to nothing, silently, forever.
        console.error('TD subscribe failed:', subErr.message);
        dropClient();
        scheduleReconnect(2000, 'subscribe failed');
        return;
      }
      message.readString('utf-8', (readErr, body) => {
        if (readErr) {
          console.error('TD read failed:', readErr.message);
          return;                       // one bad frame is not a reason to drop the feed
        }
        processMessage(body);
      });
    });

    client.on('error', e => {
      console.error('TD STOMP error:', e.message);
      dropClient();
      scheduleReconnect(2000, 'socket error');
    });
  });
  hardenClient(pending);
}

function areasLabel() { return crossingAreas.size ? [...crossingAreas].join('+') : 'no crossing-area'; }

// Which areas' C-Class drive crossings. Invalid ids are dropped (they become part of a log path).
function setCrossingAreas(areas) {
  crossingAreas = new Set((areas || []).filter(isValidArea));
}

// opts.areas: the TD areas the configured crossings need (index.js passes
// td-paths.crossingTdAreas(crossingsConfig)).
function start(opts = {}) {
  setCrossingAreas(opts.areas);
  if (!process.env.NR_FEED_USER || !process.env.NR_FEED_PASS) {
    console.warn('NR_FEED_USER / NR_FEED_PASS not set — TD listener disabled');
    return;
  }
  ensureDir(LOG_DIR);
  for (const a of crossingAreas) ensureDir(tdLogDir(a));
  if (decoder) ensureDir(SCLASS_LOG_DIR);
  if (!crossingAreas.size) console.warn('TD listener: no crossing has a td.area — no berth steps will reach any crossing');
  console.log(`TD listener starting: C-Class area=${areasLabel()}, log dir=${LOG_DIR}` +
    (decoder ? `; capturing S-Class + C-Class for area(s) ${Object.keys(decoder.areas).join(',')} -> ${SCLASS_LOG_DIR}` : ''));
  feedStartedAt = Date.now();
  // The watchdog outlives any individual client, so it is started once here and never
  // cleared — the one thing that keeps running when every other recovery path has failed.
  if (!watchdogTimer) {
    watchdogTimer = setInterval(() => checkFeedLiveness(), WATCHDOG_TICK_MS);
    if (watchdogTimer.unref) watchdogTimer.unref();
  }
  connect();
}

module.exports = {
  start,
  on: emitter.on.bind(emitter),
  // Feed liveness, for GET /health. Register #21: the outage was invisible because nothing
  // published how long it had been since the last message.
  feedHealth,
  // Test seams. The watchdog's whole job happens on a timer during an outage, so it has to be
  // callable directly; `_setFeedStateForTest` stands in for a feed that has gone quiet.
  _checkFeedLiveness: checkFeedLiveness,
  _setFeedStateForTest(st) {
    if ('lastMessageAt' in st) lastMessageAt = st.lastMessageAt;
    if ('feedStartedAt' in st) feedStartedAt = st.feedStartedAt;
    if ('currentClient' in st) currentClient = st.currentClient;
    if ('reconnectPending' in st) reconnectPending = st.reconnectPending;
    if ('forcedReconnects' in st) forcedReconnects = st.forcedReconnects;
  },
  _constantsForTest: { STALE_MS, WATCHDOG_TICK_MS, CONNECT_TIMEOUT_MS },
  // The watchdog's last act is to ask for a reconnect, so testing it reaches connect(), which
  // needs the STOMP library. Injecting a stub keeps the socket out of the test without
  // weakening what is asserted: whether a reconnect is ATTEMPTED is the behaviour under test,
  // not whether a TCP connection opens.
  _setStompitForTest(stub) { stompit = stub; },
  // The ERROR-frame test drives the REAL stompit against a fake server: these point connect() at it
  // and run one attempt, without start()'s watchdog.
  _setEndpointForTest(host, port) { endpoint = { host, port }; },
  _connectForTest() { connect(); },
  _setCrossingAreasForTest: setCrossingAreas,
  _processMessageForTest: processMessage,
  _setLogFilesForTest({ td, cclass, survey }) { if (td) tdFileFor = td; if (cclass) cclassFile = cclass; if (survey) surveyFile = survey; },
  _setSurveyUntilForTest(ms) { surveyUntil = ms; },
  _surveyUntilFrom: surveyUntilFrom,
  _constantsForSurveyTest: { SURVEY_MAX_DAYS }
};
