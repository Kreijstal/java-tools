const test = require('tape');
const { JVM } = require('../src/jvm');
const path = require('path');

test('JVM should execute ConstructorPrinter and print static and constructor messages', async function(t) {
  t.plan(1);

  const jvm = new JVM();
  const classFilePath = path.join(__dirname, '..', 'sources', 'ConstructorPrinter.class');

  let output = '';
  jvm._setTestOutputCallback((char) => {
    output += char;
  });

  await jvm.run(classFilePath);

  const expectedOrder = [
    'Static block has been executed.',
    'Hello from the constructor!'
  ];

  // The output will have newlines which might vary, so let's check for substrings in order.
  const lines = output.trim().split('\n').map(l => l.trim());

  const actual = lines.join('\n');
  const expected = expectedOrder.join('\n');

  t.equal(actual, expected, 'Output should contain static and constructor messages in the correct order');
});
