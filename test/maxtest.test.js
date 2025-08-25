const test = require('tape');
const { runTest } = require('./test-helpers');

test('MaxTest should run correctly', async function(t) {
  t.plan(2);

  const expectedOutput = `The maximum of 5 and 10 is 10
The maximum of -5 and -10 is -5`;

  const { output } = await runTest('MaxTest');
  t.ok(true, 'MaxTest should run without errors');
  t.equal(output.trim(), expectedOutput, 'MaxTest output should be correct');
});