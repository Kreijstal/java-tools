const test = require('tape');
const { runTest } = require('./test-helpers');
const { JVM } = require('../src/jvm');

test('JNI Integration with Java Bytecode Execution', async (t) => {
  const nativeMethods = {
    'NativeTest': [
      {
        name: 'nativeAdd',
        descriptor: '(II)I',
        impl: (jniEnv, thisObj, args) => args[0] + args[1]
      },
      {
        name: 'nativeGreeting',
        descriptor: '(Ljava/lang/String;)Ljava/lang/String;',
        impl: (jniEnv, thisObj, args) => {
          const name = args[0].toString();
          return jniEnv.internString(`Hello, ${name}!`);
        }
      },
      {
        name: 'nativeIsPrime',
        descriptor: '(I)Z',
        impl: (jniEnv, thisObj, args) => {
          const n = args[0];
          if (n <= 1) return false;
          if (n <= 3) return true;
          if (n % 2 === 0 || n % 3 === 0) return false;
          for (let i = 5; i * i <= n; i += 6) {
            if (n % i === 0 || n % (i + 2) === 0) return false;
          }
          return true;
        }
      }
    ]
  };

  const { output } = await runTest('NativeTest', undefined, undefined, { nativeMethods });

  t.ok(output.includes('=== Native Method Test ==='), 'Should print test header');
  t.ok(output.includes('nativeAdd(5, 3) = 8'), 'Native addition should work correctly');
  t.ok(output.includes('nativeGreeting("World") = Hello, World!'), 'Native string method should work');
  t.ok(output.includes('nativeIsPrime(17) = true'), 'Native prime check should work');
  t.ok(output.includes('=== Test Complete ==='), 'Should print test completion');

  console.log('=== JNI Integration Test Output ===');
  console.log(output);

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