'use strict';

// MEMORY_FIT: the thresholds, the allowance for parts not modelled, and the machine-facts reader.
// reserve = available - (measured + allowance), so every boundary below is stated in terms of the
// MEASURED peak, with the allowance's 100 MB worked into the arithmetic in the comments.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { memoryFit, PASS_RESERVE_MB, WARN_RESERVE_MB, NOT_MODELLED_ALLOWANCE_MB, MIN_MINUTES_FOR_VERDICT } = require('../lib/memory-fit');
const { parseMeminfo, parseHealthMemoryMB, machineFacts, osName } = require('../lib/machine');

const fit = (availableMB, peakRssMB, minutes = 60) => memoryFit({ availableMB, peakRssMB, minutes });

test('the thresholds are 300 and 150 MB of reserve; the allowance for parts not modelled is 100 MB', () => {
  assert.equal(PASS_RESERVE_MB, 300);
  assert.equal(WARN_RESERVE_MB, 150);
  assert.equal(NOT_MODELLED_ALLOWANCE_MB, 100);
});

test('PASS needs MemAvailable - (measured + 100) >= 300 MB: exactly 300 passes, a hair under does not', () => {
  assert.equal(fit(450, 50).status, 'PASS');       // 450 - 150 = 300
  assert.equal(fit(450, 50.1).status, 'WARN');     // 299.9
  assert.equal(fit(550, 150).status, 'PASS');      // 550 - 250 = 300
  assert.equal(fit(549.9, 150).status, 'WARN');    // 299.9
  assert.equal(fit(400, 0).status, 'PASS');        // 400 - 100 = 300
  assert.equal(fit(399.9, 0).status, 'WARN');      // 299.9
  assert.equal(fit(1000, 300).status, 'PASS');     // 1000 - 400 = 600
});

test('WARN is >= 150 MB (and under 300): exactly 150 is WARN, a hair under is FAIL', () => {
  assert.equal(fit(400, 150).status, 'WARN');      // 400 - 250 = 150
  assert.equal(fit(400, 150.1).status, 'FAIL');    // 149.9
  assert.equal(fit(250, 0).status, 'WARN');        // 250 - 100 = 150
  assert.equal(fit(249.9, 0).status, 'FAIL');      // 149.9
  assert.equal(fit(549.9, 150).status, 'WARN');    // 299.9: the top of the WARN band
});

test('the allowance is part of the projection: a pair that fitted on the measurement alone can fail with it', () => {
  // Measurement alone: 450 - 150 = 300 left (PASS). With 100 MB allowed for what is not modelled: 200 (WARN).
  const warn = fit(450, 150);
  assert.equal(warn.status, 'WARN');
  assert.equal(warn.reserveMB, 200);
  assert.equal(warn.data.measuredMB, 150);
  assert.equal(warn.data.allowanceMB, 100);
  assert.equal(warn.data.projectedMB, 250);
  // Measurement alone: 350 - 150 = 200 left (WARN). With the allowance: 100 (FAIL).
  assert.equal(fit(350, 150).status, 'FAIL');
});

test('FAIL means use a second machine, and a negative reserve is FAIL not an error', () => {
  const r = fit(200, 250);                         // projected 350 -> reserve -150
  assert.equal(r.status, 'FAIL');
  assert.equal(r.reserveMB, -150);
  assert.match(r.message, /use a second machine/);
  assert.match(r.message, /that would leave -150 MB free of 200 MB available/);
});

test('every message shows both parts: "measured X MB + 100 MB allowance for parts not modelled = Y MB"', () => {
  // The worked example: 70 measured + 100 allowance = 170 projected, leaving 470 - 170 = 300.
  assert.equal(fit(470, 70).message,
    'measured 70 MB + 100 MB allowance for parts not modelled = 170 MB; that would leave 300 MB free of 470 MB available (need 300): it fits next to the crossing service');
  assert.equal(fit(400, 70).message,
    'measured 70 MB + 100 MB allowance for parts not modelled = 170 MB; that would leave 230 MB free of 400 MB available (comfortable is 300 MB): it fits, but tightly - check the crossing service\'s memory at its 04:00 reload before deciding');
  assert.equal(fit(300, 70).message,
    'measured 70 MB + 100 MB allowance for parts not modelled = 170 MB; that would leave 130 MB free of 300 MB available (the floor is 150 MB) - use a second machine for the map service');
  assert.equal(fit(800, 70, 1).message,
    'measured 70 MB + 100 MB allowance for parts not modelled = 170 MB; that would leave 630 MB free of 800 MB available - but only 1 min were measured and the state is still filling; run at least 15 (default 60) before trusting this');
  // A measured figure with a decimal carries it through to the sum.
  assert.match(fit(512, 69.1).message, /^measured 69\.1 MB \+ 100 MB allowance for parts not modelled = 169\.1 MB; that would leave 342\.9 MB free of 512 MB available/);
});

test('a 299.96 MB reserve is never shown as "300" beside a WARN', () => {
  const edge = fit(549.96, 150);                   // 549.96 - 250 = 299.96
  assert.equal(edge.status, 'WARN');
  assert.equal(edge.reserveMB, 299.9, 'floored');
  assert.match(edge.message, /would leave 299\.9 MB/);
});

test('the displayed reserve is exact for every one-decimal input (binary floating point must not shave 0.1 MB off)', () => {
  // 512 - (69.1 + 100) is 342.89999999999998 in binary; a bare Math.floor(x * 10) / 10 shows 342.8.
  // About a quarter of one-decimal inputs were wrong that way before the epsilon.
  let checked = 0;
  for (let availT = 2000; availT <= 2400; availT++) {
    for (let peakT = 100; peakT <= 700; peakT += 7) {
      const r = fit(availT / 10, peakT / 10);
      const exactTenths = availT - peakT - 1000;
      assert.equal(r.reserveMB, exactTenths / 10, `available ${availT / 10}, measured ${peakT / 10}`);
      checked++;
    }
  }
  assert.ok(checked > 30000);
});

test('a WARN tells the reader what to check next (the 04:00 reload)', () => {
  assert.match(fit(500, 150).message, /04:00 reload/);      // 500 - 250 = 250
});

test('a short run cannot PASS: the state is still filling, so the projection is not evidence', () => {
  assert.equal(MIN_MINUTES_FOR_VERDICT, 15);
  const short = fit(800, 100, 1);                           // 800 - 200 = 600: would pass on size
  assert.equal(short.status, 'WARN');
  assert.match(short.message, /only 1 min were measured/);
  assert.equal(fit(800, 100, 14.9).status, 'WARN');
  assert.equal(fit(800, 100, 15).status, 'PASS');
  // ...but a short run cannot talk its way OUT of a FAIL: the measured part can only grow.
  assert.equal(fit(300, 100, 1).status, 'FAIL');            // 300 - 200 = 100
  assert.equal(fit(450, 100, 1).status, 'WARN');            // 450 - 200 = 250: the tight WARN, not the short-run one
  assert.match(fit(450, 100, 1).message, /fits, but tightly/);
});

test('unknown inputs are "could not judge" (WARN), never a crash and never a PASS', () => {
  for (const args of [{ availableMB: null, peakRssMB: 100 }, { availableMB: 500, peakRssMB: null }, { availableMB: NaN, peakRssMB: 1 }, {}, undefined]) {
    const r = memoryFit(args);
    assert.equal(r.status, 'WARN');
    assert.equal(r.reserveMB, null);
    assert.match(r.message, /could not judge/);
  }
  // The allowance is reported even when nothing could be judged.
  assert.equal(memoryFit({}).data.allowanceMB, 100);
});

test('the data block records everything the verdict was computed from, allowance included', () => {
  const r = fit(512.04, 20.06, 60);                         // projected 120.06 -> reserve 391.98 -> 391.9
  assert.deepEqual(r.data, {
    availableMB: 512, measuredMB: 20.1, allowanceMB: 100, projectedMB: 120.1, minutes: 60,
    passReserveMB: 300, warnReserveMB: 150, reserveMB: 391.9
  });
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
