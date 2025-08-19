const test = require('tape');
const { JVM } = require('../src/jvm');
const path = require('path');

test('JVM should execute Hello.class and print "Hello, World!"', async function(t) {
  t.plan(1);

  const jvm = new JVM();
  const classFilePath = path.join(__dirname, '..', 'sources', 'Hello.class');

  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(Ljava/lang/String;)V': (jvm, obj, args) => {
        output += args[0];
      },
    },
  });

  await jvm.run(classFilePath);

  t.equal(output, 'Hello, World!', 'The JVM should correctly print "Hello, World!"');
});

test('JVM should execute FinallyTest.class and print correct output', async function(t) {
  t.plan(1);

  const jvm = new JVM();
  const classFilePath = path.join(__dirname, '..', 'sources', 'FinallyTest.class');

  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(Ljava/lang/String;)V': (jvm, obj, args) => {
        output += args[0] + '\\n';
      },
    },
  });

  await jvm.run(classFilePath);

  const expectedOutput = 'Test 1: Normal execution\\n' +
    'In try block (normal)\\n' +
    'In finally block (normal)\\n' +
    '\\n' +
    'Test 2: Exceptional execution\\n' +
    'In try block (exception)\\n' +
    'In catch block (exception)\\n' +
    'In finally block (exception)\\n';

  t.equal(output, expectedOutput, 'The JVM should correctly handle finally blocks');
});