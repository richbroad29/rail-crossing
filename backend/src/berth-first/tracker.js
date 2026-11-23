'use strict';
// The berth tracker (docs/berth-first-design.md §5.2; berth-first-v1-plan §2 and decision 1).
//
// One entry per occupied berth, across every area the crossing's routes cross. It follows the feed,
// never the headcode:
//   - a STEP (CA) moves whatever is in the berth it leaves; the headcode is only a label, so two trains
//     with one headcode are two entries;
//   - an INTERPOSE (CC) writes a label: into an empty berth it starts an entry, into an occupied one it
//     relabels what is there (a train renamed where it stands, or a signaller's reminder over it);
//   - a CANCEL (CB) removes the entry.
// Decision 1 (agreed 2026-11-20): an entry made by an interpose is only DESCRIBED. It becomes a TRAIN
// when it steps. Reminders ("****", "-LB-", "4CAR"), interposed into berths by signallers (52 "****"
// into Portslade's 0005 in Oct-Nov), therefore never become trains; a "****" that does step is one,
// labelled unidentified (§5.2: shown as "Unidentified train").
//
// Messages arrive one at a time, in the order the feed sends them, and the tracker must decide as they
// come. Three things in the real feed need care (all measured in tools/learn-routes.js, 2026-11-22):
//   1. HAND-OVER: an interpose of the train's description into our berth and a cancel from the berth it
//      was in, in the same second, in either order (1B42 21 Nov 17:01:04: CC LA A001 + CB AM12; 1C04
//      23 Jun: LA's CC at :57 and CB at :58). The pair is a step. Whichever half comes first waits
//      PAIR_MS for the other: a cancelled train waits in limbo, a fresh interpose is remembered.
//   2. SAME STEP REPORTED TWICE: two areas describe some berths alike and both report the step, up to a
//      few seconds apart (TB 0682→0677 and LA T682→T677). The routes file says which berths are the
//      same (sameBerths); they are one berth here, named by the crossing's own area, and the later
//      report is an echo.
//   3. STEPS OF ONE SECOND IN REVERSE ORDER: 1N33 1 Oct 13:46:21 came as LA 0203→0024 then 0026→0203.
//      The first starts a train from an empty 0203; the second then brings the real train into 0203,
//      which would strand it there. A train arriving where a same-label train started from nothing
//      moments ago IS that train: it takes over the copy's position and history goes on unbroken.
//   4. A LOST STEP: the feed sometimes never sends one (1H56 20 Nov: 0001>0003 at 20:55:49, then
//      0005>0007 at 20:58:18, no 0003>0005 anywhere). A step out of an empty berth is first offered to a
//      train with the same label one or two berths behind (as steps seen so far connect the berths) that
//      moved in the last SKIP_MS: that train has skipped a berth and moves on (D5). Only then does a train
//      start from nowhere.
//   5. ADVANCE DESCRIPTION: an area is given the description as the train enters its neighbour's last
//      berth (BM CC L041 with LA's step into 0041, which is the same berth). Whichever arrives first,
//      the train and the label end up as one entry: the same label arriving in one berth within
//      PAIR_MS of another is one train (a "twin"), and the copy with more history is kept.
// A step out of a berth with nothing in it is accepted and starts a train there (lost interposes,
// skipped steps: D5). A cancel of nothing is ignored.
//
// The tracker knows berths, not routes or timetables: which way a step goes, which train it is and what
// it means for a closure are the engine's (routes.js heading(), link.js, engine.js).

const PAIR_MS = 5000;                // halves of a hand-over / two reports of one step arrive within this
const STALE_MS = 6 * 3600e3;         // an entry that has not moved for 6 h is a left-over label
const PATH_KEEP_MS = 90 * 60e3;      // how much of each entry's path is kept (> the longest approach)
const PATH_KEEP_MIN = 40;
const SKIP_MS = 20 * 60e3;           // a train that skipped a berth moved this recently

const HEADCODE_RE = /^[0-9][A-Z][0-9]{2}$/;
const isHeadcode = d => typeof d === 'string' && HEADCODE_RE.test(d);
// What may become a train by stepping: a headcode, or "****" / blank (a train with no description, design
// §5.2). Other labels are signallers' reminders or unit lengths ("-LB-", "-T3A", "4CAR", "*X**"): measured
// in LA, 1 Oct - 18 Nov, 41 of their movements, none crossed Portslade, against 6 of 35 for "****". -T3A
// stepped T677>0001 at 02:14:37 on 22 Nov and sat there until 04:36: no train.
const mayBeTrain = d => isHeadcode(d) || !d || /^\*+$/.test(d);

// What a message is, from its fields: from+to a step, from alone a cancel, to alone an interpose. The
// feed's label says the same; the fields are what the tracker needs, so it reads those.
function kindOf(evt) {
  if (evt.from && evt.to) return 'step';
  if (evt.from) return 'cancel';
  if (evt.to) return 'interpose';
  return null;
}

class BerthTracker {
  /**
   * @param {object} opts
   *   sameBerths: [[a, b], ...] — berth keys ("AREA:BERTH") that are one berth; a is the name kept
   *   preferArea: when a pair is given without an order, the area whose name is kept
   *   onEvent(ev): told of what changed — { type: 'train'|'move'|'relabel'|'gone'|'merge', ... }
   */
  constructor({ sameBerths = [], preferArea = null, knownSteps = [], onEvent = () => {} } = {}) {
    this.preferArea = preferArea;
    this.onEvent = onEvent;
    this.canonMap = new Map();
    for (const [a, b] of sameBerths) this._same(a, b);
    this.occ = new Map();          // berth → [entry], oldest first
    this.limbo = [];               // cancelled entries waiting PAIR_MS for the interpose half
    this.recent = [];              // entries started by an interpose in the last PAIR_MS (the other half)
    this.recentEmpty = [];         // entries started by a step from an empty berth in the last PAIR_MS
    this.into = new Map();         // berth → Set of berths steps come from: the routes' steps, then each one seen
    for (const [a, b] of knownSteps) { const k = this.canon(b); if (!this.into.has(k)) this.into.set(k, new Set()); this.into.get(k).add(this.canon(a)); }
    this.nextId = 1;
    this.lastSweep = 0;
    this.now = 0;                  // feed time of the latest event
    this.stats = { steps: 0, interposes: 0, cancels: 0, handovers: 0, echoes: 0, fromEmpty: 0, relabels: 0,
      renames: 0, twins: 0, cancelOfNothing: 0, stale: 0, gone: 0 };
  }

  _same(a, b) {
    const ca = this.canon(a), cb = this.canon(b);
    if (ca === cb) return;
    const keepB = this.preferArea && cb.startsWith(this.preferArea + ':') && !ca.startsWith(this.preferArea + ':');
    if (keepB) this.canonMap.set(ca, cb); else this.canonMap.set(cb, ca);
  }

  canon(key) { let k = key; while (this.canonMap.has(k)) k = this.canonMap.get(k); return k; }

  // ---- reading ----
  entries() { const out = []; for (const l of this.occ.values()) out.push(...l); return out; }
  trains() { return this.entries().filter(e => e.isTrain); }
  at(key) { return (this.occ.get(this.canon(key)) || []).slice(); }

  // ---- feeding ----
  // A berth event as td-listener emits it: { headcode, ts, area, event, from, to }. Its time is the
  // feed's own (ts, to the second).
  event(evt) {
    const kind = kindOf(evt);
    if (!kind || !evt.area) return;
    const t = Date.parse(evt.ts);
    if (!Number.isFinite(t)) return;
    this.tick(t);
    const label = evt.headcode || evt.desc || '';
    if (kind === 'step') this._step(evt.area, evt.from, evt.to, label, t);
    else if (kind === 'interpose') this._interpose(evt.area, evt.to, label, t);
    else this._cancel(evt.area, evt.from, label, t);
  }

  // Time passes with no event: let a cancelled train's wait run out, and clear left-over labels.
  tick(t) {
    if (t > this.now) this.now = t;
    const now = this.now;
    if (this.recent.length) this.recent = this.recent.filter(x => now - x.born.t <= PAIR_MS);
    if (this.recentEmpty.length) this.recentEmpty = this.recentEmpty.filter(x => now - x.born.t <= PAIR_MS);
    if (this.limbo.length) {
      const keep = [];
      for (const w of this.limbo) {
        if (now - w.t > PAIR_MS) this._gone(w.e, 'cancelled', w.t);
        else keep.push(w);
      }
      this.limbo = keep;
    }
    if (now - this.lastSweep >= 60e3) {
      this.lastSweep = now;
      for (const [key, list] of this.occ) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (now - list[i].lastMove > STALE_MS) { const [e] = list.splice(i, 1); this.stats.stale++; this._gone(e, 'stale', now); }
        }
        if (!list.length) this.occ.delete(key);
      }
    }
  }

  // ---- internals ----
  _new(key, t, label, born) {
    const e = {
      id: this.nextId++, label, headcode: isHeadcode(label) ? label : null, labels: [label],
      unidentified: !isHeadcode(label), isTrain: false, key, enteredAt: t, lastMove: t,
      born: { ...born, key, t }, path: [[key, t]]
    };
    return e;
  }

  _relabel(e, label) {
    if (!label || label === e.label) return;
    e.label = label;
    e.labels.push(label);
    if (isHeadcode(label)) { e.headcode = label; e.unidentified = false; }
    else if (!e.headcode) e.unidentified = true;
    this.onEvent({ type: 'relabel', entry: e, label, t: this.now });
  }

  _take(key, label, newest = false) {
    const list = this.occ.get(key);
    if (!list || !list.length) return null;
    let i = list.findIndex(e => e.label === label);
    if (i < 0) i = newest ? list.length - 1 : 0;
    const [e] = list.splice(i, 1);
    if (!list.length) this.occ.delete(key);
    return e;
  }

  _remove(e) {
    const list = this.occ.get(e.key);
    if (!list) return;
    const i = list.indexOf(e);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this.occ.delete(e.key);
  }

  // Put e into key. The same label arriving there within PAIR_MS of an entry already there is the same
  // train seen twice (an advance description and the train itself; a hand-over pair split across a
  // second): keep the copy with more history, a train over a mere label.
  _put(key, e, t) {
    let list = this.occ.get(key);
    if (!list) { list = []; this.occ.set(key, list); }
    const twin = list.find(x => x !== e && x.label === e.label && Math.abs(t - x.lastMove) <= PAIR_MS);
    if (twin) {
      const score = x => (x.isTrain ? 1e6 : 0) + x.path.length;
      const [keep, drop] = score(twin) >= score(e) ? [twin, e] : [e, twin];
      if (keep === e) list.splice(list.indexOf(twin), 1, e);
      if (keep === e) { e.key = key; }
      if (drop.isTrain && !keep.isTrain) { keep.isTrain = true; }
      this.stats.twins++;
      this.onEvent({ type: 'merge', entry: keep, dropped: drop, t });
      return keep;
    }
    e.key = key;
    list.push(e);
    return e;
  }

  _move(e, toKey, t, label) {
    const fromKey = e.key;
    if (label) this._relabel(e, label);
    e.path.push([toKey, t]);
    this._trimPath(e, t);
    e.enteredAt = t;
    e.lastMove = t;
    const kept = this._put(toKey, e, t);
    if (kept !== e) return kept;
    const copy = this._lateCopyOf(e, toKey, t);
    if (copy) return this._absorb(e, copy, t);
    const becameTrain = !e.isTrain && e.labels.some(mayBeTrain);
    if (becameTrain) { e.isTrain = true; this.onEvent({ type: 'train', entry: e, t }); }
    if (!e.isTrain) return e;
    this.onEvent({ type: 'move', entry: e, from: fromKey, to: toKey, t });
    return e;
  }

  // A same-label entry that started from nothing in this berth moments ago and has already moved on.
  _lateCopyOf(e, key, t) {
    return this.recentEmpty.find(x => x !== e && !x.gone && x.born.key === key && x.label === e.label &&
      t - x.born.t <= PAIR_MS && x.key !== key && (this.occ.get(x.key) || []).includes(x)) || null;
  }

  // e arrived late in the berth its copy started from: e takes the copy's place and path.
  _absorb(e, copy, t) {
    this._remove(e);
    const list = this.occ.get(copy.key);
    list.splice(list.indexOf(copy), 1, e);
    e.path.push(...copy.path.slice(1));
    e.key = copy.key; e.enteredAt = copy.enteredAt; e.lastMove = copy.lastMove;
    e.isTrain = true;
    this.stats.lateArrivals = (this.stats.lateArrivals || 0) + 1;
    this.onEvent({ type: 'merge', entry: e, dropped: copy, t });
    return e;
  }

  _trimPath(e, t) {
    if (e.path.length <= PATH_KEEP_MIN) return;
    let i = 0;
    while (e.path.length - i > PATH_KEEP_MIN && t - e.path[i][1] > PATH_KEEP_MS) i++;
    if (i) e.path.splice(0, i);
  }

  _gone(e, reason, t) {
    this.stats.gone++;
    e.gone = { reason, t };
    this.onEvent({ type: 'gone', entry: e, reason, t });
  }

  _step(area, from, to, label, t) {
    this.stats.steps++;
    const fromKey = this.canon(`${area}:${from}`), toKey = this.canon(`${area}:${to}`);
    if (fromKey === toKey) { this.stats.echoes++; return; }        // both ends one berth: nothing moved
    let e = this._take(fromKey, label);
    if (!e) {
      // The other area's report of a step already made.
      const there = (this.occ.get(toKey) || []).find(x => t - x.lastMove <= PAIR_MS && x.path.length > 1 &&
        (x.label === label || x.path[x.path.length - 2][0] === fromKey));
      if (there) { this.stats.echoes++; return; }
      // A train cancelled just now elsewhere, whose hand-over is this step's other report.
      const w = this._fromLimbo(label, t, null);
      const behind = w ? null : this._skipped(fromKey, label, t);
      if (w) { e = w.e; e.path.push([fromKey, t]); e.key = fromKey; this.stats.handovers++; }
      else if (behind) { e = behind; this._remove(e); e.path.push([fromKey, t]); e.key = fromKey; e.skipped = (e.skipped || 0) + 1; this.stats.skipped = (this.stats.skipped || 0) + 1; }
      else { this.stats.fromEmpty++; e = this._new(fromKey, t, label, { kind: 'stepFromEmpty' }); this.recentEmpty.push(e); }
    }
    if (!this.into.has(toKey)) this.into.set(toKey, new Set());
    this.into.get(toKey).add(fromKey);
    this._move(e, toKey, t, label);
  }

  // A same-label entry one or two berths behind `key` (by steps seen so far) that moved recently.
  _skipped(key, label, t) {
    const one = this.into.get(key);
    if (!one) return null;
    const near = new Set(one);
    for (const b of one) for (const c of this.into.get(b) || []) near.add(c);
    near.delete(key);
    let best = null;
    for (const b of near) for (const x of this.occ.get(b) || []) {
      if (x.label !== label || t - x.lastMove > SKIP_MS) continue;
      if (!best || x.lastMove > best.lastMove) best = x;
    }
    return best;
  }

  _interpose(area, to, label, t) {
    this.stats.interposes++;
    const key = this.canon(`${area}:${to}`);
    // A cancel in this very berth just now, then a new label: renamed where it stands.
    const same = this._fromLimbo(null, t, key);
    if (same) { this.stats.renames++; this._put(key, same.e, t); this._relabel(same.e, label); return; }
    // The other half of a hand-over: the train cancelled from another berth with this label.
    const w = this._fromLimbo(label, t, null);
    if (w) { this.stats.handovers++; this._move(w.e, key, t, label); return; }
    const list = this.occ.get(key);
    if (list && list.length) {
      if (list.some(x => x.label === label)) return;              // told again what is already there
      this.stats.relabels++;
      this._relabel(list[list.length - 1], label);
      return;
    }
    const e = this._new(key, t, label, { kind: 'interpose' });
    this._put(key, e, t);
    this.recent.push(e);
  }

  _cancel(area, from, label, t) {
    this.stats.cancels++;
    const key = this.canon(`${area}:${from}`);
    const e = this._take(key, label, true);
    if (!e) { this.stats.cancelOfNothing++; return; }
    // The interpose half came first: a fresh described-only entry with this label in another berth.
    const fresh = this.recent.find(x => x !== e && !x.isTrain && !x.gone && x.label === label && x.path.length === 1 &&
      x.key !== key && t - x.born.t <= PAIR_MS && (this.occ.get(x.key) || []).includes(x));
    if (fresh) {
      this.stats.handovers++;
      this._remove(fresh);
      this.onEvent({ type: 'merge', entry: e, dropped: fresh, t });
      e.key = key;
      this._move(e, fresh.key, fresh.born.t, label);
      return;
    }
    this.limbo.push({ e, key, t });
  }

  // A waiting cancelled entry: by label (another berth), or by berth (any label).
  _fromLimbo(label, t, key) {
    const i = this.limbo.findIndex(w => t - w.t <= PAIR_MS && (key ? w.key === key : (w.e.label === label)));
    if (i < 0) return null;
    return this.limbo.splice(i, 1)[0];
  }
}

module.exports = { BerthTracker, kindOf, isHeadcode, mayBeTrain, PAIR_MS, STALE_MS };
