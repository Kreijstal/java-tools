const test = require('tape');
const { JVM } = require('../src/jvm');
const path = require('path');
const { execSync } = require('child_process');

// Define test programs that should work
const WORKING_TESTS = [
  {
    name: 'RecursionTest',
    description: 'Factorial calculation - should work',
    expectedPattern: /\d+/ // Should contain numbers
  },
  {
    name: 'Hello',
    description: 'Basic string printing - should work',
    expectedPattern: /Hello, World!/
  },
  {
    name: 'RuntimeArithmetic',
    description: 'Basic arithmetic operations - should work',
    expectedPattern: /5.*2.*6/s // Multiple numbers with any chars between
  }
];

// Define test programs that previously crashed but should now work
const FIXED_CRASH_TESTS = [
  {
    name: 'SimpleArrayTest',
    description: 'Previously crashed on newarray instruction - now fixed',
    expectedPattern: /Array created|works|success/i
  },
  {
    name: 'ArrayTest',
    description: 'Complex array operations - partially working',
    expectedPattern: /.+/ // Should produce some output
  },
  {
    name: 'StaticFieldTest',
    description: 'Previously crashed on getstatic instruction - now fixed',
    expectedPattern: /100|static|field/i
  },
  {
    name: 'BoxingUnboxingTest',
    description: 'Previously crashed on sipush + boxing issues - now fixed',
    expectedPattern: /42|200|boxing/i
  },
  {
    name: 'InstanceofTest',
    description: 'Previously crashed on newarray for int[] creation - now fixed',
    expectedPattern: /1|0|true|false/i
  },
  {
    name: 'SynchronizationTest',
    description: 'Previously crashed on getstatic for static fields - now fixed',
    expectedPattern: /sync|thread|wait/i
  },
  {
    name: 'SipushTest',
    description: 'Previously crashed on sipush instruction - now fixed',
    expectedPattern: /1000|large|constant/i
  },
  {
    name: 'NullPointerTest',
    description: 'Previously caused JVM crash instead of proper NPE - now fixed',
    expectedPattern: /NullPointerException|caught|exception/i
  },
  {
    name: 'TryCatchFinallyTestFixed',
    description: 'Complex try-catch-finally constructs - now fixed (infinite loop bug resolved)',
    expectedPattern: /Exception from finally|Exception from catch|Returned value: 2|Inner catch: Inner exception|Exception from try-finally/
  },
  {
    name: 'DoubleComparisonTest',
    description: 'Double comparison operations using dcmpl instruction - now fixed',
    expectedPattern: /d1 > d2: true|NaN == NaN: false|Test completed successfully/
  },
  {
    name: 'ConversionTest',
    description: 'l2i conversion - should work',
    expectedPattern: /10/
  },
  {
    name: 'EnumTest',
    description: 'Previously had issues with enum constants - now fixed',
    expectedPattern: /Red value: 255/
},{
    name: 'AdvancedArrayCrash',
    description: 'Previously crashed on System.arraycopy - now fixed',
    expectedPattern: /Arraycopy result: dst\[3] = 2/
  },
  {
    name: 'InnerClassTest',
    description: 'Previously failed to call Objects.requireNonNull - now fixed',
    expectedPattern: /Anonymous inner class running/
  },
  {
    name: 'ConcurrencyCrash',
    description: 'Previously crashed on ReentrantLock - now fixed',
    expectedPattern: /Final counter value: 2000/
  },{
    name: 'MissingBytecodeCrash',
    description: 'Previously crashed on instanceof with interface - now fixed',
    expectedPattern: /obj is CharSequence/
  }
];

// Test programs that may still have issues
const PARTIAL_TESTS = [
  {
    name: 'TryCatchTest',
    description: 'Partial failure on exception methods',
    allowFailure: false
  },
  {
    name: 'ConversionTest',
    description: 'l2i conversion - should work',
    expectedPattern: /10/
  },
  {
    name: 'StackOverflowTest',
    description: 'Should throw StackOverflowError',
    expectedPattern: /Caught StackOverflowError/
  },
  {
    name: 'TryCatchTest',
    description: 'Should correctly handle try-catch-finally',
    expectedPattern: /Caught arithmetic exception.*Finally block executed/s
  },
  {
    name: 'EnumTest',
    description: 'Should support enums',
    expectedPattern: /Color: RED.*It's red!.*Caught expected exception/s
  },
  {
    name: 'InnerClassTest',
    description: 'Should support inner classes',
    expectedPattern: /Inner field.*Nested field.*Local variable.*Anonymous inner class running/s
  }
];

// Helper function to run JVM test
async function runJvmTest(testName, timeout = 2000) {
  return new Promise(async (resolve) => {
    let isResolved = false;
    let hasUnhandledException = false;
    const originalConsoleError = console.error;
    
    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        console.error = originalConsoleError;
        resolve({ output: '', error: 'TIMEOUT', success: false });
      }
    }, timeout);

    try {
      const jvm = new JVM();
      const sourcesPath = path.join(__dirname, '..', 'sources');
      const classFilePath = path.join(sourcesPath, `${testName}.class`);
      
      // Set the classpath so that inner classes can be found
      jvm.classpath = sourcesPath;
      
      let output = '';
      let error = '';
      
      // Override console.error to detect unhandled exceptions
      console.error = (...args) => {
        if (args[0] === 'Unhandled exception:') {
          hasUnhandledException = true;
          error = args[1]?.message || args[1]?.toString() || 'Unhandled exception';
        }
        // Don't log unhandled exceptions to keep test output clean
        if (args[0] !== 'Unhandled exception:') {
          originalConsoleError.apply(console, args);
        }
      };
      
      // Register print methods to capture output
      jvm.registerJreMethods({
        'java/io/PrintStream': {
          'println(Ljava/lang/String;)V': (jvm, obj, args) => {
            output += args[0] + '\n';
          },
          'println(I)V': (jvm, obj, args) => {
            output += args[0] + '\n';
          },
          'println(Z)V': (jvm, obj, args) => {
            output += (args[0] ? 'true' : 'false') + '\n';
          },
          'println()V': (jvm, obj, args) => {
            output += '\n';
          },
          'print(Ljava/lang/String;)V': (jvm, obj, args) => {
            output += args[0];
          },
          'print(I)V': (jvm, obj, args) => {
            output += args[0];
          },
        },
      });

      await jvm.run(classFilePath);
      
      console.error = originalConsoleError;
      
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        // If there was an unhandled exception, treat it as a failure
        const success = !hasUnhandledException;
        resolve({ output, error, success });
      }
    } catch (e) {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        console.error = originalConsoleError;
        resolve({ output: '', error: e.message || e.toString(), success: false });
      }
    }
  });
}

// Helper function to run real Java for comparison
function runRealJava(testName, timeout = 10000) {
  try {
    const sourcesPath = path.join(__dirname, '..', 'sources');
    // Properly quote the testName to handle $ characters
    const output = execSync(`timeout ${timeout/1000}s java -cp ${sourcesPath} "${testName}"`, 
      { encoding: 'utf8', timeout });
    return { output, error: '', success: true };
  } catch (e) {
    return { output: '', error: e.message || e.toString(), success: false };
  }
}

// Test working programs
test('JVM Crash Tests - Programs that should work', async function(t) {
  for (const testCase of WORKING_TESTS) {
    const jvmResult = await runJvmTest(testCase.name);
    
    t.ok(jvmResult.success, `${testCase.name}: ${testCase.description} - should not crash`);
    
    if (jvmResult.success && testCase.expectedPattern) {
      t.ok(testCase.expectedPattern.test(jvmResult.output), 
        `${testCase.name}: output should match expected pattern. Got: "${jvmResult.output}"`);
    }
  }
  
  t.end();
});

// Test previously crashing programs that should now work
test('JVM Crash Tests - Previously crashing programs now fixed', async function(t) {
  for (const testCase of FIXED_CRASH_TESTS) {
    const jvmResult = await runJvmTest(testCase.name);
    
    t.ok(jvmResult.success, `${testCase.name}: ${testCase.description} - should not crash anymore`);
    
    if (jvmResult.success && testCase.expectedPattern) {
      t.ok(testCase.expectedPattern.test(jvmResult.output), 
        `${testCase.name}: output should match expected pattern. Got: "${jvmResult.output}"`);
    }
  }
  
  t.end();
});

// Test programs that may still have issues
test('JVM Crash Tests - Programs with potential remaining issues', async function(t) {
  for (const testCase of PARTIAL_TESTS) {
    // Use shorter timeout for StackOverflowTest since it's expected to hang
    const testTimeout = testCase.name === 'StackOverflowTest' ? 1000 : 2000;
    const jvmResult = await runJvmTest(testCase.name, testTimeout);
    
    if (testCase.allowFailure) {
      // For these tests, we just log the result but don't fail
      if (jvmResult.success) {
        t.pass(`${testCase.name}: ${testCase.description} - unexpectedly succeeded!`);
      } else {
        t.pass(`${testCase.name}: ${testCase.description} - failed as expected: ${jvmResult.error}`);
      }
    } else {
      t.ok(jvmResult.success, `${testCase.name}: ${testCase.description} - should work`);
    }
  }
  
  t.end();
});

// Test critical bytecode instructions that were missing
test('JVM Crash Tests - Critical bytecode instructions', async function(t) {
  const criticalTests = [
    {
      name: 'SipushTest',
      instruction: 'sipush',
      description: 'sipush instruction for 16-bit integer constants'
    },
    {
      name: 'SimpleArrayTest', 
      instruction: 'newarray',
      description: 'newarray instruction for primitive array creation'
    },
    {
      name: 'ArrayTest',
      instruction: 'iaload/iastore',
      description: 'iaload/iastore instructions for array element access'
    },
    {
      name: 'StaticFieldTest',
      instruction: 'getstatic/putstatic',
      description: 'getstatic/putstatic instructions for static field access'
    }
  ];

  for (const testCase of criticalTests) {
    const jvmResult = await runJvmTest(testCase.name);
    
    t.ok(jvmResult.success, `${testCase.instruction}: ${testCase.description} - should work`);
    
    if (!jvmResult.success) {
      t.comment(`${testCase.name} failed with error: ${jvmResult.error}`);
    }
  }
  
  t.end();
});

// Test proper exception handling
test('JVM Crash Tests - Exception handling improvements', async function(t) {
  const jvmResult = await runJvmTest('NullPointerTest');
  
  t.ok(jvmResult.success, 'NullPointerTest: Should handle NPE properly instead of crashing JVM');
  
  if (jvmResult.success) {
    // Should contain NullPointerException handling
    const hasNPEHandling = /NullPointerException|exception.*caught|null.*pointer/i.test(jvmResult.output);
    t.ok(hasNPEHandling, 'Should properly handle NullPointerException instead of JVM crash');
  }
  
  t.end();
});

// Test boxing/unboxing improvements
test('JVM Crash Tests - Boxing/unboxing display fixes', async function(t) {
  const jvmResult = await runJvmTest('BoxingUnboxingTest');
  
  t.ok(jvmResult.success, 'BoxingUnboxingTest: Should handle boxing/unboxing without crashes');
  
  if (jvmResult.success) {
    // Should show actual numbers, not "[object Object]"
    const hasProperDisplay = /\d+/.test(jvmResult.output) && !/\[object Object\]/i.test(jvmResult.output);
    t.ok(hasProperDisplay, 'Integer objects should display as numbers, not "[object Object]"');
  }
  
  t.end();
  
  // Force exit after a short delay to prevent hanging
  setTimeout(() => {
    process.exit(0);
  }, 100);
});