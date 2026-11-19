'use strict';

// Records two more Network Rail feeds, for berth-first Phase 0 (docs/berth-first-design.md §7, on
// main). LOG ONLY: nothing here is read by predictions, so a fault in this module can cost data but
// never a wrong closure. Each line is { rx, msg }: the receive time and the message exactly as sent,
// so the replay can feed them back in the order the live code would have seen them.
//
//   VSTP_ALL           short-notice timetables (replacement trains, ECS, freight, specials)
//                      -> data/logs/vstp/vstp-<London date>.jsonl
//   TRAIN_MVT_ALL_TOC  TRUST train movements (activation, cancellation, reinstatement, change of
//                      origin/identity/location, movements) -> data/logs/trust/trust-<date>.jsonl
//
// One STOMP connection per feed, separate from the TD listener's: a feed we are not entitled to
// gets an ERROR frame, and that must not take the berth feed down with it. Same hardening as the
// TD listener (connect timeout, single-flight backoff, the stompit ERROR-frame fix), plus a
// liveness check on TRUST, which is never quiet. VSTP is: hours can pass without one.
//
// Files are written plain for the current day and gzipped once the London date has moved on
// (rotate(), daily at 03:20 — after td-rotation 03:00 and sclass-rotation 03:10), together with
// td-listener's national C-Class log (data/logs/td-all/). How long each is kept: KEEP_DAYS.
// The same run prunes the daily app log (data/logs/<date>.jsonl: LDB lateness, state, held) at the
// same age. It is left plain, not gzipped: the analysis tools and the startup seed read it as .jsonl.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { londonDateStamp } = require('./time-utils');
const { hardenClient } = require('./td-listener');

const HOST = 'publicdatafeeds.networkrail.co.uk';
const PORT = 61618;
const LOG_ROOT = path.join(__dirname, '..', 'data', 'logs');
const CONNECT_TIMEOUT_MS = 30 * 1000;
const WATCHDOG_TICK_MS = 60 * 1000;
// Days each log is kept. Every folder here is gzipped the day after it is written.
// td-all is written by td-listener.js (the national C-Class log) but rotated here, with the others
// that are gzipped daily rather than after 7 days: they are the big ones.
// One policy for every log (retention.js, 90 days, Rich 2026-11-19). Volume test 2026-11-19 (evening
// rate): TRUST ~670 MB/day raw at ~16x, national C-Class ~280 MB/day raw at ~6-9x. VSTP is tiny.
const { KEEP_DAYS: KEEP } = require('./retention');
const KEEP_DAYS = { vstp: KEEP, trust: KEEP, 'td-all': KEEP };

// staleMs: silence that forces a reconnect. null = never (VSTP is genuinely quiet for hours).
const FEEDS = {
  vstp:  { topic: '/topic/VSTP_ALL',          staleMs: null },
  trust: { topic: '/topic/TRAIN_MVT_ALL_TOC', staleMs: 5 * 60 * 1000 }
};

let stompit = null;
let logRoot = LOG_ROOT;
const state = {};   // key -> { client, reconnectPending, attempts, lastMessageAt, startedAt, received, written, forced }

function dirFor(key) { return path.join(logRoot, key); }
function fileFor(key, stamp = londonDateStamp()) { return path.join(dirFor(key), `${key}-${stamp}.jsonl`); }

// TRUST bodies are a JSON array of messages; VSTP a single object. One line per message either way.
function linesFor(key, body, rx) {
  let parsed;
  try { parsed = JSON.parse(body); } catch (e) {
    console.error(`${key} feed: unparseable message (${e.message}) — logged raw`);
    return [JSON.stringify({ rx, raw: body })];
  }
  const msgs = Array.isArray(parsed) ? parsed : [parsed];
  return msgs.map(m => JSON.stringify({ rx, msg: m }));
}

function record(key, body, now = new Date()) {
  const st = state[key];
  st.lastMessageAt = now.getTime();
  st.received++;
  const lines = linesFor(key, body, now.toISOString());
  try {
    fs.mkdirSync(dirFor(key), { recursive: true });
    fs.appendFileSync(fileFor(key, londonDateStamp(now)), lines.join('\n') + '\n');
    st.written += lines.length;
  } catch (e) { console.error(`${key} feed: write failed: ${e.message}`); }
}

function dropClient(key) {
  const st = state[key];
  if (!st.client) return;
  const c = st.client;
  st.client = null;
  try { c.destroy ? c.destroy() : c.disconnect(); } catch (_) { /* already gone */ }
}

function scheduleReconnect(key, delayMs, why) {
  const st = state[key];
  if (st.reconnectPending) return;
  st.reconnectPending = true;
  console.error(`${key} feed: reconnecting in ${Math.round(delayMs / 1000)}s (${why})`);
  setTimeout(() => { st.reconnectPending = false; connect(key); }, delayMs);
}

function connect(key) {
  const st = state[key];
  const { topic } = FEEDS[key];
  if (!stompit) stompit = require('stompit');
  let settled = false;
  const backoff = () => Math.min(60000, 1000 * Math.pow(2, st.attempts++));
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    console.error(`${key} feed: connect timed out`);
    scheduleReconnect(key, backoff(), 'connect timeout');
  }, CONNECT_TIMEOUT_MS);

  const pending = stompit.connect({
    host: HOST, port: PORT,
    connectHeaders: {
      host: '/', login: process.env.NR_FEED_USER, passcode: process.env.NR_FEED_PASS,
      'heart-beat': '15000,15000', 'client-id': `rail-crossing-${key}-${process.pid}`
    }
  }, (err, client) => {
    if (settled) { try { client && client.destroy(); } catch (_) {} return; }
    settled = true;
    clearTimeout(timer);
    if (err) {
      console.error(`${key} feed: connect failed: ${err.message}`);
      scheduleReconnect(key, backoff(), 'connect failed');
      return;
    }
    st.attempts = 0;
    st.client = client;
    console.log(`${key} feed: connected, subscribing to ${topic}`);
    client.subscribe({ destination: topic, ack: 'auto' }, (subErr, message) => {
      if (subErr) {
        console.error(`${key} feed: subscribe failed: ${subErr.message}`);
        dropClient(key);
        scheduleReconnect(key, backoff(), 'subscribe failed');
        return;
      }
      message.readString('utf-8', (readErr, body) => {
        if (readErr) { console.error(`${key} feed: read failed: ${readErr.message}`); return; }
        record(key, body);
      });
    });
    client.on('error', e => {
      console.error(`${key} feed: STOMP error: ${e.message}`);
      dropClient(key);
      scheduleReconnect(key, backoff(), 'socket error');
    });
  });
  hardenClient(pending);
}

function checkLiveness(now = Date.now()) {
  for (const [key, { staleMs }] of Object.entries(FEEDS)) {
    const st = state[key];
    if (!st || staleMs == null) continue;
    const since = st.lastMessageAt || st.startedAt;
    if (since == null || now - since <= staleMs) continue;
    st.forced++;
    console.error(`${key} feed: silent for ${Math.round((now - since) / 1000)}s — forcing a reconnect`);
    dropClient(key);
    st.lastMessageAt = now;
    st.reconnectPending = false;
    scheduleReconnect(key, 0, 'watchdog: feed silent');
  }
}

function gzipFile(src) {
  return new Promise((resolve, reject) => {
    pipeline(fs.createReadStream(src), zlib.createGzip(), fs.createWriteStream(src + '.gz'), err => {
      if (err) return reject(err);
      fs.unlink(src, e => (e ? reject(e) : resolve(src + '.gz')));
    });
  });
}

// Gzip every day except today (London), prune anything older than PRUNE_AFTER_DAYS.
async function rotate(now = new Date()) {
  const today = londonDateStamp(now);
  let gzipped = 0, pruned = 0;
  for (const [key, keepDays] of Object.entries(KEEP_DAYS)) {
    const dir = dirFor(key);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(new RegExp(`^${key}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl(\\.gz)?$`));
      if (!m) continue;
      const full = path.join(dir, f);
      const ageDays = (Date.parse(today + 'T00:00:00Z') - Date.parse(m[1] + 'T00:00:00Z')) / 86400000;
      if (ageDays > keepDays) {
        try { fs.unlinkSync(full); pruned++; } catch (e) { console.error(`feed rotation: prune ${f} failed: ${e.message}`); }
        continue;
      }
      if (m[1] < today && !m[2]) {
        try { await gzipFile(full); gzipped++; } catch (e) { console.error(`feed rotation: gzip ${f} failed: ${e.message}`); }
      }
    }
  }
  // The daily app log, data/logs/<date>.jsonl: pruned at the same age, never gzipped (see top).
  if (fs.existsSync(logRoot)) {
    for (const f of fs.readdirSync(logRoot)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/);
      if (!m) continue;
      const ageDays = (Date.parse(today + 'T00:00:00Z') - Date.parse(m[1] + 'T00:00:00Z')) / 86400000;
      if (ageDays <= KEEP) continue;
      try { fs.unlinkSync(path.join(logRoot, f)); pruned++; } catch (e) { console.error(`feed rotation: prune ${f} failed: ${e.message}`); }
    }
  }
  if (gzipped || pruned) console.log(`feed rotation: ${gzipped} gzipped, ${pruned} pruned`);
  return { gzipped, pruned };
}

function msUntilNext0320Local() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(3, 20, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

function start() {
  const now = Date.now();
  for (const key of Object.keys(FEEDS)) {
    state[key] = { client: null, reconnectPending: false, attempts: 0, lastMessageAt: null,
      startedAt: now, received: 0, written: 0, forced: 0 };
    connect(key);
  }
  setInterval(() => checkLiveness(), WATCHDOG_TICK_MS).unref();
  setTimeout(function tick() {
    rotate().catch(e => console.error('feed rotation failed:', e.message));
    setTimeout(tick, 24 * 3600 * 1000).unref();
  }, msUntilNext0320Local()).unref();
  // A summary every 30 min, so the journal shows each feed is alive without a line per message.
  setInterval(() => {
    for (const [key, st] of Object.entries(state)) {
      console.log(`${key} feed: ${st.received} frames, ${st.written} messages logged`
        + (st.forced ? `, ${st.forced} forced reconnects` : ''));
      st.received = 0; st.written = 0;
    }
  }, 30 * 60 * 1000).unref();
}

// For GET /health: how long since each feed last delivered.
function feedHealth(now = Date.now()) {
  const out = {};
  for (const [key, st] of Object.entries(state)) {
    const since = st.lastMessageAt || st.startedAt;
    out[key] = { connected: st.client !== null, lastMessageAt: st.lastMessageAt ? new Date(st.lastMessageAt).toISOString() : null,
      staleSecs: since == null ? null : Math.round((now - since) / 1000), forcedReconnects: st.forced };
  }
  return out;
}

module.exports = {
  start, rotate, feedHealth, FEEDS, KEEP_DAYS,
  _linesFor: linesFor,
  _setLogRootForTest(dir) { logRoot = dir; },
  _initStateForTest(key) { state[key] = { client: null, reconnectPending: false, attempts: 0, lastMessageAt: null, startedAt: Date.now(), received: 0, written: 0, forced: 0 }; },
  _recordForTest: record
};
