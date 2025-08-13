const test = require('tape');
const { JVM } = require('../src/jvm');
const path = require('path');

test('JVM should execute RuntimeArithmetic.class with all arithmetic operations', async function(t) {
  t.plan(1);

  const jvm = new JVM();
  const classFilePath = path.join(__dirname, '..', 'sources', 'RuntimeArithmetic.class');

  let output = '';
  const originalLog = console.log;
  console.log = function(message) {
    output += message + '\n';
  };

  await jvm.run(classFilePath, { silent: true });

  console.log = originalLog;

  const expected = '5\n2\n6\n';
  t.equal(output, expected, 'The JVM should correctly execute iadd, isub, and imul operations');
});

test('JVM should execute VerySimple.class with subtraction', async function(t) {
  t.plan(1);

  const jvm = new JVM();
  const classFilePath = path.join(__dirname, '..', 'sources', 'VerySimple.class');

  let output = '';
  const originalLog = console.log;
  console.log = function(message) {
    output += message + '\n';
  };

  await jvm.run(classFilePath, { silent: true });

  console.log = originalLog;

  t.equal(output, '1\n', 'The JVM should correctly execute subtraction (3-2=1)');
});

test('JVM should execute SmallDivisionTest.class with division and remainder operations', async function(t) {
  t.plan(1);

  const jvm = new JVM();
  const classFilePath = path.join(__dirname, '..', 'sources', 'SmallDivisionTest.class');

  let output = '';
  const originalLog = console.log;
  console.log = function(message) {
    output += message + '\n';
  };

  await jvm.run(classFilePath, { silent: true });

  console.log = originalLog;

  const expected = '2\n1\n2\n0\n';
  t.equal(output, expected, 'The JVM should correctly execute idiv and irem operations');
});

test('JVM should execute ConstantsTest.class with iconst instructions', async function(t) {
  t.plan(3);

  const jvm = new JVM();
  const classFilePath = path.join(__dirname, '..', 'sources', 'ConstantsTest.class');

  let output = '';
  const originalLog = console.log;
  console.log = function(message) {
    output += message + '\n';
  };

  await jvm.run(classFilePath, { silent: true });

  console.log = originalLog;

  const lines = output.trim().split('\n');
  t.equal(lines[0], '0', 'iconst_0 should work correctly');
  t.equal(lines[1], '1', 'iconst_1 should work correctly');
  t.equal(lines[2], '3', 'iconst_3 should work correctly');
});