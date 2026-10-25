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
  const frame = {closedOuterEntry: {outer: true}};
  const thread = {closedEntryFrame: frame};
  const tick = new Promise((resolve, reject) => {frame.closedTick = {resolve, reject};});
  withoutStderr({ env: {} }, () => {}, () => world.failSuspendable(frame, thread, {}, error));
  assert.equal(frame.closedTick, null);
  assert.equal(thread.closedEntryFrame.outer, true);
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
