const { runTest } = require('./test-helpers.js');
const test = require('tape');

test('simple stdin test - basic input', async (t) => {
  const inputData = 'Hello World';
  const expectedOutput = 'You entered: Hello World\n';

  const result = await runTest('SimpleStdinTest', expectedOutput, t, {
    inputData: inputData
  });

  t.equal(result.output, expectedOutput, 'Simple stdin test should work correctly');
  t.ok(result.success, 'Test should complete successfully');
  t.end();
});

test('simple stdin test - empty input', async (t) => {
  const inputData = '';
  const expectedOutput = 'No input received\n';

  const result = await runTest('SimpleStdinTest', expectedOutput, t, {
    inputData: inputData
  });

  t.equal(result.output, expectedOutput, 'Simple stdin test should handle empty input');
  t.ok(result.success, 'Test should complete successfully');
  t.end();
});

test('simple stdin test - special characters', async (t) => {
  const inputData = 'Test\twith\ttabs';
  const expectedOutput = 'You entered: Test\twith\ttabs\n';

  const result = await runTest('SimpleStdinTest', expectedOutput, t, {
    inputData: inputData
  });

  t.equal(result.output, expectedOutput, 'Simple stdin test should handle special characters');
  t.ok(result.success, 'Test should complete successfully');
  t.end();
});

test('simple stdin test - numbers', async (t) => {
  const inputData = '12345';
  const expectedOutput = 'You entered: 12345\n';

  const result = await runTest('SimpleStdinTest', expectedOutput, t, {
    inputData: inputData
  });

  t.equal(result.output, expectedOutput, 'Simple stdin test should handle numbers');
  t.ok(result.success, 'Test should complete successfully');
  t.end();
});
