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

// Single shared emitter — index.js wires its 'sighting' events into each
// crossing-state's recordTdSighting method.
const emitter = new EventEmitter();

// NROD's public feed is plain STOMP — they do not expose a TLS endpoint.
// Credentials travel in the clear; this is the documented NROD design.
const HOST = 'publicdatafeeds.networkrail.co.uk';
const PORT = 61618;
const TOPIC = '/topic/TD_ALL_SIG_AREA';
const TARGET_AREA = 'LA';
const LOG_DIR = path.join(__dirname, '..', 'data', 'logs', 'td');

const RELEVANT_MSG_TYPES = new Set(['CA_MSG', 'CB_MSG', 'CC_MSG']);

// --- S-Class (additive) — barrier-state capture for the configured describer
// areas (e.g. BM/Yapton), decoded ALONGSIDE (never instead of) the LA C-Class
// path. S-Class types are disjoint from C-Class, so the two never interfere.
const S_CLASS_MSG_TYPES = new Set(['SF_MSG', 'SG_MSG', 'SH_MSG']);
const SCLASS_LOG_DIR = path.join(__dirname, '..', 'data', 'logs', 'sclass');

let decoder = null; // null => S-Class disabled (no/invalid config); LA path unaffected
try {
  const sclassConfig = require('../config/sclass.json');
  const d = new SClassDecoder(sclassConfig);
  const areas = Object.keys(d.areas);
  if (areas.length) { decoder = d; console.log(`S-Class decode enabled for area(s): ${areas.join(', ')}`); }
  else console.log('S-Class config has no areas — decode disabled');
} catch (e) {
  console.warn('S-Class decode disabled (config load failed):', e.message);
}

// C-Class berth steps for the S-Class areas (BM) are captured too: we need the
// BM berth chain to confirm YN and for the Phase 2 join, and the real-time feed
// cannot be backfilled — so it must start with this window. Captured to a
// SEPARATE, area-tagged log (never the LA td log) and NEVER emitted as a
// 'sighting' (those drive Portslade prediction state, which stays LA-only).
// Excludes TARGET_AREA so the LA C-Class path is never diverted here, even if
// LA were later added to the S-Class map.
const CCLASS_EXTRA_AREAS = new Set(decoder ? Object.keys(decoder.areas).filter(a => a !== TARGET_AREA) : []);

let messagesReceived = 0;
let eventsLogged = 0;
let cclassExtraLogged = 0;
let sclassRawLogged = 0;
let sclassEventsLogged = 0;
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

function logFile() {
  return path.join(LOG_DIR, `td-${londonDateStamp()}.jsonl`);
}

function writeEvent(evt) {
  ensureDir(LOG_DIR);
  fs.appendFile(logFile(), JSON.stringify(evt) + '\n', err => {
    if (err) console.error('TD log write failed:', err.message);
  });
}

// ---- S-Class capture (additive) ----
function sclassRawFile() { return path.join(SCLASS_LOG_DIR, `sclass-${londonDateStamp()}.jsonl`); }
function barrierFile() { return path.join(SCLASS_LOG_DIR, `barrier-${londonDateStamp()}.jsonl`); }
function cclassFile(area) { return path.join(SCLASS_LOG_DIR, `cclass-${area}-${londonDateStamp()}.jsonl`); }

function appendJsonl(file, obj, label) {
  ensureDir(SCLASS_LOG_DIR);
  fs.appendFile(file, JSON.stringify(obj) + '\n', err => {
    if (err) console.error(`${label} write failed:`, err.message);
  });
}

// Decode one S-Class message into barrier phase events: log the raw message (for
// re-derivation and hunting L() functions not yet in the map), log/emit any
// decoded CLOSE/OPEN events, and emit 'barrier' for downstream consumers.
// Bounded to areas present in config (BM). Does not touch the C-Class path.
function handleSClass(type, msg) {
  if (!decoder) return;
  const area = msg && msg.area_id;
  if (!area || !decoder.hasArea(area)) return;
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
      // tagged log only — no 'sighting', never the LA td log. TARGET_AREA is
      // excluded from the set, so LA falls through to the unchanged block below.
      if (RELEVANT_MSG_TYPES.has(type) && msg && CCLASS_EXTRA_AREAS.has(msg.area_id)) {
        handleCClassExtra(type, msg); continue;
      }

      if (!RELEVANT_MSG_TYPES.has(type)) continue;
      if (!msg || msg.area_id !== TARGET_AREA) continue;
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
    console.log(`TD listener: ${messagesReceived} msgs received, ${eventsLogged} LA events logged` +
      (decoder ? `, ${cclassExtraLogged} BM C-Class + ${sclassRawLogged} S-Class raw + ${sclassEventsLogged} barrier events` : '') +
      ` (last 5 min)`);
    messagesReceived = 0;
    eventsLogged = 0;
    cclassExtraLogged = 0;
    sclassRawLogged = 0;
    sclassEventsLogged = 0;
    lastSummaryAt = now;
  }
}

function connect() {
  const connectOptions = {
    host: HOST,
    port: PORT,
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

  stompit.connect(connectOptions, (err, client) => {
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
}

function start() {
  if (!process.env.NR_FEED_USER || !process.env.NR_FEED_PASS) {
    console.warn('NR_FEED_USER / NR_FEED_PASS not set — TD listener disabled');
    return;
  }
  ensureDir(LOG_DIR);
  if (decoder) ensureDir(SCLASS_LOG_DIR);
  console.log(`TD listener starting: C-Class area=${TARGET_AREA}, log dir=${LOG_DIR}` +
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
  _setStompitForTest(stub) { stompit = stub; }
};
