'use strict';

// Plain-text lines for the report's notes: the detail behind each one-line verdict, readable in the .txt
// report. None of it is in the paste-back block; the numbers a decision needs are in the check messages.

const { fmtInt, listCap, isAre, hasHave } = require('./format');

function semanticsNotes(r) {
  const p = r.pct;
  const lines = [
    `SMART_SEMANTICS: ${fmtInt(r.groups)} (area, STANOX, direction) groups have both an arrival and a departure, of ${fmtInt(r.groupsTotal)} groups in all `
      + `(${fmtInt(r.arrivalOnly)} arrival-only, ${fmtInt(r.departureOnly)} departure-only); ${fmtInt(r.withoutBerthData)} of the testable ones ${hasHave(r.withoutBerthData)} no berth on one side. `
      + `Rows ignored: ${fmtInt(r.ignored.unrecognisedEvent)} with an EVENT other than A/B/C/D, ${fmtInt(r.ignored.missingAreaOrStanox)} with no area or STANOX.`,
    `  our reading (arrival TOBERTH = departure FROMBERTH): exact ${fmtInt(r.ours.exact)} (${p.oursExact}%), one SMART step apart ${fmtInt(r.ours.adjacent)} (${p.oursAdjacent}%), neither ${fmtInt(r.ours.none)} (${p.oursNone}%)`,
    `  reversed reading (arrival FROMBERTH = departure TOBERTH): exact ${fmtInt(r.reversed.exact)} (${p.reversedExact}%), one step apart ${fmtInt(r.reversed.adjacent)} (${p.reversedAdjacent}%), neither ${fmtInt(r.reversed.none)} (${p.reversedNone}%)`,
    `  ours/reversed, group counts: ${JSON.stringify(r.cross)}`
  ];
  const rl = r.rowLevel;
  if (rl) {
    // The group test is "some arrival, some departure", which is lenient at a big multi-platform station; this counts every row.
    lines.push(`  by row, within those ${fmtInt(r.groups)} groups (${fmtInt(rl.arrivalRows)} arrival rows, ${fmtInt(rl.departureRows)} departure rows; exact berth match inside the group, no one-step tolerance):`,
      `    our reading: ${fmtInt(rl.ours.arrivalMatched)} arrival rows end at a berth some departure leaves from (${rl.pct.oursArrival}%); ${fmtInt(rl.ours.departureMatched)} departure rows leave from a berth some arrival ends at (${rl.pct.oursDeparture}%)`,
      `    reversed reading: ${fmtInt(rl.reversed.arrivalMatched)} arrival rows start at a berth some departure ends at (${rl.pct.reversedArrival}%); ${fmtInt(rl.reversed.departureMatched)} departure rows end at a berth some arrival starts from (${rl.pct.reversedDeparture}%)`);
  }
  for (const d of ['up', 'down']) {
    const b = r.byDirection[d];
    lines.push(`  ${d} (${d === 'up' ? 'A/B' : 'C/D'}): ${fmtInt(b.groups)} groups; ours exact ${fmtInt(b.ours.exact)}, adjacent ${fmtInt(b.ours.adjacent)}, neither ${fmtInt(b.ours.none)}; reversed exact ${fmtInt(b.reversed.exact)}`);
  }
  const areaHead = '    area  groups  ours exact  reversed exact';
  const areaLine = a => `    ${a.td.padEnd(4)} ${String(a.groups).padStart(6)}  ${String(a.oursExactPct).padStart(9)}%  ${String(a.reversedExactPct).padStart(13)}%`;
  lines.push(`  by TD area (${fmtInt(r.areas.count)} with a testable group), the biggest first:`, areaHead);
  for (const a of r.areas.biggest) lines.push(areaLine(a));
  if (r.areas.worstFitting.length) {
    lines.push('  worst-fitting areas among those with at least 5 groups:', areaHead);
    for (const a of r.areas.worstFitting) lines.push(areaLine(a));
  }
  return lines;
}

function resolutionNotes(r) {
  const lines = [
    `STATION_RESOLUTION: ${fmtInt(r.stanoxes)} SMART STANOX over ${fmtInt(r.rowsWithStanox)} rows; ${fmtInt(r.stationStanoxes)} are stations (${fmtInt(r.severalCrs)} of them with more than one CRS in CORPUS); `
      + `${fmtInt(r.nonStations)} ${isAre(r.nonStations)} not (junctions, signals, boundaries), of which ${fmtInt(r.notInCorpus)} ${isAre(r.notInCorpus)} not in CORPUS at all. `
      + `${fmtInt(r.rowsAtResolvedStations)} rows are at stations with coordinates.`
  ];
  if (r.unresolvedTop.length) {
    lines.push(`  stations with no coordinates, most SMART rows first (${r.unresolvedTop.length} of ${fmtInt(r.unresolved)}; STANOX, rows, CRS, STANME):`);
    for (const u of r.unresolvedTop) lines.push(`    ${u.stanox}  ${String(u.rows).padStart(5)} rows  ${u.crs}  "${u.name}"`);
  }
  return lines;
}

function anchorNotes(a) {
  const lines = [`ANCHORS by TD area (${fmtInt(a.totals.areas)} areas; anchors / hints / conflicts / suspicious), largest first:`];
  const areas = Object.entries(a.perArea).sort((x, y) => y[1].anchors - x[1].anchors || (x[0] < y[0] ? -1 : 1));
  for (const [td, s] of areas.slice(0, 40)) lines.push(`  ${td.padEnd(3)} ${String(s.anchors).padStart(5)} ${String(s.hints).padStart(5)} ${String(s.conflicts).padStart(4)} ${String(s.suspicious).padStart(4)}`);
  if (areas.length > 40) lines.push(`  ... and ${areas.length - 40} smaller areas (all of them are in the anchor file)`);
  lines.push(`ANCHORS rows: ${fmtInt(a.rowCounts.anchoring)} placed a berth at a station; ${fmtInt(a.rowCounts.atNonStation)} are at a timing point that is not a station; `
    + `${fmtInt(a.rowCounts.atUnplaceableStation)} at a station with no coordinates; ${fmtInt(a.rowCounts.notTimingEvent)} have an EVENT other than A/B/C/D; ${fmtInt(a.rowCounts.missingAreaOrStanox)} have no area or STANOX.`);
  const conflict = c => `${c.td} ${c.berth}  ${c.maxKm} km  ${c.claimants.map(x => `${x.crs} (${x.name}) ${x.n}`).join(' vs ')}`;
  if (a.suspiciousTop.length) {
    lines.push(`ANCHORS suspicious conflicts, claimants more than ${a.totals.suspiciousKm} km apart (top ${a.suspiciousTop.length} of ${fmtInt(a.totals.suspicious)}):`);
    for (const c of a.suspiciousTop) lines.push(`  ${conflict(c)}`);
  } else {
    lines.push(`ANCHORS: no conflict has claimants more than ${a.totals.suspiciousKm} km apart.`);
  }
  if (a.conflictsNearest.length) {
    lines.push('ANCHORS largest conflicts under the limit (neighbouring stations sharing a berth):');
    for (const c of a.conflictsNearest) lines.push(`  ${conflict(c)}`);
  }
  return lines;
}

function coverageNotes(cov, logs, tdData, area, anchoredBerths) {
  const lines = [
    `LA_COVERAGE: TD logs in ${logs.dir}: ${logs.found} file(s) found, ${logs.files.length} read (${logs.files.map(f => f.date).join(', ')}).`,
    `  ${fmtInt(tdData.lines)} lines, ${fmtInt(tdData.areaLines)} in area ${area}, ${fmtInt(tdData.bad)} unparseable (a half-written last line is normal); events ${JSON.stringify(tdData.events)}.`
  ];
  for (const f of tdData.perFile) lines.push(`  ${f.date}: ${fmtInt(f.lines)} lines${f.bad ? `, ${f.bad} unparseable` : ''}${f.error ? `, COULD NOT BE READ (${f.error})` : ''}`);
  lines.push(`  berths seen ${fmtInt(cov.berthsSeen)} (${fmtInt(tdData.stepBerths.size)} at the end of a step, ${fmtInt(cov.berthsSeen - tdData.stepBerths.size)} only via an interpose or cancel); `
    + `at 0/1/2/3 steps from an anchor: ${cov.atHop.join(' / ')}; beyond 3 or unconnected ${fmtInt(cov.beyond)}.`);
  lines.push(`  steps: ${fmtInt(cov.edges.distinct)} distinct, ${fmtInt(cov.edges.usable)} seen at least ${cov.minEdgeCount} times (used), ${fmtInt(cov.edges.seenTooFew)} seen fewer (ignored). `
    + `${fmtInt(cov.anchorsInArea)} anchors in ${area}, ${fmtInt(cov.anchorsNotSeen)} of them never seen in these logs.`);
  const sample = items => listCap([...items].sort(), 10) || '(none)';
  lines.push(`  berth id formats, for eyeballing that SMART and TD agree: ${area} anchors ${sample(anchoredBerths)}; berths in the logs ${sample(tdData.berths)}`);
  return lines;
}

function sussexNotes(s) {
  const lines = [`SUSSEX box: lat ${s.box.south} to ${s.box.north}, lon ${s.box.west} to ${s.box.east}; ${fmtInt(s.conflicts)} anchored ${s.conflicts === 1 ? 'berth' : 'berths'} in it ${isAre(s.conflicts)} claimed by more than one station.`];
  if (s.stationsWithoutAnchor.length) {
    lines.push(`SUSSEX stations in the box with no anchored berth (${s.stationsWithoutAnchor.length}): ${listCap(s.stationsWithoutAnchor.map(x => `${x.crs} ${x.name}`), 60)}`);
  }
  return lines;
}

function naptanNotes(r) {
  if (!r.ok) return [`NAPTAN_PROBE: ${r.reason}`];
  return [
    `NAPTAN_PROBE: HTTP ${r.status} from ${r.host} (${r.redirects} redirect${r.redirects === 1 ? '' : 's'}), content-type ${r.contentType || '-'}, encoding ${r.contentEncoding || 'none'}, ${fmtInt(r.bytes)} bytes, ${r.seconds} s.`,
    `NAPTAN_PROBE header (${r.header.length}): ${r.header.join(', ')}`,
    `NAPTAN_PROBE ATCOCode prefixes: ${JSON.stringify(r.prefixes)}; StopType among 9100 rows: ${JSON.stringify(r.stopTypes)}; ${fmtInt(r.ragged)} rows with the wrong number of columns.`,
    ...r.sample.map(s => `NAPTAN_PROBE sample: ${JSON.stringify(s)}`)
  ];
}

module.exports = { semanticsNotes, resolutionNotes, anchorNotes, coverageNotes, sussexNotes, naptanNotes };
