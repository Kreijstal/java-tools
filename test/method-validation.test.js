const test = require('tape');
const { runTest } = require('./test-helpers');

test('MethodInvocationValidationTest should pass normal method calls', async function(t) {
  t.plan(2);

  const expectedOutput = `Testing method invocation validation
Static method result: 8
Instance method result: 15
All validations passed`;

  const { output } = await runTest('MethodInvocationValidationTest');
  t.ok(true, 'MethodInvocationValidationTest should run without errors');
  t.equal(output.trim(), expectedOutput, 'MethodInvocationValidationTest output should be correct');
});