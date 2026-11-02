'use strict';

// Deterministic fake TD traffic, shaped like the national feed: JSON arrays of
// {"CA_MSG": {...}} wrappers across many areas. Trains enter an area (CC interpose), step along
// that area's berth chain (CA) and leave (CB cancel), so the same edges recur — the same shape of
// state a map service would build — with CT heartbeats and S-class noise mixed in.

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

class TdGenerator {
  /** @param {{seed?: number, areas?: number, chainLength?: number}} [o] */
  constructor({ seed = 1, areas = 40, chainLength = 12 } = {}) {
    this.rand = mulberry32(seed);
    this.areaIds = Array.from({ length: areas }, (_, i) => `A${String(i).padStart(2, '0')}`);
    this.chainLength = chainLength;
    this.trains = [];          // {area, descr, pos}
    this.counter = 0;
    this.sent = { frames: 0, events: 0 };
  }

  _pick(arr) { return arr[Math.floor(this.rand() * arr.length)]; }
  _berth(i) { return String(i).padStart(4, '0'); }
  _descr() { const n = this.counter++; return `${1 + (n % 9)}${String.fromCharCode(65 + (n % 26))}${String(n % 100).padStart(2, '0')}`; }

  _event(now) {
    const r = this.rand();
    const area = this._pick(this.areaIds);
    const base = { time: String(now), area_id: area };
    if (r < 0.25) return { CT_MSG: { ...base, msg_type: 'CT', report_time: '1000' } };
    if (r < 0.30) return { SF_MSG: { ...base, msg_type: 'SF', address: '01', data: '00' } };
    if (r < 0.40 || this.trains.length < 5) {
      const t = { area, descr: this._descr(), pos: 0 };
      this.trains.push(t);
      return { CC_MSG: { ...base, msg_type: 'CC', descr: t.descr, to: this._berth(0) } };
    }
    const i = Math.floor(this.rand() * this.trains.length);
    const t = this.trains[i];
    if (t.pos >= this.chainLength - 1) {
      this.trains.splice(i, 1);
      return { CB_MSG: { time: String(now), area_id: t.area, msg_type: 'CB', descr: t.descr, from: this._berth(t.pos) } };
    }
    const ev = { CA_MSG: { time: String(now), area_id: t.area, msg_type: 'CA', descr: t.descr, from: this._berth(t.pos), to: this._berth(t.pos + 1) } };
    t.pos++;
    return ev;
  }

  /** One STOMP message body: an array of `events` wrappers. */
  frame(events = 3, now = Date.now()) {
    const body = JSON.stringify(Array.from({ length: events }, () => this._event(now)));
    this.sent.frames++;
    this.sent.events += events;
    return body;
  }
}

/**
 * TRUST-shaped messages: [{"header": {...}, "body": {...}}] with the movement-heavy mix of the
 * real feed (documentation shapes, not observed). Platform is often blank, as it is on the real one.
 */
function trustFrame(rand, now = Date.now()) {
  const header = type => ({ msg_type: type, source_dev_id: '', user_id: '', original_data_source: 'SDR', msg_queue_timestamp: String(now), source_system_id: 'TRUST' });
  const id = () => `${String(Math.floor(rand() * 1e6)).padStart(6, '0')}MA${String(Math.floor(rand() * 90) + 10)}`;
  const items = [];
  for (let i = 0; i < 1 + Math.floor(rand() * 4); i++) {
    const r = rand();
    if (r < 0.05) items.push({ header: header('0001'), body: { train_id: id(), train_uid: `W${Math.floor(rand() * 99999)}`, schedule_start_date: '2026-11-02', toc_id: '88' } });
    else if (r < 0.08) items.push({ header: header('0002'), body: { train_id: id(), loc_stanox: '87100', canx_type: 'ON CALL' } });
    else {
      const body = { train_id: id(), event_type: rand() < 0.5 ? 'ARRIVAL' : 'DEPARTURE', loc_stanox: String(87000 + Math.floor(rand() * 900)), actual_timestamp: String(now), planned_timestamp: rand() < 0.97 ? String(now - 30000) : '', timetable_variation: String(Math.floor(rand() * 8)), variation_status: rand() < 0.6 ? 'ON TIME' : 'LATE', platform: rand() < 0.4 ? ' 2' : '  ' };
      items.push({ header: header('0003'), body });
    }
  }
  return JSON.stringify(items);
}

/** A VSTP Create or Delete (documentation shape): a single object, not an array. */
function vstpMessage(rand) {
  const uid = `W${Math.floor(rand() * 99999)}`;
  if (rand() < 0.25) return JSON.stringify({ VSTPCIFMsgV1: { schedule: { transaction_type: 'Delete', CIF_train_uid: uid, schedule_start_date: '2026-11-03', schedule_end_date: '2026-11-03', schedule_days_runs: '0100000' } } });
  return JSON.stringify({
    VSTPCIFMsgV1: {
      timestamp: String(Date.now()), owner: 'Network Rail',
      schedule: {
        transaction_type: 'Create', CIF_train_uid: uid, schedule_start_date: '2026-11-03', schedule_end_date: '2026-11-03', schedule_days_runs: '0100000', train_status: '1', CIF_stp_indicator: 'N',
        schedule_segment: [{ signalling_id: '1A23', CIF_train_category: 'EE', schedule_location: [{ location: { tiploc: { tiploc_id: 'BRGHTN' } }, scheduled_departure_time: '101500' }] }]
      }
    }
  });
}

/** Publish `perSec` frames a second from a FakeStompServer until stopped. Returns a stop function. */
function feed(server, destination, { perSec = 20, events = 3, seed = 1 } = {}) {
  const gen = new TdGenerator({ seed });
  const timer = setInterval(() => server.publish(destination, gen.frame(events)), Math.max(1, Math.round(1000 / perSec)));
  const stop = () => clearInterval(timer);
  stop.gen = gen;
  return stop;
}

module.exports = { TdGenerator, feed, mulberry32, trustFrame, vstpMessage };
