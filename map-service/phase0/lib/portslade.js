'use strict';

// PORTSLADE_KNOWN_ANSWER: compare what SMART says about the Portslade stretch of TD area LA with what
// this project has already verified on the real feed.
//
// The known answers (CLAUDE.md, "TD berth mappings"; both verified on live TD):
//   eastbound berth chain  0016 > 0014 > 0012 > 0010 > 0008 > 0006 > 0004 > 0002
//   westbound berth chain  T682 > T677 > 0001 > 0003 > 0005 > 0007
//   Southwick (SWK, TIPLOC STHWICK) sits inside berth 0006
// Portslade is CRS PLD (TIPLOC PSLDAWH); its neighbours are Fishersgate FSG, Aldrington AGT, Hove HOV and
// Shoreham-by-Sea SSE.
//
// Rows are found by STANOX: CORPUS lists which STANOX a CRS has. If that finds nothing for a station,
// rows in LA whose STANME contains the station's name are reported instead, so a CORPUS/SMART STANOX
// mismatch is visible as such rather than looking like "SMART has nothing for Portslade".
//
// Southwick is the sharpest independent test of the reading that the project has (callers spend a median
// 160 s in berth 0006, non-callers 49 s), so it counts towards the verdict: see `analyseSouthwick`.

const { fmtInt, listCap } = require('./format');
const { str, classifyEvent } = require('./norm');

const AREA = 'LA';
const KNOWN_CHAINS = {
  east: ['0016', '0014', '0012', '0010', '0008', '0006', '0004', '0002'],
  west: ['T682', 'T677', '0001', '0003', '0005', '0007']
};
const KNOWN_BERTHS = new Set([...KNOWN_CHAINS.east, ...KNOWN_CHAINS.west]);
const SOUTHWICK_BERTH = '0006';
const TARGETS = [
  { crs: 'PLD', name: 'Portslade', nameHint: 'PORTSLADE' },
  { crs: 'SWK', name: 'Southwick', nameHint: 'SOUTHWICK' },
  { crs: 'FSG', name: 'Fishersgate', nameHint: 'FISHERSGATE' },
  { crs: 'AGT', name: 'Aldrington', nameHint: 'ALDRINGTON' },
  { crs: 'HOV', name: 'Hove', nameHint: 'HOVE' },
  { crs: 'SSE', name: 'Shoreham-by-Sea', nameHint: 'SHOREHAM' }
];
const EVENT_NAMES = { A: 'arrive up', B: 'depart up', C: 'arrive down', D: 'depart down' };

const sortBerths = list => [...list].sort();

/**
 * Southwick (SWK) sits inside LA berth 0006. Under our reading an ARRIVAL puts the station at its TOBERTH, so
 * if SMART has arrival rows for Southwick in LA, at least one of them should end at 0006.
 *
 *   confirmed     some arrival row (EVENT A or C) has TOBERTH 0006
 *   contradicted  there are arrival rows and none has TOBERTH 0006
 *   no-arrivals   there are SMART rows for it in LA but none is an arrival, so the arrival test cannot be made
 *   absent        no SMART rows for it in LA at all (it may simply have none)
 *
 * Up and down (A/B and C/D) are not mapped to east and west anywhere here: an arrival counts whichever of A
 * and C it is. The berths it does use are reported either way (arrival TOBERTHs, departure FROMBERTHs), taken
 * from its own rows rather than from the anchor table, so a conflict elsewhere cannot change the answer.
 * `claimedBerths` is the anchor table's view of the same station, kept for the notes.
 */
function analyseSouthwick(swk, anchorTable) {
  const kindOf = r => (classifyEvent(r.compact.event) || {}).kind;
  const arrivals = swk.rowsDetail.filter(r => kindOf(r) === 'arrival');
  const departures = swk.rowsDetail.filter(r => kindOf(r) === 'departure');
  const berths = (rows, field) => sortBerths(new Set(rows.map(r => r.compact[field]).filter(Boolean)));
  const arrivalTo = berths(arrivals, 'to');
  const departureFrom = berths(departures, 'from');

  let outcome;
  if (swk.rows === 0) outcome = 'absent';
  else if (arrivals.length === 0) outcome = 'no-arrivals';
  else outcome = arrivalTo.includes(SOUTHWICK_BERTH) ? 'confirmed' : 'contradicted';

  const claimedBerths = sortBerths(anchorTable
    .filter(e => e.td === AREA && (e.crs === 'SWK' || (e.claims && 'SWK' in e.claims)))
    .map(e => e.berth));
  return {
    expected: SOUTHWICK_BERTH, outcome,
    stanoxes: swk.stanoxes, rows: swk.rows, arrivalRows: arrivals.length, departureRows: departures.length,
    arrivalTo, departureFrom, nameMatches: swk.nameMatches || [], claimedBerths
  };
}

/**
 * @param {object} p
 * @param {Array<{compact:object, raw:object}>} p.rawKept   every SMART row in area LA, as kept by readSmart
 * @param {{stanoxesForCrs:function}} p.corpus
 * @param {object[]} p.anchorTable                            analyseAnchors' table (for the Southwick notes)
 */
function analysePortslade({ rawKept, corpus, anchorTable }) {
  const la = rawKept.filter(r => r.compact.td === AREA);
  const stations = {};
  for (const t of TARGETS) {
    const stanoxes = corpus.stanoxesForCrs(t.crs);
    const rows = la.filter(r => stanoxes.includes(r.compact.stanox));
    const berths = new Set();
    for (const r of rows) { if (r.compact.from) berths.add(r.compact.from); if (r.compact.to) berths.add(r.compact.to); }
    const entry = {
      crs: t.crs, name: t.name, stanoxes, rows: rows.length,
      berths: sortBerths(berths),
      unexpected: sortBerths([...berths].filter(b => !KNOWN_BERTHS.has(b))),
      rowsDetail: rows
    };
    if (!rows.length) {
      // Fall back to the station's name so a STANOX mismatch is distinguishable from "no rows".
      const byName = new Map();
      for (const r of la) {
        if (str(r.raw.STANME).toUpperCase().includes(t.nameHint)) byName.set(r.compact.stanox, (byName.get(r.compact.stanox) || 0) + 1);
      }
      entry.nameMatches = [...byName].map(([stanox, n]) => ({ stanox, rows: n }));
    }
    stations[t.crs] = entry;
  }

  return {
    area: AREA, stations, knownChains: KNOWN_CHAINS,
    southwick: analyseSouthwick(stations.SWK, anchorTable)
  };
}

/** The Portslade half of the verdict: { status, text }. */
function judgePortsladeStation(r) {
  const pld = r.stations.PLD;
  if (pld.rows === 0) {
    let why;
    if (!pld.stanoxes.length) why = 'CORPUS gives PLD no STANOX';
    else why = `CORPUS gives PLD STANOX ${pld.stanoxes.join(', ')} but SMART has no rows for it in area ${r.area}`;
    if (pld.nameMatches && pld.nameMatches.length) {
      why += `; rows in ${r.area} with a station name like PORTSLADE do exist under STANOX ${pld.nameMatches.map(m => `${m.stanox} (${fmtInt(m.rows)})`).join(', ')}`;
    }
    return { status: 'WARN', text: `No SMART rows in area ${r.area} for Portslade (PLD): ${why}.` };
  }
  if (pld.unexpected.length) {
    return {
      status: 'WARN',
      text: `Portslade (PLD) has ${fmtInt(pld.rows)} SMART rows in ${r.area}, but they mention berths outside the known chains: ${pld.unexpected.join(', ')} (all its berths: ${pld.berths.join(', ')}).`
    };
  }
  return {
    status: 'PASS',
    text: `Portslade (PLD) has ${fmtInt(pld.rows)} SMART rows in ${r.area}, and every berth they mention is on the known chains (${pld.berths.join(', ') || 'none named'}).`
  };
}

/** The Southwick half of the verdict: { warn, text }. Only `contradicted` warns; the rest say plainly what could not be tested. */
function judgeSouthwick(sw, area) {
  const b = sw.expected;
  const nameMatch = sw.nameMatches.length
    ? ` Rows in ${area} with a station name like SOUTHWICK do exist under STANOX ${sw.nameMatches.map(m => `${m.stanox} (${fmtInt(m.rows)})`).join(', ')}.`
    : '';
  const leaves = sw.departureFrom.length ? ` (its departures leave from ${listCap(sw.departureFrom, 8)})` : '';
  switch (sw.outcome) {
    case 'confirmed':
      return { warn: false, text: `Southwick (SWK) arrives into berth ${b} as expected.` };
    case 'contradicted': {
      const ends = sw.arrivalTo.length ? `arrivals end at ${listCap(sw.arrivalTo, 8)}` : 'its arrivals name no TOBERTH';
      const dep = sw.departureFrom.length ? `; departures leave from ${listCap(sw.departureFrom, 8)}` : '';
      const only = sw.arrivalRows === 1;
      return {
        warn: true,
        text: `Southwick (SWK) is known to sit in berth ${b}, but ${only ? 'its only arrival row' : `none of its ${fmtInt(sw.arrivalRows)} arrival rows`} in ${area} ${only ? 'does not end' : 'ends'} there (${ends}${dep}).`
      };
    }
    case 'no-arrivals':
      return {
        warn: false,
        text: `Southwick (SWK) has ${fmtInt(sw.rows)} SMART ${sw.rows === 1 ? 'row' : 'rows'} in ${area} but no arrival rows (EVENT A or C), so the arrival check against berth ${b} could not be made${leaves}.`
      };
    default:                                               // absent
      return {
        warn: false,
        text: !sw.stanoxes.length
          ? `Southwick (SWK) could not be checked against berth ${b}: CORPUS gives SWK no STANOX, so no SMART rows could be found for it.${nameMatch}`
          : `Southwick (SWK) has no SMART rows in area ${area}, so berth ${b} could not be checked (it may simply have none).${nameMatch}`
      };
  }
}

/**
 * PASS  Portslade (PLD) has rows in LA, every berth they mention is on the known chains, and Southwick is not
 *       contradicted.
 * WARN  otherwise: no PLD rows in LA (why, if it can be told); berths outside the chains (named); or Southwick
 *       has arrival rows in LA and none of them ends at 0006 (the berths it does use are named).
 * Southwick with no LA rows at all, or with rows but no arrivals, leaves the status as it was and says so in
 * the message.
 */
function judgePortslade(r) {
  const pld = judgePortsladeStation(r);
  const swk = judgeSouthwick(r.southwick, r.area);
  return { status: pld.status === 'PASS' && !swk.warn ? 'PASS' : 'WARN', message: `${pld.text} ${swk.text}` };
}

function berthText(b) { return b === '' ? '-' : (KNOWN_BERTHS.has(b) ? b : `${b}?`); }

/** One line per SMART row of each of the six stations, for the report notes. `?` marks a berth outside the known chains. */
function describePortslade(r) {
  const lines = [`Portslade known answer (area ${r.area}); "?" after a berth means it is not on the known chains: east ${r.knownChains.east.join(' > ')}; west ${r.knownChains.west.join(' > ')}`];
  for (const t of TARGETS) {
    const s = r.stations[t.crs];
    lines.push(`${t.crs} ${t.name}: STANOX ${s.stanoxes.join(', ') || '(none in CORPUS)'}; ${fmtInt(s.rows)} rows in ${r.area}; berths: ${s.berths.join(', ') || '-'}${s.unexpected.length ? `; outside the chains: ${s.unexpected.join(', ')}` : ''}`);
    for (const { compact: c, raw } of s.rowsDetail) {
      const ev = EVENT_NAMES[c.event] || `event ${c.event || '(blank)'}`;
      lines.push(`  ${t.crs}  ${berthText(c.from)} > ${berthText(c.to)}  ${c.event || '?'} (${ev})  offset ${str(raw.BERTHOFFSET) || '-'}s  platform ${str(raw.PLATFORM) || '-'}  `
        + `line ${str(raw.FROMLINE) || '-'}>${str(raw.TOLINE) || '-'}  steptype ${str(raw.STEPTYPE) || '-'}  route ${str(raw.ROUTE) || '-'}  STANME "${str(raw.STANME)}"  comment "${str(raw.COMMENT)}"`);
    }
    if (s.nameMatches && s.nameMatches.length) {
      lines.push(`  ${t.crs}: no rows by STANOX, but STANME matches ${t.nameHint} under STANOX ${s.nameMatches.map(m => `${m.stanox} (${m.rows})`).join(', ')}`);
    }
  }
  const sw = r.southwick;
  const outcome = {
    confirmed: `CONFIRMED (an arrival row ends at ${sw.expected})`,
    contradicted: `CONTRADICTED (arrival rows exist and none ends at ${sw.expected})`,
    'no-arrivals': 'not testable (no arrival rows)',
    absent: `not testable (no SMART rows for Southwick in ${r.area})`
  }[sw.outcome];
  lines.push(`Southwick: expected berth ${sw.expected}. Rows in ${r.area}: ${fmtInt(sw.rows)} (${fmtInt(sw.arrivalRows)} arrival, ${fmtInt(sw.departureRows)} departure); `
    + `arrivals end at ${sw.arrivalTo.join(', ') || '-'}; departures leave from ${sw.departureFrom.join(', ') || '-'}. Result: ${outcome}.`);
  lines.push(`Southwick in the anchor table: SWK claims ${r.area} berths ${sw.claimedBerths.join(', ') || '(none)'}.`);
  return lines;
}

/** The result without the raw rows (those go in the notes), for the report's JSON data. */
function portsladeData(r) {
  const stations = {};
  for (const [crs, s] of Object.entries(r.stations)) {
    stations[crs] = { ...s };
    delete stations[crs].rowsDetail;
  }
  return { ...r, stations };
}

module.exports = { analysePortslade, judgePortslade, describePortslade, portsladeData, KNOWN_CHAINS, KNOWN_BERTHS, TARGETS, AREA };
