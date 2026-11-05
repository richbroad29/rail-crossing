#!/usr/bin/env node
'use strict';
// Browser checks for the map page. Starts the mock service (1,500 trains) and a static server,
// drives real Chrome with Playwright, and writes screenshots to ./out (or $OUT).
//   node map/test/visual/run.js            everything
//   node map/test/visual/run.js shots      phone + desktop, light + dark: map, panel, search, stale; national
//   node map/test/visual/run.js probes     close-zoom train probes (14, 16, 18)
//   node map/test/visual/run.js e2e        behaviour checks (keyboard, deep links, share, theme ...)
//   node map/test/visual/run.js basemap    positron vs liberty vs dark base maps, Sussex z9 and z12
//   node map/test/visual/run.js perf       frame times
//   node map/test/visual/run.js phase2 [network|views|stacked|approx|panel|sequence|video]   phase 2: track, board, network, sequence, video
//   node map/test/visual/run.js shots d-dark   only shots whose name contains "d-dark"
// Exit code is non-zero if a check failed or the page logged a console error.
if (process.env.NODE_TEST_CONTEXT) { console.log('Browser checks are not unit tests; run: node map/test/visual/run.js'); process.exit(0); }
process.env.RM_VISUAL = '1';
const L = require('./lib.js');

(async () => {
  const what = process.argv[2] || 'all';
  const only = process.argv[3];
  const s = await L.servers();
  const browser = await L.launch();
  let failed = 0;
  try {
    if (what === 'all' || what === 'shots') failed += await require('./shots.js')(browser, only);
    if (what === 'all' || what === 'probes') failed += await require('./probes.js')(browser);
    if (what === 'all' || what === 'e2e') failed += await require('./e2e.js')(browser);
    if (what === 'all' || what === 'basemap') failed += await require('./basemap.js')(browser);
    if (what === 'all' || what === 'perf') failed += await require('./perf.js')(browser);
    if (what === 'all' || what === 'phase2') failed += await require('./phase2.js')(browser, what === 'phase2' ? only : undefined);
  } finally {
    await browser.close();
    s.stop();
  }
  console.log(failed ? '\n' + failed + ' problem(s). Screenshots: ' + L.CFG.out : '\nAll good. Screenshots: ' + L.CFG.out);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
