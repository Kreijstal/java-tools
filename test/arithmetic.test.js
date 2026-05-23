const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const frontend = require('../src/java-frontend');
const { runTest } = require('./test-helpers');
const { CONSTANTS_ICONST_PREFIX, expectedOutputForClass } = require('./fixtures/runtimeExpectations');

function compileFrontendClass(t, sourceFile) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-frontend-arithmetic-'));
  t.teardown(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  frontend.compileJavaFile(path.join(__dirname, '..', 'sources', sourceFile), {
    outputDir,
    sourceFileName: sourceFile,
  });
  return outputDir;
}

test('JVM should execute frontend-generated RuntimeArithmetic.class with all arithmetic operations', async t => {
  t.plan(2);
  const classpath = compileFrontendClass(t, 'RuntimeArithmetic.java');
  await runTest('RuntimeArithmetic', expectedOutputForClass('RuntimeArithmetic'), t, { classpath });
});

test('JVM should execute frontend-generated VerySimple.class with subtraction', async t => {
  t.plan(2);
  const classpath = compileFrontendClass(t, 'VerySimple.java');
  await runTest('VerySimple', expectedOutputForClass('VerySimple'), t, { classpath });
});

test('JVM should execute frontend-generated SmallDivisionTest.class with division and remainder operations', async t => {
  t.plan(2);
  const classpath = compileFrontendClass(t, 'SmallDivisionTest.java');
  await runTest('SmallDivisionTest', expectedOutputForClass('SmallDivisionTest'), t, { classpath, silent: true });
});

test('JVM should execute frontend-generated ConstantsTest.class with iconst instructions', async t => {
  t.plan(3);
  const classpath = compileFrontendClass(t, 'ConstantsTest.java');
  const { output } = await runTest('ConstantsTest', undefined, undefined, { classpath, silent: true });
  const lines = output.trim().split('\n');
  t.equal(lines[0], CONSTANTS_ICONST_PREFIX[0], 'iconst_0 should work correctly');
  t.equal(lines[1], CONSTANTS_ICONST_PREFIX[1], 'iconst_1 should work correctly');
  t.equal(lines[2], CONSTANTS_ICONST_PREFIX[2], 'iconst_3 should work correctly');
});
