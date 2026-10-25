'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const path = require('node:path');

test('dead large closed arrays recycle without spilling or reusing storage held by a host view', () => {
  // Exercise actual host finalization of Wasm GC handles and their optional
  // TypedArray views. No guest-visible free or liveness guess is involved.
  const script = `
    const assert = require('node:assert/strict');
    const {WasmHeap} = require('./src/core/wasmHeap');
    const {ClosedRuntime} = require('./src/jit/closed/representation');
    (async () => {
      const heap = new WasmHeap(1);
      const runtime = new ClosedRuntime({wasmHeap: heap, classes: {}, jre: {}, nextHashCode: 1});
      const collectUntil = async predicate => {
        for (let i = 0; i < 40 && !predicate(); i++) {
          global.gc();
          await new Promise(resolve => setImmediate(resolve));
        }
        assert.ok(predicate(), 'dead array storage was not reclaimed');
      };
      for (let i = 0; i < 16; i++) {
        const before = heap.stats.arrayReclaimed;
        let store = runtime.newPrimitiveArray('[I', 32768);
        assert.ok(runtime.ops.parrBase(store) >= 0, 'dead large arrays exhausted the heap');
        store = null;
        await collectUntil(() => heap.stats.arrayReclaimed > before);
      }
      assert.equal(runtime.spilledArrays || 0, 0);
      assert.ok(heap.stats.arrayReused >= 15);
      assert.ok(heap.usage().allocated <= 131072 + 8, 'bump allocation grew across dead buffers');

      let store = runtime.newPrimitiveArray('[I', 32768);
      let view = runtime.toJs(store);
      view[0] = 123; view[view.length - 1] = 456;
      const base = view.wasmBase;
      store = null;
      const before = heap.stats.arrayReclaimed;
      for (let i = 0; i < 4; i++) {global.gc(); await new Promise(setImmediate);}
      assert.equal(heap.stats.arrayReclaimed, before, 'live view lost its underlying extent');
      let other = runtime.newPrimitiveArray('[I', 32768);
      assert.notEqual(runtime.ops.parrBase(other), base, 'live arrays aliased recycled storage');
      assert.equal(view[0], 123); assert.equal(view[view.length - 1], 456);
      view = null;
      await collectUntil(() => heap.stats.arrayReclaimed > before);
      const next = runtime.newPrimitiveArray('[I', 32768);
      assert.equal(runtime.ops.parrBase(next), base);
      const zeroed = runtime.toJs(next);
      assert.equal(zeroed[0], 0); assert.equal(zeroed[zeroed.length - 1], 0);
      assert.equal(runtime.spilledArrays || 0, 0);
      // Keep the other live handle reachable through the final checks.
      assert.notEqual(runtime.ops.parrBase(other), runtime.ops.parrBase(next));
      console.log('large arrays recycled; live views retained; reused storage zeroed');
    })().catch(error => {console.error(error); process.exitCode = 1;});
  `;
  const output = execFileSync(process.execPath, ['--expose-gc', '-e', script], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000,
  });
  assert.match(output, /large arrays recycled; live views retained; reused storage zeroed/);
});
