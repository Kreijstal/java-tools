const test = require('tape');
const { JVM } = require('../src/jvm');
const path = require('path');

test('JVM should handle exceptions', async function(t) {
  t.plan(1);

  const jvm = new JVM();
  const classFilePath = path.join(__dirname, '..', 'sources', 'ExceptionTest.class');

  let output = '';
  const originalLog = console.log;
  console.log = function(message) {
    output += message;
  };

  await jvm.run(classFilePath, { silent: true });

  console.log = originalLog;

  t.equal(output, 'Caught exception', 'The JVM should correctly handle the exception');
});