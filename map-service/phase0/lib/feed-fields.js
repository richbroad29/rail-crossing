'use strict';

// What TRUST and VSTP messages actually contain — measured, not assumed.
//
// Every shape below comes from documentation, NOT observation: neither feed was switched on when
// this was written. So nothing here may hard-fail on a missing field. Each planned field is
// reported as a presence rate (the key exists) and a populated rate (it holds a value: not null,
// not blank), and alongside them is a CENSUS of the keys really seen, so a field the feed names
// differently reads as "planned X 0%, observed Y 100%" instead of as an error. Pure: no I/O.

const MAX_TYPES = 50;          // distinct message types kept; the rest go to "(other)"
const MAX_KEYS = 200;          // distinct keys counted per type, per census
// maxDepth 10 because a VSTP location sits nine levels down (VSTPCIFMsgV1.schedule.schedule_segment[0]
// .schedule_location[0].location.tiploc.tiploc_id) and an example that cuts off before the
// locations hides exactly what it is there to show. Size stays bounded by the other three limits.
const EXAMPLE_LIMITS = Object.freeze({ maxDepth: 10, maxString: 80, maxArray: 2, maxKeys: 40 });

// TRUST header.msg_type, from the NROD documentation. 0004 (unidentified train) is not on the
// national feed as far as the documentation says, but is named so an unexpected one is legible.
const TRUST_TYPES = Object.freeze({
  '0001': 'activation',
  '0002': 'cancellation',
  '0003': 'movement',
  '0004': 'unidentified train',
  '0005': 'reinstatement',
  '0006': 'change of origin',
  '0007': 'change of identity',
  '0008': 'change of location'
});

// The fields the map plans to use. TRUST's two lists are the brief's. Every other TRUST type is
// only asked for train_id (the join key); the census shows the rest. VSTP's list is MY reading of
// the documentation — the brief gave none — so treat it as a guess that the census corrects.
const PLANNED = Object.freeze({
  trust: Object.freeze({
    '0001': ['train_id', 'train_uid', 'schedule_start_date'],
    '0003': ['train_id', 'event_type', 'loc_stanox', 'actual_timestamp', 'planned_timestamp', 'timetable_variation', 'variation_status', 'platform'],
    '*': ['train_id']
  }),
  vstp: Object.freeze({
    Create: [
      'transaction_type', 'CIF_train_uid', 'schedule_start_date', 'schedule_end_date', 'schedule_days_runs', 'train_status', 'CIF_stp_indicator',
      'schedule_segment[0].signalling_id', 'schedule_segment[0].CIF_train_category',
      'schedule_segment[0].schedule_location[0].location.tiploc.tiploc_id',
      'schedule_segment[0].schedule_location[0].scheduled_departure_time'
    ],
    Delete: ['transaction_type', 'CIF_train_uid', 'schedule_start_date', 'schedule_end_date', 'schedule_days_runs'],
    '*': ['transaction_type']
  })
});

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const bump = (map, key, cap) => {
  if (!map.has(key) && cap !== undefined && map.size >= cap) key = '(other)';
  map.set(key, (map.get(key) || 0) + 1);
};
const sortedObject = map => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));

/**
 * Look `path` up in `obj`: dotted names with optional [n] array indexes
 * ("schedule_segment[0].signalling_id"). Own properties only — "constructor" is not a field.
 * Returns {present, value}: present means the key (or array element) exists, even if it holds null.
 */
function lookup(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    const m = /^([^[\]]+)(?:\[(\d+)\])?$/.exec(part);
    if (!m || !isObj(cur) || !own(cur, m[1])) return { present: false, value: undefined };
    cur = cur[m[1]];
    if (m[2] !== undefined) {
      const i = Number(m[2]);
      if (!Array.isArray(cur) || i >= cur.length) return { present: false, value: undefined };
      cur = cur[i];
    }
  }
  return { present: true, value: cur };
}

/** A value that says something: not null, not blank text, not an empty array or object. */
function isPopulated(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return Object.keys(v).length > 0;
  return true; // numbers (including 0) and booleans
}

/** A copy small enough to put in a report: long strings, big arrays and deep nesting are cut and marked. */
function trimForExample(value, limits = EXAMPLE_LIMITS, depth = 0) {
  if (typeof value === 'string') return value.length > limits.maxString ? `${value.slice(0, limits.maxString)}…(+${value.length - limits.maxString} chars)` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= limits.maxDepth) return '…(nested deeper)';
  if (Array.isArray(value)) {
    const out = value.slice(0, limits.maxArray).map(v => trimForExample(v, limits, depth + 1));
    if (value.length > limits.maxArray) out.push(`…(+${value.length - limits.maxArray} more)`);
    return out;
  }
  const keys = Object.keys(value);
  const out = {};
  for (const k of keys.slice(0, limits.maxKeys)) out[k] = trimForExample(value[k], limits, depth + 1);
  if (keys.length > limits.maxKeys) out['…'] = `(+${keys.length - limits.maxKeys} more keys)`;
  return out;
}

/** Work out what kind of message an item is and where its fields live. Never throws. */
function describe(feed, item) {
  if (feed === 'trust') {
    const header = isObj(item.header) ? item.header : null;
    const type = header && header.msg_type !== undefined && header.msg_type !== null ? String(header.msg_type) : '(no header.msg_type)';
    return { type, label: TRUST_TYPES[type] || 'unrecognised type', node: isObj(item.body) ? item.body : null, side: header, plannedKey: type };
  }
  // VSTP: {"VSTPCIFMsgV1": {"schedule": {...}}} — the type is the root key plus the transaction.
  const rootKey = Object.keys(item).find(k => isObj(item[k]));
  const root = rootKey ? item[rootKey] : null;
  const schedule = root && isObj(root.schedule) ? root.schedule : null;
  const tx = schedule && typeof schedule.transaction_type === 'string' ? schedule.transaction_type : '?';
  return { type: rootKey ? `${rootKey}:${tx}` : '(no root key)', label: tx, node: schedule, side: root, plannedKey: tx };
}

class FeedAnalyser {
  /** @param {'trust'|'vstp'} feed */
  constructor(feed) {
    if (feed !== 'trust' && feed !== 'vstp') throw new TypeError(`unknown feed ${feed}`);
    this.feed = feed;
    this.frames = 0;
    this.items = 0;
    this.parseErrors = 0;
    this.unrecognisedItems = 0;
    this.topKeys = new Map();
    this.types = new Map();
    this._examples = new Map();
  }

  /** One STOMP message body. Never throws, whatever it contains. */
  ingest(body) {
    this.frames++;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { this.parseErrors++; return; }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!isObj(item)) { this.unrecognisedItems++; continue; }
      this.items++;
      for (const k of Object.keys(item)) bump(this.topKeys, k, MAX_KEYS);
      this._record(describe(this.feed, item), item);
    }
  }

  _typeEntry(d) {
    let key = d.type;
    if (!this.types.has(key) && this.types.size >= MAX_TYPES) key = '(other)';
    let t = this.types.get(key);
    if (!t) {
      const overflow = key === '(other)';
      // The overflow bucket mixes unrelated types, so it has no planned fields to measure.
      const list = overflow ? [] : (PLANNED[this.feed][d.plannedKey] || PLANNED[this.feed]['*']);
      t = {
        label: overflow ? `types beyond the first ${MAX_TYPES}` : d.label,
        count: 0,
        planned: new Map(list.map(f => [f, { present: 0, populated: 0 }])),
        keys: new Map(),
        sideKeys: new Map()
      };
      this.types.set(key, t);
    }
    return { key, t };
  }

  _record(d, item) {
    const { key, t } = this._typeEntry(d);
    t.count++;
    for (const [field, tally] of t.planned) {
      const r = d.node ? lookup(d.node, field) : { present: false };
      if (r.present) { tally.present++; if (isPopulated(r.value)) tally.populated++; }
    }
    if (d.node) for (const k of Object.keys(d.node)) bump(t.keys, k, MAX_KEYS);
    if (d.side) for (const k of Object.keys(d.side)) bump(t.sideKeys, k, MAX_KEYS);
    if (!this._examples.has(key)) this._examples.set(key, trimForExample(item));
  }

  summary() {
    const types = {};
    const byType = {};
    for (const [key, t] of [...this.types.entries()].sort((a, b) => b[1].count - a[1].count)) {
      byType[key] = { label: t.label, count: t.count, sharePct: pct(t.count, this.items) };
      const planned = {};
      for (const [field, tally] of t.planned) {
        planned[field] = { present: tally.present, populated: tally.populated, presentPct: pct(tally.present, t.count), populatedPct: pct(tally.populated, t.count) };
      }
      types[key] = {
        label: t.label,
        count: t.count,
        planned,
        bodyKeys: sortedObject(t.keys),
        // TRUST: the keys of `header`. VSTP: the keys one level above `schedule`.
        headerKeys: sortedObject(t.sideKeys)
      };
    }
    return {
      feed: this.feed,
      frames: this.frames,
      items: this.items,
      parseErrors: this.parseErrors,
      unrecognisedItems: this.unrecognisedItems,
      topLevelKeys: sortedObject(this.topKeys),
      byType,
      types
    };
  }

  /** One trimmed example per type, first seen. For the JSON report only. */
  examples() { return Object.fromEntries(this._examples); }
}

module.exports = { FeedAnalyser, lookup, isPopulated, trimForExample, describe, TRUST_TYPES, PLANNED, MAX_TYPES, MAX_KEYS, EXAMPLE_LIMITS };
