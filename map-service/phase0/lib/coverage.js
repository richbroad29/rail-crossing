'use strict';

// LA_COVERAGE: how much of the berth network the station anchors reach. Phase 1 places an unanchored
// berth by interpolating between anchored ones along observed steps, so the share of berths already at an
// anchor, or within a few steps of one, says how much interpolation it will have to do.
//
// Distance is the number of steps (edges) to the nearest anchored berth, counted over observed steps in
// either direction: a berth two steps BEHIND an anchor is as near as one two steps ahead. A step counts
// only if it was seen at least `minEdgeCount` times in the logs, so one mis-stepped description cannot
// connect two berths that are not connected.

const { pct, fmtInt } = require('./format');

/**
 * @param {object} p
 * @param {Set<string>} p.berths                       every berth seen
 * @param {Map<string,Map<string,number>>} p.edges     observed steps, from -> to -> times seen
 * @param {Set<string>} p.anchored                     berths anchored at a station (in this area)
 * @param {number} [p.minEdgeCount=2]
 * @param {number} [p.maxHops=3]
 */
function analyseCoverage({ berths, edges, anchored, minEdgeCount = 2, maxHops = 3 }) {
  const adjacent = new Map();
  const link = (a, b) => { let s = adjacent.get(a); if (!s) { s = new Set(); adjacent.set(a, s); } s.add(b); };
  let usable = 0, seenTooFew = 0;
  for (const [from, m] of edges) {
    for (const [to, n] of m) {
      if (n < minEdgeCount) { seenTooFew++; continue; }
      usable++;
      link(from, to); link(to, from);
    }
  }

  const distance = new Map();
  let frontier = [];
  for (const b of berths) if (anchored.has(b)) { distance.set(b, 0); frontier.push(b); }
  for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
    const next = [];
    for (const u of frontier) {
      for (const v of adjacent.get(u) || []) {
        if (!distance.has(v)) { distance.set(v, hop); next.push(v); }
      }
    }
    frontier = next;
  }

  const atHop = new Array(maxHops + 1).fill(0);
  for (const [b, d] of distance) if (berths.has(b)) atHop[d]++;
  const total = berths.size;
  const within = [];                                    // within[k] = berths at most k steps from an anchor
  atHop.reduce((run, n, k) => { within[k] = run + n; return run + n; }, 0);
  const shares = within.map(n => pct(n, total));
  let anchoredNotSeen = 0;
  for (const b of anchored) if (!berths.has(b)) anchoredNotSeen++;

  return {
    berthsSeen: total,
    anchoredSeen: within[0],
    atHop, within, sharePct: shares,
    beyond: total - within[maxHops],
    anchorsInArea: anchored.size,
    anchorsNotSeen: anchoredNotSeen,
    edges: { distinct: usable + seenTooFew, usable, seenTooFew },
    minEdgeCount, maxHops
  };
}

/**
 * LA_COVERAGE message. `logs` is { files, oldest, newest } from findTdLogFiles.
 */
function describeCoverage(cov, { area = 'LA', logs }) {
  const days = logs.files.length;
  const span = days === 1 ? logs.newest : `${logs.oldest} to ${logs.newest}`;
  // Anchors exist but not one of them is a berth the logs ever mention: the likeliest cause is that SMART and
  // TD write berth ids differently (an area prefix, zero padding), which would break every later join.
  const mismatch = cov.anchorsInArea > 0 && cov.anchoredSeen === 0
    ? ` None of the ${fmtInt(cov.anchorsInArea)} ${area} anchors appears among the berths in the TD logs: check that SMART and TD write berth ids the same way (prefix, zero padding).`
    : '';
  return `${area}: ${fmtInt(cov.berthsSeen)} berths seen in ${days} ${days === 1 ? 'day' : 'days'} of TD logs (${span}); `
    + `${cov.sharePct[0]}% are anchored at a station, ${cov.sharePct[1]}% within 1 step of one, ${cov.sharePct[2]}% within 2, ${cov.sharePct[3]}% within 3 `
    + `(steps seen at least ${cov.minEdgeCount} times); ${fmtInt(cov.beyond)} are further away or unconnected.${mismatch}`;
}

module.exports = { analyseCoverage, describeCoverage };
