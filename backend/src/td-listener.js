const stompit = require('stompit');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { londonDateStamp } = require('./time-utils');

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

let messagesReceived = 0;
let eventsLogged = 0;
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

function processMessage(body) {
  let parsed;
  try { parsed = JSON.parse(body); }
  catch (e) { console.error('TD JSON parse failed:', e.message); return; }
  if (!Array.isArray(parsed)) return;

  messagesReceived++;
  for (const wrapper of parsed) {
    for (const [type, msg] of Object.entries(wrapper)) {
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
      if (evt.desc && (evt.event === 'CA' || evt.event === 'CB')) {
        emitter.emit('sighting', { headcode: evt.desc, ts: evt.ts, area: evt.area });
      }
    }
  }

  const now = Date.now();
  if (now - lastSummaryAt > 300000) {
    console.log(`TD listener: ${messagesReceived} msgs received, ${eventsLogged} LA events logged (last 5 min)`);
    messagesReceived = 0;
    eventsLogged = 0;
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
  console.log(`TD listener starting: area=${TARGET_AREA}, log dir=${LOG_DIR}`);
  connect();
}

module.exports = { start, on: emitter.on.bind(emitter), off: emitter.off.bind(emitter) };
