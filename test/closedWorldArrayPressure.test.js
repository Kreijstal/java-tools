'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { compileFixture, runDetailed } = require('./helpers/closedWorld');

test('a primitive-array replacement remains usable when the native heap is full', () => {
  const directory = compileFixture('ClosedArrayPressure');
  try {
    for (const wasmHeapMb of [1, 4]) {
      const result = runDetailed(directory, 'ClosedArrayPressure', {
        closedWorld: true, wasmHeapMb, jit: { compileWorker: false },
      });
      assert.equal(result.failure, null, result.stderr);
      assert.equal(result.output.trim(), 'outline 19 7 1046528');
      assert.ok(result.stats?.built);
      assert.ok(result.stats.entries > 0);
    }
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('spilled primitive arrays preserve element kinds, bounds, identity, clone and host copying', () => {
  const directory = compileFixture('ClosedSpilledArrayKinds');
  try {
    for (const wasmHeapMb of [0.0625, 4]) {
      const result = runDetailed(directory, 'ClosedSpilledArrayKinds', {
        closedWorld: true, wasmHeapMb, jit: { compileWorker: false },
      });
      assert.equal(result.failure, null, result.stderr);
      assert.equal(result.output.trim(), 'kinds 14');
      assert.ok(result.stats?.built);
      assert.ok(result.stats.entries > 0);
    }
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
