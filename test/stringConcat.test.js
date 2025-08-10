const test = require('tape');
const JVM = require('../src/jvm');

test('JVM should execute string concatenation examples', (t) => {
  const jvm = new JVM();
  
  // Capture console output
  const originalLog = console.log;
  let output = '';
  console.log = (msg) => {
    output += msg + '\n';
  };

  // Test simple string concatenation (compile-time optimized)
  output = '';
  jvm.run('sources/SimpleStringConcat.class', { silent: true });
  t.equal(output.trim(), 'Hello World', 'Simple string concatenation should work');

  // Test String.concat method calls
  output = '';
  jvm.run('sources/StringConcatMethod.class', { silent: true });
  t.equal(output.trim(), 'Hello World', 'String.concat method should work');

  // Restore console.log
  console.log = originalLog;
  
  t.end();
});