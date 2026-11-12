#!/usr/bin/env node
'use strict';
// A live crossing's published figures, measured from the app's own record (burger-menu ticket 12):
// the open/close events in the daily log (`cat:"state"` transitions). Rich chose this source
// knowing it is the app's modelled closures, not barrier truth.
//
//   barrier-down time  the 25th-75th percentile of closure length (CLOSED until it leaves CLOSED)
//   closures per day   the median day
//   busiest hour       the median, over days, of that day's busiest clock hour (UK time)
//
// A closure that spans a restart (`cat:"startup"`) or lasts over 30 min (a feed outage) is left out.
// Only whole UK days are counted. Prints the `presentation.figures` block for the definition.
//
// Usage (on the VPS, from ~/rail-crossing/backend):
//   node scripts/crossing-figures.js --crossing portslade --from 2026-10-15 --to 2026-11-11
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ID = val('--crossing'), FROM = val('--from'), TO = val('--to');
const DIR = val('--dir') || path.join(__dirname, '..', 'data', 'logs');
if (!ID || !FROM || !TO) { console.error('usage: --crossing <id> --from YYYY-MM-DD --to YYYY-MM-DD'); process.exit(2); }

const ukDate = d => d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });          // YYYY-MM-DD
const ukHour = d => Number(d.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }));
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };

// UTC files: a UK day can start in the previous file, so read one day either side.
const files = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
  .filter(f => { const d = f.slice(0, 10); return d >= shift(FROM, -1) && d <= shift(TO, 1); });
function shift(d, n) { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }

const lengths = [], perDay = {}, perHour = {};
let start = null, dropped = 0;
for (const f of files) {
  for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
    if (!line.includes('"cat":"state"') && !line.includes('"cat":"startup"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.cat === 'startup') { start = null; continue; }
    if (e.crossing !== ID) continue;
    const t = new Date(e.ts), day = ukDate(t);
    if (e.to === 'CLOSED') {
      start = t;
      if (day >= FROM && day <= TO) {
        perDay[day] = (perDay[day] || 0) + 1;
        const k = day + ' ' + ukHour(t); perHour[k] = (perHour[k] || 0) + 1;
      }
    } else if (e.from === 'CLOSED' && start) {
      const s = (t - start) / 1000, d0 = ukDate(start); start = null;
      if (d0 < FROM || d0 > TO) continue;
      if (s > 1800) { dropped++; continue; }
      lengths.push(s);
    }
  }
}
const days = Object.keys(perDay).sort();
if (!days.length) { console.error('no closures in that window'); process.exit(1); }
const busiest = days.map(d => Math.max(...Object.entries(perHour).filter(([k]) => k.startsWith(d + ' ')).map(([, v]) => v)));
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const out = {
  asOf: `${months[Number(TO.slice(5, 7)) - 1]} ${TO.slice(0, 4)}`,
  window: `${FROM}..${TO}`,
  closures: lengths.length,
  downP25Secs: Math.round(q(lengths, 0.25)),
  downP75Secs: Math.round(q(lengths, 0.75)),
  closuresPerDay: q(Object.values(perDay), 0.5),
  busiestHour: q(busiest, 0.5)
};
console.error(`${days.length} UK days, ${lengths.length} closures, ${dropped} over 30 min left out; per day ${Math.min(...Object.values(perDay))}-${Math.max(...Object.values(perDay))}`);
console.log(JSON.stringify(out, null, 2));
