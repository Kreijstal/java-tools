const test = require('tape');
const { runTest } = require('./test-helpers');

test('JVM should execute InflaterTest.class', async (t) => {
  await runTest('InflaterTest', 'Test passed', t);
  t.end();
});
