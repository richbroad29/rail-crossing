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
// It also serves /topic/TRAIN_MVT_ALL_TOC (TRUST) and /topic/VSTP_ALL in the documented wire shapes
// when --trust-rate / --vstp-rate are given (see TrustSynth). TRUST activations and movements walk
// real SMART STANOXes; they are NOT tied to the synthetic TD trains' headcodes, so they exercise the
// service's TRUST state and memory (the point of the generator) rather than its matching.
//
// Options: --port=61613 --mode= --file= --smart= --rate=20 (events/s, synthetic) --trains=300
//          --speed=60|max --loop --seed=1
//          --trust-rate=25 (messages/s) --trust-prefill=0 (activations + movements sent at once on
//          first subscriber, to reach a full day's state) --vstp-rate=2 (messages/MINUTE)

const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const { FakeStompServer } = require('./fake-stomp-server');

const TOPIC = '/topic/TD_ALL_SIG_AREA';
const TRUST_TOPIC = '/topic/TRAIN_MVT_ALL_TOC', VSTP_TOPIC = '/topic/VSTP_ALL';

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

/** The STANOXes SMART knows, in file order. */
async function readSmartStanoxes(file) {
  const { streamRows } = require('../src/json-rows');
  const set = new Set();
  await streamRows(file, { onRow(r) { const n = parseInt(String(r.STANOX || '').trim(), 10); if (n > 0) set.add(n); } });
  return [...set];
}

/**
 * TRUST in the documented shapes: 0001 activations, then 0003 movements along a route of real
 * STANOXes (arrival + departure per stop, a pass for some), the last one with train_terminated, with
 * the occasional 0002 cancellation, 0005 reinstatement and 0007 identity change, at realistic mixes:
 * roughly 1 activation per 20 messages. Also VSTP Create/Delete.
 */
class TrustSynth {
  constructor({ stanoxes, seed = 3 }) {
    this.rand = mulberry32(seed); this.sx = stanoxes; this.live = []; this.n = 0;
  }
  _pick(a) { return a[Math.floor(this.rand() * a.length)]; }
  _id(hc, dd, p) { return `${p}${hc}MY${dd}`; }
  _hc() { const n = this.n; return `${1 + (n % 9)}${String.fromCharCode(65 + (n * 7) % 26)}${String(n % 100).padStart(2, '0')}`; }
  _activate(now) {
    const n = this.n++, hc = this._hc(), dd = String(new Date(now).getUTCDate()).padStart(2, '0');
    const id = this._id(hc, dd, String(10 + (n % 80)));
    const route = Array.from({ length: 8 + Math.floor(this.rand() * 14) }, () => this._pick(this.sx));
    const day = new Date(now).toISOString().slice(0, 10);
    this.live.push({ id, route, i: 0, arrived: false, t: now, hc });
    return { header: { msg_type: '0001' }, body: { schedule_source: 'C', train_file_address: null, schedule_end_date: day, train_id: id, tp_origin_timestamp: day, tp_origin_stanox: String(route[0]),
      origin_dep_timestamp: String(now), train_service_code: '24673000', toc_id: '84', d1266_record_number: '00000', train_call_type: 'AUTOMATIC',
      train_uid: `C${String(n % 100000).padStart(5, '0')}`, train_call_mode: 'NORMAL', schedule_type: 'O', sched_origin_stanox: String(route[0]), schedule_wtt_id: `${hc}M`, schedule_start_date: day } };
  }
  _move(tr, now) {
    const sx = tr.route[tr.i], last = tr.i === tr.route.length - 1;
    const evt = tr.arrived ? 'DEPARTURE' : 'ARRIVAL';
    const late = Math.floor(this.rand() * 9) - 2;
    const msg = { header: { msg_type: '0003' }, body: { event_type: evt, gbtt_timestamp: String(now), original_loc_stanox: '', planned_timestamp: String(now - late * 60000), timetable_variation: String(Math.abs(late)),
      original_loc_timestamp: '', current_train_id: '', delay_monitoring_point: 'true', next_report_run_time: '1', reporting_stanox: String(sx), actual_timestamp: String(now), correction_ind: 'false',
      event_source: 'AUTOMATIC', train_file_address: null, platform: this.rand() < 0.64 ? String(1 + Math.floor(this.rand() * 8)) : ' ', division_code: '84', train_terminated: String(last && evt === 'ARRIVAL'),
      train_id: tr.id, offroute_ind: 'false', variation_status: late > 0 ? 'LATE' : late < 0 ? 'EARLY' : 'ON TIME', train_service_code: '24673000', toc_id: '84', loc_stanox: String(sx),
      auto_expected: 'true', direction_ind: 'UP', route: '', planned_event_type: evt, next_report_stanox: '', line_ind: '' } };
    if (tr.arrived || last) { tr.i++; tr.arrived = false; } else tr.arrived = true;
    return msg;
  }
  /** `k` messages: mostly movements of live trains, about 1 in 20 an activation, rarely the others. */
  messages(k, now) {
    const out = [];
    while (out.length < k) {
      const r = this.rand();
      if (!this.live.length || r < 0.05) { out.push(this._activate(now)); continue; }
      const idx = Math.floor(this.rand() * this.live.length), tr = this.live[idx];
      if (tr.i >= tr.route.length) { this.live.splice(idx, 1); continue; }
      if (r > 0.995) out.push({ header: { msg_type: '0002' }, body: { train_id: tr.id, loc_stanox: String(tr.route[Math.min(tr.i, tr.route.length - 1)]), canx_type: 'EN ROUTE', canx_reason_code: 'YI', train_file_address: null, toc_id: '84' } });
      else if (r > 0.99) out.push({ header: { msg_type: '0007' }, body: { train_id: tr.id, revised_train_id: this._id(tr.hc, tr.id.slice(8, 10), String(10 + (this.n % 80))), event_timestamp: String(now), train_file_address: null, toc_id: '84' } });
      else out.push(this._move(tr, now));
    }
    return out;
  }
  vstp(now) {
    const day = new Date(now).toISOString().slice(0, 10), n = this.n++;
    const uid = `V${String(n % 100000).padStart(5, '0')}`;
    if (this.rand() < 0.2) return { VSTPCIFMsgV1: { Schedule: { transaction_type: 'Delete', schedule_start_date: day, schedule_end_date: day, CIF_train_uid: uid, CIF_stp_indicator: 'N' } } };
    const locs = Array.from({ length: 6 }, (_, i) => ({ scheduled_arrival_time: i ? '1000' + String(i).padStart(2, '0') : '', scheduled_departure_time: i < 5 ? '1001' + String(i).padStart(2, '0') : '', scheduled_pass_time: '', CIF_platform: '1', location: { tiploc: { tiploc_id: `SYN${(n + i) % 500}` } } }));
    return { VSTPCIFMsgV1: { Schedule: { transaction_type: 'Create', schedule_id: uid, schedule_start_date: day, schedule_end_date: day, schedule_days_runs: '1111111', CIF_train_uid: uid, train_status: '1', CIF_stp_indicator: 'N',
      schedule_segment: { signalling_id: this._hc(), atoc_code: 'SN', CIF_train_category: 'XX', CIF_power_type: 'EMU', CIF_speed: '075', schedule_location: locs } } } };
  }
}

class FakeNrod {
  /** @param {object} o  port, mode, file, smart, rate, trains, speed, loop, seed, frameSize */
  constructor(o = {}) {
    this.o = { port: 0, mode: 'synthetic', rate: 20, trains: 300, speed: 60, loop: false, seed: 1, frameSize: 50, trustRate: 0, trustPrefill: 0, vstpRate: 0, ...o };
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
    clearInterval(this._timer); clearTimeout(this._timer); clearInterval(this._trustTimer); clearInterval(this._vstpTimer); clearInterval(this._burst);
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
    if (this.o.trustRate > 0 || this.o.vstpRate > 0 || this.o.trustPrefill > 0) await this._startTrust();
  }

  async _startTrust() {
    if (!this.o.smart) throw new Error('--trust-rate needs --smart (the STANOXes come from it).');
    const synth = new TrustSynth({ stanoxes: await readSmartStanoxes(this.o.smart), seed: this.o.seed + 2 });
    this.trust = synth; this.sent.trust = 0; this.sent.vstp = 0;
    const pub = (topic, msgs, counter) => { this.server.publish(topic, JSON.stringify(msgs)); this.sent[counter] += msgs.length; };
    // A full day's state at once, on the first subscriber (TRUST is not durable: a real service sees this build up over a day).
    if (this.o.trustPrefill > 0) {
      this.server.waitFor(() => this.server.framesOf('SUBSCRIBE').some(f => f.headers.destination === TRUST_TOPIC), 3600000, 'a TRUST subscriber').then(() => {
        let left = this.o.trustPrefill * 14;
        const burst = setInterval(() => { const k = Math.min(left, 150); pub(TRUST_TOPIC, synth.messages(k, Date.now()), 'trust'); left -= k; if (left <= 0) clearInterval(burst); }, 40);
        this._burst = burst;
      }).catch(() => {});
    }
    const tickMs = 100;
    if (this.o.trustRate > 0) {
      let carry = 0;
      this._trustTimer = setInterval(() => { carry += this.o.trustRate * tickMs / 1000; const k = Math.floor(carry); carry -= k; if (k) pub(TRUST_TOPIC, synth.messages(k, Date.now()), 'trust'); }, tickMs);
    }
    if (this.o.vstpRate > 0) {
      this._vstpTimer = setInterval(() => pub(VSTP_TOPIC, [synth.vstp(Date.now())], 'vstp'), Math.round(60000 / this.o.vstpRate));
    }
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
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`Unknown argument "${a}"`);
    const [, k, v] = m;
    if (k === 'loop') o.loop = true;
    else if (['port', 'rate', 'trains', 'seed'].includes(k)) o[k] = Number(v);
    else if (k === 'trust-rate') o.trustRate = Number(v);
    else if (k === 'trust-prefill') o.trustPrefill = Number(v);
    else if (k === 'vstp-rate') o.vstpRate = Number(v);
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

module.exports = { FakeNrod, Synthetic, TrustSynth, readSmartChains, readSmartStanoxes, wrap, TOPIC, TRUST_TOPIC, VSTP_TOPIC, mulberry32 };
