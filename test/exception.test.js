const test = require('tape');
const { runTest } = require('./test-helpers');

test('Exception Tests', async function(t) {
  t.test('JVM should handle basic exceptions', async t => {
    t.plan(2);
    await runTest('ExceptionTest', 'Caught exception', t);
  });

  t.test('JVM should handle finally blocks', async t => {
    t.plan(2);
    const expectedOutput = 'Test 1: Normal execution\n' +
      'In try block (normal)\n' +
      'In finally block (normal)\n' +
      '\n' +
      'Test 2: Exceptional execution\n' +
      'In try block (exception)\n' +
      'In catch block (exception)\n' +
      'In finally block (exception)';
    await runTest('FinallyTest', expectedOutput, t);
  });

  t.test('JVM should handle complex try-catch-finally constructs', async t => {
    t.plan(2);
    const expectedOutput = '--- Test: Exception in finally ---\n' +
      'Outer try\n' +
      'Inner finally, throwing new exception\n' +
      'Caught: Exception from finally\n' +
      '\n' +
      '--- Test: Exception in catch ---\n' +
      'Outer try\n' +
      'Outer catch, throwing new exception\n' +
      'Caught: Exception from catch\n' +
      '\n' +
      '--- Test: Return in finally ---\n' +
      'In try\n' +
      'In finally\n' +
      'Returned value: 2\n' +
      '\n' +
      '--- Test: Nested try-catch-finally ---\n' +
      'Outer try\n' +
      'Inner try\n' +
      'Inner catch: Inner exception\n' +
      'Inner finally\n' +
      'Outer try after inner\n' +
      'Outer finally\n' +
      '\n' +
      '--- Test: Try-finally without catch ---\n' +
      'Inner try\n' +
      'Inner finally\n' +
      'Caught: Exception from try-finally';
    await runTest('TryCatchFinallyTest', expectedOutput, t);
  });

  t.test('JVM should handle NullPointerException', async t => {
    t.plan(2);
    const expectedOutput = 'Testing null pointer operations...\n' +
      'Caught NullPointerException as expected\n' +
      'Caught second NullPointerException\n' +
      'Caught NPE on array.length\n' +
      'Test completed';
    await runTest('NullPointerTest', expectedOutput, t);
  });

  t.test('JVM should handle StackOverflowError', async t => {
    t.plan(2);
    const expectedOutput = '=== Stack Overflow Test ===\n' +
      'Starting infinite recursion...\n' +
      'Recursion depth: 1000\n' +
      'Caught StackOverflowError at depth: 1024\n' +
      'Test completed';
    await runTest('StackOverflowTest', expectedOutput, t);
  });
});