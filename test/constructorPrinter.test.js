const test = require('tape');
const path = require('path');
const { runTest } = require('./test-helpers.js');

test('JVM should execute ConstructorPrinter.class and print "Hello, World!"', t => {
  t.plan(2);
  const expectedOutput = 'Static block has been executed.\nHello from the constructor!';
  runTest('ConstructorPrinter', expectedOutput, t);
});
