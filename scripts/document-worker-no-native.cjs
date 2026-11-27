'use strict';
// Test-process sentinel, loaded before the bundle in BOTH the renderer child and its worker threads.
// Any attempted load fails the process even if a dependency catches the exception and tries a fallback.
const refuse = () => {
  process.exitCode = 1;
  throw new Error('Document generation attempted to load a native module');
};
require('node:module')._extensions['.node'] = refuse;
process.dlopen = refuse;
const data = require('node:worker_threads').workerData;
if (data && Number.isSafeInteger(data.proofExpectedOffset)) {
  require('node:assert/strict').equal(new Date('2026-01-15T12:00:00Z').getTimezoneOffset(), data.proofExpectedOffset,
    'The actual rendering worker did not inherit the process time zone');
}
