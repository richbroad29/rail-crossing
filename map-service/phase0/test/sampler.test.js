'use strict';

// The resource sampler against planted readings: peak RSS, the headroom figure the memory
// verdict uses, CPU arithmetic, and the two guards that stop the measurement before it can hurt
// the box it is running on.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ResourceSampler, MEMORY_FLOOR_MB, HEAP_GUARD_FRACTION } = require('../lib/sampler');

const MB = 1048576;

// A harness whose clock, memory, CPU and meminfo are all driven by the test.
function rig({ availStart = 500, rssStart = 50, heapLimitMB = 256 } = {}) {
  const h = { t: 0, rss: rssStart, heapUsed: 10, avail: availStart, cpu: { user: 0, system: 0 }, noProc: false };
  h.sampler = new ResourceSampler({
    now: () => h.t,
    memoryUsage: () => ({ rss: h.rss * MB, heapUsed: h.heapUsed * MB, heapTotal: h.heapUsed * 1.5 * MB, external: 2 * MB, arrayBuffers: 1 * MB }),
    cpuUsage: () => ({ ...h.cpu }),
    meminfo: () => (h.noProc ? null : { memAvailableMB: h.avail }),
    heapLimitBytes: heapLimitMB * MB
  });
  h.step = (secs, o = {}) => {
    h.t += secs * 1000;
    if (o.rss !== undefined) h.rss = o.rss;
    if (o.heapUsed !== undefined) h.heapUsed = o.heapUsed;
    if (o.avail !== undefined) h.avail = o.avail;
    if (o.cpuUs) { h.cpu = { user: h.cpu.user + o.cpuUs[0], system: h.cpu.system + o.cpuUs[1] }; }
    return h.sampler.sample();
  };
  return h;
}

test('the guard thresholds are the verdict\'s own: 150 MB of availability and 85% of the heap', () => {
  assert.equal(MEMORY_FLOOR_MB, 150);
  assert.equal(HEAP_GUARD_FRACTION, 0.85);
});

test('begin() records MemAvailable with the process still at baseline', () => {
  const h = rig({ availStart: 512 });
  assert.equal(h.sampler.begin(), 512);
  assert.equal(h.sampler.startAvailableMB, 512);
});

test('peak RSS, peak heap and CPU over the run, from planted readings', () => {
  const h = rig();
  h.sampler.begin();
  h.step(10, { rss: 60, heapUsed: 20, avail: 480, cpuUs: [100000, 50000] });   // 0.15 s CPU in 10 s = 1.5%
  h.step(10, { rss: 120, heapUsed: 70, avail: 420, cpuUs: [200000, 100000] });  // 0.30 s in 10 s = 3%
  h.step(10, { rss: 100, heapUsed: 50, avail: 440, cpuUs: [0, 0] });            // idle interval = 0%
  const s = h.sampler.summary(30000);
  assert.equal(s.samples, 3);
  assert.equal(s.peakRssMB, 120);
  assert.equal(s.peakHeapUsedMB, 70);
  assert.equal(s.cpu.userSecs, 0.3);
  assert.equal(s.cpu.systemSecs, 0.15);
  assert.equal(s.cpu.percentOfOneCoreMean, 1.5);       // 0.45 s of CPU over 30 s
  assert.equal(s.cpu.percentPeakInterval, 3);
  assert.equal(s.heapLimitMB, 256);
  assert.equal(h.sampler.samples[0].cpuPercent, 1.5);
  assert.equal(h.sampler.samples[1].cpuPercent, 3);
  assert.equal(h.sampler.samples[2].cpuPercent, 0);
});

test('availableForVerdict is the LEAST room a map service would have had, never more than the start reading', () => {
  const h = rig({ availStart: 500, rssStart: 50 });
  h.sampler.begin();
  // We grow by 70 MB and available falls by exactly that: nothing else changed, so adding our RSS
  // back gives the same 550 every time, and the start reading (500) is the lowest.
  h.step(10, { rss: 90, avail: 460 });
  h.step(10, { rss: 120, avail: 430 });
  assert.equal(h.sampler.summary(20000).availableForVerdictMB, 500);

  // Now ANOTHER process grows by 100 MB mid-run (the crossing service reloading its timetable):
  // available (440) + our RSS (120) = 560 would not show it, but 340 + 120 = 460 does.
  const g = rig({ availStart: 500, rssStart: 50 });
  g.sampler.begin();
  g.step(10, { rss: 120, avail: 380 });   // + us = 500
  g.step(10, { rss: 120, avail: 340 });   // + us = 460  <- someone else grew by 40 beyond us
  const s = g.sampler.summary(20000);
  assert.equal(s.availableForVerdictMB, 460);
  assert.equal(s.memAvailableMinMB, 340);
  assert.equal(s.memAvailableStartMB, 500);
});

test('without /proc (a Mac), availability is unknown — null, not 0 and not an error', () => {
  const h = rig();
  h.noProc = true;
  assert.equal(h.sampler.begin(), null);
  const s = h.step(10, { rss: 80 });
  assert.equal(s.memAvailableMB, null);
  assert.equal(s.memAvailableWithoutUsMB, null);
  const sum = h.sampler.summary(10000);
  assert.equal(sum.availableForVerdictMB, null);
  assert.equal(sum.memAvailableMinMB, null);
  assert.equal(sum.peakRssMB, 80);
  assert.equal(h.sampler.guard(s), null, 'the memory guard cannot fire on a reading it does not have');
});

test('guard: stops when available memory falls BELOW 150 MB; 150 itself is fine', () => {
  const h = rig();
  assert.equal(h.sampler.guard(h.step(10, { avail: 150 })), null);
  const low = h.sampler.guard(h.step(10, { avail: 149.9 }));
  assert.equal(low.rule, 'memory-floor');
  assert.match(low.message, /149\.9 MB \(floor 150 MB\)/);
});

test('guard: stops at 85% of the heap limit, before V8 aborts without a report', () => {
  const h = rig({ heapLimitMB: 256 });
  assert.equal(h.sampler.guard(h.step(10, { heapUsed: 200 })), null);          // 78%
  assert.equal(h.sampler.guard(h.step(10, { heapUsed: 0.84 * 256 })), null);
  const hi = h.sampler.guard(h.step(10, { heapUsed: 0.85 * 256 }));
  assert.equal(hi.rule, 'heap-cap');
  assert.match(hi.message, /85% of its 256 MB limit/);
});

test('guard: the memory rule is reported first when both fire', () => {
  const h = rig({ heapLimitMB: 256 });
  assert.equal(h.sampler.guard(h.step(10, { heapUsed: 250, avail: 100 })).rule, 'memory-floor');
});

test('series: one row per started minute with that minute\'s worst figures', () => {
  const h = rig();
  h.sampler.begin();
  h.step(10, { rss: 60, avail: 480 });
  h.step(40, { rss: 90, avail: 450, cpuUs: [0, 3000000] });                    // t=50 s, minute 0
  h.step(20, { rss: 80, avail: 470 });                                         // t=70 s, minute 1
  h.step(60, { rss: 95, avail: 440 });                                         // t=130 s, minute 2
  const rows = h.sampler.series();
  assert.deepEqual(rows.map(r => r.minute), [0, 1, 2]);
  assert.deepEqual(rows.map(r => r.rssMBMax), [90, 80, 95]);
  assert.deepEqual(rows.map(r => r.memAvailableMBMin), [450, 470, 440]);
  assert.equal(rows[0].cpuPercentMax, 7.5);                                     // 3 s of CPU in a 40 s interval
});

test('an empty sampler summarises without throwing', () => {
  const h = rig();
  const s = h.sampler.summary(1000);
  assert.equal(s.samples, 0);
  assert.equal(s.peakRssMB, null);
  assert.equal(s.cpu.percentPeakInterval, null);
  assert.deepEqual(h.sampler.series(), []);
});
