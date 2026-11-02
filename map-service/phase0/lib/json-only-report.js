'use strict';

// A Report that can also carry bulky data meant for the JSON file ONLY.
//
// Report.fact() puts everything in both the .json and the .txt, and the .txt is what gets read
// (and sometimes pasted). Example messages from a feed are useful evidence but noise in the
// readable report, so they ride in a separate `examples` object that only toJSON() emits — which
// is also the only place Report.write() scrubs credentials from, so they are scrubbed like
// everything else. lib/report.js itself is deliberately left alone: this extends it.

const { Report } = require('./report');

class JsonOnlyReport extends Report {
  constructor(name, opts) {
    super(name, opts);
    this.examples = {};
  }

  /** Attach `value` under `key` in the JSON report's `examples`; never in the .txt or the summary. */
  jsonOnly(key, value) {
    this.examples[key] = value;
    return this;
  }

  toJSON() {
    return { ...super.toJSON(), examples: this.examples };
  }
}

module.exports = { JsonOnlyReport };
