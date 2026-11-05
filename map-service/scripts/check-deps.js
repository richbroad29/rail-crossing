#!/usr/bin/env node
'use strict';
// `npm test` runs this first (pretest): no node_modules -> exit 2 at once with a sentence.
try { require('../src/deps').requireDeps(); }
catch (e) { console.error(`rail-map: ${e.message}`); process.exit(2); }
