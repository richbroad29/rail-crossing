const stompit = require('stompit');
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

let messagesReceived = 0;
let eventsLogged = 0;
let sclassRawLogged = 0;
let sclassEventsLogged = 0;
let connectAttempts = 0;
let lastSummaryAt = Date.now();

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

function processMessage(body) {
  let parsed;
  try { parsed = JSON.parse(body); }
  catch (e) { console.error('TD JSON parse failed:', e.message); return; }
  if (!Array.isArray(parsed)) return;

  messagesReceived++;
  for (const wrapper of parsed) {
    for (const [type, msg] of Object.entries(wrapper)) {
      // S-Class (additive; configured areas only). Handled independently of the
      // C-Class path below — SF/SG/SH never overlap CA/CB/CC, so this leaves the
      // LA C-Class capture/sighting flow exactly as it was.
      if (S_CLASS_MSG_TYPES.has(type)) { handleSClass(type, msg); continue; }

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
      (decoder ? `, ${sclassRawLogged} S-Class raw + ${sclassEventsLogged} barrier events` : '') +
      ` (last 5 min)`);
    messagesReceived = 0;
    eventsLogged = 0;
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

  stompit.connect(connectOptions, (err, client) => {
    if (err) {
      const backoff = Math.min(60000, 1000 * Math.pow(2, connectAttempts));
      console.error(`TD STOMP connect failed: ${err.message} — retry in ${backoff / 1000}s`);
      connectAttempts++;
      setTimeout(connect, backoff);
      return;
    }
    connectAttempts = 0;
    console.log(`TD STOMP connected to ${HOST}:${PORT}, subscribing to ${TOPIC}`);

    client.subscribe({ destination: TOPIC, ack: 'auto' }, (subErr, message) => {
      if (subErr) {
        console.error('TD subscribe failed:', subErr.message);
        return;
      }
      message.readString('utf-8', (readErr, body) => {
        if (readErr) {
          console.error('TD read failed:', readErr.message);
          return;
        }
        processMessage(body);
      });
    });

    client.on('error', e => {
      console.error('TD STOMP error:', e.message);
      try { client.disconnect(); } catch (_) {}
      setTimeout(connect, 2000);
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
    (decoder ? `; S-Class area(s)=${Object.keys(decoder.areas).join(',')}, log dir=${SCLASS_LOG_DIR}` : ''));
  connect();
}

module.exports = { start, on: emitter.on.bind(emitter), off: emitter.off.bind(emitter) };
