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

test('JVM should execute TryCatchFinallyTest.class and print correct output', async function(t) {
  t.plan(1);

  const jvm = new JVM();
  const classFilePath = path.join(__dirname, '..', 'sources', 'TryCatchFinallyTest.class');

  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(Ljava/lang/String;)V': (jvm, obj, args) => {
        output += args[0] + '\\n';
      },
       'println(I)V': (jvm, obj, args) => {
        output += args[0] + '\\n';
      }
    },
  });

  // Use timeout of 2 seconds as mentioned in requirements to avoid infinite loops
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Test timeout - possible infinite loop')), 2000);
  });
  
  try {
    await Promise.race([jvm.run(classFilePath), timeoutPromise]);
  } catch (error) {
    // If timeout or other error, we still want to check partial output
    if (!error.message.includes('timeout')) {
      // Re-throw non-timeout errors
      throw error;
    }
  }

  const expectedOutput = '--- Test: Exception in finally ---\\n' +
    'Outer try\\n' +
    'Inner finally, throwing new exception\\n' +
    'Caught: Exception from finally\\n' +
    '\\n' +
    '--- Test: Exception in catch ---\\n' +
    'Outer try\\n' +
    'Outer catch, throwing new exception\\n' +
    'Caught: Exception from catch\\n' +
    '\\n' +
    '--- Test: Return in finally ---\\n' +
    'In try\\n' +
    'In catch\\n' +
    'In finally\\n' +
    'Returned value: 2\\n' +
    '\\n' +
    '--- Test: Nested try-catch-finally ---\\n' +
    'Outer try\\n' +
    'Inner try\\n' +
    'Inner catch: Inner exception\\n' +
    'Inner finally\\n' +
    'Outer try after inner\\n' +
    'Outer finally\\n' +
    '\\n' +
    '--- Test: Try-finally without catch ---\\n' +
    'Inner try\\n' +
    'Inner finally\\n' +
    'Caught: Exception from try-finally\\n';

  t.equal(output.trim(), expectedOutput.trim(), 'The JVM should correctly handle all try-catch-finally edge cases');
});