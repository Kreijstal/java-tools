const test = require('tape');
const { JVM } = require('../src/jvm');

test('JNI Native Method Registration and Execution', (t) => {
  const jvm = new JVM({ verbose: false });

  // Test 1: Register a simple native method
  t.test('should register and find native methods', (st) => {
    const testImplementation = (jniEnv, thisObj, args) => {
      return 42;
    };

    jvm.registerNativeMethod('com/test/Native', 'getValue', '()I', testImplementation);
    
    const foundMethod = jvm.hasNativeMethod('com/test/Native', 'getValue', '()I');
    st.true(foundMethod, 'Native method should be found after registration');
    
    const nativeMethods = jvm.getNativeMethods('com/test/Native');
    st.equal(nativeMethods.length, 1, 'Should have one native method registered');
    st.equal(nativeMethods[0].methodName, 'getValue', 'Method name should match');
    st.equal(nativeMethods[0].descriptor, '()I', 'Descriptor should match');
    
    st.end();
  });

  // Test 2: Test native method execution through JRE method lookup
  t.test('should execute native methods through _jreFindMethod', (st) => {
    let executionCount = 0;
    const testImplementation = (jniEnv, thisObj, args) => {
      executionCount++;
      return jniEnv.internString('Hello from native!');
    };

    jvm.registerNativeMethod('com/test/Native', 'getMessage', '()Ljava/lang/String;', testImplementation);
    
    const method = jvm._jreFindMethod('com/test/Native', 'getMessage', '()Ljava/lang/String;');
    st.ok(method, 'Should find registered native method through _jreFindMethod');
    
    if (method) {
      const result = method(jvm, null, [], null);
      st.equal(executionCount, 1, 'Native method should have been executed');
      st.equal(result.toString(), 'Hello from native!', 'Should return correct string value');
    }
    
    st.end();
  });

  // Test 3: Test JNI environment object
  t.test('should provide proper JNI environment', (st) => {
    let capturedEnv = null;
    const testImplementation = (jniEnv, thisObj, args) => {
      capturedEnv = jniEnv;
      return null;
    };

    jvm.registerNativeMethod('com/test/Native', 'testEnv', '()V', testImplementation);
    
    const method = jvm._jreFindMethod('com/test/Native', 'testEnv', '()V');
    method(jvm, null, [], null);
    
    st.ok(capturedEnv, 'JNI environment should be provided');
    st.equal(capturedEnv.className, 'com/test/Native', 'Environment should have correct class name');
    st.equal(capturedEnv.methodName, 'testEnv', 'Environment should have correct method name');
    st.equal(capturedEnv.descriptor, '()V', 'Environment should have correct descriptor');
    st.ok(typeof capturedEnv.internString === 'function', 'Environment should provide internString function');
    st.ok(typeof capturedEnv.createObject === 'function', 'Environment should provide createObject function');
    
    st.end();
  });

  // Test 4: Test built-in native methods
  t.test('should have built-in native methods registered', (st) => {
    // Test System.currentTimeMillis()
    const currentTimeMethod = jvm._jreFindMethod('java/lang/System', 'currentTimeMillis', '()J');
    st.ok(currentTimeMethod, 'System.currentTimeMillis should be registered');
    
    if (currentTimeMethod) {
      const time = currentTimeMethod(jvm, null, [], null);
      st.ok(typeof time === 'number' && time > 0, 'Should return a positive timestamp');
    }

    // Test Object.hashCode()  
    const hashCodeMethod = jvm._jreFindMethod('java/lang/Object', 'hashCode', '()I');
    st.ok(hashCodeMethod, 'Object.hashCode should be registered');
    
    if (hashCodeMethod) {
      const obj = { type: 'java/lang/Object' };
      const hash1 = hashCodeMethod(jvm, obj, [], null);
      const hash2 = hashCodeMethod(jvm, obj, [], null);
      st.equal(hash1, hash2, 'Same object should return same hash code');
      st.ok(typeof hash1 === 'number', 'Hash code should be a number');
    }
    
    st.end();
  });

  // Test 5: Test backward compatibility with legacy JRE methods
  t.test('should maintain backward compatibility', (st) => {
    // This tests that existing JRE methods still work
    const stringMethod = jvm._jreFindMethod('java/lang/String', 'length', '()I');
    st.ok(stringMethod, 'Legacy JRE methods should still be found');
    st.end();
  });

  t.end();
});

test('JNI Native Library Loading', (t) => {
  const jvm = new JVM({ verbose: false });

  t.test('should load native library from object', (st) => {
    const testLibrary = {
      name: 'TestLib',
      version: '1.0',
      nativeMethods: {
        'com/test/LibTest': {
          'add(II)I': (jniEnv, thisObj, args) => args[0] + args[1],
          'multiply(II)I': (jniEnv, thisObj, args) => args[0] * args[1]
        }
      }
    };

    const library = jvm.loadNativeLibrary('testlib', testLibrary);
    st.equal(library.name, 'TestLib', 'Library should be loaded correctly');
    
    // Check that methods were auto-registered
    const addMethod = jvm._jreFindMethod('com/test/LibTest', 'add', '(II)I');
    st.ok(addMethod, 'Library methods should be auto-registered');
    
    if (addMethod) {
      const result = addMethod(jvm, null, [5, 3], null);
      st.equal(result, 8, 'Library method should execute correctly');
    }
    
    st.end();
  });

  t.test('should handle library loading errors gracefully', (st) => {
    st.throws(() => {
      jvm.loadNativeLibrary('nonexistent', '/path/that/does/not/exist.js');
    }, /Failed to load native library/, 'Should throw error for non-existent library');
    
    st.end();
  });

  t.end();
});

test('JNI Method Signature Handling', (t) => {
  const jvm = new JVM({ verbose: false });

  t.test('should handle different method signatures', (st) => {
    // Test void method
    jvm.registerNativeMethod('com/test/Sig', 'voidMethod', '()V', (jniEnv) => {});
    
    // Test method with primitive parameters
    jvm.registerNativeMethod('com/test/Sig', 'intMethod', '(I)I', (jniEnv, thisObj, args) => args[0] * 2);
    
    // Test method with object parameters
    jvm.registerNativeMethod('com/test/Sig', 'stringMethod', '(Ljava/lang/String;)Ljava/lang/String;', 
      (jniEnv, thisObj, args) => jniEnv.internString('Hello ' + args[0]));

    st.equal(jvm.getNativeMethods('com/test/Sig').length, 3, 'All methods should be registered');
    
    // Test execution
    const intMethod = jvm._jreFindMethod('com/test/Sig', 'intMethod', '(I)I');
    if (intMethod) {
      const result = intMethod(jvm, null, [21], null);
      st.equal(result, 42, 'Integer method should work correctly');
    }
    
    st.end();
  });

  t.end();
});