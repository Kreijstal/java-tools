const { runTest } = require('./test-helpers.js');
const test = require('tape');

test('simple echo program - basic input', async (t) => {
  const inputData = 'Hello World\nTest Input\nquit\n';
  const expectedOutput = `Echo program started. Type 'quit' to exit.
Echo: Hello World
Echo: Test Input
Echo program exited.
`;

  const result = await runTest('SimpleEcho', expectedOutput, t, {
    inputData: inputData
  });

  t.equal(result.output, expectedOutput, 'Echo program should work correctly');
  t.ok(result.success, 'Test should complete successfully');
  t.end();
});

test('simple echo program - empty input', async (t) => {
  const inputData = '\n\nquit\n';
  const expectedOutput = `Echo program started. Type 'quit' to exit.
Echo: 
Echo: 
Echo program exited.
`;

  const result = await runTest('SimpleEcho', expectedOutput, t, {
    inputData: inputData
  });

  t.equal(result.output, expectedOutput, 'Echo program should handle empty lines');
  t.ok(result.success, 'Test should complete successfully');
  t.end();
});

test('simple echo program - immediate quit', async (t) => {
  const inputData = 'quit\n';
  const expectedOutput = `Echo program started. Type 'quit' to exit.
Echo program exited.
`;

  const result = await runTest('SimpleEcho', expectedOutput, t, {
    inputData: inputData
  });

  t.equal(result.output, expectedOutput, 'Echo program should quit immediately');
  t.ok(result.success, 'Test should complete successfully');
  t.end();
});

test('simple echo program - multiple lines', async (t) => {
  const inputData = 'Line 1\nLine 2\nLine 3\nquit\n';
  const expectedOutput = `Echo program started. Type 'quit' to exit.
Echo: Line 1
Echo: Line 2
Echo: Line 3
Echo program exited.
`;

  const result = await runTest('SimpleEcho', expectedOutput, t, {
    inputData: inputData
  });

  t.equal(result.output, expectedOutput, 'Echo program should handle multiple lines');
  t.ok(result.success, 'Test should complete successfully');
  t.end();
});
