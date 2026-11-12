#!/usr/bin/env node
'use strict';
// Checks shared/finder.js against the burger-menu map's Search matching rules (ticket 06), on
// the real shared/directory.json. Run from the repo root: node scripts/finder-test.js
const fs = require('fs');
const path = require('path');
const F = require('../shared/finder.js');

const dir = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'directory.json'), 'utf8'));
F.use(dir.crossings);

let pass = 0, fail = 0;
function check(label, got, want) {
  if (got === want) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:      ${got}\n          expected: ${want}`); }
}
const names = q => F.search(q).hits.map(h => h.e.name);
const first = q => (F.search(q).hits[0] || {}).e;
const has = (q, n) => F.search(q).hits.some(h => h.e.n === n);

console.log('\nfinder: search rules (ticket 06)\n');
// 1. every word must start a word, any order
check('"boundary portslade" finds Portslade', has('boundary portslade', 1950), true);
check('"portslade boundary" (any order) finds Portslade', has('portslade boundary', 1950), true);
check('"lade" (not a word start) does not find Portslade', has('lade', 1950), false);
check('"port" (word start) finds Portslade', has('port', 1950), true);
// 2. case, accents, apostrophes, hyphens, & = and
check('"KINGS LYNN" finds crossings in King\'s Lynn', F.search('KINGS LYNN').hits.length > 0, true);
check('"clacton on sea" (hyphens ignored)', F.search('clacton on sea').hits.length > 0 || F.search('clacton').hits.length === 0, true);
check('"&" means "and"', F._norm('Boston & Spilsby'), 'boston and spilsby');
check('accents ignored', F._norm('Ynys Môn'), 'ynys mon');
// 3. level / crossing / railway / rail are dropped
check('"portslade level crossing" finds Portslade', has('portslade level crossing', 1950), true);
check('"rail crossing" alone finds nothing (all words dropped)', F.search('rail crossing').hits.length, 0);
// 4. rd / ln / st, both ways
check('"boundary rd" finds Portslade', has('boundary rd', 1950), true);
check('"station rd" finds roads called Station Road', F.search('station rd').hits.some(h => /Station Road/.test(h.e.road || '')), true);
check('"st" matches Street', F.search('high st').hits.some(h => /High Street/.test(h.e.road || '')), true);
// road number and Welsh road name count as the road
check('"B2194" (road number) finds Portslade', has('b2194', 1950), true);
check('"heol yr orsaf" (Welsh road name) finds something', F.search('heol yr orsaf').hits.length > 0, true);
// counties and country
check('"brighton" (council) finds Portslade', has('brighton', 1950), true);
check('"east sussex" (county) finds Portslade', has('east sussex', 1950), true);
// 5. typo retry only when nothing matches
const t = F.search('portslde');
check('"portslde" (typo) finds Portslade on retry', t.hits.some(h => h.e.n === 1950), true);
check('  ... and says it is a close spelling', t.typo, true);
check('"port" (exact hits exist) is not a typo search', F.search('port').typo, false);
check('one-letter edit, 4-letter word: no typo retry', F.search('lewe').typo, false);
// 6. two-character minimum
check('one character: no results', F.search('p').hits.length, 0);
check('two characters: results', F.search('po').hits.length > 0, true);
// ordering: live first, then name/town, road, county/country
check('live crossing first for "portslade"', first('portslade').id, 'portslade');
check('live crossing first for "sussex"', first('sussex').id, 'portslade');
const st = F.search('station').hits;
const g = st.filter(h => !h.e.id).map(h => h.group);
check('groups never go backwards (name/town, road, county)', g.every((x, i) => i === 0 || g[i - 1] <= x), true);
// closest first within a group when location is known
const here = { lat: 50.8372, lon: -0.2021 };
const near = F.search('station', { here }).hits.filter(h => !h.e.id && h.group === 1);
check('with location: closest first within a group', near.every((h, i) => i === 0 || near[i - 1].d <= h.d), true);
// nearest
const n3 = F.nearest(here, 3);
check('nearest: 3 results', n3.top.length, 3);
check('nearest from Portslade: Portslade is first', n3.top[0].e.n, 1950);
check('nearest: no "nearest live" when one of the 3 is live', n3.nearestLive, null);
const far = F.nearest({ lat: 57.48, lon: -4.22 }, 3);   // Inverness
check('nearest from Inverness: none live, so a nearest live crossing', far.nearestLive && far.nearestLive.e.id, 'portslade');
check('miles Portslade to Inverness about 487 (worked by hand: 459 mi north, 163 mi west)', Math.abs(far.nearestLive.d - 487) < 3, true);
// request link
const soon = F.byNumber(2624);
check('request link pre-fills town and road', F.requestUrl(soon).includes('entry.310342749=Acton') && F.requestUrl(soon).includes('entry.330374812=East%20Churchfield'), true);
check('live crossing links to its page', F.href(F.byNumber(1950)), '/portslade/');
check('"Road, Town" for an unnamed road shows the town only', F.place(F.byNumber(981)), 'Strathpeffer');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
