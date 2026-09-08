// Regression test for the exponential lowering of nested static calls:
//   f.a(1L, f.a(1L, f.a(1L, ...)))
// The lowering used to try two (and then a third) method-resolution strategies
// that each lowered the nested arguments again, making a depth-N chain cost
// 2^N. GeoBlox's obfuscated kernels (ge.c, qc.java) hit this shape and turned
// a ~30 ms lower into several seconds per file.
const test = require('tape');
const frontend = require('../src/java-frontend');

function nestedStaticCall(depth) {
  let expr = '1L';
  for (let i = 0; i < depth; i++) {
    expr = `f.a(1L, ${expr})`;
  }
  return `class C { long m() { return ${expr}; } }
class f { static long a(long p, long q) { return p; } }`;
}

test('nested static user calls lower in near-linear time', (t) => {
  const deep = frontend.parseJava(nestedStaticCall(16), { sourceFileName: 'C.java' });
  const t0 = Date.now();
  const deepIr = frontend.lowerAstToJavaIr(deep, { sourceFileName: 'C.java' });
  const deepMs = Date.now() - t0;

  // Before the fix depth 12 already took ~16 s (and the curve was doubling per
  // level, so depth 16 would run for minutes). An absolute bound is robust
  // against GC/noise and still catches the exponential regression by orders
  // of magnitude.
  t.ok(deepMs < 8000,
    `depth-16 lowers in ${deepMs} ms (was exponential before the fix)`);
  t.ok(deepIr && deepIr.classes && deepIr.classes.length > 0,
    'the nested chain still lowers to a valid IR document');
  t.end();
});
