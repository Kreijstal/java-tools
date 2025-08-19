const test = require('tape');
const { JVM } = require('../src/jvm');
const path = require('path');

test('JNI Integration with Java Bytecode Execution', async (t) => {
  const jvm = new JVM({ verbose: false });
  
  // Register the native methods that NativeTest.java expects
  jvm.registerNativeMethod('NativeTest', 'nativeAdd', '(II)I', (jniEnv, thisObj, args) => {
    return args[0] + args[1];
  });
  
  jvm.registerNativeMethod('NativeTest', 'nativeGreeting', '(Ljava/lang/String;)Ljava/lang/String;', 
    (jniEnv, thisObj, args) => {
      const name = args[0].toString();
      return jniEnv.internString(`Hello, ${name}!`);
    }
  );
  
  jvm.registerNativeMethod('NativeTest', 'nativeIsPrime', '(I)Z', (jniEnv, thisObj, args) => {
    const n = args[0];
    if (n <= 1) return false;
    if (n <= 3) return true;
    if (n % 2 === 0 || n % 3 === 0) return false;
    
    for (let i = 5; i * i <= n; i += 6) {
      if (n % i === 0 || n % (i + 2) === 0) {
        return false;
      }
    }
    return true;
  });

  // Capture process.stdout output since that's what System.out uses
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += chunk.toString();
    return true;
  };

  try {
    // Execute the Java class
    const classPath = path.join(__dirname, '..', 'sources', 'NativeTest.class');
    await jvm.run(classPath);
    
    // Restore stdout
    process.stdout.write = originalWrite;
    
    // Verify the output contains expected results
    t.ok(output.includes('=== Native Method Test ==='), 'Should print test header');
    t.ok(output.includes('nativeAdd(5, 3) = 8'), 'Native addition should work correctly');
    t.ok(output.includes('nativeGreeting("World") = Hello, World!'), 'Native string method should work');
    t.ok(output.includes('nativeIsPrime(17) = true'), 'Native prime check should work');
    t.ok(output.includes('=== Test Complete ==='), 'Should print test completion');
    
    console.log('=== JNI Integration Test Output ===');
    console.log(output);
    
  } catch (error) {
    process.stdout.write = originalWrite;
    t.fail(`Execution failed: ${error.message}`);
  }

  t.end();
});

test('JNI Method Resolution Priority', async (t) => {
  const jvm = new JVM({ verbose: false });
  
  // Test that JNI methods take priority over JRE methods
  let jniCalled = false;
  jvm.registerNativeMethod('java/lang/Object', 'toString', '()Ljava/lang/String;', 
    (jniEnv, thisObj, args) => {
      jniCalled = true;
      return jniEnv.internString('JNI toString called');
    }
  );
  
  // Create an object and call toString through method resolution
  const obj = { type: 'java/lang/Object' };
  const method = jvm._jreFindMethod('java/lang/Object', 'toString', '()Ljava/lang/String;');
  
  t.ok(method, 'toString method should be found');
  
  if (method) {
    const result = method(jvm, obj, [], null);
    t.ok(jniCalled, 'JNI method should be called instead of JRE method');
    t.equal(result.toString(), 'JNI toString called', 'JNI method result should be returned');
  }
  
  t.end();
});