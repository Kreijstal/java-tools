'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {compileFixture, runDetailed, jspiNode} = require('./helpers/closedWorld');

test('object factories preserve closed types and fields when native storage is exhausted', () => {
  const directory = compileFixture('ClosedObjectPressure');
  try {
    for (const suspendable of jspiNode() ? [false, true] : [false]) {
     for (const wasmHeapMb of [1, 4]) {
      const result = runDetailed(directory, 'ClosedObjectPressure', {
        closedWorld: true, wasmHeapMb, jspiNode: suspendable, jit: {compileWorker: false},
      });
      assert.equal(result.failure, null, result.stderr);
      assert.equal(result.output.trim(), 'objects 35 16');
      assert.ok(result.stats?.built);
      assert.ok(result.stats.entries > 0);
      if (wasmHeapMb === 1) assert.ok(result.stats.spilledObjects > 0);
      else assert.equal(result.stats.spilledObjects, 0);
     }
    }
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});
