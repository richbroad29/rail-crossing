'use strict';

// How much memory the run used, so the report can say whether it fits the 1 GB VPS it runs on
// (`nice -n 19 node --max-old-space-size=256 bin/smart-check.js`).
//
// Heap is SAMPLED (after each chunk read and at each stage boundary): the peak is the highest sample, so
// it can miss a short spike between two samples, and it includes garbage not yet collected, so it can
// also read high. RSS is different: the kernel tracks the true peak for the whole process, and that is
// the figure that matters to the machine.

const v8 = require('v8');

const MB = 1048576;
const round1 = x => Math.round(x * 10) / 10;

class MemoryProbe {
  constructor() {
    this.peakHeapUsed = 0;
    this.peakAt = '';
    this.sample('start');
  }

  sample(label) {
    const used = v8.getHeapStatistics().used_heap_size;
    if (used > this.peakHeapUsed) { this.peakHeapUsed = used; this.peakAt = label; }
  }

  report() {
    this.sample('end');
    const maxRssKb = process.resourceUsage().maxRSS;            // kilobytes
    return {
      peakHeapUsedMB: round1(this.peakHeapUsed / MB),
      peakHeapAt: this.peakAt,
      heapLimitMB: round1(v8.getHeapStatistics().heap_size_limit / MB),
      peakRssMB: round1(maxRssKb / 1024)
    };
  }
}

module.exports = { MemoryProbe };
