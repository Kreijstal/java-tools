const test = require('tape');
const { runTest } = require('./test-helpers');

test('JVM should execute CRC32Test.class', async (t) => {
  await runTest('CRC32Test', 'Test passed', t);
  t.end();
});
