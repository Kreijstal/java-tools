const test = require('tape');
const path = require('path');
const { runTest } = require('./test-helpers');

test('Simple output test', async function(t) {
  t.plan(1);

  const { output } = await runTest('Hello');
  t.equal(output.trim(), 'Hello, World!', 'The output should be "Hello, World!"');
});
