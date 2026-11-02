'use strict';

// CORPUS: the Network Rail location reference file. Documented as
//   {"TIPLOCDATA":[{NLC, STANOX, TIPLOC, "3ALPHA", UIC, NLCDESC, NLCDESC16}, ...]}
// with a single space for a blank value. This script only needs it to turn a SMART STANOX into a
// CRS station code (3ALPHA), and a TIPLOC set for the NaPTAN cross-check.
//
// Read read-only, streamed like SMART. A STANOX can appear on several rows (several TIPLOCs share
// one timing point) and only some of those rows carry a CRS, so the index keeps every distinct CRS a
// STANOX has rather than the first one met.

const { streamRows, wrapperText } = require('./json-rows');
const { str, stanoxKey, crsKey } = require('./norm');
const { FieldStats, Counter } = require('./stats');
const { fmtInt, oneLine, listCap } = require('./format');

const WRAPPER_KEY = 'TIPLOCDATA';

class CorpusIndex {
  constructor() {
    this.stanoxToCrs = new Map();   // STANOX -> [CRS, ...] (distinct)
    this.crsToStanox = new Map();   // CRS -> [STANOX, ...] (distinct)
    this.stanoxes = new Set();      // every STANOX in the file, with a CRS or not
    this.tiplocs = new Set();       // every TIPLOC
  }
  crsForStanox(stanox) { return this.stanoxToCrs.get(stanox) || []; }
  stanoxesForCrs(crs) { return this.crsToStanox.get(crs) || []; }
  hasStanox(stanox) { return this.stanoxes.has(stanox); }
}

function addDistinct(map, key, value) {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

/** Stream CORPUS into an index. Resolves { index, facts }. */
async function loadCorpus(file, { onChunk } = {}) {
  const index = new CorpusIndex();
  const fields = new FieldStats();
  const stanoxLengths = new Counter(20);
  let withStanox = 0, withCrs = 0, withBoth = 0, oddCrs = 0;

  const scan = await streamRows(file, {
    onChunk,
    onRow(row) {
      fields.observe(row);
      const stanox = stanoxKey(row.STANOX);
      const crs = crsKey(row['3ALPHA']);
      const tiploc = str(row.TIPLOC);
      if (stanox) { withStanox++; index.stanoxes.add(stanox); stanoxLengths.add(String(str(row.STANOX).length)); }
      if (crs) withCrs++;
      else if (str(row['3ALPHA'])) oddCrs++;            // something is there, but it is not a CRS
      if (tiploc) index.tiplocs.add(tiploc);
      if (stanox && crs) {
        withBoth++;
        addDistinct(index.stanoxToCrs, stanox, crs);
        addDistinct(index.crsToStanox, crs, stanox);
      }
    }
  });

  const several = map => [...map].filter(([, v]) => v.length > 1);
  const facts = {
    rows: fields.rows,
    bad: scan.bad,
    badSamples: scan.badSamples,
    wrapper: scan.wrapper,
    endedCleanly: scan.endedCleanly,
    head: scan.head,
    compressed: scan.compressed,
    bytesOnDisk: scan.size,
    bytesUncompressed: scan.bytes,
    fields: fields.summary(),
    rowsWithStanox: withStanox,
    stanoxLengths: stanoxLengths.toObject(),
    rowsWithCrs: withCrs,
    rowsWithStanoxAndCrs: withBoth,
    rowsWithOddCrs: oddCrs,
    distinctStanox: index.stanoxes.size,
    distinctStanoxWithCrs: index.stanoxToCrs.size,
    distinctCrs: index.crsToStanox.size,
    distinctTiploc: index.tiplocs.size,
    stanoxWithSeveralCrs: several(index.stanoxToCrs).length,
    stanoxWithSeveralCrsSample: several(index.stanoxToCrs).slice(0, 5).map(([k, v]) => ({ stanox: k, crs: v })),
    crsWithSeveralStanox: several(index.crsToStanox).length,
    crsWithSeveralStanoxSample: several(index.crsToStanox).slice(0, 5).map(([k, v]) => ({ crs: k, stanox: v }))
  };
  return { index, facts };
}

/**
 * Can this CORPUS do the one job we need of it? { ok, problem }. `problem` is a sentence for the
 * STATION_RESOLUTION message when it cannot.
 */
function judgeCorpus(facts) {
  const names = listCap(facts.fields.map(f => f.name), 12) || '(none)';
  if (facts.rows === 0) {
    return { ok: false, problem: `CORPUS has no readable rows (the file starts: "${oneLine(facts.head, 60)}")` };
  }
  if (facts.rowsWithStanox === 0) {
    return { ok: false, problem: `no CORPUS row has a STANOX value, so SMART cannot be tied to stations (${fmtInt(facts.rows)} rows; fields seen: ${names})` };
  }
  if (facts.rowsWithStanoxAndCrs === 0) {
    return { ok: false, problem: `no CORPUS row has both a STANOX and a 3ALPHA (CRS) code (${fmtInt(facts.rows)} rows; fields seen: ${names})` };
  }
  return { ok: true, problem: null };
}

/** Plain-text lines for the report notes. */
function describeCorpusFacts(f) {
  const w = f.wrapper;
  const documented = w.kind === 'object-with-array' && w.key === WRAPPER_KEY;
  const lines = [
    `CORPUS: ${fmtInt(f.rows)} rows; wrapper ${wrapperText(w)}${documented ? '' : ` (documented: {"${WRAPPER_KEY}":[…]})`}; ${f.compressed ? 'gzip' : 'not gzipped'}; ${fmtInt(f.bad)} unparseable rows.`,
    `CORPUS: ${fmtInt(f.distinctStanox)} distinct STANOX (${fmtInt(f.distinctStanoxWithCrs)} with a CRS), ${fmtInt(f.distinctCrs)} distinct CRS, ${fmtInt(f.distinctTiploc)} TIPLOCs; `
      + `${fmtInt(f.stanoxWithSeveralCrs)} STANOX carry more than one CRS, ${fmtInt(f.crsWithSeveralStanox)} CRS more than one STANOX.`,
    `CORPUS STANOX widths in characters: ${JSON.stringify(f.stanoxLengths)}`,
    `CORPUS fields seen: ${f.fields.map(x => `${x.name} (${fmtInt(x.nonEmpty)} non-blank)`).join(', ')}`
  ];
  for (const s of f.stanoxWithSeveralCrsSample) lines.push(`CORPUS STANOX with several CRS: ${s.stanox} -> ${s.crs.join(', ')}`);
  for (const s of f.crsWithSeveralStanoxSample) lines.push(`CORPUS CRS with several STANOX: ${s.crs} -> ${s.stanox.join(', ')}`);
  return lines;
}

module.exports = { loadCorpus, judgeCorpus, describeCorpusFacts, CorpusIndex, WRAPPER_KEY };
