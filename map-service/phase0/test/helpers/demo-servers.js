#!/usr/bin/env node
'use strict';

// Fake NROD + fake crossing-service /health, as one standalone process, so the REAL scripts can be
// run end to end on a machine with neither:
//
//   node test/helpers/demo-servers.js [--stale-after SECS] [--drop-after SECS]
//
// It prints one JSON line {stompPort, healthUrl, envFile} and then serves until SIGTERM/SIGINT:
//   - TD_ALL_SIG_AREA at ~60 frames/s across 40 areas, TRAIN_MVT_ALL_TOC at ~8/s, VSTP_ALL at ~1 per 3 s;
//   - /health healthy, with a td block — until `--stale-after` seconds after the FIRST STOMP
//     connection, when td.staleSecs jumps to 120 (the "crossing service lost its feed" scenario);
//   - `--drop-after` drops every client abruptly that many seconds after the first connection.
// The credentials are fake and contain $ " \ and : — the awkward characters the real password has.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const { FakeStompServer } = require('./fake-stomp-server');
const { FakeHealth, healthyBody } = require('./fake-health');
const { TdGenerator, trustFrame, vstpMessage, mulberry32 } = require('./td-gen');

const { values } = parseArgs({ options: { 'stale-after': { type: 'string' }, 'drop-after': { type: 'string' } } });
const staleAfterMs = values['stale-after'] ? Number(values['stale-after']) * 1000 : null;
const dropAfterMs = values['drop-after'] ? Number(values['drop-after']) * 1000 : null;

(async () => {
  const login = 'demo@example.com', pass = 'd3m0$"pass\\word:x';
  const srv = new FakeStompServer({ login, passcode: pass });
  await srv.listen();

  let firstConnectionAt = null;
  const mk = healthyBody();
  const health = new FakeHealth(() => {
    const b = mk();
    if (staleAfterMs !== null && firstConnectionAt !== null && Date.now() - firstConnectionAt > staleAfterMs) {
      b.td.staleSecs = 120; b.td.stale = true; b.status = 'degraded';
    }
    return b;
  });
  const healthUrl = await health.listen();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-demo-'));
  const envFile = path.join(dir, 'demo.env');
  fs.writeFileSync(envFile, `NR_FEED_USER=${login}\nNR_FEED_PASS=${pass}\n`);

  const td = new TdGenerator({ seed: 7, areas: 40 });
  const rand = mulberry32(11);
  const timers = [
    setInterval(() => srv.publish('/topic/TD_ALL_SIG_AREA', td.frame(4)), 16),
    setInterval(() => srv.publish('/topic/TRAIN_MVT_ALL_TOC', trustFrame(rand)), 120),
    setInterval(() => srv.publish('/topic/VSTP_ALL', vstpMessage(rand)), 3000),
    setInterval(() => {
      if (firstConnectionAt === null && srv.connections.length > 0) {
        firstConnectionAt = Date.now();
        if (dropAfterMs !== null) setTimeout(() => srv.dropAll(), dropAfterMs);
      }
    }, 50)
  ];

  process.stdout.write(JSON.stringify({ stompPort: srv.port, healthUrl, envFile }) + '\n');
  const bye = async () => { timers.forEach(clearInterval); await srv.close().catch(() => {}); await health.close().catch(() => {}); process.exit(0); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
})();
