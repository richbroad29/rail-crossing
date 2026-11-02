'use strict';

// MEMORY_FIT thresholds, on and either side of each boundary, and the machine-facts reader.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { memoryFit, PASS_RESERVE_MB, WARN_RESERVE_MB, MIN_MINUTES_FOR_VERDICT } = require('../lib/memory-fit');
const { parseMeminfo, parseHealthMemoryMB, machineFacts, osName } = require('../lib/machine');

const fit = (availableMB, projectedMB, minutes = 60) => memoryFit({ availableMB, projectedMB, minutes });

test('the thresholds are 300 and 150 MB of reserve', () => {
  assert.equal(PASS_RESERVE_MB, 300);
  assert.equal(WARN_RESERVE_MB, 150);
});

test('PASS needs MemAvailable - projected >= 300 MB: exactly 300 passes, a hair under does not', () => {
  assert.equal(fit(450, 150).status, 'PASS');
  assert.equal(fit(450, 150.1).status, 'WARN');
  assert.equal(fit(500, 100).status, 'PASS');
  assert.equal(fit(300, 0).status, 'PASS');
});

test('WARN is >= 150 MB (and under 300): exactly 150 is WARN, a hair under is FAIL', () => {
  assert.equal(fit(300, 150).status, 'WARN');
  assert.equal(fit(300, 150.1).status, 'FAIL');
  assert.equal(fit(449.9, 150).status, 'WARN');
});

test('FAIL means use a second machine, and a negative reserve is FAIL not an error', () => {
  const r = fit(200, 250);
  assert.equal(r.status, 'FAIL');
  assert.equal(r.reserveMB, -50);
  assert.match(r.message, /use a second machine/);
  assert.match(r.message, /only|leave -50 MB/);
});

test('messages carry the figures, and a 299.96 MB reserve is never shown as "300"', () => {
  const pass = fit(512, 120);
  assert.match(pass.message, /about 120 MB would leave 392 MB free of 512 MB available/);
  assert.match(pass.message, /fits next to the crossing service/);
  const edge = fit(449.96, 150);
  assert.equal(edge.status, 'WARN');
  assert.equal(edge.reserveMB, 299.9, 'floored');
  assert.match(edge.message, /299\.9 MB/);
});

test('a WARN tells the reader what to check next (the 04:00 reload)', () => {
  assert.match(fit(400, 150).message, /04:00 reload/);
});

test('a short run cannot PASS: the state is still filling, so the projection is not evidence', () => {
  assert.equal(MIN_MINUTES_FOR_VERDICT, 15);
  const short = fit(800, 100, 1);
  assert.equal(short.status, 'WARN');
  assert.match(short.message, /only 1 min were measured/);
  assert.equal(fit(800, 100, 14.9).status, 'WARN');
  assert.equal(fit(800, 100, 15).status, 'PASS');
  // ...but a short run cannot talk its way OUT of a FAIL: projected can only grow.
  assert.equal(fit(200, 100, 1).status, 'FAIL');
  assert.equal(fit(300, 100, 1).status, 'WARN');
});

test('unknown inputs are "could not judge" (WARN), never a crash and never a PASS', () => {
  for (const args of [{ availableMB: null, projectedMB: 100 }, { availableMB: 500, projectedMB: null }, { availableMB: NaN, projectedMB: 1 }, {}, undefined]) {
    const r = memoryFit(args);
    assert.equal(r.status, 'WARN');
    assert.equal(r.reserveMB, null);
    assert.match(r.message, /could not judge/);
  }
});

test('the data block records everything the verdict was computed from', () => {
  const r = fit(512.04, 120.06, 60);
  assert.deepEqual(r.data, { availableMB: 512, projectedMB: 120.1, minutes: 60, passReserveMB: 300, warnReserveMB: 150, reserveMB: 391.9 });
});

// ---- machine facts --------------------------------------------------------------------------------

// An Oracle Always Free AMD micro, give or take: 1 GB, a little swap.
const MEMINFO = `MemTotal:         989536 kB
MemFree:          102400 kB
MemAvailable:     521216 kB
Buffers:           20000 kB
Cached:           400000 kB
SwapTotal:       2097148 kB
SwapFree:        2000000 kB
`;

test('parseMeminfo reads MemAvailable, swap and total, in MB', () => {
  assert.deepEqual(parseMeminfo(MEMINFO), { memTotalMB: 966.3, memAvailableMB: 509, memFreeMB: 100, swapTotalMB: 2048, swapFreeMB: 1953.1 });
});

test('parseMeminfo copes with an old kernel (no MemAvailable) and with text that is not meminfo', () => {
  const old = parseMeminfo('MemTotal: 1024 kB\nMemFree: 512 kB\n');
  assert.equal(old.memAvailableMB, null);
  assert.equal(old.swapTotalMB, null);
  assert.equal(parseMeminfo('nope'), null);
  assert.equal(parseMeminfo(''), null);
  assert.equal(parseMeminfo(undefined), null);
});

test('parseHealthMemoryMB reads the crossing service\'s "66MB"', () => {
  assert.equal(parseHealthMemoryMB('66MB'), 66);
  assert.equal(parseHealthMemoryMB(' 120 MB '), 120);
  assert.equal(parseHealthMemoryMB('12.5mb'), 12.5);
  for (const bad of ['', 'lots', null, undefined, 66, '66']) assert.equal(parseHealthMemoryMB(bad), null, String(bad));
});

const fakeOs = (over = {}) => ({
  type: () => 'Linux', platform: () => 'linux', release: () => '5.15.0-1050-oracle', arch: () => 'x64',
  cpus: () => [{ model: '  AMD EPYC 7551 32-Core Processor ' }, { model: 'x' }],
  totalmem: () => 1013284864, loadavg: () => [0.456, 0.3, 0.2], uptime: () => 7200, homedir: () => '/home/ubuntu',
  ...over
});
const files = map => p => { if (p in map) return map[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };

test('machineFacts: a Linux box reports shape, memory, swap, load, disk and the crossing service\'s memory', () => {
  const f = machineFacts({
    os: fakeOs(),
    readFileSync: files({ '/proc/meminfo': MEMINFO, '/etc/os-release': 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 22.04.4 LTS"\n' }),
    statfsSync: dir => { assert.equal(dir, '/home/ubuntu'); return { bavail: 2621440n, bsize: 4096n }; },
    health: { status: 'ok', memory: '66MB' }
  });
  assert.equal(f.os, 'Ubuntu 22.04.4 LTS (kernel 5.15.0-1050-oracle)');
  assert.equal(f.arch, 'x64');
  assert.equal(f.cpuModel, 'AMD EPYC 7551 32-Core Processor');
  assert.equal(f.cpuCount, 2);
  assert.equal(f.memTotalMB, 966.3);
  assert.equal(f.memAvailableMB, 509);
  assert.equal(f.swapTotalMB, 2048);
  assert.equal(f.swapUsedMB, 94.9);
  assert.deepEqual(f.loadAverage, [0.46, 0.3, 0.2]);
  assert.equal(f.uptimeHours, 2);
  assert.equal(f.homeDiskFreeGB, 10);
  assert.equal(f.crossingServiceMemoryMB, 66);
  assert.equal(f.nodeVersion, process.version);
});

test('machineFacts: with no /proc, no os-release and no statfs, fields are null — never an error', () => {
  const f = machineFacts({
    os: fakeOs({ type: () => 'Darwin', platform: () => 'darwin', release: () => '23.1.0', cpus: () => [] }),
    readFileSync: files({}),
    statfsSync: () => { throw new Error('ENOSYS'); }
  });
  assert.equal(f.os, 'Darwin darwin (kernel 23.1.0)');
  assert.equal(f.cpuModel, null);
  assert.equal(f.cpuCount, 0);
  assert.equal(f.memAvailableMB, null);
  assert.equal(f.memTotalMB, 966.3, 'falls back to os.totalmem');
  assert.equal(f.swapTotalMB, null);
  assert.equal(f.swapUsedMB, null);
  assert.equal(f.homeDiskFreeGB, null);
  assert.equal(f.crossingServiceMemoryMB, null);
});

test('osName: PRETTY_NAME with or without quotes', () => {
  const name = text => osName({ os: fakeOs(), readFileSync: files({ '/etc/os-release': text }) });
  assert.match(name('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n'), /^Debian GNU\/Linux 12 \(bookworm\) \(kernel/);
  assert.match(name('PRETTY_NAME=Alpine\n'), /^Alpine \(kernel/);
});
