'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {compileFixture, hotspot, runDetailed, jspiNode} = require('./helpers/closedWorld');
const {JVM} = require('../src/core/jvm');
const threadJre = require('../src/jre/java/lang/Thread');
const key = 'native:java/lang/Thread.currentThread()Ljava/lang/Thread;';

test('currentThread identity survives scheduler switches and suspension', {
  skip: jspiNode() ? false : 'requires JS Promise Integration for suspended module threads',
}, () => {
  const directory = compileFixture('ClosedCurrentThread');
  try {
    const expected = hotspot(directory, 'ClosedCurrentThread');
    const result = runDetailed(directory, 'ClosedCurrentThread', {closedWorld: true,
      jspiNode: true, jit: {compileWorker: false}});
    assert.equal(result.failure, null, result.stderr);
    assert.equal(result.output, expected);
    assert.ok(result.stats.entries > 0);
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});

test('the direct bridge preserves polling and explicit thread context; custom natives keep their protocol', () => {
  const jvm = new JVM({wasmHeap: true, wasmHeapMb: 1, closedWorld: true, jit: {compileWorker: false}});
  const world = jvm.jit.closedWorld;
  const active = {id: 1, name: 'active'}, unrelated = {id: 2, name: 'unrelated'};
  jvm.threads = [unrelated]; jvm.currentThreadIndex = 0; world.thread = active;
  const native = jvm._jreFindMethod('java/lang/Thread', 'currentThread', '()Ljava/lang/Thread;');
  assert.equal(jvm.jni.builtinImplementationOf(native), threadJre.staticMethods['currentThread()Ljava/lang/Thread;']);
  world.nativeImport(key, native, '()Ljava/lang/Thread;', false);
  let polls = 0, parked;
  world.sliceExpired = () => {polls++; return false;};
  const impl = world.imports.get(key).impl;
  assert.equal(world.runtime.toJs(impl()).nativeThread, active);
  assert.equal(polls, 1);
  world.sliceExpired = () => true;
  world.requestPark = value => {parked = value; return true;};
  assert.equal(impl(), null);
  assert.equal(world.runtime.toJs(parked.value).nativeThread, active);
  assert.equal(world.counters.preempted, 1);

  const override = new JVM({wasmHeap: true, wasmHeapMb: 1, closedWorld: true, jit: {compileWorker: false}}).jit.closedWorld;
  const custom = () => Promise.resolve({type: 'java/lang/Thread'});
  override.nativeImport(key, custom, '()Ljava/lang/Thread;', false);
  let observed;
  override.hostResult = (kind, value) => {observed = value; return 7;};
  assert.equal(override.imports.get(key).impl(), 7);
  assert.ok(observed instanceof Promise, 'custom native retains async-result handling');
  jvm.jni.registerNativeMethod('java/lang/Thread', 'currentThread', '()Ljava/lang/Thread;', () => null);
  assert.equal(jvm.jni.builtinImplementationOf(jvm._jreFindMethod('java/lang/Thread', 'currentThread', '()Ljava/lang/Thread;')), null);
});
