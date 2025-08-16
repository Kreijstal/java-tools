const test = require('tape');
const { JVM } = require('../src/jvm');
const path = require('path');

test('JVM should execute SimpleStringConcat', async (t) => {
  t.plan(1);

  const jvm = new JVM();

  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(Ljava/lang/String;)V': (jvm, obj, args) => {
        output += args[0];
      },
    },
  });

  await jvm.run(path.join(__dirname, '..', 'sources', 'SimpleStringConcat.class'));
  t.equal(output.trim(), 'Hello World', 'SimpleStringConcat should work');
});

test('JVM should execute StringConcatMethod', async (t) => {
  t.plan(1);

  const jvm = new JVM();

  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(Ljava/lang/String;)V': (jvm, obj, args) => {
        output += args[0];
      },
    },
  });

  await jvm.run(path.join(__dirname, '..', 'sources', 'StringConcatMethod.class'));
  t.equal(output.trim(), 'Hello World', 'StringConcatMethod should work');
});