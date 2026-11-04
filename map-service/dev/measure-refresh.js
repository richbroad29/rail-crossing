#!/usr/bin/env node
'use strict';

// The worst moment for memory: the daily CIF refresh, with the national model populated and the old
// index still serving. Runs the real App in this process (so start it under the real heap cap):
//
//   node --max-old-space-size=192 dev/measure-refresh.js --ref-dir=DIR --cif=FILE [--seconds=20] [--trains=3500]
//
// It fills the model from a synthetic national feed at 200 events/s, then re-indexes the CIF exactly
// as RefData._refresh does after the download (load, then swap in), sampling RSS every 20 ms.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { App } = require('../src/app');
const { loadConfig } = require('../src/config');
const log = require('../src/log');

const opt = {};
for (const a of process.argv.slice(2)) { const m = /^--([a-z-]+)=(.*)$/.exec(a); if (m) opt[m[1]] = m[2]; }
const mb = n => Math.round(n / 1048576);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-'));
  const refDir = path.join(work, 'ref'); fs.mkdirSync(refDir);
  for (const f of ['smart-latest.json.gz', 'corpus-latest.json.gz', 'naptan-rail.csv']) fs.copyFileSync(path.join(opt['ref-dir'], f), path.join(refDir, f));
  fs.copyFileSync(opt.cif, path.join(refDir, 'cif-latest.json.gz'));
  const port = 62000 + Math.floor(Math.random() * 900);
  const fake = spawn(process.execPath, [path.join(__dirname, 'fake-nrod.js'), '--mode=synthetic', `--smart=${path.join(refDir, 'smart-latest.json.gz')}`, '--rate=200', `--trains=${opt.trains || 3500}`, `--port=${port}`, '--trust-rate=25', '--vstp-rate=2', `--trust-prefill=${opt['trust-prefill'] || 0}`], { stdio: 'ignore' });
  await sleep(1000);
  log.setSink(() => {});
  const { config } = loadConfig({ env: {}, argv: [], overrides: { port: 0 } });
  const app = new App({ config, dataDir: path.join(work, 'data'), fake: { host: '127.0.0.1', port, refDir } });
  await app.start();
  await sleep(Number(opt.seconds || 20) * 1000);
  const before = process.memoryUsage();
  let peak = before.rss, peakHeap = before.heapUsed;
  const iv = setInterval(() => { const m = process.memoryUsage(); peak = Math.max(peak, m.rss); peakHeap = Math.max(peakHeap, m.heapTotal); }, 20);
  const t0 = Date.now();
  const { data, rows } = await app.refdata._loadFile('cif', app.refdata.fileFor('cif'));
  app.refdata._install('cif', data, rows);           // as _refresh does once the file has loaded
  const took = Date.now() - t0;
  await sleep(3000);
  clearInterval(iv);
  const after = process.memoryUsage();
  console.log(JSON.stringify({
    trains: app.model.counts().trains, trustActivations: app.trust.acts.size, vstpSchedules: app.vstp.size, refreshSecs: took / 1000,
    rssMB: { before: mb(before.rss), peakDuringRefresh: mb(peak), afterSettled: mb(after.rss) }, heapUsedMB: { before: mb(before.heapUsed), after: mb(after.heapUsed) }
  }));
  await app.stop(); fake.kill(); fs.rmSync(work, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
