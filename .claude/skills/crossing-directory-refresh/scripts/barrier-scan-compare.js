#!/usr/bin/env node
// barrier-scan-compare.js <previous scan> <this scan> <sclass.json> <area-names.json>
// Compare two barrier-bit-scan outputs: per area, candidate BYTES (a byte with >=1 candidate pair) now vs before.
const fs = require('fs');
const [prevF, curF, cfgF, namesF] = process.argv.slice(2);
const parse = f => fs.readFileSync(f, 'utf8').split('\n').filter(l => /^[A-Z0-9]{2}\s+[0-9A-F]{2}\s/.test(l) && /\bYES\b/.test(l))
  .map(l => { const p = l.trim().split(/\s+/); return { area: p[0], byte: p[1], up: +p[2], down: +p[3], perDay: +p[4], lower: +p[5], closed: +p[6], raise: +p[7] }; });
const prev = parse(prevF), cur = parse(curF);
const collected = new Set(Object.keys(JSON.parse(fs.readFileSync(cfgF, 'utf8')).areas));
const names = JSON.parse(fs.readFileSync(namesF, 'utf8'));
const byArea = rows => { const m = {}; for (const r of rows) { const a = (m[r.area] ||= {}); const k = r.byte; if (!a[k] || a[k].perDay < r.perDay) a[k] = r; } return m; };
const P = byArea(prev), C = byArea(cur);
const areas = [...new Set([...Object.keys(P), ...Object.keys(C)])].sort();
console.log(`pairs: before ${prev.length}, now ${cur.length}; bytes: before ${Object.values(P).reduce((s, a) => s + Object.keys(a).length, 0)}, now ${Object.values(C).reduce((s, a) => s + Object.keys(a).length, 0)}`);
console.log('\n== Collected areas (in sclass.json): candidate bytes before -> now ==');
for (const a of areas.filter(a => collected.has(a))) {
  const pb = new Set(Object.keys(P[a] || {})), cb = new Set(Object.keys(C[a] || {}));
  const gained = [...cb].filter(b => !pb.has(b)), lost = [...pb].filter(b => !cb.has(b));
  console.log(`${a}  ${pb.size} -> ${cb.size}${gained.length ? '  +' + gained.join(',') : ''}${lost.length ? '  -' + lost.join(',') : ''}   (${names[a] || '?'})`);
}
const fresh = areas.filter(a => !collected.has(a) && C[a]);
console.log(`\n== NEW areas (not collected) with candidates: ${fresh.length} ==`);
const rowsNew = fresh.map(a => ({ a, bytes: Object.values(C[a]).sort((x, y) => y.perDay - x.perDay) }))
  .sort((x, y) => y.bytes.length - x.bytes.length || y.bytes[0].perDay - x.bytes[0].perDay);
for (const { a, bytes } of rowsNew)
  console.log(`${a}  ${String(bytes.length).padStart(2)} byte(s)  busiest ${bytes[0].byte} ${bytes[0].perDay.toFixed(1)}/day (lower ${bytes[0].lower}s, closed ${bytes[0].closed}s)   ${names[a] || '?'}`);
console.log('\nnew-area bytes total:', rowsNew.reduce((s, x) => s + x.bytes.length, 0));
