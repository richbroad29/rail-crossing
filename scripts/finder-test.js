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

// ---- postcodes: what counts as one, and the lookup (against a fake postcodes.io) -------------
console.log('\nfinder: postcodes\n');
const pc = q => { const p = F.postcode(q); return p ? `${p.kind} ${p.code} ${p.area}` : 'null'; };
check('"CF5 6XB" is a full postcode', pc('CF5 6XB'), 'full CF5 6XB CF5');
check('"cf56xb" (lower case, no space) is the same postcode', pc('cf56xb'), 'full CF5 6XB CF5');
check('"  sw1a  1aa " (extra spaces, letter in the district)', pc('  sw1a  1aa '), 'full SW1A 1AA SW1A');
check('"BN41" is a district', pc('BN41'), 'area BN41 BN41');
check('"cf5 6x" (half typed, with space) looks up the district', pc('cf5 6x'), 'area CF5 CF5');
check('"CF56X" (half typed, no space) waits: district unclear', pc('CF56X'), 'partial CF56X null');
check('"portslade" is not a postcode', pc('portslade'), 'null');
check('"boundary rd" is not a postcode', pc('boundary rd'), 'null');
check('"CF5 6XBZ" (too long) is not a postcode', pc('CF5 6XBZ'), 'null');
check('"CF5-6XB" (hyphen) is the same postcode', pc('CF5-6XB'), 'full CF5 6XB CF5');
check('"cf5.6xb." (dots) is the same postcode', pc('cf5.6xb.'), 'full CF5 6XB CF5');
check('"C F 5 6 X B" (spaced out) is the same postcode', pc('C F 5 6 X B'), 'full CF5 6XB CF5');
check('"cf5-6x" (half typed, hyphen) looks up the district', pc('cf5-6x'), 'area CF5 CF5');
check('"BN41-" (trailing hyphen) is the district', pc('BN41-'), 'area BN41 BN41');
check('"st fagans cf5 6xb" (other words) is not read as a postcode', pc('st fagans cf5 6xb'), 'null');
// A known postcode near Portslade must answer with Portslade first, through the same nearest().
const fake = { 'postcodes/BN411AA': { latitude: 50.8372, longitude: -0.2021 }, 'outcodes/CF5': { latitude: 51.4834, longitude: -3.2455 },
  'terminated_postcodes/E1W1UU': { latitude: 51.508, longitude: -0.0737 } };
const asked = [];
globalThis.fetch = url => {
  const k = url.replace('https://api.postcodes.io/', ''); asked.push(k);
  if (k === 'postcodes/FA11AA') return Promise.resolve({ ok: false, status: 500 });
  const r = fake[k];
  return Promise.resolve(r ? { ok: true, status: 200, json: () => Promise.resolve({ status: 200, result: r }) } : { ok: false, status: 404 });
};
(async () => {
  const bn = await F.lookupPostcode(F.postcode('bn41 1aa'));
  check('a full postcode resolves to its position', bn && bn.lat, 50.8372);
  check('  ... and nearest() from it puts Portslade first', F.nearest(bn, 3).top[0].e.n, 1950);
  check('  ... sent compacted to /postcodes/', asked[0], 'postcodes/BN411AA');
  asked.length = 0; await F.lookupPostcode(F.postcode('BN41 1AA'));
  check('asked once a visit: the same postcode again sends nothing', asked.length, 0);
  check('a district resolves through /outcodes/', (await F.lookupPostcode(F.postcode('CF5'))).lat, 51.4834);
  asked.length = 0;
  check('a retired postcode still resolves', (await F.lookupPostcode(F.postcode('E1W 1UU'))).lat, 51.508);
  check('  ... tried as current first, then retired', asked.join(','), 'postcodes/E1W1UU,terminated_postcodes/E1W1UU');
  check('no such postcode resolves to null', await F.lookupPostcode(F.postcode('ZZ1 1ZZ')), null);
  check('no such district resolves to null (e.g. a road number like "A27")', await F.lookupPostcode(F.postcode('A27')), null);
  check('a partial postcode sends nothing', (asked.length = 0, await F.lookupPostcode(F.postcode('CF56X')), asked.length), 0);
  let failed = false; try { await F.lookupPostcode(F.postcode('FA1 1AA')); } catch (e) { failed = true; }
  check('a service failure rejects (so the page can say so)', failed, true);
  asked.length = 0; try { await F.lookupPostcode(F.postcode('FA1 1AA')); } catch (e) { /* expected */ }
  check('  ... and is not remembered: asking again retries', asked.length, 1);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
