const test = require('tape');
const { runTest } = require('./test-helpers');

test('JVM should execute InputStreamReaderTest.class', async (t) => {
  await runTest('InputStreamReaderTest', 'Test passed', t);
  t.end();
});
