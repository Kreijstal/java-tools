const test = require('tape');
const { runTest } = require('./test-helpers.js');

test('JVM should execute Hello.class and print "Hello, World!"', t => {
  t.plan(1);
  runTest('Hello', 'Hello, World!', t);
});

test('JVM should execute FinallyTest.class and print correct output', t => {
  t.plan(1);
  const expectedOutput = 'Test 1: Normal execution\n' +
    'In try block (normal)\n' +
    'In finally block (normal)\n' +
    '\n' +
    'Test 2: Exceptional execution\n' +
    'In try block (exception)\n' +
    'In catch block (exception)\n' +
    'In finally block (exception)';
  runTest('FinallyTest', expectedOutput, t);
});

test('JVM should execute TryCatchFinallyTest.class and print correct output', t => {
  t.plan(1);
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
    'In catch\n' +
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
  runTest('TryCatchFinallyTest', expectedOutput, t, { timeout: 2000 });
});