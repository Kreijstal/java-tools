const test = require('tape');
const { JVM } = require('../src/jvm');

function setupPrintCapture(jvm) {
  let out = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(I)V': (jvmInstance, obj, args) => {
        out += `${args[0]}\n`;
      },
    },
  });
  return () => out;
}

test('JVM provides an empty args array by default', async (t) => {
  t.plan(1);
  const jvm = new JVM({ classpath: ['sources'] });
  const getOutput = setupPrintCapture(jvm);

  await jvm.run('ArgsLengthTest');
  t.equal(getOutput().trim(), '0', 'args.length should be zero when nothing is passed');
});

test('JVM forwards provided CLI arguments to main', async (t) => {
  t.plan(1);
  const jvm = new JVM({ classpath: ['sources'] });
  const getOutput = setupPrintCapture(jvm);

  await jvm.run('ArgsLengthTest', { args: ['alpha', 'beta', 'gamma'] });
  t.equal(getOutput().trim(), '3', 'args.length should match explicit args array');
});
