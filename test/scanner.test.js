const { runTest } = require('./test-helpers.js');
const test = require('tape');

test('Scanner - basic input with StdinDemo', async (t) => {
  const inputData = 'Alice\n42\n';
  const expectedOutput = 'Hello! What\'s your name?\n' +
                        'Nice to meet you, Alice!\n' +
                        'What\'s your favorite number?\n' +
                        'Great choice! 42 is a wonderful number.\n';

  const result = await runTest('StdinDemo', expectedOutput, t, {
    inputData: inputData
  });

  t.equal(result.output, expectedOutput, 'Scanner should work with nextLine() and nextInt()');
  t.ok(result.success, 'Test should complete successfully');
  t.end();
});

test('Scanner - different inputs', async (t) => {
  const inputData = 'Bob\n123\n';
  const expectedOutput = 'Hello! What\'s your name?\n' +
                        'Nice to meet you, Bob!\n' +
                        'What\'s your favorite number?\n' +
                        'Great choice! 123 is a wonderful number.\n';

  const result = await runTest('StdinDemo', expectedOutput, t, {
    inputData: inputData
  });

  t.equal(result.output, expectedOutput, 'Scanner should handle different string and int inputs');
  t.ok(result.success, 'Test should complete successfully');
  t.end();
});

test('Scanner - whitespace handling', async (t) => {
  const inputData = '  Charlie  \n  456  \n';
  const expectedOutput = 'Hello! What\'s your name?\n' +
                        'Nice to meet you,   Charlie  !\n' +
                        'What\'s your favorite number?\n' +
                        'Great choice! 456 is a wonderful number.\n';

  const result = await runTest('StdinDemo', expectedOutput, t, {
    inputData: inputData
  });

  t.equal(result.output, expectedOutput, 'Scanner should handle whitespace correctly');
  t.ok(result.success, 'Test should complete successfully');
  t.end();
});