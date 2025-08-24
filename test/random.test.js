const test = require('tape');
const { runTest } = require('./test-helpers');

test('JVM should execute RandomTest.class', t => {
  t.plan(2);
  const expected = `3139482720
48
4437113785340752062
true
0.3090505599975586
0.5504370051176339
62 186 248 152 109 167 18 200 43 205 `;
  runTest('RandomTest', expected, t);
});
