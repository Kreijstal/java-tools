'use strict';
const test = require('tape');
const {mathIntrinsicFunction} = require('../src/jit/wasmShared');

test('Wasm math bindings retain numeric semantics without a native trampoline', t => {
  t.equal(mathIntrinsicFunction('sin', '(D)D'), Math.sin, 'unary double binds the native directly');
  t.equal(mathIntrinsicFunction('pow', '(DD)D'), Math.pow, 'binary double binds the native directly');
  t.equal(mathIntrinsicFunction('abs', '(I)I'), Math.abs, 'integer conversion stays at the Wasm boundary');
  const abs = mathIntrinsicFunction('abs', '(F)F');
  const min = mathIntrinsicFunction('min', '(FF)F');
  const max = mathIntrinsicFunction('max', '(FF)F');
  t.equal(abs(-1.00000007), Math.fround(1.00000007), 'unary float result rounds to float32');
  t.equal(max(1.00000007, 0), Math.fround(1.00000007), 'binary float result rounds to float32');
  t.ok(Object.is(min(0, -0), -0), 'minimum preserves negative zero');
  t.ok(Object.is(max(0, -0), 0), 'maximum preserves positive zero');
  t.ok(Number.isNaN(min(NaN, 1)), 'NaN propagates');
  t.equal(abs(-Infinity), Infinity, 'infinity is preserved');
  const longAbs = mathIntrinsicFunction('abs', '(J)J');
  t.equal(longAbs(-(1n << 63n)), -(1n << 63n), 'long minimum overflow remains Java-compatible');
  t.equal(mathIntrinsicFunction('sqrt', '(J)J'), null, 'unsupported long overload remains refused');
  t.end();
});
