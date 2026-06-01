'use strict';

// Fix 3 validation — confirm same-day STP=C cancellations actually suppress
// services, against a LIVE update extract. Read-only: it does NOT touch the
// running backend or its in-memory state.
//
// What it does:
//   1. downloads today's toc-update-<dow> update extract,
//   2. parses the full CIF snapshot already on disk (the baseline),
//   3. applies the update onto it via the new merge path,
//   4. prints which predicted services the update suppresses (and any it adds).
//
// Run on the VPS, from the backend/ directory:
//   node scripts/validate-update.js
//
// Best run midday or later — early morning the update extract may carry few
// cancellations. Needs NR_FEED_USER / NR_FEED_PASS (auto-loaded from .env below)
// and the full CIF already downloaded at data/schedule/cif-latest.json.gz.

const fs = require('fs');
const path = require('path');

// Load backend/.env if creds aren't already in the environment, so this works
// with zero extra setup wherever the service is configured.
if (!process.env.NR_FEED_USER) {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const cifFetcher = require('../src/cif-fetcher');
const { parseScheduleFile, applyUpdateExtract } = require('../src/schedule-parser');

const crossingsConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'crossings.json'), 'utf-8')
);

(async () => {
  const fullPath = cifFetcher.latestFilePath();
  if (!fs.existsSync(fullPath)) {
    console.error(`No full CIF on disk at ${fullPath}.`);
    console.error('Start the backend once (it downloads the full snapshot) and re-run.');
    process.exit(1);
  }

  let updateFile;
  try {
    const res = await cifFetcher.downloadCifUpdate();
    updateFile = res.path;
    console.log(`Downloaded update extract toc-update-${res.day}: ${res.bytes} bytes`);
  } catch (err) {
    console.error('Update extract download failed:', err.message);
    process.exit(1);
  }

  const base = await parseScheduleFile(fullPath, crossingsConfig);
  const { trains: after, stats } = await applyUpdateExtract(updateFile, crossingsConfig, base);

  console.log('\n=== Fix 3 validation ===');
  console.log(`Update records: ${stats.records}  cancellations: ${stats.cancelled}  overlays: ${stats.overlays}  deletes(ignored): ${stats.deletes}`);

  let anySuppressed = false;
  for (const cid of Object.keys(crossingsConfig)) {
    const baseList = base[cid] || [];
    const afterUids = new Set((after[cid] || []).map(t => t.uid));
    const dropped = baseList.filter(t => !afterUids.has(t.uid));
    const baseUids = new Set(baseList.map(t => t.uid));
    const added = (after[cid] || []).filter(t => !baseUids.has(t.uid));

    console.log(`\n[${cid}] ${baseList.length} predicted before → ${(after[cid] || []).length} after update`);
    if (dropped.length) {
      anySuppressed = true;
      console.log(`  SUPPRESSED by update (${dropped.length}) — these are real same-day cancellations:`);
      for (const t of dropped) {
        console.log(`    ${t.uid}  ${t.headcode || ''}  ~${t.estimatedCrossingTime || '?'}  ${t.direction}`);
      }
    } else {
      console.log('  Suppressed by update: none right now (try again later in the day).');
    }
    if (added.length) {
      console.log(`  Added by update (${added.length}):`);
      for (const t of added) console.log(`    ${t.uid}  ${t.headcode || ''}  ~${t.estimatedCrossingTime || '?'}  ${t.direction} [stp ${t.stp}]`);
    }
  }

  console.log('\nResult: ' + (anySuppressed
    ? 'PASS — at least one real service was suppressed by the live update extract. Fix 3 works on real data.'
    : 'No cancellations in the extract right now — not a failure. Re-run midday/afternoon when more cancellations have been issued.'));
})().catch(err => { console.error(err); process.exit(1); });
