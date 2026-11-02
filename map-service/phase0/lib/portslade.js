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

const { fmtInt, listCap } = require('./format');
const { str } = require('./norm');

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
 * @param {object} p
 * @param {Array<{compact:object, raw:object}>} p.rawKept   every SMART row in area LA, as kept by readSmart
 * @param {{stanoxesForCrs:function}} p.corpus
 * @param {object[]} p.anchorTable                            analyseAnchors' table (to check Southwick)
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

  const swkAnchors = sortBerths(anchorTable
    .filter(e => e.td === AREA && (e.crs === 'SWK' || (e.claims && 'SWK' in e.claims)))
    .map(e => e.berth));
  return {
    area: AREA, stations, knownChains: KNOWN_CHAINS,
    southwick: { expected: SOUTHWICK_BERTH, claimedBerths: swkAnchors, ok: swkAnchors.includes(SOUTHWICK_BERTH) }
  };
}

/**
 * PASS  Portslade (PLD) has rows in LA and every berth they mention is on the known chains.
 * WARN  otherwise: no PLD rows in LA (why, if it can be told), or berths outside the chains (named).
 * Southwick's berth is reported in the message but does not change the status.
 */
function judgePortslade(r) {
  const pld = r.stations.PLD;
  const swk = r.southwick.ok
    ? `Southwick (SWK) anchors berth ${r.southwick.expected} as expected.`
    : `Southwick (SWK) is NOT anchored at ${r.southwick.expected} (it anchors: ${listCap(r.southwick.claimedBerths, 8) || 'nothing in LA'}).`;

  if (pld.rows === 0) {
    let why;
    if (!pld.stanoxes.length) why = 'CORPUS gives PLD no STANOX';
    else why = `CORPUS gives PLD STANOX ${pld.stanoxes.join(', ')} but SMART has no rows for it in area ${r.area}`;
    if (pld.nameMatches && pld.nameMatches.length) {
      why += `; rows in ${r.area} with a station name like PORTSLADE do exist under STANOX ${pld.nameMatches.map(m => `${m.stanox} (${fmtInt(m.rows)})`).join(', ')}`;
    }
    return { status: 'WARN', message: `No SMART rows in area ${r.area} for Portslade (PLD): ${why}. ${swk}` };
  }
  if (pld.unexpected.length) {
    return {
      status: 'WARN',
      message: `Portslade (PLD) has ${fmtInt(pld.rows)} SMART rows in ${r.area}, but they mention berths outside the known chains: ${pld.unexpected.join(', ')} (all its berths: ${pld.berths.join(', ')}). ${swk}`
    };
  }
  return {
    status: 'PASS',
    message: `Portslade (PLD) has ${fmtInt(pld.rows)} SMART rows in ${r.area}, and every berth they mention is on the known chains (${pld.berths.join(', ') || 'none named'}). ${swk}`
  };
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
  lines.push(`Southwick: expected berth ${r.southwick.expected}; SWK claims in ${r.area}: ${r.southwick.claimedBerths.join(', ') || '(none)'} - ${r.southwick.ok ? 'as expected' : 'NOT as expected'}`);
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
