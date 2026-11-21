#!/usr/bin/env node
// area-names.js <smart-latest.json.gz> <corpus-latest.json.gz>  (copies in ~/rail-map-refdata, or NROD SupportingFileAuthenticate?type=SMART / CORPUS)
// TD area -> its most frequent SMART locations (via CORPUS STANOX names). Output JSON {area: "A, B, C"}.
const fs = require('fs'), zlib = require('zlib');
const [smartF, corpusF] = process.argv.slice(2);
const smart = JSON.parse(zlib.gunzipSync(fs.readFileSync(smartF))).BERTHDATA;
const corpus = JSON.parse(zlib.gunzipSync(fs.readFileSync(corpusF)));
const rows = corpus.TIPLOCDATA || corpus;
const name = {};
for (const r of rows) {
  const s = String(r.STANOX || '').trim(); if (!s) continue;
  const n = String(r.NLCDESC || '').trim(); if (!n) continue;
  if (!name[s] || n.length < name[s].length) name[s] = n;
}
const cnt = {};
for (const b of smart) {
  const a = b.TD, s = String(b.STANOX || '').trim(); if (!a || !s) continue;
  const n = name[s] || ('STANOX ' + s);
  (cnt[a] ||= {})[n] = (cnt[a][n] || 0) + 1;
}
const out = {};
for (const [a, m] of Object.entries(cnt))
  out[a] = Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, 4).map(x => x[0].replace(/\s+/g, ' ')).join(', ');
console.log(JSON.stringify(out, null, 1));
