'use strict';
// The closed-world module (src/jit/closed) must compile ordinary guest code
// into one Wasm module and print exactly what HotSpot prints, with the work
// actually running inside that module.
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileFixture, hotspot, runDetailed } = require('./helpers/closedWorld');

const JIT = { compileWorker: false };

test('closed module matches HotSpot on arithmetic, arrays, dispatch and exceptions', () => {
  const directory = compileFixture('ClosedCompute');
  const expected = hotspot(directory, 'ClosedCompute');
  const result = runDetailed(directory, 'ClosedCompute', { closedWorld: true, jit: JIT });
  assert.equal(result.failure, null, result.stderr);
  assert.equal(result.output, expected);
  assert.ok(result.stats && result.stats.built, 'closed world was built');
  assert.ok(result.stats.admitted >= 10, `admitted ${JSON.stringify(result.stats)}`);
  assert.ok(result.stats.entries > 0, `module entered ${JSON.stringify(result.stats)}`);
});

test('closed module handles exception handlers, finally, rethrow and monitors like HotSpot', () => {
  const directory = compileFixture('ClosedExceptions');
  const expected = hotspot(directory, 'ClosedExceptions');
  const result = runDetailed(directory, 'ClosedExceptions', { closedWorld: true, jit: JIT });
  assert.equal(result.failure, null, result.stderr);
  assert.equal(result.output, expected);
  assert.ok(result.stats.admitted >= 15, `admitted ${JSON.stringify(result.stats)}`);
  assert.ok(!result.stats.rejectReasons['exception-handlers'], 'handler methods are admitted');
  // toCharArray / split / getBytes results entered the module as closed storage.
  assert.ok(result.stats.adoptedArrays >= 3, `adopted ${JSON.stringify(result.stats)}`);
});

test('closed module runs the storage fixture (objects, statics, clone, handlers in loops) like HotSpot', () => {
  const directory = compileFixture('ClosedRepr');
  const expected = hotspot(directory, 'ClosedRepr');
  const result = runDetailed(directory, 'ClosedRepr', { closedWorld: true, jit: JIT });
  assert.equal(result.failure, null, result.stderr);
  assert.equal(result.output, expected);
  assert.ok(result.stats.admitted >= 10, `admitted ${JSON.stringify(result.stats)}`);
});

test('closed module answers instanceof and checkcast like HotSpot', () => {
  const directory = compileFixture('ClosedTypeTests');
  const expected = hotspot(directory, 'ClosedTypeTests');
  const result = runDetailed(directory, 'ClosedTypeTests', { closedWorld: true, jit: JIT });
  assert.equal(result.failure, null, result.stderr);
  assert.equal(result.output, expected);
  assert.ok(result.stats.admitted >= 5, `admitted ${JSON.stringify(result.stats)}`);
});
