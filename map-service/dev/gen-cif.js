#!/usr/bin/env node
'use strict';

// A realistic, deterministic, FULL-SIZE synthetic CIF for memory measurement when the real file is
// not to hand (it needs NROD credentials):
//
//   node dev/gen-cif.js --out=/tmp/cif-latest.json.gz --corpus=/path/corpus-latest.json.gz [--today=25000] [--noise=40000] [--date=2026-11-02]
//
// `today` schedules run on --date (about 80% permanent, 12% with an STP overlay of the same uid, 3% with
// an STP cancel, plus a few past-midnight workings); `noise` more are valid on other dates only, to
// make the file (and the streaming parse) the size of the real one. Locations are real CORPUS TIPLOCs;
// each schedule has 12-40 points of calls and passes, times increasing, platforms on calls.

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { streamRows } = require('../src/json-rows');

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const pad = (n, w) => String(n).padStart(w, '0');
const hhmm = m => `${pad(Math.floor(m / 60) % 24, 2)}${pad(m % 60, 2)}`;

async function generate({ out, corpus, today = 25000, noise = 40000, date = '2026-11-02', seed = 7 }) {
  const rand = rng(seed);
  const tiplocs = [];
  await streamRows(corpus, { onRow(r) { const t = String(r.TIPLOC || '').trim(), s = String(r.STANOX || '').trim(); if (t && t.length <= 7 && s) tiplocs.push(t); } });
  if (tiplocs.length < 100) throw new Error('the corpus has too few TIPLOCs to build routes from');
  const pick = a => a[Math.floor(rand() * a.length)];
  const cats = ['OO', 'XX', 'EE', 'DD', 'XZ'], pwr = ['EMU', 'DMU', 'D', 'E'], tocs = ['SN', 'GW', 'SW', 'XC', 'VT', 'TL', 'LO', 'NT'];
  const dayOf = d => new Date(d + 'T00:00:00Z');
  const addDays = (d, n) => new Date(dayOf(d).getTime() + n * 86400000).toISOString().slice(0, 10);

  const locations = () => {
    const n = 12 + Math.floor(rand() * 29);
    let t = Math.floor(rand() * 1400);
    const locs = [];
    for (let i = 0; i < n; i++) {
      const tip = pick(tiplocs);
      t += 1 + Math.floor(rand() * 6);
      const type = i === 0 ? 'LO' : i === n - 1 ? 'LT' : 'LI';
      const l = { location_type: type, record_identity: type, tiploc_code: tip, tiploc_instance: null, platform: '', line: '', engineering_allowance: '', pathing_allowance: '', performance_allowance: '' };
      const calls = type !== 'LI' || rand() < 0.55;
      if (type === 'LO') { l.departure = hhmm(t); l.public_departure = hhmm(t); l.platform = String(1 + Math.floor(rand() * 8)); }
      else if (type === 'LT') { l.arrival = hhmm(t); l.public_arrival = hhmm(t); l.platform = String(1 + Math.floor(rand() * 8)); }
      else if (calls) { l.arrival = hhmm(t); l.departure = hhmm(t + 1); l.public_arrival = hhmm(t); l.public_departure = hhmm(t + 1); l.platform = String(1 + Math.floor(rand() * 8)); t += 1; }
      else { l.pass = hhmm(t); }
      locs.push(l);
    }
    return locs;
  };

  const headcode = () => `${1 + Math.floor(rand() * 9)}${String.fromCharCode(65 + Math.floor(rand() * 26))}${pad(Math.floor(rand() * 100), 2)}`;
  const record = ({ uid, stp, hc, start, end, days, locs }) => JSON.stringify({ JsonScheduleV1: {
    CIF_bank_holiday_running: null, CIF_stp_indicator: stp, CIF_train_uid: uid, applicable_timetable: 'Y', atoc_code: pick(tocs),
    new_schedule_segment: { traction_class: '', uic_code: '' }, schedule_days_runs: days, schedule_end_date: end, schedule_segment: locs ? {
      signalling_id: hc, CIF_train_category: pick(cats), CIF_headcode: '', CIF_course_indicator: 1, CIF_train_service_code: pad(Math.floor(rand() * 1e8), 8), CIF_business_sector: '??',
      CIF_power_type: pick(pwr), CIF_timing_load: pick(['377', '387', '350', '170', '66']), CIF_speed: pick(['075', '090', '100', '060']), CIF_operating_characteristics: '', CIF_train_class: '', CIF_sleepers: '', CIF_reservations: '',
      CIF_connection_indicator: '', CIF_catering_code: '', CIF_service_branding: '', schedule_location: locs } : undefined,
    schedule_start_date: start, train_status: 'P', transaction_type: 'Create' } });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const gz = zlib.createGzip(), ws = fs.createWriteStream(out);
  gz.pipe(ws);
  const done = new Promise((resolve, reject) => { ws.on('finish', resolve); ws.on('error', reject); });
  let count = 0;
  const emit = async line => { count++; if (!gz.write(line + '\n')) await new Promise(r => gz.once('drain', r)); };
  await emit('{"JsonTimetableV1":{"classification":"public","timestamp":1793000000,"owner":"Network Rail","Sender":{"organisation":"Rail Delivery Group","application":"NTROD","component":"SCHEDULE"},"Metadata":{"type":"full","sequence":1}}}');
  let uidN = 0;
  const uid = () => `${String.fromCharCode(65 + Math.floor(uidN / 100000) % 26)}${pad(uidN++ % 100000, 5)}`;
  const start = addDays(date, -60), end = addDays(date, 100);
  for (let i = 0; i < today; i++) {
    const id = uid(), hc = headcode(), locs = locations();
    await emit(record({ uid: id, stp: 'P', hc, start, end, days: '1111111', locs }));
    const r = rand();
    if (r < 0.12) await emit(record({ uid: id, stp: 'O', hc, start: date, end: date, days: '1111111', locs: locations() }));
    else if (r < 0.15) await emit(record({ uid: id, stp: 'C', hc, start: date, end: date, days: '1111111', locs: null }));
  }
  // A few past-midnight workings.
  for (let i = 0; i < 150; i++) {
    const locs = locations();
    locs[0].departure = '2345'; locs[0].public_departure = '2345';
    locs[1].arrival = '2352'; locs[1].departure = '2353'; if (locs[2]) { delete locs[2].pass; locs[2].arrival = '0004'; locs[2].departure = '0005'; }
    await emit(record({ uid: uid(), stp: 'P', hc: headcode(), start, end, days: '1111111', locs }));
  }
  for (let i = 0; i < noise; i++) {
    const s = addDays(date, 3 + Math.floor(rand() * 60));
    await emit(record({ uid: uid(), stp: rand() < 0.8 ? 'P' : 'O', hc: headcode(), start: s, end: addDays(s, Math.floor(rand() * 40)), days: rand() < 0.5 ? '0000011' : '1111100', locs: locations() }));
  }
  gz.end();
  await done;
  return { lines: count, bytes: fs.statSync(out).size };
}

if (require.main === module) {
  const o = {};
  for (const a of process.argv.slice(2)) { const m = /^--([a-z]+)=(.*)$/.exec(a); if (m) o[m[1]] = m[2]; }
  if (!o.out || !o.corpus) { console.error('usage: gen-cif.js --out=FILE --corpus=CORPUS.json.gz [--today=25000] [--noise=40000] [--date=YYYY-MM-DD]'); process.exit(2); }
  generate({ out: o.out, corpus: o.corpus, today: Number(o.today || 25000), noise: Number(o.noise || 40000), date: o.date || '2026-11-02' })
    .then(r => console.log(`wrote ${o.out}: ${r.lines} lines, ${(r.bytes / 1048576).toFixed(1)} MB gzipped`))
    .catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { generate };
