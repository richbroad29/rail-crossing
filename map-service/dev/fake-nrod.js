#!/usr/bin/env node
'use strict';

// A local stand-in for Network Rail's STOMP TD feed, so the service (and the page) can be run end to
// end with no credentials and no network:
//
//   node dev/fake-nrod.js --mode=synthetic --smart=/path/smart-latest.json.gz --rate=50
//   node dev/fake-nrod.js --mode=replay --file=/path/td-2026-11-01.jsonl --speed=60
//
// then, in another terminal:
//
//   node bin/rail-map.js --fake=127.0.0.1:61613 --ref-dir=/path/to/reference/files
//
// It serves /topic/TD_ALL_SIG_AREA as the real feed does: each STOMP frame is a JSON array of
// {"CA_MSG": {...}} / {"CB_MSG": ...} / {"CC_MSG": ...} wrappers (plus CT heartbeats).
// It listens on 127.0.0.1 ONLY and accepts any login.
//
// Modes
//   synthetic  trains walk real SMART berth steps (so they land on the map), with occasional
//              renumbering (CB + CC on the same berth) and end-of-journey cancels.
//   replay     re-sends a crossing-service TD log ({"ts","area","event","desc","from","to"} per line).
//              Event times are REWRITTEN to now (the log is days old and the service distrusts stale
//              feed clocks); the gaps between events are kept, divided by --speed. --speed=max sends
//              as fast as the socket takes it.
//
// Options: --port=61613 --mode= --file= --smart= --rate=20 (events/s, synthetic) --trains=300
//          --speed=60|max --loop --seed=1

const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const { FakeStompServer } = require('./fake-stomp-server');

const TOPIC = '/topic/TD_ALL_SIG_AREA';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrap = (type, area, descr, from, to, time) => ({
  [`${type}_MSG`]: { area_id: area, descr, ...(from ? { from } : {}), ...(to ? { to } : {}), time: String(time), msg_type: type }
});

/** SMART file -> Map<area, Map<berth, berth[]>> of the steps a train can take (FROMBERTH -> TOBERTH). */
async function readSmartChains(file) {
  const { streamRows } = require('../src/json-rows');
  const adj = new Map();
  await streamRows(file, {
    onRow(r) {
      const area = String(r.TD || '').trim(), from = String(r.FROMBERTH || '').trim(), to = String(r.TOBERTH || '').trim();
      if (!area || !from || !to || from === to) return;
      let m = adj.get(area); if (!m) { m = new Map(); adj.set(area, m); }
      let l = m.get(from); if (!l) { l = []; m.set(from, l); }
      if (!l.includes(to)) l.push(to);
    }
  });
  for (const [a, m] of [...adj]) if (m.size < 20) adj.delete(a);
  return adj;
}

class Synthetic {
  constructor({ adj, trains = 300, seed = 1 }) {
    this.rand = mulberry32(seed);
    this.adj = adj;
    this.areas = [...adj.keys()].sort();
    this.n = trains;
    this.trains = [];
    this.counter = 0;
  }
  _descr() { const n = this.counter++; return `${1 + (n % 9)}${String.fromCharCode(65 + (n * 7) % 26)}${String(n % 100).padStart(2, '0')}`; }
  _pick(a) { return a[Math.floor(this.rand() * a.length)]; }
  _spawn(now, out) {
    for (let tries = 0; tries < 20; tries++) {
      const area = this._pick(this.areas), m = this.adj.get(area);
      const berth = this._pick([...m.keys()]);
      const t = { area, berth, descr: this._descr(), steps: 0 };
      this.trains.push(t);
      out.push(wrap('CC', area, t.descr, null, berth, now));
      return;
    }
  }
  /** `k` events: advance random trains one berth, occasionally renumber or end the journey. */
  events(k, now) {
    const out = [];
    while (this.trains.length < this.n && out.length < k) this._spawn(now, out);
    while (out.length < k) {
      if (!this.trains.length) { this._spawn(now, out); continue; }          // every train ended: start another
      const i = Math.floor(this.rand() * this.trains.length), t = this.trains[i];
      const next = this.adj.get(t.area).get(t.berth);
      const r = this.rand();
      if (!next || !next.length || t.steps > 60 || r < 0.01) {
        out.push(wrap('CB', t.area, t.descr, t.berth, null, now));
        this.trains.splice(i, 1);
      } else if (r < 0.02) {
        out.push(wrap('CB', t.area, t.descr, t.berth, null, now));
        t.descr = this._descr();
        out.push(wrap('CC', t.area, t.descr, null, t.berth, now));
      } else {
        const to = this._pick(next);
        out.push(wrap('CA', t.area, t.descr, t.berth, to, now));
        t.berth = to; t.steps++;
      }
    }
    return out;
  }
}

class FakeNrod {
  /** @param {object} o  port, mode, file, smart, rate, trains, speed, loop, seed, frameSize */
  constructor(o = {}) {
    this.o = { port: 0, mode: 'synthetic', rate: 20, trains: 300, speed: 60, loop: false, seed: 1, frameSize: 50, ...o };
    this.server = new FakeStompServer({ acceptAny: true, heartbeat: [15000, 15000] });
    this.sent = { frames: 0, events: 0 };
    this._timer = null;
    this.finished = false;
    this._onFinish = null;
    this.done = new Promise(r => { this._onFinish = r; });
  }

  async start() {
    const port = await this.server.listen(this.o.port);
    this.port = port;
    if (this.o.mode === 'replay') await this._startReplay();
    else await this._startSynthetic();
    return port;
  }

  async stop() {
    clearInterval(this._timer); clearTimeout(this._timer);
    await this.server.close();
  }

  _publish(events) {
    for (let i = 0; i < events.length; i += this.o.frameSize) {
      const chunk = events.slice(i, i + this.o.frameSize);
      chunk.push({ CT_MSG: { area_id: 'XX', time: String(Date.now()), msg_type: 'CT', report_time: '1000' } });
      this.server.publish(TOPIC, JSON.stringify(chunk));
      this.sent.frames++; this.sent.events += chunk.length - 1;
    }
  }

  async _startSynthetic() {
    let adj;
    if (this.o.smart) adj = await readSmartChains(this.o.smart);
    else {
      adj = new Map();
      for (let a = 0; a < 20; a++) {
        const m = new Map();
        for (let b = 0; b < 40; b++) m.set(String(b).padStart(4, '0'), [String(b + 1).padStart(4, '0')]);
        adj.set(`Z${String.fromCharCode(65 + a)}`, m);
      }
    }
    if (!adj.size) throw new Error('No usable berth chains (is --smart a SMART file?).');
    const gen = new Synthetic({ adj, trains: this.o.trains, seed: this.o.seed });
    const tickMs = 50, perTick = Math.max(1, Math.round(this.o.rate * tickMs / 1000));
    this._timer = setInterval(() => this._publish(gen.events(perTick, Date.now())), tickMs);
  }

  async _readLog() {
    const input = this.o.file.endsWith('.gz') ? fs.createReadStream(this.o.file).pipe(zlib.createGunzip()) : fs.createReadStream(this.o.file);
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const ev = [];
    for await (const line of rl) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch (_) { continue; }
      const t = Date.parse(r.ts);
      if (!['CA', 'CB', 'CC'].includes(r.event) || !Number.isFinite(t)) continue;
      ev.push({ t, type: r.event, area: r.area, descr: r.desc, from: r.from, to: r.to });
    }
    return ev;
  }

  async _startReplay() {
    if (!this.o.file) throw new Error('Replay mode needs --file=<td log .jsonl>.');
    const events = await this._readLog();
    this.total = events.length;
    if (!events.length) throw new Error(`No CA/CB/CC events in ${this.o.file}.`);
    const max = this.o.speed === 'max';
    const speed = max ? Infinity : Number(this.o.speed) || 1;
    // Wait for the first subscriber so nothing is sent into the void.
    this.server.waitFor(() => this.server.framesOf('SUBSCRIBE').length >= 1, 3600000, 'a subscriber').then(() => {
      const run = () => {
        let i = 0;
        const t0 = events[0].t, wall0 = Date.now();
        const step = () => {
          const out = [];
          const horizon = max ? Infinity : (Date.now() - wall0) * speed;
          const now = Date.now();
          while (i < events.length && (max ? out.length < this.o.frameSize * 4 : events[i].t - t0 <= horizon)) {
            const e = events[i++];
            out.push(wrap(e.type, e.area, e.descr, e.from, e.to, now));
          }
          if (out.length) this._publish(out);
          if (i >= events.length) {
            if (this.o.loop) { this._timer = setTimeout(run, 1000); return; }
            this.finished = true; this._onFinish(this.sent); return;
          }
          this._timer = setTimeout(step, max ? 2 : 100);
        };
        step();
      };
      run();
    }).catch(() => {});
  }
}

function parseArgs(argv) {
  const o = {};
  for (const a of argv) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`Unknown argument "${a}"`);
    const [, k, v] = m;
    if (k === 'loop') o.loop = true;
    else if (['port', 'rate', 'trains', 'seed'].includes(k)) o[k] = Number(v);
    else if (k === 'speed') o.speed = v === 'max' ? 'max' : Number(v);
    else if (['mode', 'file', 'smart'].includes(k)) o[k] = v;
    else throw new Error(`Unknown option --${k}`);
  }
  if (o.port === undefined) o.port = 61613;
  return o;
}

if (require.main === module) {
  (async () => {
    const o = parseArgs(process.argv.slice(2));
    const f = new FakeNrod(o);
    const port = await f.start();
    console.log(`fake NROD: ${o.mode || 'synthetic'} TD on 127.0.0.1:${port} ${TOPIC} (any login)`);
    f.done.then(s => console.log(`fake NROD: replay finished, ${s.events} events in ${s.frames} frames`));
    const bye = async () => { await f.stop(); process.exit(0); };
    process.on('SIGINT', bye); process.on('SIGTERM', bye);
  })().catch(e => { console.error(`fake NROD: ${e.message}`); process.exit(1); });
}

module.exports = { FakeNrod, Synthetic, readSmartChains, wrap, TOPIC, mulberry32 };
