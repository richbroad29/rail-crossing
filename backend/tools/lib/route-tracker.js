'use strict';
// The route-learning tracker: follows trains berth by berth across every area it is given and
// remembers each one's path, so learn-routes.js can walk back from every clear step
// (docs/berth-first-design.md §5.1-5.2; berth-first-v1-plan §4).
//
// Tracking follows the feed, never the headcode:
//   - a step X→Y moves whatever is in X (§5.2). The headcode is a label;
//   - an interpose (to only) into an empty berth starts a new entry there; into an occupied one it
//     relabels it;
//   - a cancel (from only) ends the entry.
// Trains pass between areas in two ways, both seen in the real feed:
//   - HAND-OVER: an interpose of the same description in the same second as a cancel elsewhere
//     (insight 1, 1B42 21 Nov 17:01:04: CC LA:A001 + CB AM12). It is a step from the cancelled berth;
//   - SAME STEP: neighbouring areas describe the same physical berths, and report the same step
//     within a second of each other (2S02 20 Nov 05:02:07: TB 0682→0677 and LA T682→T677; then TB
//     0677→N001 with LA T677→0001). Such berths are ONE berth. Which berths they are is learned
//     beforehand over every day (sameBerths below: a same-second test alone pairs the wrong steps
//     when one area reports a second late), and the tracker keeps a single entry, in the berth named
//     by the crossing's own area where it has a name; the other area's report is an echo.
// A train arriving from an area we are not reading is recognised the same way against that area's
// messages (foreignMatches), and recorded as a hand-over from it, so the caller can widen its areas.
// A step out of a berth nobody occupies is accepted and starts an entry there (lost interposes,
// skipped steps: D5).
// A berth can hold more than one entry (§5.7: platforms where a train pulls in behind). When it does,
// a step out takes the entry whose label matches, else the one there longest; a cancel removes the
// matching label, else the newest.
//
// This is a measuring tool, not the engine's tracker (that is src/berth-first/tracker.js, step 3):
// it keeps every path whole so they can be analysed afterwards.

const STALE_MS = 6 * 3600e3;        // an entry that has not moved for 6 h is a left-over label
const AREA_GAP_MS = 3 * 3600e3;     // an area silent this long has lost its picture: start afresh
const SWEEP_MS = 15 * 60e3;
// Two areas' reports of one step differ by up to a few seconds (BM L041→A027 3 s after LA's 0041→A027,
// 1N54 23 Jun 17:49:50/53). Two different trains with one description can't reach one berth this close.
const SAME_TRAIN_MS = 5000;

class RouteTracker {
  /**
   * @param {object} opts
   *   clears: [{ dir, area, from, to }] — the crossing's clear steps
   *   preferArea: the area whose berth names win when two areas name the same berth
   *   onRun(run): called at every clear step with { dir, t, descr, entry } (entry still live)
   *   onEnd(entry): called when an entry ends (cancel, stale, area gap, duplicate, end of data)
   *   onOccupied(ev): a step or hand-over into a berth that already holds an entry
   */
  constructor({ clears, preferArea = null, sameBerths = [], onRun = () => {}, onEnd = () => {}, onOccupied = () => {} }) {
    this.clearList = clears;
    this.preferArea = preferArea || (clears[0] && clears[0].area) || null;
    this.onRun = onRun; this.onEnd = onEnd; this.onOccupied = onOccupied;
    this.occ = new Map();             // canonical "AREA:BERTH" → [entry]
    this.canonMap = new Map();        // "AREA:BERTH" → the key it is the same berth as
    this.sameBerth = new Map();       // canonical → Set of every name it has
    this.nextId = 1;
    this.lastSweep = 0;
    this.areaLast = new Map();        // area → last event time
    // How trains arrive in each berth: by hand-over (from any area) or by a plain interpose seen while
    // the national log was running. A berth that mostly receives hand-overs is a fringe berth, and on
    // days without the national log its interposes are hand-overs we cannot see the other half of.
    this.arrivals = new Map();        // key → { handover, interpose }
    this.nationalFrom = null;
    this.stats = { steps: 0, stepFromEmpty: 0, echoes: 0, interposes: 0, relabels: 0, cancels: 0, handovers: 0,
      foreignHandovers: 0, foreignSameSteps: 0, duplicates: 0, stale: 0, areaGaps: 0 };
    for (const [a, b] of sameBerths) this._union(a, b, 0);
  }

  canon(k) { let x = k; while (this.canonMap.has(x)) x = this.canonMap.get(x); return x; }

  _clearKey(fromKey, toKey) {
    for (const c of this.clearList) if (this.canon(`${c.area}:${c.from}`) === fromKey && this.canon(`${c.area}:${c.to}`) === toKey) return c;
    return null;
  }

  // Two names for one berth. The crossing's own area names it if it can.
  _union(a, b, t) {
    const ca = this.canon(a), cb = this.canon(b);
    if (ca === cb) return;
    const keepA = this.preferArea ? (ca.startsWith(this.preferArea + ':') || !cb.startsWith(this.preferArea + ':')) : true;
    const [keep, drop] = keepA ? [ca, cb] : [cb, ca];
    this.canonMap.set(drop, keep);
    if (!this.sameBerth.has(keep)) this.sameBerth.set(keep, new Set([keep]));
    for (const n of this.sameBerth.get(drop) || [drop]) this.sameBerth.get(keep).add(n);
    this.sameBerth.delete(drop);
    // Both names may already hold an entry for the same train: keep the one with more history.
    const moving = this.occ.get(drop) || [];
    this.occ.delete(drop);
    for (const e of moving) {
      const list = this.occ.get(keep) || [];
      const twin = list.find(x => x.descr === e.descr);
      if (twin) {
        const [win, lose] = twin.path.length >= e.path.length ? [twin, e] : [e, twin];
        if (win !== twin) list.splice(list.indexOf(twin), 1, win);
        this.stats.duplicates++;
        this._end(lose, 'duplicate', t);
      } else { list.push(e); }
      this.occ.set(keep, list);
    }
    for (const e of this.occ.get(keep) || []) {
      const last = e.path[e.path.length - 1];
      if (last[0] === drop) last[0] = keep;
    }
  }

  _arrive(key, kind, t) {
    if (kind === 'interpose' && (this.nationalFrom === null || t < this.nationalFrom)) return;
    if (!this.arrivals.has(key)) this.arrivals.set(key, { handover: 0, interpose: 0 });
    this.arrivals.get(key)[kind]++;
  }

  _newEntry(key, t, descr, born) {
    return { id: this.nextId++, descr, path: [[key, t]], born: { ...born, key, t }, moved: t, labels: [descr] };
  }

  _put(key, e, t) {
    let list = this.occ.get(key);
    if (!list) { list = []; this.occ.set(key, list); }
    // The same description arriving in the same berth within 5 s is the same train, tracked twice (an
    // area whose hand-over pair straddles a second: LA CC A001 at 06:17:57, CB AM12 at :58, 1C04 23 Jun,
    // while BM tracked it from H987). Keep the copy with more history.
    const twin = list.find(x => x.descr === e.descr && Math.abs(t - x.moved) <= SAME_TRAIN_MS);
    if (twin) {
      const [keep, lose] = twin.path.length >= e.path.length ? [twin, e] : [e, twin];
      if (keep === e) list.splice(list.indexOf(twin), 1, e);
      this.stats.duplicates++;
      this._end(lose, 'duplicate', t);
      return;
    }
    if (list.length) this.onOccupied({ key, t, mover: e, occupants: list.slice() });
    list.push(e);
  }

  _take(key, descr, newest = false) {
    const list = this.occ.get(key);
    if (!list || !list.length) return null;
    let i = list.findIndex(e => e.descr === descr);
    if (i < 0) i = newest ? list.length - 1 : 0;
    const [e] = list.splice(i, 1);
    if (!list.length) this.occ.delete(key);
    return e;
  }

  _end(e, kind, t, extra = {}) { e.end = { kind, t, ...extra }; this.onEnd(e); }

  _move(e, toKey, t, descr) {
    const fromKey = e.path[e.path.length - 1][0];
    if (descr && descr !== e.descr) { e.descr = descr; e.labels.push(descr); (e.relabelAt = e.relabelAt || []).push([e.path.length - 1, t]); }
    e.path.push([toKey, t]);
    e.moved = t;
    this._put(toKey, e, t);
    const c = this._clearKey(fromKey, toKey);
    if (c) this.onRun({ dir: c.dir, t, descr: e.descr, entry: e });
  }

  _sweep(t) {
    if (t - this.lastSweep < SWEEP_MS) return;
    this.lastSweep = t;
    for (const [key, list] of this.occ) {
      const area = key.slice(0, 2);
      const gap = this.areaLast.has(area) && t - this.areaLast.get(area) > AREA_GAP_MS;
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (gap || t - e.moved > STALE_MS) {
          list.splice(i, 1);
          this.stats[gap ? 'areaGaps' : 'stale']++;
          this._end(e, gap ? 'areaGap' : 'stale', t);
        }
      }
      if (!list.length) this.occ.delete(key);
    }
  }

  /**
   * One day's events (sorted by feed time) for the areas being read.
   * foreignMatches: Map("<t>|<descr>" → [{area, kind, from, to}]) — messages from areas NOT being
   *   read that share a second and a description with one of ours.
   * nationalFrom: when the national log starts that day, or null if it has none.
   */
  processDay(events, foreignMatches = new Map(), nationalFrom = null) {
    this.nationalFrom = nationalFrom;
    let i = 0;
    while (i < events.length) {
      const t = events[i].t;
      let j = i;
      while (j < events.length && events[j].t === t) j++;
      this._second(events.slice(i, j), foreignMatches);
      i = j;
    }
  }

  _second(group, foreignMatches) {
    const t = group[0].t;
    this._sweep(t);
    for (const e of group) {
      const last = this.areaLast.get(e.area);
      if (last !== undefined && t - last > AREA_GAP_MS) this._clearArea(e.area, t);
      this.areaLast.set(e.area, t);
    }
    // Hand-overs: an interpose paired with a cancel of the same description, in another berth.
    const used = new Set();
    for (let a = 0; a < group.length; a++) {
      const cc = group[a];
      if (cc.kind !== 'interpose' || used.has(a)) continue;
      for (let b = 0; b < group.length; b++) {
        const cb = group[b];
        if (b === a || used.has(b) || cb.kind !== 'cancel' || cb.descr !== cc.descr) continue;
        if (this.canon(`${cb.area}:${cb.from}`) === this.canon(`${cc.area}:${cc.to}`)) continue;
        used.add(a); used.add(b);
        cc.pairedWith = cb;
        break;
      }
    }
    // Steps out of an occupied berth go first; a step out of an empty berth waits until the rest of
    // the second has run, because the train may be about to arrive there in this same second
    // (1H18 20 Nov 11:22:04: TB 0675→0682, LA T682→T677 and TB 0682→0677 all in one second, LA's
    // report arriving first). Only then is it an echo or a train from nowhere.
    // Interposes come after the steps of their second: an area that is given a train's description in
    // advance (BM's CC into L041 with LA's step into its 0041, 2S02 20 Nov 05:31:34) labels the berth
    // the train has just stepped into, it doesn't start a second train there.
    let waiting = [];
    const interposes = [];
    for (let a = 0; a < group.length; a++) {
      const ev = group[a];
      if (used.has(a) && ev.kind === 'cancel') continue;
      if (ev.kind === 'step') {
        if (this.occ.has(this.canon(`${ev.area}:${ev.from}`))) this._step(ev, foreignMatches);
        else waiting.push(ev);
      } else if (ev.kind === 'interpose') interposes.push(ev);
      else if (ev.kind === 'cancel') this._cancel(ev);
    }
    for (let progress = true; progress && waiting.length;) {
      progress = false;
      const still = [];
      for (const ev of waiting) {
        if (this.occ.has(this.canon(`${ev.area}:${ev.from}`))) { this._step(ev, foreignMatches); progress = true; }
        else still.push(ev);
      }
      waiting = still;
    }
    for (const ev of waiting) this._step(ev, foreignMatches);
    for (const ev of interposes) this._interpose(ev, foreignMatches);
  }

  _clearArea(area, t) {
    for (const [key, list] of this.occ) {
      if (key.slice(0, 2) !== area) continue;
      for (const e of list) { this.stats.areaGaps++; this._end(e, 'areaGap', t); }
      this.occ.delete(key);
    }
  }

  _step(ev, foreignMatches) {
    this.stats.steps++;
    const fromKey = this.canon(`${ev.area}:${ev.from}`), toKey = this.canon(`${ev.area}:${ev.to}`);
    if (fromKey === toKey) { this.stats.echoes++; return; }        // both ends one berth: nothing moves
    let e = this._take(fromKey, ev.descr);
    if (!e) {
      // The other area's report of a step already made: the same train reached this berth just now.
      const there = (this.occ.get(toKey) || []).find(x => ev.t - x.moved <= SAME_TRAIN_MS && x.path.length > 1 && (x.descr === ev.descr || x.path[x.path.length - 2][0] === fromKey));
      if (there) { this.stats.echoes++; return; }
      const f = (foreignMatches.get(`${ev.t}|${ev.descr}`) || []).find(m => m.kind === 'step');
      if (f) {
        this.stats.foreignSameSteps++;
        e = this._newEntry(fromKey, ev.t, ev.descr, { kind: 'handover', fromArea: f.area, fromBerth: f.from, via: 'sameStep' });
        this._arrive(fromKey, 'handover', ev.t);
      } else {
        this.stats.stepFromEmpty++;
        e = this._newEntry(fromKey, ev.t, ev.descr, { kind: 'stepFromEmpty' });
      }
    }
    this._move(e, toKey, ev.t, ev.descr);
  }

  _interpose(ev, foreignMatches) {
    const toKey = this.canon(`${ev.area}:${ev.to}`);
    if (ev.pairedWith) {                                          // hand-over between our areas
      this.stats.handovers++;
      const cb = ev.pairedWith;
      const fromKey = this.canon(`${cb.area}:${cb.from}`);
      let e = this._take(fromKey, cb.descr);
      if (!e) { this.stats.stepFromEmpty++; e = this._newEntry(fromKey, ev.t, ev.descr, { kind: 'stepFromEmpty' }); }
      this._move(e, toKey, ev.t, ev.descr);
      this._arrive(toKey, 'handover', ev.t);
      return;
    }
    // A hand-over from an area we don't read is a train arriving, even into an occupied berth.
    const fm = foreignMatches.get(`${ev.t}|${ev.descr}`) || [];
    const f = fm.find(m => m.kind === 'cancel');
    if (f) {
      this.stats.foreignHandovers++;
      this._put(toKey, this._newEntry(toKey, ev.t, ev.descr, { kind: 'handover', fromArea: f.area, fromBerth: f.from, via: 'cancelInterpose' }), ev.t);
      this._arrive(toKey, 'handover', ev.t);
      return;
    }
    const list = this.occ.get(toKey);
    // Described in advance by an area we don't read, as the train steps there (BM CC L041 with LA's
    // step into 0041): a train arriving from that area.
    const adv = (!list || !list.length) && fm.find(m => m.kind === 'step');
    if (adv) {
      this.stats.foreignAdvance = (this.stats.foreignAdvance || 0) + 1;
      this._put(toKey, this._newEntry(toKey, ev.t, ev.descr, { kind: 'handover', fromArea: adv.area, fromBerth: adv.to, via: 'advanceDescription' }), ev.t);
      this._arrive(toKey, 'handover', ev.t);
      return;
    }
    if (list && list.length) {                                    // a new label for what is there
      this.stats.relabels++;
      const e = list[list.length - 1];
      if (ev.descr !== e.descr) {
        e.descr = ev.descr; e.labels.push(ev.descr);
        (e.relabelAt = e.relabelAt || []).push([e.path.length - 1, ev.t]);    // where it became this train
      }
      return;
    }
    this.stats.interposes++;
    this._arrive(toKey, 'interpose', ev.t);
    this._put(toKey, this._newEntry(toKey, ev.t, ev.descr, { kind: 'interpose' }), ev.t);
  }

  _cancel(ev) {
    this.stats.cancels++;
    const key = this.canon(`${ev.area}:${ev.from}`);
    const e = this._take(key, ev.descr, true);
    if (e) this._end(e, 'cancel', ev.t, { key });
  }

  // Every entry still live (end of the replayed window).
  flush(t) {
    for (const list of this.occ.values()) for (const e of list) this._end(e, 'open', t);
    this.occ.clear();
  }

  // The berths that two areas name, for the routes file.
  equivalences() {
    return [...this.sameBerth.entries()].filter(([, s]) => s.size > 1).map(([k, s]) => [k, [...s].filter(x => x !== k).sort()]).sort();
  }
}

// ---- Which berths two areas both describe ----
// Over a day's events (sorted by time): every pair of steps by the same description in two different
// areas within a second of each other votes that their from-berths are one berth and their to-berths
// are one berth (a whole vote in the same second, half a vote a second apart: neighbouring areas'
// reports differ by a second now and then, LA A031→A007 05:37:43 with BM's at :42). Accumulate across
// days in `votes`, then choose.
function countSameSteps(events, votes = new Map()) {
  const steps = events.filter(e => e.kind === 'step');
  const vote = (a, b, w) => {
    if (!votes.has(a)) votes.set(a, new Map());
    votes.get(a).set(b, (votes.get(a).get(b) || 0) + w);
  };
  let j0 = 0;
  for (let i = 0; i < steps.length; i++) {
    const x = steps[i];
    while (steps[j0].t < x.t - 1000) j0++;
    for (let j = j0; j < steps.length && steps[j].t <= x.t + 1000; j++) {
      const y = steps[j];
      if (y.area === x.area || y.descr !== x.descr) continue;
      const w = y.t === x.t ? 1 : 0.5;
      vote(`${x.area}:${x.from}`, `${y.area}:${y.from}`, w);
      vote(`${x.area}:${x.to}`, `${y.area}:${y.to}`, w);
    }
  }
  return votes;
}

// Two berths are one when each is the other's clear favourite: at least 5 votes, and a score at least
// twice the runner-up's (a train's previous or next step, a second away, picks up votes too; a tie is
// no evidence). Describers number shared berths alike (LA T682 = TB 0682, BM L041 = LA 0041, LA 0001 =
// TB N001), so a matching last three characters doubles a candidate's score.
// Returns [{ berths: [a, b], votes }].
const sameNumber = (a, b) => a.slice(-3) === b.slice(-3);
function chooseSameBerths(votes, { minVotes = 5 } = {}) {
  const best = new Map();
  for (const [a, m] of votes) {
    const ranked = [...m.entries()].map(([b, v]) => ({ b, v, score: v * (sameNumber(a, b) ? 2 : 1) })).sort((x, y) => y.score - x.score);
    const top = ranked[0], second = ranked[1] ? ranked[1].score : 0;
    if (top.v >= minVotes && top.score >= 2 * second) best.set(a, { b: top.b, v: top.v });
  }
  const out = [], seen = new Set();
  for (const [a, { b, v }] of best) {
    const back = best.get(b);
    if (!back || back.b !== a) continue;
    const id = [a, b].sort().join('=');
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ berths: [a, b], votes: v });
  }
  return out.sort((x, y) => x.berths[0].localeCompare(y.berths[0]));
}

module.exports = { RouteTracker, STALE_MS, AREA_GAP_MS, countSameSteps, chooseSameBerths };
