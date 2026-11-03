'use strict';

// One plain line per message, to stdout (journald timestamps it). No stack traces, no per-event
// logging: callers log transitions and a 5-minute summary only. Every line passes through
// `redact` with every registered secret, so a credential can never reach the journal.

const { redact } = require('./env');

const MAX_LINE = 600;
let secrets = [];
let sink = line => { try { process.stdout.write(line + '\n'); } catch (_) { /* stdout closed: nothing sane to do */ } };

function addSecrets(list) {
  for (const s of list || []) if (s && s.length >= 3 && !secrets.includes(s)) secrets.push(s);
}

function setSink(fn) { sink = fn || (() => {}); }
function resetForTest() { secrets = []; }

function clean(text) {
  let s = redact(String(text), secrets);
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e -￿]/g, '?');
  return s.length > MAX_LINE ? s.slice(0, MAX_LINE - 1) + '…' : s;
}

/** The message of whatever was thrown, never its stack and never its attached objects. */
function errText(e) {
  if (e === null || e === undefined) return 'unknown error';
  if (typeof e === 'string') return e;
  const code = e.code ? ` [${e.code}]` : '';
  return `${e.message || e.name || 'error'}${code}`;
}

function write(level, msg) {
  try { sink(`${level} ${clean(msg)}`); } catch (_) { /* a failing log line must never take the service down */ }
}

module.exports = {
  info: m => write('INFO', m),
  warn: m => write('WARN', m),
  error: m => write('ERROR', m),
  errText, addSecrets, setSink, clean, resetForTest
};
