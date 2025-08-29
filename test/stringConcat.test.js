const test = require('tape');
const { JVM } = require('../src/jvm');
const path = require('path');

test('JVM should execute SimpleStringConcat', async (t) => {
  t.plan(1);

  const jvm = new JVM({ classpath: ['sources'] });

  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(Ljava/lang/String;)V': (jvm, obj, args) => {
        output += args[0];
      },
    },
  });

  await jvm.run('SimpleStringConcat');
  t.equal(output.trim(), 'Hello World', 'SimpleStringConcat should work');
});

test('JVM should execute StringConcatMethod', async (t) => {
  t.plan(1);

  const jvm = new JVM({ classpath: ['sources'] });

  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(Ljava/lang/String;)V': (jvm, obj, args) => {
        output += args[0];
      },
    },
  });

  await jvm.run('StringConcatMethod');
  t.equal(output.trim(), 'Hello World', 'StringConcatMethod should work');
});