#!/usr/bin/env node
// Tells IndexNow search engines (Bing, Yandex, Seznam, Naver; Google doesn't take part) that pages
// changed, so a newly launched crossing is crawled within hours, not weeks (burger-menu ticket 12).
// The key is public by design: IndexNow checks it against https://railcrossing.uk/<key>.txt, which
// must be live first. Run after a push that adds or changes pages:
//   node scripts/indexnow.mjs                 every URL in sitemap.xml
//   node scripts/indexnow.mjs /portslade/     just these paths
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = '44c5b93a1748b4a18c7a88b996a88e11';
const SITE = 'https://railcrossing.uk';
const args = process.argv.slice(2);
const urls = args.length ? args.map(p => SITE + (p.startsWith('/') ? p : '/' + p))
  : [...readFileSync(join(ROOT, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: 'railcrossing.uk', key: KEY, keyLocation: `${SITE}/${KEY}.txt`, urlList: urls })
});
console.log(`IndexNow: HTTP ${res.status} for ${urls.length} URL(s): ${urls.join(' ')}`);
console.log(res.status === 200 || res.status === 202 ? 'accepted' : await res.text());
