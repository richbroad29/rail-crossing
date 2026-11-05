#!/usr/bin/env node
'use strict';

// A replay-based measure of the TRUST activation match, on REAL timetable and REAL TD data.
//
//   node --max-old-space-size=1536 dev/trust-match-report.js --ref-dir=DIR --td=DIR/td-2026-11-01.jsonl [--day=2026-11-01]
//
// What is real: the CIF timetable for the day (every schedule), SMART (the area <-> STANOX table),
// CORPUS (TIPLOC <-> STANOX) and a real day of TD for area LA (every train that appeared, with its
// headcode, area and first-sighting time).
// What is SYNTHESISED, because no TRUST capture was available: the activations. The model is the
// best case for TRUST: every schedule running that day is activated (uid, train_id built from its
// headcode, origin STANOX and origin departure from the timetable). That makes the test one of the
// MATCHER, not of the feed: how often does "headcode + area covers it + time window" pick the right
// schedule when the whole national population is activated, duplicate headcodes included?
//
// Three measures:
//   1. DUPLICATION in the real CIF: how many headcodes belong to more than one schedule that day, and
//      for the LA trains, how many candidates the headcode alone leaves.
//   2. AGREEMENT with the phase-1 time match: both run on every LA train at its first sighting. They
//      agree, disagree, or one finds a match the other does not. A disagreement is read, not assumed.
//   3. DECOYS: for each LA train that has a unique truth, a decoy activation is added for the same
//      headcode (a real other schedule with that headcode, else a copy under another uid) in ANOTHER
//      area or at another time; the match must still return the truth.

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { buildCifIndex } = require('../src/cif-index');
const R = require('../src/reference');
const { TrustState } = require('../src/trust');
const { dayNumOf } = require('../src/time');
const { loadConfig } = require('../src/config');
const T = require('../test/trust-helpers');

const opt = {};
for (const a of process.argv.slice(2)) { const m = /^--([a-z-]+)=(.*)$/.exec(a); if (m) opt[m[1]] = m[2]; }
if (!opt['ref-dir'] || !opt.td) { console.error('usage: trust-match-report.js --ref-dir=DIR --td=td.jsonl [--day=YYYY-MM-DD] [--area=LA]'); process.exit(2); }
const DAY = opt.day || '2026-11-01', AREA = opt.area || 'LA';
const dayNum = dayNumOf(DAY);
// train_id: 2 + headcode + 2 + day of month; the prefix and the two middle characters keep ids of one headcode distinct (a few headcodes cover over a thousand schedules).
const tid = (hc, k) => `${10 + (Math.floor(k / 1296) % 90)}${hc.padEnd(4, ' ').slice(0, 4)}${(k % 1296).toString(36).toUpperCase().padStart(2, '0')}${DAY.slice(8, 10)}`;
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : 'n/a');

(async () => {
  const t0 = Date.now();
  const [smart, corpus] = await Promise.all([R.loadSmart(path.join(opt['ref-dir'], 'smart-latest.json.gz')), R.loadCorpus(path.join(opt['ref-dir'], 'corpus-latest.json.gz'))]);
  const cif = await buildCifIndex(path.join(opt['ref-dir'], 'cif-latest.json.gz'), { dayNums: [dayNum] });
  const day = cif.days[0];
  console.error(`loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${day.count} schedules run on ${DAY}`);

  // area <-> TIPLOC (phase 1) and area <-> STANOX (TRUST)
  const areaTiplocs = new Map(), areaStanox = new Map();
  for (let r = 0; r < smart.rows; r++) {
    const sx = parseInt(smart.stanox[r], 10);
    if (!sx) continue;
    let s = areaStanox.get(smart.area[r]); if (!s) { s = new Set(); areaStanox.set(smart.area[r], s); } s.add(sx);
    let t = areaTiplocs.get(smart.area[r]); if (!t) { t = new Set(); areaTiplocs.set(smart.area[r], t); }
    for (const tl of corpus.stanoxTiplocs.get(smart.stanox[r]) || []) t.add(tl);
  }
  const stanoxOf = tl => { const c = corpus.byTiploc.get(tl); return c && c.stanox ? parseInt(c.stanox, 10) || 0 : 0; };
  const ctx = { cif, areaStanox, stanoxOf, tiplocsOfStanox: () => [], isStation: tl => !!(corpus.byTiploc.get(tl) || {}).crs };

  // 1. duplication
  let hcs = 0, dupHcs = 0, schedules = 0, inDup = 0;
  for (const list of day.byHc.values()) { hcs++; schedules += list.length; if (list.length > 1) { dupHcs++; inDup += list.length; } }

  // TD trains: first sighting per (area, headcode, train-run). A headcode seen again after 3 h is a new run.
  const trains = [];
  const last = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(opt.td), crlfDelay: Infinity });
  for await (const line of rl) {
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    if (r.area !== AREA || !r.desc || !['CA', 'CC'].includes(r.event)) continue;
    const ts = Date.parse(r.ts);
    const prev = last.get(r.desc);
    if (!prev || ts - prev.lastTs > 3 * 3600000) { const t = { hc: r.desc, first: ts, lastTs: ts }; trains.push(t); last.set(r.desc, t); } else prev.lastTs = ts;
  }
  const cfg = loadConfig({ env: {}, argv: [] }).config.trust;

  // TRUST in the best case: every schedule activated.
  const clock = { now: trains.length ? trains[0].first : Date.parse(`${DAY}T00:00:00Z`) };
  const trust = new TrustState({ config: { ...cfg, maxActivations: 200000 }, now: () => clock.now, context: () => ctx });
  const midnight = Date.UTC(+DAY.slice(0, 4), +DAY.slice(5, 7) - 1, +DAY.slice(8, 10));
  let unresolvedOrigin = 0;
  const perHc = new Map();
  let skippedHc = 0;
  for (const rec of cif.eachRec(day)) {
    if (!/^[0-9A-Z]{4}$/.test(rec.hc)) { skippedHc++; continue; }        // TRUST train_id carries exactly four headcode characters
    const p0 = cif.point(rec, 0);
    const sx = stanoxOf(p0.tiploc);
    if (!sx) unresolvedOrigin++;
    const dep = (p0.dep >= 0 ? p0.dep : p0.pass >= 0 ? p0.pass : p0.arr) * 60000;
    const kk = (perHc.get(rec.hc) || 0) + 1; perHc.set(rec.hc, kk);
    trust.activate({ train_id: tid(rec.hc, kk), train_uid: rec.uid, tp_origin_timestamp: DAY, tp_origin_stanox: String(sx || ''), origin_dep_timestamp: String(midnight + dep), schedule_type: rec.stp }, clock.now);
  }
  console.error(`activated ${trust.size} schedules (${unresolvedOrigin} with an origin STANOX unknown to CORPUS)`);

  // 2. agreement with phase 1, and 1b. how many candidates the headcode alone leaves
  const out = { day: DAY, area: AREA, tdTrains: trains.length, ambiguousByHeadcodeAlone: 0, phase1: { matched: 0, none: 0 }, trust: { matched: 0, none: 0 },
    agree: 0, disagree: 0, trustOnly: 0, phase1Only: 0, bothNone: 0, tierCounts: { 0: 0, 1: 0 } };
  const disagreements = [], phase1Only = [];
  const truthRows = [];
  for (const t of trains) {
    clock.now = t.first;
    const cands = (trust.byHc.get(t.hc) || new Set()).size;
    if (cands > 1) out.ambiguousByHeadcodeAlone++;
    const p1 = cif.match(t.hc, AREA, t.first, { areaTiplocs, window: 45 });
    const tm = trust.match(t.hc, AREA, t.first, ctx);
    if (p1) out.phase1.matched++; else out.phase1.none++;
    if (tm) { out.trust.matched++; out.tierCounts[tm.tier]++; } else out.trust.none++;
    if (p1 && tm) { if (p1.rec.uid === tm.rec.uid) out.agree++; else { out.disagree++; if (disagreements.length < 8) disagreements.push({ hc: t.hc, at: new Date(t.first).toISOString().slice(11, 16), phase1: p1.rec.uid, p1dist: +p1.dist.toFixed(1), trust: tm.rec.uid, trustDist: +tm.dist.toFixed(1), tier: tm.tier }); } }
    else if (tm) out.trustOnly++;
    else if (p1) { out.phase1Only++; if (phase1Only.length < 8) phase1Only.push({ hc: t.hc, at: new Date(t.first).toISOString().slice(11, 16), phase1: p1.rec.uid, p1dist: +p1.dist.toFixed(1) }); }
    else out.bothNone++;
    if (p1 && tm && p1.rec.uid === tm.rec.uid) truthRows.push({ t, uid: p1.rec.uid });
  }

  // 3. decoys: another activation for the same headcode in ANOTHER area (a real schedule with that headcode if the
  // CIF has one outside this area, else a copy under another uid placed at a STANOX in a different area).
  const otherArea = [...areaStanox.keys()].find(a => a !== AREA && areaStanox.get(a).size > 3);
  const farStanox = [...areaStanox.get(otherArea)][0];
  let decoyed = 0, decoyOk = 0, decoyWrong = 0, decoyNull = 0;
  const decoyTrust = new TrustState({ config: { ...cfg, maxActivations: 200000 }, now: () => clock.now, context: () => ctx });
  let k = 0;
  for (const { t, uid } of truthRows) {
    const rec = cif.find(uid, dayNum);
    const p0 = cif.point(rec, 0);
    const mk = (id, u, sx, depMin) => decoyTrust.activate({ train_id: id, train_uid: u, tp_origin_timestamp: DAY, tp_origin_stanox: String(sx), origin_dep_timestamp: String(midnight + depMin * 60000), schedule_type: 'O' }, t.first);
    // the truth, then a decoy: the same headcode, a different schedule (uid), originating in another area
    for (const a of [...decoyTrust.acts.values()]) { decoyTrust._drop(a); }
    mk(tid(t.hc, k++), uid, stanoxOf(p0.tiploc), p0.dep >= 0 ? p0.dep : p0.pass);
    const sameHcOther = (day.byHc.get(t.hc) || []).map(i => cif.scheds[i]).find(r => r.uid !== uid && !(cif.point(r, 0) && areaStanox.get(AREA).has(stanoxOf(cif.point(r, 0).tiploc))));
    mk(tid(t.hc, k++), sameHcOther ? sameHcOther.uid : `ZZ${k}`, farStanox, 600);
    clock.now = t.first; decoyed++;
    const m = decoyTrust.match(t.hc, AREA, t.first, ctx);
    if (!m) decoyNull++; else if (m.rec && m.rec.uid === uid) decoyOk++; else decoyWrong++;
  }

  const res = {
    activationsMade: trust.size, schedulesWithoutAFourCharacterHeadcode: skippedHc, activationsRejected: trust.counts.bad.toJSON(),
    cifDay: { schedules, headcodes: hcs, headcodesWithMoreThanOneSchedule: dupHcs, schedulesSharingAHeadcode: inDup, shareOfSchedulesSharing: pct(inDup, schedules) },
    ...out,
    rates: {
      trustMatched: pct(out.trust.matched, out.tdTrains), phase1Matched: pct(out.phase1.matched, out.tdTrains),
      agreementWhereBothMatch: pct(out.agree, out.agree + out.disagree), headcodeAloneAmbiguous: pct(out.ambiguousByHeadcodeAlone, out.tdTrains)
    },
    decoys: { trialsWithTruthKnown: decoyed, correct: decoyOk, wrong: decoyWrong, noMatch: decoyNull, correctRate: pct(decoyOk, decoyed), wrongRate: pct(decoyWrong, decoyed) },
    disagreements, phase1Only
  };
  console.log(JSON.stringify(res, null, 1));
  process.exit(0);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
