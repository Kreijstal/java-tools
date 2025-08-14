const test = require('tape');
const { JVM } = require('../src/jvm');

test('JVM invokevirtual should support various Java methods', async (t) => {
  t.plan(7);

  const jvm = new JVM();
  
  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream.println(Ljava/lang/String;)V': (j, o, a) => {
      output += a[0] + '\n';
    }
  });

  // Test enhanced invokevirtual with string methods
  output = '';
  await jvm.run('sources/StringMethodsTest.class', { silent: true });
  const lines = output.trim().split('\n');
  t.equal(lines[0], 'Hello World', 'Basic string should print correctly');
  t.equal(lines[1], 'HELLO WORLD', 'String.toUpperCase should work');
  t.equal(lines[2], 'hello world', 'String.toLowerCase should work');
  t.equal(lines[3], 'Hello Java', 'String.concat should work');
  t.equal(lines[4], 'Tests completed', 'PrintStream.println should work');

  // Test complex invokevirtual calls
  output = '';
  await jvm.run('sources/InvokeVirtualTest.class', { silent: true });
  const testLines = output.trim().split('\n');
  t.equal(testLines[0], 'Hello World', 'Complex string concatenation should work');
  t.equal(testLines[1], 'Test completed', 'Multiple println calls should work');
});