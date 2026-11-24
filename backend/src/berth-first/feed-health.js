'use strict';

// Feed health for the berth-first engine (docs/berth-first-design.md §5.11, D7, D23; v1 plan §2).
//
// Berth-first predicts ONLY from the berths, so a silent feed is not a quiet slide back to timetable times
// (as for 4½ days from 22 Sep under the old engine): it is an app that would show no closures at all. So it
// says so plainly instead — no closures, no countdowns, the agreed message.
//
// What counts as silent: each area the crossing's routes cross sends a heartbeat (TD "CT") every 30 s, day
// and night, even when no train moves. Measured on the national log (19 Nov 21:52 to 23 Nov, LA and TB):
// 30 s median, longest gap 38 s, never a minute. An area is OUT when nothing (heartbeat or berth event) has
// been heard from it for longer than its routes-file `feedHealth.<area>.maxSilenceSecs` (learn-routes; 120 s
// for both today). LA's own berth steps stop for hours overnight, which is why silence is never measured on
// steps alone. The whole feed going quiet silences every area, so it needs no separate test.
//
// A BLIND SPAN is a silence that went past the limit and then ended — an outage, or a restart whose downtime
// was that long. The feed does not resend what was missed, so a train last placed before a blind span may
// be anywhere now: the engine counts it again only once it has moved (engine.js, 'unconfirmed').
//
// Two clocks, kept apart: `wall` is this machine's time when a message arrived (silence is judged on it, so
// a describer clock that drifts cannot fake or hide an outage); `feed` is the message's own time, the clock
// the tracker's entries carry (lastMove), so "placed before the blind span" compares like with like.

const DEFAULT_MAX_SILENCE_SECS = 120;   // an area the routes file gives no measured limit for: 4 heartbeats

const OUTAGE_MESSAGE = 'Network Rail data is currently unavailable, so we can\'t predict closures. We\'re working to get this fixed.';

class FeedHealth {
  /**
   * @param {string[]} areas         the areas the crossing's routes cross (routes file `areas`)
   * @param {object}   limits        routes file `feedHealth`: { <area>: { maxSilenceSecs } }
   * @param {number}   startedWall   when the engine started (wall ms)
   */
  constructor(areas, limits = {}, startedWall = Date.now()) {
    this.startedWall = startedWall;
    this.restart = null;              // { fromFeed, fromWall }: when the previous process last heard the feed
    this.areas = new Map();
    for (const a of areas || []) {
      const l = limits && limits[a];
      const secs = l && Number.isFinite(l.maxSilenceSecs) && l.maxSilenceSecs > 0 ? l.maxSilenceSecs : DEFAULT_MAX_SILENCE_SECS;
      this.areas.set(a, { maxSilenceMs: secs * 1000, measured: !!(l && Number.isFinite(l.maxSilenceSecs)),
        lastWall: null, lastFeed: null, blind: null });
    }
    this.spans = [];                  // every blind span so far, newest last (bounded): for /health and the log
  }

  // A restart: the previous process last heard the feed at fromWall (its national log's last line; else its
  // latest logged berth event). If this process first hears an area more than that area's limit later, the
  // downtime was a blind span for it, exactly as a silence while running would have been.
  markRestart(fromWall) {
    this.restart = Number.isFinite(fromWall) ? { fromWall, fromFeed: fromWall } : null;
  }

  // Anything heard from `area`: a heartbeat or a berth event, as it arrives.
  heard(area, feedMs, wallMs) {
    const a = this.areas.get(area);
    if (!a || !Number.isFinite(wallMs)) return;
    const feed = Number.isFinite(feedMs) ? feedMs : wallMs;
    let from = null;
    if (a.lastWall !== null) {
      if (wallMs - a.lastWall > a.maxSilenceMs) from = { feed: a.lastFeed, wall: a.lastWall };
    } else if (this.restart && wallMs - this.restart.fromWall > a.maxSilenceMs) {
      from = { feed: this.restart.fromFeed, wall: this.restart.fromWall };
    }
    if (from) {
      a.blind = { area, fromFeed: from.feed, fromWall: from.wall, toFeed: feed, toWall: wallMs };
      this.spans.push(a.blind);
      if (this.spans.length > 50) this.spans.shift();
    }
    a.lastWall = wallMs;
    if (a.lastFeed === null || feed > a.lastFeed) a.lastFeed = feed;
  }

  // Each area now: heard yet, seconds since, its limit, out or not.
  status(wallNow = Date.now()) {
    const areas = {}, out = [];
    for (const [name, a] of this.areas) {
      const silentMs = a.lastWall === null ? wallNow - this.startedWall : wallNow - a.lastWall;
      const isOut = silentMs > a.maxSilenceMs || a.lastWall === null;
      areas[name] = {
        heard: a.lastWall !== null,
        silentSecs: Math.max(0, Math.round(silentMs / 1000)),
        maxSilenceSecs: a.maxSilenceMs / 1000,
        ...(a.measured ? {} : { limit: 'default' }),
        out: isOut,
        ...(a.blind ? { lastBlindSpan: { from: new Date(a.blind.fromWall).toISOString(), to: new Date(a.blind.toWall).toISOString(),
          secs: Math.round((a.blind.toWall - a.blind.fromWall) / 1000) } } : {})
      };
      if (isOut) out.push(name);
    }
    return { ok: out.length === 0, out, areas };
  }

  // Why the feed is not usable now, or null: 'starting' while an area has not been heard since this process
  // started and its limit has not yet run out (the first heartbeat is up to 30 s away), else 'feed'.
  problem(wallNow = Date.now()) {
    let starting = false, feed = false, since = Infinity;
    const areas = [];
    for (const [name, a] of this.areas) {
      if (a.lastWall === null) {
        areas.push(name);
        if (wallNow - this.startedWall <= a.maxSilenceMs) starting = true;
        else { feed = true; since = Math.min(since, this.restart ? this.restart.fromWall : this.startedWall); }
      } else if (wallNow - a.lastWall > a.maxSilenceMs) {
        areas.push(name); feed = true; since = Math.min(since, a.lastWall);
      }
    }
    if (feed) return { reason: 'feed', areas, since };
    if (starting) return { reason: 'starting', areas, since: this.startedWall };
    return null;
  }

  // The end of the latest blind span over all areas (wall ms), or null: predictions wait a settling time after it.
  lastRecovery() {
    let best = null;
    for (const a of this.areas.values()) if (a.blind && (best === null || a.blind.toWall > best.toWall)) best = a.blind;
    return best;
  }

  // Was a tracked entry in `area`, which last moved at feed time lastMoveFeed, placed before that area's latest
  // blind span? Then it may have moved anywhere unseen.
  placedBeforeBlind(area, lastMoveFeed) {
    const a = this.areas.get(area);
    return !!(a && a.blind && Number.isFinite(lastMoveFeed) && lastMoveFeed <= a.blind.fromFeed);
  }
}

module.exports = { FeedHealth, OUTAGE_MESSAGE, DEFAULT_MAX_SILENCE_SECS };
