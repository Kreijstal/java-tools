'use strict';
// Closed world on JS Promise Integration: threads park inside the module
// (monitors, wait/notify, sleep, join), calls to methods outside the module
// run as ordinary frames, and module recursion is depth-counted. Each fixture
// must print what HotSpot prints with the module on and with it off.
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileFixture, hotspot, runDetailed, jspiNode } = require('./helpers/closedWorld');

const skip = jspiNode() ? false : 'no Node with WebAssembly.Suspending (set JVM_JSPI_NODE)';
const JIT = { compileWorker: false };

function check(fixture, expectStats, { off = true } = {}) {
  const directory = compileFixture(fixture);
  const expected = hotspot(directory, fixture);
  const closed = runDetailed(directory, fixture, { jspiNode: true, closedWorld: true, jit: JIT });
  assert.equal(closed.failure, null, closed.stderr);
  assert.equal(closed.output, expected);
  assert.ok(closed.stats && closed.stats.built, `closed world was built: ${closed.stderr.slice(-2000)}`);
  expectStats(closed.stats);
  if (!off) return;
  const plain = runDetailed(directory, fixture, { jspiNode: true, closedWorld: false, jit: JIT });
  assert.equal(plain.failure, null, plain.stderr);
  assert.equal(plain.output, expected);
}

test('threads park inside the module on monitors, wait/notify, sleep and join', { skip }, () => {
  check('ClosedThreads', (stats) => {
    assert.ok(stats.parks > 0, `parked ${JSON.stringify(stats)}`);
    assert.ok(stats.admitted >= 10, `admitted ${JSON.stringify(stats)}`);
  });
});

test('calls the module cannot make directly run as ordinary frames', { skip }, () => {
  check('ClosedSlowCalls', (stats) => {
    assert.ok(stats.slowCalls > 0, `slow calls ${JSON.stringify(stats)}`);
  });
});

test('module recursion throws a catchable StackOverflowError and recovers', { skip }, () => {
  check('ClosedRecursion', (stats) => {
    assert.ok(stats.recursive >= 4, `recursive methods ${JSON.stringify(stats)}`);
  // Without the module the generated-JS tiers recurse on the JS stack and
  // die with a RangeError instead of StackOverflowError (also on Node 22).
  }, { off: false });
});

test('handlers inside handlers keep the frame state (try-with-resources)', { skip }, () => {
  check('ClosedTryResources', (stats) => {
    assert.ok(stats.admitted >= 5, `admitted ${JSON.stringify(stats)}`);
  });
});

test('a thread that never blocks is preempted so others run', { skip }, () => {
  check('ClosedPreemption', (stats) => {
    assert.ok(stats.preempted > 0, `preempted ${JSON.stringify(stats)}`);
  });
});
