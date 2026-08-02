// Print a snippet to paste into the observer's page console (or run via the browser tool) that
// answers the ONE question a frontend deploy needs: is the page EXECUTING the code that is
// deployed?
//
//   node .claude/skills/crossing-audit/scripts/stale-check.js [symbol]
//
// Why this exists: `curl https://railcrossing.uk/shared/predict.js` bypasses the service worker
// entirely, so it confirms the FILE and tells you nothing about what the app is running. On
// 2026-07-31 that distinction cost a capture — the file was correct, the page was executing the
// previous copy, and the recorded row looked completely normal. The check below compares a live
// function's source against a cache-busted fetch of the file, so it cannot be fooled the same
// way. A novel query string is a cache miss, so it reaches the network.
const symbol = process.argv[2] || 'enrich';
console.log(`// Paste into the observer page console. Checks the RUNNING PREDICT.${symbol}
// against the deployed file. Expect stale:false.
(async () => {
  const live = PREDICT.${symbol}.toString().replace(/\\s+/g, ' ').trim();
  const file = await fetch('/shared/predict.js?probe=' + Date.now(), { cache: 'reload' })
    .then(r => r.text());
  const flat = file.replace(/\\s+/g, ' ');
  const body = live.slice(live.indexOf('{'));            // skip the name/arg preamble
  const found = flat.includes(body.slice(0, 200));
  return { symbol: '${symbol}', stale: !found,
           note: found ? 'page is running the deployed code'
                       : 'PAGE IS RUNNING STALE CODE — reload once and re-check' };
})()`);
