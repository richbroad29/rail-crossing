#!/usr/bin/env node
'use strict';

// Memory and CPU of the real service, in its real process, under the real heap cap:
//
//   node dev/measure-memory.js --ref-dir=/path/refdata [--minutes=10] [--rate=200] [--trains=5000] [--sse=60]
//                              [--cif=/path/cif-latest.json.gz | generated] [--node=/path/to/node]
//
// 1. Builds a reference folder from the real SMART / CORPUS / NaPTAN and a full-size CIF (the real one
//    if --cif is given, else a generated 25,000-schedule day plus 40,000 other-date records).
// 2. Starts dev/fake-nrod.js (synthetic national TD over every SMART area at --rate events/s, separate
//    process) and the service (`node --max-old-space-size=192 bin/rail-map.js --fake ...`).
// 3. Samples the SERVICE process (ps RSS and CPU time; /health heapMB) at start-up (peak while the CIF
//    parses) and every 10 s through the run, with --sse live SSE clients and /trains polled every 5 s.
// 4. Prints the table and the verdict against the budget (steady-state RSS <= 220 MB).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { generate } = require('./gen-cif');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const opt = {};
for (const a of process.argv.slice(2)) { const m = /^--([a-z-]+)=(.*)$/.exec(a); if (m) opt[m[1]] = m[2]; }
const NODE = opt.node || process.execPath;
const minutes = Number(opt.minutes || 10), rate = Number(opt.rate || 200), trains = Number(opt.trains || 5000), sseN = Number(opt.sse || 60);
const REF = opt['ref-dir'];
if (!REF) { console.error('usage: measure-memory.js --ref-dir=<folder with smart-latest.json.gz corpus-latest.json.gz naptan-rail.csv>'); process.exit(2); }

function ps(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'rss=,time=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
    const [rssKb, time] = out;
    const parts = time.split(':').map(Number);
    const secs = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    return { rssMB: Number(rssKb) / 1024, cpuSecs: secs };
  } catch (_) { return null; }
}
const getJson = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, agent: false }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
});

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-'));
  const refDir = path.join(work, 'ref'), dataDir = path.join(work, 'data');
  fs.mkdirSync(refDir); fs.mkdirSync(dataDir);
  for (const f of ['smart-latest.json.gz', 'corpus-latest.json.gz', 'naptan-rail.csv']) fs.copyFileSync(path.join(REF, f), path.join(refDir, f));
  if (opt.cif) { fs.copyFileSync(opt.cif, path.join(refDir, 'cif-latest.json.gz')); console.log(`CIF: ${opt.cif}`); }
  else {
    const r = await generate({ out: path.join(refDir, 'cif-latest.json.gz'), corpus: path.join(refDir, 'corpus-latest.json.gz'), today: 25000, noise: 40000, date: opt.date || new Date().toISOString().slice(0, 10) });
    console.log(`CIF: generated ${r.lines} lines, ${(r.bytes / 1048576).toFixed(1)} MB gzipped (25,000 schedules running today)`);
  }

  const stompPort = 62000 + Math.floor(Math.random() * 1000), port = 36000 + Math.floor(Math.random() * 1000);
  const fake = spawn(NODE, [path.join(__dirname, 'fake-nrod.js'), '--mode=synthetic', `--smart=${path.join(refDir, 'smart-latest.json.gz')}`, `--rate=${rate}`, `--trains=${trains}`, `--port=${stompPort}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  fake.stdout.on('data', () => {});
  await sleep(1500);
  const svcLog = [];
  const svc = spawn(NODE, ['--max-old-space-size=192', path.join(__dirname, '..', 'bin', 'rail-map.js'), `--fake=127.0.0.1:${stompPort}`, `--ref-dir=${refDir}`],
    { env: { ...process.env, PORT: String(port), MAP_DATA_DIR: dataDir, MAP_ENV_FILE: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] });
  svc.stdout.on('data', d => svcLog.push(String(d))); svc.stderr.on('data', d => svcLog.push(String(d)));
  let exited = null;
  svc.on('exit', (c, s) => { exited = { c, s }; });

  // Start-up: peak RSS while the CIF streams in.
  let peakStart = 0, health = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    const p = ps(svc.pid); if (p) peakStart = Math.max(peakStart, p.rssMB);
    if (exited) break;
    try { health = await getJson(port, '/map/v1/health'); if (health.reference.cif.schedules > 0 && health.status !== 'starting') break; } catch (_) { /* not up yet */ }
    await sleep(100);
  }
  if (exited) { console.error('the service exited during start-up:', exited, svcLog.join('').slice(-800)); fake.kill(); process.exit(1); }
  console.log(`start-up: ${((Date.now() - t0) / 1000).toFixed(1)} s to load SMART+CORPUS+NaPTAN+CIF (${health.reference.cif.schedules} schedules indexed); peak RSS during load ${peakStart.toFixed(0)} MB`);

  // SSE clients and polling.
  const clients = [];
  const boxes = ['?bbox=50.7,-0.4,50.95,-0.1', '?bbox=51.3,-0.6,51.7,0.3', '?bbox=52.3,-2.2,52.7,-1.5', '?bbox=53.3,-2.4,53.6,-2.0', ''];
  for (let i = 0; i < sseN; i++) {
    const req = http.request({ host: '127.0.0.1', port, path: `/map/v1/stream${boxes[i % boxes.length]}`, agent: false }, res => { res.on('data', () => {}); res.on('error', () => {}); });
    req.on('error', () => {}); req.end(); clients.push(req);
  }
  const poll = setInterval(() => { getJson(port, '/map/v1/trains?bbox=50,-6,56,2').catch(() => {}); }, 5000);

  await sleep(15000);                                  // let the synthetic population fill
  const rows = [];
  const base = ps(svc.pid), baseT = Date.now();
  const end = Date.now() + minutes * 60000;
  let n = 0;
  while (Date.now() < end && !exited) {
    await sleep(10000);
    const p = ps(svc.pid); if (!p) break;
    let h = null; try { h = await getJson(port, '/map/v1/health'); } catch (_) { /* busy */ }
    rows.push({ t: Math.round((Date.now() - baseT) / 1000), rss: p.rssMB, heap: h ? h.heapMB : null, trains: h ? h.model.trains : null, placed: h ? h.model.placed : null, sse: h ? h.clients.sse : null, evMin: h ? h.feeds.td.messagesPerMin : null, cpu: p.cpuSecs });
    if (++n % 6 === 0) console.log(`  t=${rows[rows.length - 1].t}s rss=${p.rssMB.toFixed(0)}MB heap=${h ? h.heapMB : '?'}MB trains=${h ? h.model.trains : '?'}`);
  }
  clearInterval(poll); clients.forEach(c => c.destroy());
  const last = ps(svc.pid);
  const wall = (Date.now() - baseT) / 1000;
  const cpuAvg = last && base ? ((last.cpuSecs - base.cpuSecs) / wall) * 100 : null;
  const rssVals = rows.map(r => r.rss), heapVals = rows.filter(r => r.heap !== null).map(r => r.heap);
  const half = Math.floor(rows.length / 2);
  const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const result = {
    node: process.version === undefined ? null : execFileSync(NODE, ['--version'], { encoding: 'utf8' }).trim(),
    minutes, rate, trainsTarget: trains, sseClients: sseN, cifSchedules: health.reference.cif.schedules,
    startupPeakRssMB: Math.round(peakStart),
    steady: { rssMB: { min: Math.round(Math.min(...rssVals)), mean: Math.round(mean(rssVals)), max: Math.round(Math.max(...rssVals)) }, heapMB: { min: Math.min(...heapVals), mean: Math.round(mean(heapVals)), max: Math.max(...heapVals) } },
    growth: { firstHalfMeanRssMB: Math.round(mean(rssVals.slice(0, half))), secondHalfMeanRssMB: Math.round(mean(rssVals.slice(half))) },
    trains: { max: Math.max(...rows.map(r => r.trains || 0)), placedAtEnd: rows[rows.length - 1].placed },
    eventsPerMinMeasured: Math.round(mean(rows.map(r => r.evMin || 0))),
    cpu: { avgPercentOfOneCore: cpuAvg === null ? null : Math.round(cpuAvg * 10) / 10 },
    budgetRssMB: 220, withinBudget: Math.max(...rssVals) <= 220
  };
  console.log(JSON.stringify(result, null, 1));
  console.log(svcLog.join('').split('\n').filter(l => /summary|WARN|ERROR/.test(l)).slice(-6).join('\n'));
  svc.kill('SIGTERM'); fake.kill('SIGTERM');
  await sleep(1500);
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
