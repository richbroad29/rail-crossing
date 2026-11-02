'use strict';

// One report per phase-0 run: facts, checks with a verdict, and free-text notes.
//
// Written to <outDir>/<name>-<UTC stamp>.json (everything) and .txt (readable), and a compact
// SUMMARY block is printed for Rich to paste back into the chat. Every string that leaves this
// module passes through `redact` first, so a credential that reached an error message cannot
// reach a file or the terminal.
//
// Exit code: 1 if any check FAILed, else 0. INFO and WARN never fail a run.

const fs = require('fs');
const path = require('path');
const { redact } = require('./env');

const STATUSES = new Set(['PASS', 'WARN', 'FAIL', 'INFO']);

function stamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20261102T101500Z
}

class Report {
  /**
   * @param {string} name             script name, e.g. 'smart-check'
   * @param {object} opts
   * @param {string} opts.outDir      where the .json and .txt go (created if missing)
   * @param {string[]} [opts.secrets] strings to scrub from everything written or printed
   * @param {function} [opts.now]     clock, for tests
   */
  constructor(name, { outDir, secrets = [], now = () => new Date() } = {}) {
    if (!name || !outDir) throw new Error('Report needs a name and an outDir');
    this.name = name;
    this.outDir = outDir;
    this.secrets = secrets;
    this.now = now;
    this.startedAt = now();
    this.facts = {};
    this.summaryFacts = [];
    this.checks = [];
    this.notes = [];
  }

  /** Record a fact. `summary: true` also puts it in the paste-back block (keep those short). */
  fact(key, value, { summary = false } = {}) {
    this.facts[key] = value;
    if (summary && !this.summaryFacts.includes(key)) this.summaryFacts.push(key);
    return this;
  }

  /** Record a verdict. `message` is one line for a person; `data` is detail for the JSON. */
  check(id, status, message, data) {
    if (!STATUSES.has(status)) throw new Error(`Unknown status ${status}`);
    const existing = this.checks.findIndex(c => c.id === id);
    const entry = { id, status, message: String(message || ''), data: data === undefined ? null : data };
    if (existing >= 0) this.checks[existing] = entry; else this.checks.push(entry);
    return this;
  }

  note(text) { this.notes.push(String(text)); return this; }

  get exitCode() { return this.checks.some(c => c.status === 'FAIL') ? 1 : 0; }

  _scrub(s) { return redact(s, this.secrets); }

  summaryText() {
    const head = `===== ${this.name} · ${this.startedAt.toISOString()} · paste from here =====`;
    const idw = Math.max(4, ...this.checks.map(c => c.id.length));
    const lines = [head];
    for (const c of this.checks) lines.push(`${c.status.padEnd(4)}  ${c.id.padEnd(idw)}  ${c.message}`);
    for (const k of this.summaryFacts) lines.push(`fact  ${k} = ${formatValue(this.facts[k])}`);
    lines.push(`===== end ${this.name} =====`);
    return this._scrub(lines.join('\n'));
  }

  textReport() {
    const lines = [this.summaryText(), '', 'Facts:'];
    for (const [k, v] of Object.entries(this.facts)) lines.push(`  ${k}: ${formatValue(v, 2000)}`);
    if (this.notes.length) { lines.push('', 'Notes:'); for (const n of this.notes) lines.push(`  ${n}`); }
    return this._scrub(lines.join('\n')) + '\n';
  }

  toJSON() {
    return {
      script: this.name,
      startedAt: this.startedAt.toISOString(),
      finishedAt: this.now().toISOString(),
      exitCode: this.exitCode,
      checks: this.checks,
      facts: this.facts,
      notes: this.notes
    };
  }

  /** Write both files; returns their paths. Never throws on a scrub; throws if the disk does. */
  write() {
    fs.mkdirSync(this.outDir, { recursive: true });
    const base = path.join(this.outDir, `${this.name}-${stamp(this.startedAt)}`);
    const json = this._scrub(JSON.stringify(this.toJSON(), null, 2)) + '\n';
    fs.writeFileSync(base + '.json', json);
    fs.writeFileSync(base + '.txt', this.textReport());
    return { jsonPath: base + '.json', txtPath: base + '.txt' };
  }

  /** Write, print the paste-back block and where the files went, and return the exit code. */
  finish(stdout = process.stdout) {
    const { jsonPath, txtPath } = this.write();
    stdout.write('\n' + this.summaryText() + '\n');
    stdout.write(`\nFull report: ${txtPath}\n            ${jsonPath}\n`);
    return this.exitCode;
  }
}

function formatValue(v, max = 300) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

module.exports = { Report, stamp };
