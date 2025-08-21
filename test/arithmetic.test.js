const test = require('tape');
const { runTest } = require('./test-helpers');

test('JVM should execute RuntimeArithmetic.class with all arithmetic operations', t => {
  t.plan(1);
  const expected = '5\n2\n6';
  runTest('RuntimeArithmetic', expected, t);
});

test('JVM should execute VerySimple.class with subtraction', t => {
  t.plan(1);
  runTest('VerySimple', '1', t);
});

test('JVM should execute SmallDivisionTest.class with division and remainder operations', t => {
  t.plan(1);
  const expected = '2\n1\n2\n0';
  runTest('SmallDivisionTest', expected, t, { silent: true });
});

test('JVM should execute ConstantsTest.class with iconst instructions', async t => {
  t.plan(3);
  const { output } = await runTest('ConstantsTest', undefined, undefined, { silent: true });
  const lines = output.trim().split('\n');
  t.equal(lines[0], '0', 'iconst_0 should work correctly');
  t.equal(lines[1], '1', 'iconst_1 should work correctly');
  t.equal(lines[2], '3', 'iconst_3 should work correctly');
});