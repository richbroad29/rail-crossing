'use strict';

// A missing dependency must FAIL, fast and in plain words, never hang. Without node_modules the
// STOMP client could not be loaded, which the reconnect loop treated as "connect failed, retry with
// backoff" forever, so `npm test` sat for ten minutes instead of saying so. Every entry point checks
// here first: bin/rail-map.js, App.start(), the tests' helpers, and `npm test` (pretest).

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

/** The dependency names this service declares (package.json `dependencies`). */
function declared(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return Object.keys(pkg.dependencies || {});
}

/**
 * Throws one plain sentence naming every dependency that cannot be loaded.
 * @param {object} [o]  root: the package folder; names: override the list; resolve: stand-in for require.resolve
 */
function requireDeps({ root = ROOT, names = null, resolve = null } = {}) {
  const list = names || declared(root);
  const res = resolve || (n => require.resolve(n, { paths: [root] }));
  const missing = [];
  for (const n of list) { try { res(n); } catch (_) { missing.push(n); } }
  if (missing.length) {
    const e = new Error(`Missing dependenc${missing.length > 1 ? 'ies' : 'y'}: ${missing.join(', ')}. Run "npm ci" in ${root} and try again.`);
    e.code = 'MISSING_DEPENDENCY';
    throw e;
  }
  return list;
}

module.exports = { requireDeps, declared };
