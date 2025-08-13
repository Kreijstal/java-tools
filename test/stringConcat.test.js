const test = require('tape');
const { JVM } = require('../src/jvm');
const path = require('path');

test('JVM should execute string concatenation examples', async (t) => {
  t.plan(2);

  const jvm = new JVM();
  let output = '';
  const originalLog = console.log;
  console.log = function(message) {
    output += message;
  };

  await jvm.run(path.join(__dirname, '..', 'sources', 'SimpleStringConcat.class'), { silent: true });
  t.equal(output.trim(), 'Hello World', 'SimpleStringConcat should work');

  output = '';
  await jvm.run(path.join(__dirname, '..', 'sources', 'StringConcatMethod.class'), { silent: true });
  t.equal(output.trim(), 'Hello World', 'StringConcatMethod should work');

  console.log = originalLog;
});