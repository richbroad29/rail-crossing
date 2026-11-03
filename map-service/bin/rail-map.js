#!/usr/bin/env node
'use strict';

// Entry point. Run as:  node --max-old-space-size=192 bin/rail-map.js [--fake[=host:port] --ref-dir=DIR]

const { loadConfig } = require('../src/config');
const { App } = require('../src/app');
const stomp = require('../src/stomp');
const log = require('../src/log');

async function main() {
  let cfg;
  try { cfg = loadConfig(); }
  catch (e) { log.error(`start: ${log.errText(e)}`); process.exit(2); }

  const app = new App(cfg);

  // A stray exception must not take the map down for one bad message, but a process that keeps
  // throwing is not healthy: after 5 in a minute, exit and let systemd restart it.
  const recent = [];
  const survive = (kind, e) => {
    log.error(`${kind}: ${log.errText(e)}`);
    const t = Date.now();
    recent.push(t);
    while (recent.length && t - recent[0] > 60000) recent.shift();
    if (recent.length >= 5) {
      log.error('too many unexpected errors; exiting for a clean restart');
      try { stomp.killActive(); } catch (_) { /* gone */ }
      process.exit(1);
    }
  };
  process.on('uncaughtException', e => survive('uncaught exception', e));
  process.on('unhandledRejection', e => survive('unhandled rejection', e));

  let stopping = false;
  const shutdown = async sig => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig}: shutting down`);
    const hard = setTimeout(() => { try { stomp.killActive(); } catch (_) { /* gone */ } process.exit(0); }, 10000);
    if (hard.unref) hard.unref();
    try { await app.stop(); } catch (e) { log.error(`shutdown: ${log.errText(e)}`); }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try { await app.start(); }
  catch (e) { log.error(`start: ${log.errText(e)}`); process.exit(1); }
}

main();
