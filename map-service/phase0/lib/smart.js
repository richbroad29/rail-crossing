'use strict';

// Reading the SMART file: what it actually looks like (format facts), and its rows in a compact form
// for the analyses. The documented format is {"BERTHDATA":[{TD, FROMBERTH, TOBERTH, FROMLINE, TOLINE,
// BERTHOFFSET, PLATFORM, EVENT, ROUTE, STANOX, STANME, STEPTYPE, COMMENT}, ...]}. Nothing here assumes
// it: every assumption is turned into a number in the facts, and `judgeSmartFormat` compares them with
// the documentation.

const { streamRows, wrapperText } = require('./json-rows');
const { str, stanoxKey, areaKey, classifyEvent } = require('./norm');
const { Counter, NumberHistogram, FieldStats } = require('./stats');
const { fmtInt, fmtPct, pct, oneLine, listCap } = require('./format');

const WRAPPER_KEY = 'BERTHDATA';
const EXPECTED_FIELDS = ['TD', 'FROMBERTH', 'TOBERTH', 'FROMLINE', 'TOLINE', 'BERTHOFFSET', 'PLATFORM', 'EVENT', 'ROUTE', 'STANOX', 'STANME', 'STEPTYPE', 'COMMENT'];
// The fields every analysis in this script leans on. If these are not there, nothing else is meaningful.
const CORE_FIELDS = ['TD', 'FROMBERTH', 'TOBERTH', 'STANOX', 'EVENT'];
const PRESENT_THRESHOLD = 0.99;        // an expected field must exist on at least this share of rows
const CORE_FAIL_BELOW = 0.5;           // a core field on fewer rows than this means it is not SMART
const BAD_ROW_WARN_ABOVE = 0.01;       // more than this share of unparseable rows is worth a WARN
const NUMERIC = /^[+-]?\d+(\.\d+)?$/;

class SmartFacts {
  constructor() {
    this.fields = new FieldStats();
    this.events = new Counter();
    this.stepTypes = new Counter();
    this.areas = new Counter(1000);
    this.stanoxLengths = new Counter(20);          // how wide the STANOX values are: a join against CORPUS depends on it
    this.offsets = {};
    for (const k of ['arrival', 'departure', 'other']) this.offsets[k] = { hist: new NumberHistogram(), nonNumeric: 0, empty: 0 };
  }

  observe(row) {
    this.fields.observe(row);
    const event = str(row.EVENT);
    this.events.add(event);
    this.stepTypes.add(str(row.STEPTYPE));
    this.areas.add(areaKey(row.TD));
    this.stanoxLengths.add(String(str(row.STANOX).length));
    const cls = classifyEvent(event.toUpperCase());
    const bucket = this.offsets[cls ? cls.kind : 'other'];
    const raw = str(row.BERTHOFFSET);
    if (raw === '') bucket.empty++;
    else if (NUMERIC.test(raw)) bucket.hist.add(Number(raw));
    else bucket.nonNumeric++;
  }

  /** @param {object} scan the summary returned by streamRows */
  finish(scan) {
    const rows = this.fields.rows;
    const fields = this.fields.summary();
    const byName = new Map(fields.map(f => [f.name, f]));
    const presentPct = {};
    for (const name of EXPECTED_FIELDS) presentPct[name] = byName.has(name) ? pct(byName.get(name).present, rows) : 0;
    const populated = {};
    for (const name of ['PLATFORM', 'FROMLINE', 'TOLINE']) {
      const f = byName.get(name);
      populated[name] = { rows: f ? f.nonEmpty : 0, pct: f ? pct(f.nonEmpty, rows) : 0 };
    }
    const offsets = {};
    for (const [k, v] of Object.entries(this.offsets)) offsets[k] = { ...v.hist.summary(), nonNumeric: v.nonNumeric, empty: v.empty };

    return {
      rows,
      bad: scan.bad,
      badSamples: scan.badSamples,
      wrapper: scan.wrapper,
      endedCleanly: scan.endedCleanly,
      head: scan.head,
      tail: scan.tail,
      compressed: scan.compressed,
      bytesOnDisk: scan.size,
      bytesUncompressed: scan.bytes,
      fields,
      presentPct,
      populated,
      events: this.events.toObject(),
      stepTypes: this.stepTypes.toObject(),
      offsets,
      stanoxLengths: this.stanoxLengths.toObject(),
      tdAreas: this.areas.counts.size + (this.areas.overflow ? 1 : 0),
      tdAreaCodes: [...this.areas.counts.keys()].sort()
    };
  }
}

/**
 * The compact form the analyses use. Strings are interned through `intern`, so the few thousand
 * distinct berths and STANOXes are stored once however many rows mention them.
 */
function compactRow(row, intern = s => s) {
  return {
    td: intern(areaKey(row.TD)),
    from: intern(str(row.FROMBERTH)),
    to: intern(str(row.TOBERTH)),
    stanox: intern(stanoxKey(row.STANOX)),
    event: intern(str(row.EVENT).toUpperCase())
  };
}

/**
 * Stream a SMART file. Resolves { rows, stanoxInfo, facts, rawKept }:
 *   rows        compact rows, every one that parsed
 *   stanoxInfo  Map STANOX -> { rows, name }  (name: the first non-blank STANME seen)
 *   facts       see SmartFacts.finish
 *   rawKept     the original objects of rows for which keepRaw(compactRow) is true (the Portslade print)
 */
async function readSmart(file, { keepRaw = () => false, onChunk } = {}) {
  const facts = new SmartFacts();
  const pool = new Map();
  const intern = s => { const e = pool.get(s); if (e !== undefined) return e; pool.set(s, s); return s; };
  const rows = [];
  const rawKept = [];
  const stanoxInfo = new Map();

  const scan = await streamRows(file, {
    onChunk,
    onRow(row) {
      facts.observe(row);
      const c = compactRow(row, intern);
      rows.push(c);
      if (keepRaw(c)) rawKept.push({ compact: c, raw: row });
      if (c.stanox) {
        let info = stanoxInfo.get(c.stanox);
        if (!info) { info = { rows: 0, name: '' }; stanoxInfo.set(c.stanox, info); }
        info.rows++;
        if (!info.name) info.name = str(row.STANME);
      }
    }
  });
  return { rows, stanoxInfo, rawKept, facts: facts.finish(scan) };
}

/**
 * SMART_FORMAT: does the file read the way the documentation says?
 *   PASS  rows parse, the wrapper is {"BERTHDATA":[…]}, every expected field exists on >= 99% of rows,
 *         the document is complete, and fewer than 1% of rows failed to parse.
 *   WARN  rows parse but something differs (named in the message).
 *   FAIL  no rows parse, or the rows do not look like SMART at all (a core field on under half of them).
 * @returns {{ status: string, message: string }}
 */
function judgeSmartFormat(f) {
  const names = listCap(f.fields.map(x => x.name), 20) || '(none)';
  if (f.rows === 0) {
    return {
      status: 'FAIL',
      message: `No SMART rows could be read (0 rows parsed${f.bad ? `, ${fmtInt(f.bad)} unparseable` : ''}); the file starts: "${oneLine(f.head, 70)}"`
    };
  }

  const coreMissing = CORE_FIELDS.filter(n => f.presentPct[n] < CORE_FAIL_BELOW * 100);
  if (coreMissing.length) {
    return {
      status: 'FAIL',
      message: `${fmtInt(f.rows)} rows parse but they do not look like SMART: ${coreMissing.join(', ')} missing from most rows. Fields seen: ${names}`
    };
  }

  const problems = [];
  const w = f.wrapper;
  if (!(w.kind === 'object-with-array' && w.key === WRAPPER_KEY)) {
    problems.push(`the wrapper is ${wrapperText(w)} not {"${WRAPPER_KEY}":[…]}`);
  }
  const short = EXPECTED_FIELDS.filter(n => f.presentPct[n] < PRESENT_THRESHOLD * 100);
  if (short.length) {
    problems.push(`expected fields missing on more than 1% of rows: ${short.map(n => `${n} (missing on ${(100 - f.presentPct[n]).toFixed(1)}%)`).join(', ')}`);
  }
  const attempted = f.rows + f.bad;
  if (f.bad / attempted > BAD_ROW_WARN_ABOVE) {
    problems.push(`${fmtInt(f.bad)} of ${fmtInt(attempted)} rows (${fmtPct(f.bad, attempted)}) failed to parse`);
  }
  if (!f.endedCleanly) problems.push('the file ends inside the document (truncated?)');

  const extra = f.fields.map(x => x.name).filter(n => !EXPECTED_FIELDS.includes(n));
  const extraText = extra.length ? ` Extra fields: ${listCap(extra, 8)}.` : '';
  const badText = f.bad ? ` ${fmtInt(f.bad)} unparseable ${f.bad === 1 ? 'row' : 'rows'} skipped.` : '';

  if (problems.length) {
    return {
      status: 'WARN',
      message: `SMART rows parse (${fmtInt(f.rows)}) but differ from the documentation: ${problems.join('; ')}. Fields seen: ${names}.${extraText}`
    };
  }
  return {
    status: 'PASS',
    message: `SMART reads as documented: ${fmtInt(f.rows)} rows inside ${wrapperText(w)}; fields: ${names}.${extraText}${badText}`
  };
}

/** Plain-text lines describing the format facts, for the report's notes. */
function describeSmartFacts(f) {
  const lines = [];
  lines.push(`SMART: ${fmtInt(f.rows)} rows; wrapper ${wrapperText(f.wrapper)}; ${f.compressed ? 'gzip' : 'not gzipped'}; `
    + `${fmtInt(f.bytesOnDisk)} bytes on disk, ${fmtInt(f.bytesUncompressed)} bytes of JSON; ${fmtInt(f.bad)} unparseable rows; `
    + `${f.endedCleanly ? 'document complete' : 'DOCUMENT ENDS INSIDE ITSELF (truncated?)'}.`);
  lines.push(`SMART file starts: ${oneLine(f.head, 160)}`);
  lines.push(`SMART file ends:   ${oneLine(f.tail, 100)}`);
  for (const s of f.badSamples) lines.push(`SMART unparseable row: ${s.reason}: ${oneLine(s.sample, 100)}`);
  lines.push('SMART field presence (rows with the key / rows with a non-blank value):');
  for (const x of f.fields) lines.push(`  ${x.name.padEnd(12)} ${fmtInt(x.present).padStart(9)} (${fmtPct(x.present, f.rows).padStart(6)})  /  ${fmtInt(x.nonEmpty).padStart(9)} (${fmtPct(x.nonEmpty, f.rows).padStart(6)})`);
  lines.push(`SMART EVENT values: ${JSON.stringify(f.events)}`);
  lines.push(`SMART STEPTYPE values: ${JSON.stringify(f.stepTypes)}`);
  lines.push('SMART BERTHOFFSET in seconds (arrival = EVENT A/C, departure = B/D, other = any other EVENT):');
  for (const k of ['arrival', 'departure', 'other']) {
    const o = f.offsets[k];
    const dist = o.count ? `n=${fmtInt(o.count)} min=${o.min} p10=${o.p10} median=${o.median} p90=${o.p90} max=${o.max}` : 'no numeric values';
    lines.push(`  ${k.padEnd(9)} ${dist}; non-numeric ${fmtInt(o.nonNumeric)}, blank ${fmtInt(o.empty)}`);
  }
  lines.push(`SMART STANOX widths in characters (0 = blank): ${JSON.stringify(f.stanoxLengths)}`);
  lines.push(`SMART populated: PLATFORM ${f.populated.PLATFORM.pct}%, FROMLINE ${f.populated.FROMLINE.pct}%, TOLINE ${f.populated.TOLINE.pct}%`);
  lines.push(`SMART TD areas (${f.tdAreas}): ${listCap(f.tdAreaCodes, 80)}`);
  return lines;
}

module.exports = {
  readSmart, compactRow, SmartFacts, judgeSmartFormat, describeSmartFacts,
  EXPECTED_FIELDS, CORE_FIELDS, WRAPPER_KEY
};
