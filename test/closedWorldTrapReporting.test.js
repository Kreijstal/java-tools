'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClosedWorld } = require('../src/jit/closed/ClosedWorld');

function withoutStderr(processShim, sink, run) {
  const process = globalThis.process, error = console.error;
  try {
    globalThis.process = processShim;
    console.error = sink;
    return run();
  } finally {
    globalThis.process = process;
    console.error = error;
  }
}

test('browser trap reporting preserves the original error and includes its message', () => {
  for (const shim of [undefined, { env: {} }]) {
    const world = Object.create(ClosedWorld.prototype), messages = [];
    const error = new WebAssembly.RuntimeError('unreachable executed');
    // Firefox stacks can omit the error message.
    error.stack = 'wasm-function[7]@module:10';
    withoutStderr(shim, message => messages.push(message), () => {
      assert.equal(world.translateTrap(error), error);
      assert.equal(world.translateTrap(error), error);
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /unreachable executed/);
    assert.match(messages[0], /wasm-function\[7\]/);
  }
});

test('a throwing diagnostic sink cannot replace a Wasm trap', () => {
  const world = Object.create(ClosedWorld.prototype);
  const error = new WebAssembly.RuntimeError('integer overflow');
  withoutStderr({ env: {} }, () => {throw new Error('logger failed');}, () => {
    assert.equal(world.translateTrap(error), error);
  });
});

test('Node diagnostics retain stderr and Java trap translations remain intact', () => {
  const messages = [], world = Object.create(ClosedWorld.prototype);
  const shim = {stderr: {write: text => messages.push(text)}};
  withoutStderr(shim, () => {throw new Error('unexpected console write');}, () => {
    const error = new WebAssembly.RuntimeError('unreachable');
    assert.equal(world.translateTrap(error), error);
    assert.deepEqual(world.translateTrap(new WebAssembly.RuntimeError('null reference')),
      {type: 'java/lang/NullPointerException', message: null});
    assert.deepEqual(world.translateTrap(new RangeError('Maximum call stack size exceeded')),
      {type: 'java/lang/StackOverflowError', message: null});
  });
  assert.equal(messages.length, 1);
  assert.ok(messages[0].endsWith('\n'));
});

test('a browser trap rejects the scheduler segment instead of leaving it pending', async () => {
  const world = Object.create(ClosedWorld.prototype);
  const error = new WebAssembly.RuntimeError('unreachable executed');
  const frame = {className: 'FailedEntry', method: {name: 'run', descriptor: '()V'}, closedOuterEntry: {outer: true}};
  const thread = {id: 7, name: 'failed worker', closedEntryFrame: frame};
  // A different thread may have entered the module before the rejection job.
  world.thread = {id: 8, name: 'other worker'};
  const tick = new Promise((resolve, reject) => {frame.closedTick = {resolve, reject};});
  withoutStderr({ env: {} }, () => {}, () => world.failSuspendable(frame, thread, {}, error));
  assert.equal(frame.closedTick, null);
  assert.equal(thread.closedEntryFrame.outer, true);
  assert.equal(error.jvmClosedWorld.thread.id, 7);
  assert.equal(error.jvmClosedWorld.javaEntry.className, 'FailedEntry');
  await assert.rejects(tick, caught => caught === error);
});

test('an exception translation failure also rejects the scheduler segment', async () => {
  const world = Object.create(ClosedWorld.prototype), failure = new Error('translation failed');
  world.translateTrap = () => {throw failure;};
  const frame = {}, thread = {closedEntryFrame: frame};
  const tick = new Promise((resolve, reject) => {frame.closedTick = {resolve, reject};});
  world.failSuspendable(frame, thread, {}, new Error('host failure'));
  await assert.rejects(tick, caught => caught === failure);
});

test('traps expose bounded scalar context without retaining the Java frame or heap', () => {
  const world = Object.create(ClosedWorld.prototype), reports = [];
  world.jvm = {onRuntimeDiagnostic: detail => reports.push(detail)};
  world.thread = {id: 7, name: 'worker', closedEntryFrame: {className: 'Example',
    method: {name: 'render', descriptor: '()V'}, locals: ['private guest value']}};
  world.runtime = {heap: {usage: () => ({allocated: 1048576, free: 0, live: 1048576,
    limit: 1048576, reserved: 1048576, privateObject: {}})}, spilledArrays: 3, spilledArrayBytes: 8192,
    spilledObjects: 2, spilledObjectBytes: 128};
  const error = new WebAssembly.RuntimeError('bad cast');
  error.stack = 'x'.repeat(12000);
  withoutStderr({env: {}}, () => {}, () => {
    assert.equal(world.translateTrap(error), error);
    world.translateTrap(error);
  });
  assert.equal(reports.length, 1);
  const detail = reports[0];
  assert.equal(error.jvmClosedWorld, detail);
  assert.equal(detail.stack.length, 8000);
  assert.deepEqual(detail.javaEntry, {className: 'Example', methodName: 'render', descriptor: '()V'});
  assert.equal(detail.heap.limit, 1048576);
  assert.equal(detail.spilledArrays, 3);
  assert.equal(detail.spilledArrayBytes, 8192);
  assert.equal(detail.spilledObjects, 2);
  assert.equal(detail.spilledObjectBytes, 128);
  assert.doesNotMatch(JSON.stringify(detail), /private guest value|privateObject|locals/);
  world.thread.closedEntryFrame.className = 'Changed';
  assert.equal(detail.javaEntry.className, 'Example');
});

test('diagnostic hooks cannot mask frozen errors and the number of reports is bounded', () => {
  const world = Object.create(ClosedWorld.prototype);
  let calls = 0;
  world.jvm = {onRuntimeDiagnostic() {calls++; throw new Error('collector failed');}};
  withoutStderr({env: {}}, () => {}, () => {
    for (let i = 0; i < 30; i++) {
      const error = Object.freeze(new WebAssembly.RuntimeError('bad cast ' + i));
      assert.equal(world.translateTrap(error), error);
    }
  });
  assert.equal(calls, 16);
  assert.equal(world.trapReportCount, 16);
});

test('an asynchronously rejected diagnostic hook cannot mask the original trap', async () => {
  const world = Object.create(ClosedWorld.prototype);
  world.jvm = {onRuntimeDiagnostic: () => Promise.reject(new Error('collector unavailable'))};
  const error = new WebAssembly.RuntimeError('bad cast');
  withoutStderr({env: {}}, () => {}, () => assert.equal(world.translateTrap(error), error));
  // Give an unhandled rejection a chance to fail the test runner.
  await new Promise(resolve => setImmediate(resolve));
});

test('a collector that mutates its record cannot replace the original trap', () => {
  const world = Object.create(ClosedWorld.prototype);
  world.jvm = {onRuntimeDiagnostic(detail) {detail.cycle = detail;}};
  const error = new WebAssembly.RuntimeError('bad cast');
  withoutStderr({env: {}}, () => {}, () => assert.equal(world.translateTrap(error), error));
});
