'use strict';

// The pure analyses over SMART rows. No I/O, no clock: each function takes data and returns data, so
// each can be tested against a constructed dataset whose answer is known.
//
// Rows are the compact form from smart.js: { td, from, to, stanox, event }.
//
// THE READING UNDER TEST. A SMART row says "this berth step is a timing event at this STANOX". For an
// arrival (EVENT A or C) the train steps INTO the platform berth, so the station is at the step's TOBERTH.
// For a departure (B or D) it steps OUT of the platform berth, so the station is at FROMBERTH. If that is
// right, then for one (TD area, STANOX, direction) the TO berths of the arrivals and the FROM berths of
// the departures are the same berth. SMART_SEMANTICS measures how often that holds; ANCHORS applies the
// reading to place berths at stations.

const { classifyEvent } = require('./norm');
const { haversineKm, inBox } = require('./geo');
const { fmtInt, fmtPct, pct, listCap, isAre } = require('./format');

const SEP = '\u0001';                                   // cannot occur in a berth, area or STANOX
const stepKey = (td, a, b) => td + SEP + a + SEP + b;

function addDistinct(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

// ---- SMART_SEMANTICS --------------------------------------------------------------------------------

/**
 * How well does the reading hold? Rows are grouped by (TD area, STANOX, direction), direction being up
 * for EVENT A/B and down for C/D. Among groups that have both an arrival row and a departure row, each
 * group is classified under two readings:
 *
 *   ours      some arrival's TOBERTH  equals some departure's FROMBERTH     (the reading above)
 *   reversed  some arrival's FROMBERTH equals some departure's TOBERTH      (the contrast)
 *
 * as 'exact' (the berths are equal), else 'adjacent' (two of the berths involved are one SMART step
 * apart: some row in the same area steps from one to the other, in either direction), else 'none'.
 * `adjacent` therefore means "not exact, but a platform that spans two berths would look like this".
 *
 * Berths that are blank on a row (an interpose has no FROMBERTH, a clear has no TOBERTH) are ignored,
 * not matched against each other.
 */
function analyseSemantics(rows) {
  const steps = new Set();
  const groups = new Map();
  const ignored = { unrecognisedEvent: 0, missingAreaOrStanox: 0 };

  for (const r of rows) {
    if (r.td && r.from && r.to) steps.add(stepKey(r.td, r.from, r.to));
    const cls = classifyEvent(r.event);
    if (!cls) { ignored.unrecognisedEvent++; continue; }
    if (!r.td || !r.stanox) { ignored.missingAreaOrStanox++; continue; }
    const key = r.td + SEP + r.stanox + SEP + cls.dir;
    let g = groups.get(key);
    if (!g) {
      g = { td: r.td, dir: cls.dir, arrivals: 0, departures: 0, arrTo: [], arrFrom: [], depFrom: [], depTo: [] };
      groups.set(key, g);
    }
    if (cls.kind === 'arrival') { g.arrivals++; addDistinct(g.arrTo, r.to); addDistinct(g.arrFrom, r.from); }
    else { g.departures++; addDistinct(g.depFrom, r.from); addDistinct(g.depTo, r.to); }
  }

  const compare = (td, A, D) => {
    for (const a of A) if (D.includes(a)) return 'exact';
    for (const a of A) for (const d of D) if (steps.has(stepKey(td, a, d)) || steps.has(stepKey(td, d, a))) return 'adjacent';
    return 'none';
  };
  const tally = () => ({ exact: 0, adjacent: 0, none: 0 });
  const result = {
    groupsTotal: groups.size, groups: 0, arrivalOnly: 0, departureOnly: 0, withoutBerthData: 0,
    ours: tally(), reversed: tally(), cross: {}, byDirection: { up: null, down: null }, byAreaAll: new Map(), ignored
  };
  for (const d of ['up', 'down']) result.byDirection[d] = { groups: 0, ours: tally(), reversed: tally() };

  for (const g of groups.values()) {
    if (g.arrivals === 0) { result.departureOnly++; continue; }
    if (g.departures === 0) { result.arrivalOnly++; continue; }
    const ours = compare(g.td, g.arrTo, g.depFrom);
    const reversed = compare(g.td, g.arrFrom, g.depTo);
    result.groups++;
    result.ours[ours]++;
    result.reversed[reversed]++;
    result.cross[`${ours}/${reversed}`] = (result.cross[`${ours}/${reversed}`] || 0) + 1;
    if (!g.arrTo.length || !g.depFrom.length) result.withoutBerthData++;
    const bd = result.byDirection[g.dir];
    bd.groups++; bd.ours[ours]++; bd.reversed[reversed]++;
    let a = result.byAreaAll.get(g.td);
    if (!a) { a = { td: g.td, groups: 0, oursExact: 0, reversedExact: 0 }; result.byAreaAll.set(g.td, a); }
    a.groups++;
    if (ours === 'exact') a.oursExact++;
    if (reversed === 'exact') a.reversedExact++;
  }

  const n = result.groups;
  result.pct = {
    oursExact: pct(result.ours.exact, n),
    oursAdjacent: pct(result.ours.adjacent, n),
    oursNone: pct(result.ours.none, n),
    reversedExact: pct(result.reversed.exact, n),
    reversedAdjacent: pct(result.reversed.adjacent, n),
    reversedNone: pct(result.reversed.none, n)
  };
  // The whole per-area distribution can be 100+ rows; keep the largest areas and the worst-fitting
  // ones (among areas with enough groups to mean anything).
  const areas = [...result.byAreaAll.values()].map(a => ({ ...a, oursExactPct: pct(a.oursExact, a.groups), reversedExactPct: pct(a.reversedExact, a.groups) }));
  const biggest = [...areas].sort((x, y) => y.groups - x.groups || (x.td < y.td ? -1 : 1)).slice(0, 25);
  const worst = areas.filter(a => a.groups >= 5).sort((x, y) => x.oursExactPct - y.oursExactPct || (x.td < y.td ? -1 : 1)).slice(0, 15);
  result.areas = { count: areas.length, biggest, worstFitting: worst };
  delete result.byAreaAll;
  return result;
}

// FIRST-PASS THRESHOLDS. These are a starting point, not a derived standard: the check is a verdict a
// person can act on, but the FULL DISTRIBUTION (the counts, the ours-by-reversed table, by direction and
// by area) is in the report's data precisely so that a person can judge it for themselves and move
// these numbers if the data says they are wrong.
const SEMANTICS_PASS_AT = 60;      // our reading's exact share, in percent, for PASS ...
const SEMANTICS_CLEAR_BY = 20;     // ... provided it beats the reversed reading by at least this many points
const SEMANTICS_WARN_AT = 30;      // below PASS but at or above this is WARN; below this is FAIL

/**
 * SMART_SEMANTICS verdict.
 *   PASS  ours >= 60% exact AND at least 20 points above the reversed reading's exact share
 *   WARN  ours 30% to under 60%; or >= 60% but the reversed reading is within 20 points (cannot tell them apart)
 *   FAIL  ours under 30%, or there is no group with both an arrival and a departure to test
 * @param {object} res    analyseSemantics' result
 * @param {object} [ctx]  { events } the EVENT values seen, quoted when nothing can be tested
 */
function judgeSemantics(res, ctx = {}) {
  const thresholds = { passAt: SEMANTICS_PASS_AT, clearBy: SEMANTICS_CLEAR_BY, warnAt: SEMANTICS_WARN_AT, firstPass: true };
  if (res.groups === 0) {
    const seen = ctx.events ? ` EVENT values seen: ${JSON.stringify(ctx.events)}.` : '';
    return { status: 'FAIL', thresholds, message: `No station/direction group has both an arrival and a departure row, so the berth reading cannot be tested.${seen}` };
  }
  const o = res.pct.oursExact, r = res.pct.reversedExact;
  // Decided on the exact counts (percent * groups), never on the rounded percentages shown: 59.96% must
  // not pass a 60% rule because it prints as 60.0.
  const n = res.groups, ours = res.ours.exact * 100, rev = res.reversed.exact * 100;
  let status, tail = '';
  if (ours < SEMANTICS_WARN_AT * n) status = 'FAIL';
  else if (ours >= SEMANTICS_PASS_AT * n && ours - rev >= SEMANTICS_CLEAR_BY * n) status = 'PASS';
  else {
    status = 'WARN';
    if (ours >= SEMANTICS_PASS_AT * n) tail = ' The reversed reading is nearly as good, so the data cannot tell them apart.';
  }
  const message = `Our reading (arrival at TOBERTH, departure at FROMBERTH) holds exactly for ${o}% of ${fmtInt(res.groups)} station/direction groups `
    + `(a further ${res.pct.oursAdjacent}% are one SMART step apart); the reversed reading holds for ${r}%.${tail}`;
  return { status, thresholds, message };
}

// ---- STATION_RESOLUTION -----------------------------------------------------------------------------

/**
 * Of the distinct SMART STANOXes: how many are stations (CORPUS gives them a CRS), and of those how many
 * have coordinates in the station table.
 * @param {object} p
 * @param {Map<string,{rows:number,name:string}>} p.stanoxInfo  from readSmart
 * @param {{crsForStanox:function, hasStanox:function}} p.corpus
 * @param {Map<string,object>} p.stations                        CRS -> { name, lat, lon }
 */
function analyseStationResolution({ stanoxInfo, corpus, stations, topN = 20 }) {
  let stanoxes = 0, notInCorpus = 0, nonStations = 0, stationStanoxes = 0, resolved = 0, severalCrs = 0;
  let rowsTotal = 0, rowsAtResolved = 0;
  const unresolved = [];
  for (const [stanox, info] of stanoxInfo) {
    stanoxes++;
    rowsTotal += info.rows;
    const crs = corpus.crsForStanox(stanox);
    if (!crs.length) {
      nonStations++;
      if (!corpus.hasStanox(stanox)) notInCorpus++;
      continue;
    }
    stationStanoxes++;
    if (crs.length > 1) severalCrs++;
    if (crs.some(c => stations.has(c))) { resolved++; rowsAtResolved += info.rows; }
    else unresolved.push({ stanox, name: info.name, crs: crs.join('/'), rows: info.rows });
  }
  unresolved.sort((a, b) => b.rows - a.rows || (a.stanox < b.stanox ? -1 : 1));
  return {
    stanoxes, stationStanoxes, nonStations, notInCorpus, resolved, severalCrs,
    unresolved: unresolved.length,
    unresolvedTop: unresolved.slice(0, topN),
    rowsWithStanox: rowsTotal,
    rowsAtResolvedStations: rowsAtResolved,
    resolvedPct: pct(resolved, stationStanoxes)
  };
}

const RESOLUTION_PASS_AT = 90, RESOLUTION_WARN_AT = 75;

/** The most common non-blank width in a { width: count } object from the format facts, or null. */
function dominantWidth(lengths) {
  let best = null, n = -1;
  for (const [width, count] of Object.entries(lengths || {})) if (width !== '0' && count > n) { best = width; n = count; }
  return best;
}

/**
 * STATION_RESOLUTION verdict: PASS >= 90% of station STANOXes resolved, WARN 75-90%, FAIL below.
 * @param {object} res
 * @param {object} [ctx] { smartStanoxLengths, corpusStanoxLengths }: when the verdict is not PASS and the
 *   two files write STANOX at different widths, the message says so, since that alone would break the join.
 */
function judgeStationResolution(res, ctx = {}) {
  const thresholds = { passAt: RESOLUTION_PASS_AT, warnAt: RESOLUTION_WARN_AT };
  if (res.stationStanoxes === 0) {
    const a = dominantWidth(ctx.smartStanoxLengths), b = dominantWidth(ctx.corpusStanoxLengths);
    const widths = a && b && a !== b ? ` SMART STANOX are mostly ${a} characters long but CORPUS's are ${b}: the two files may format the code differently.` : '';
    return { status: 'FAIL', thresholds, message: `None of the ${fmtInt(res.stanoxes)} SMART timing points (STANOX) has a CRS in CORPUS, so no station can be placed.${widths}` };
  }
  // Exact counts again, not the rounded resolvedPct.
  const scaled = res.resolved * 100, n = res.stationStanoxes;
  const status = scaled >= RESOLUTION_PASS_AT * n ? 'PASS' : scaled >= RESOLUTION_WARN_AT * n ? 'WARN' : 'FAIL';
  const absent = res.notInCorpus ? ` ${fmtInt(res.notInCorpus)} STANOX ${isAre(res.notInCorpus)} not in CORPUS at all.` : '';
  const a = dominantWidth(ctx.smartStanoxLengths), b = dominantWidth(ctx.corpusStanoxLengths);
  const widths = status !== 'PASS' && a && b && a !== b
    ? ` SMART STANOX are mostly ${a} characters long but CORPUS's are ${b}: the two files may format the code differently.` : '';
  return {
    status, thresholds,
    message: `${fmtInt(res.stanoxes)} SMART timing points (STANOX): ${fmtInt(res.stationStanoxes)} ${isAre(res.stationStanoxes)} stations (have a CRS in CORPUS), `
      + `${fmtInt(res.resolved)} of those (${fmtPct(res.resolved, res.stationStanoxes)}) have coordinates in the station table; unresolved: ${fmtInt(res.unresolved)}.${absent}${widths}`
  };
}

// ---- ANCHORS ----------------------------------------------------------------------------------------

/**
 * Apply the reading to place berths at stations.
 *   anchor  a berth that is the station's own: an arrival's TOBERTH, a departure's FROMBERTH
 *   hint    the other berth of a station step (an arrival's FROMBERTH, a departure's TOBERTH): next to a
 *           station but not at it. A berth that is anchored somewhere is not also a hint.
 *   claim   one row asserting that a berth is at a station. A berth claimed by more than one station is a
 *           conflict; the distance between its claimants says whether that is a platform shared by two
 *           neighbouring stations (small) or the reading being wrong somewhere (large).
 *
 * Only stations with coordinates can claim a berth (an anchor without a position is no use to the map);
 * claims by stations the table cannot place are counted, not lost. A STANOX that CORPUS gives two CRS
 * makes both of them claimants, so the ambiguity shows up as a conflict instead of being hidden.
 *
 * The winner of a conflict is the station with most claims (ties: the first CRS alphabetically). Every
 * claimant is kept in the output so phase 1 can decide differently.
 *
 * @param {object[]} rows
 * @param {object} p
 * @param {function(string):string[]} p.crsForStanox
 * @param {Map<string,{name:string,lat:number,lon:number}>} p.stations
 * @param {number} [p.suspiciousKm=5]  conflicts with claimants further apart than this are suspicious
 */
function analyseAnchors(rows, { crsForStanox, stations, suspiciousKm = 5 }) {
  const anchors = new Map();      // td+SEP+berth -> { td, berth, claims: Map<crs, n> }
  const hints = new Map();
  const rowCounts = { anchoring: 0, atNonStation: 0, atUnplaceableStation: 0, notTimingEvent: 0, missingAreaOrStanox: 0 };

  const claim = (map, td, berth, crs) => {
    const key = td + SEP + berth;
    let e = map.get(key);
    if (!e) { e = { td, berth, claims: new Map() }; map.set(key, e); }
    e.claims.set(crs, (e.claims.get(crs) || 0) + 1);
  };

  for (const r of rows) {
    const cls = classifyEvent(r.event);
    if (!cls) { rowCounts.notTimingEvent++; continue; }
    if (!r.td || !r.stanox) { rowCounts.missingAreaOrStanox++; continue; }
    const all = crsForStanox(r.stanox);
    if (!all.length) { rowCounts.atNonStation++; continue; }
    const placeable = all.filter(c => stations.has(c));
    if (!placeable.length) { rowCounts.atUnplaceableStation++; continue; }
    rowCounts.anchoring++;
    const [strong, weak] = cls.kind === 'arrival' ? [r.to, r.from] : [r.from, r.to];
    for (const crs of placeable) {
      if (strong) claim(anchors, r.td, strong, crs);
      if (weak) claim(hints, r.td, weak, crs);
    }
  }
  for (const key of anchors.keys()) hints.delete(key);

  const winner = claims => [...claims].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  const maxPairKm = crsList => {
    let max = 0;
    for (let i = 0; i < crsList.length; i++) for (let j = i + 1; j < crsList.length; j++) {
      max = Math.max(max, haversineKm(stations.get(crsList[i]), stations.get(crsList[j])));
    }
    return max;
  };
  const byKey = (a, b) => (a.td < b.td ? -1 : a.td > b.td ? 1 : a.berth < b.berth ? -1 : a.berth > b.berth ? 1 : 0);

  const perArea = {};
  const area = td => perArea[td] || (perArea[td] = { anchors: 0, hints: 0, conflicts: 0, suspicious: 0 });
  const table = [];
  const conflicts = [];
  for (const a of [...anchors.values()].sort(byKey)) {
    const w = winner(a.claims), st = stations.get(w);
    const entry = { td: a.td, berth: a.berth, crs: w, lat: st.lat, lon: st.lon, n: [...a.claims.values()].reduce((x, y) => x + y, 0) };
    area(a.td).anchors++;
    if (a.claims.size > 1) {
      const crsList = [...a.claims.keys()].sort();
      const km = maxPairKm(crsList);
      entry.claims = Object.fromEntries([...a.claims].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)));
      entry.maxKm = Math.round(km * 100) / 100;
      area(a.td).conflicts++;
      if (km > suspiciousKm) { entry.suspicious = true; area(a.td).suspicious++; }
      conflicts.push(entry);
    }
    table.push(entry);
  }
  const hintTable = [];
  for (const h of [...hints.values()].sort(byKey)) {
    const w = winner(h.claims), st = stations.get(w);
    hintTable.push({ td: h.td, berth: h.berth, crs: w, lat: st.lat, lon: st.lon, n: [...h.claims.values()].reduce((x, y) => x + y, 0) });
    area(h.td).hints++;
  }

  const suspicious = conflicts.filter(c => c.suspicious).sort((a, b) => b.maxKm - a.maxKm || byKey(a, b));
  const detail = c => ({
    td: c.td, berth: c.berth, maxKm: c.maxKm,
    claimants: Object.entries(c.claims).map(([crs, n]) => ({ crs, name: stations.get(crs).name, n }))
  });
  return {
    table, hintTable, perArea, rowCounts,
    totals: {
      anchors: table.length, hints: hintTable.length, conflicts: conflicts.length, suspicious: suspicious.length,
      areas: Object.keys(perArea).length, suspiciousKm
    },
    suspiciousTop: suspicious.slice(0, 20).map(detail),
    conflictsNearest: conflicts.filter(c => !c.suspicious).sort((a, b) => b.maxKm - a.maxKm).slice(0, 10).map(detail)
  };
}

/** ANCHORS message: always INFO. */
function describeAnchors(a) {
  const t = a.totals;
  const sus = t.conflicts ? `, ${fmtInt(t.suspicious)} of those more than ${t.suspiciousKm} km apart${t.suspicious ? ' (suspicious)' : ''}` : '';
  return `${fmtInt(t.anchors)} berths in ${fmtInt(t.areas)} TD areas are anchored at a station; ${fmtInt(t.hints)} more are only next to a station step (hints); `
    + `${fmtInt(t.conflicts)} ${isAre(t.conflicts)} claimed by more than one station${sus}.`;
}

// ---- SUSSEX -----------------------------------------------------------------------------------------

const SUSSEX_BOX = { south: 50.72, west: -0.96, north: 51.17, east: 0.87 };

/**
 * Anchored berths whose winning station lies inside the box, by TD area, and how many of the stations
 * in the box have at least one anchor. "Winning" is the anchor table's own rule, so a station that
 * loses every conflict it is in does not count as anchored here: this is the table phase 1 will use.
 */
function analyseSussex(anchorTable, stations, box = SUSSEX_BOX) {
  const byArea = {};
  const anchoredStations = new Set();
  let anchored = 0, conflicts = 0;
  for (const a of anchorTable) {
    if (!inBox(a, box)) continue;
    anchored++;
    byArea[a.td] = (byArea[a.td] || 0) + 1;
    anchoredStations.add(a.crs);
    if (a.claims) conflicts++;
  }
  const inside = [...stations].filter(([, s]) => inBox(s, box)).map(([crs, s]) => ({ crs, name: s.name }));
  const withoutAnchor = inside.filter(s => !anchoredStations.has(s.crs)).sort((a, b) => (a.crs < b.crs ? -1 : 1));
  return {
    box, anchored, conflicts,
    byArea: Object.fromEntries(Object.entries(byArea).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))),
    stationsInBox: inside.length,
    stationsAnchored: inside.length - withoutAnchor.length,
    stationsWithoutAnchor: withoutAnchor
  };
}

function describeSussex(s) {
  const areas = Object.entries(s.byArea).map(([td, n]) => `${td} ${fmtInt(n)}`);
  return `${fmtInt(s.anchored)} anchored berths at ${fmtInt(s.stationsAnchored)} of the ${fmtInt(s.stationsInBox)} stations in the Sussex box, by TD area: ${listCap(areas, 12) || '(none)'}.`;
}

module.exports = {
  analyseSemantics, judgeSemantics,
  analyseStationResolution, judgeStationResolution,
  analyseAnchors, describeAnchors,
  analyseSussex, describeSussex, SUSSEX_BOX,
  SEMANTICS_PASS_AT, SEMANTICS_CLEAR_BY, SEMANTICS_WARN_AT, RESOLUTION_PASS_AT, RESOLUTION_WARN_AT
};
