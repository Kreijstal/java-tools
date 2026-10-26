'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {compileFixture, hotspot, runDetailed} = require('./helpers/closedWorld');
const {JVM} = require('../src/core/jvm');
const {ClosedCompiler} = require('../src/jit/closed/ClosedCompiler');

test('receiver-field reuse preserves alias writes, calls, volatile barriers and exception order', async () => {
  const directory = compileFixture('ClosedReceiverFields');
  try {
    const result = runDetailed(directory, 'ClosedReceiverFields', {closedWorld: true, jit: {compileWorker: false}});
    assert.equal(result.failure, null, result.stderr);
    assert.equal(result.output, hotspot(directory, 'ClosedReceiverFields'));
    assert.ok(result.stats.entries > 0);

    const jvm = new JVM({classpath: directory, wasmHeap: true, wasmHeapMb: 1, closedWorld: true,
      jit: {compileWorker: false}});
    await jvm.loadClassByName('ClosedReceiverFields');
    const original = ClosedCompiler.prototype.analyzeInvariantReceiverFields, counts = new Map();
    try {
      ClosedCompiler.prototype.analyzeInvariantReceiverFields = function () {
        original.call(this);
        counts.set(this.entry.key, this.invariantReceiverFields.length);
      };
      await jvm.jit.closedWorld.build();
    } finally {ClosedCompiler.prototype.analyzeInvariantReceiverFields = original;}
    assert.equal(counts.get('ClosedReceiverFields.raster([I[F[IIFF)I'), 3);
    for (const [key, count] of counts) {
      if (/\.(aliasWrite|acrossCall|volatileRead|otherReceiver)\(/.test(key)) assert.equal(count, 0, key);
    }
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});
