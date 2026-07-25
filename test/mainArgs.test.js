const test = require('tape');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

function compileArgsLengthTest(t) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-frontend-main-args-'));
  t.teardown(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  frontend.compileJavaFile(path.resolve(__dirname, '../sources/ArgsLengthTest.java'), {
    outputDir,
    sourceFileName: 'ArgsLengthTest.java',
  });
  return outputDir;
}

test('JVM provides an empty args array by default', async (t) => {
  t.plan(1);
  const classpath = compileArgsLengthTest(t);
  const jvm = new JVM({ classpath });
  const getOutput = setupPrintCapture(jvm);

  await jvm.run('ArgsLengthTest');
  t.equal(getOutput().trim(), '0', 'args.length should be zero when nothing is passed');
});

test('JVM forwards provided CLI arguments to main', async (t) => {
  t.plan(1);
  const classpath = compileArgsLengthTest(t);
  const jvm = new JVM({ classpath });
  const getOutput = setupPrintCapture(jvm);

  await jvm.run('ArgsLengthTest', { args: ['alpha', 'beta', 'gamma'] });
  t.equal(getOutput().trim(), '3', 'args.length should match explicit args array');
});
