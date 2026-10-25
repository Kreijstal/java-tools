'use strict';
// Closed-world storage (src/jit/closed/representation.js) must be invisible to
// Java: a program run with closedWorld storage and no JIT prints exactly what
// HotSpot prints.
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileFixture, hotspot, runJvmJs } = require('./helpers/closedWorld');

test('closed storage preserves objects, arrays, statics and clone semantics', async () => {
  const directory = compileFixture('ClosedRepr');
  const expected = hotspot(directory, 'ClosedRepr');
  const actual = await runJvmJs(directory, 'ClosedRepr', { closedWorld: true, jit: { enabled: false, compileWorker: false } });
  assert.equal(actual, expected);
});

// Object.clone used to copy only the wrapper, so the clone shared the
// original's field map and `copy.a = 1000` also changed `d.a`.
test('the same program without closed storage', async () => {
  const directory = compileFixture('ClosedRepr');
  const actual = await runJvmJs(directory, 'ClosedRepr', { jit: { enabled: false, compileWorker: false } });
  assert.equal(actual, hotspot(directory, 'ClosedRepr'));
});
