const test = require('tape');
const { JVM } = require('../src/jvm');

test('JVM invokevirtual should support StringMethodsTest', async (t) => {
  t.plan(5);

  const jvm = new JVM();
  
  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(Ljava/lang/String;)V': (jvm, obj, args) => {
        output += args[0] + '\n';
      },
    },
  });

  await jvm.run('sources/StringMethodsTest.class');
  const lines = output.trim().split('\n');
  t.equal(lines[0], 'Hello World', 'Initial string should be correct');
  t.equal(lines[1], 'HELLO WORLD', 'toUpperCase should work');
  t.equal(lines[2], 'hello world', 'toLowerCase should work');
  t.equal(lines[3], 'Hello Java', 'replace should work');
  t.equal(lines[4], 'Tests completed', 'Final line should be correct');
});

test('JVM invokevirtual should support InvokeVirtualTest', async (t) => {
  t.plan(2);

  const jvm = new JVM();

  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(Ljava/lang/String;)V': (jvm, obj, args) => {
        output += args[0] + '\n';
      },
    },
  });

  await jvm.run('sources/InvokeVirtualTest.class');
  const testLines = output.trim().split('\n');
  t.equal(testLines[0], 'Hello World', 'Should print from Thing.print');
  t.equal(testLines[1], 'Test completed', 'Should print from main');
});