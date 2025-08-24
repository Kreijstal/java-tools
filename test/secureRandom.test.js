const test = require('tape');
const { runTest } = require('./test-helpers');

test('JVM should execute SecureRandomTest.class', async (t) => {
  t.plan(5);

  const { output, success, error } = await runTest('SecureRandomTest', undefined, t);

  const lines = output.trim().split('\n');
  t.equal(lines.length, 3, 'Should have 3 lines of output');
  t.ok(lines[0].startsWith('nextInt: '), 'Output line should have correct prefix');
  t.ok(lines[1].startsWith('nextBytes: '), 'Output line should have correct prefix');
  t.ok(lines[2].startsWith('generateSeed: '), 'Output line should have correct prefix');
});
