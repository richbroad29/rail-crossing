#!/usr/bin/env node
'use strict';

// Thin entry point: all the logic is in lib/smart-check.js so it can be tested without a process.
require('../lib/smart-check').run(process.argv.slice(2)).then(code => { process.exitCode = code; });
