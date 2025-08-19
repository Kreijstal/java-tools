/**
 * Example usage of JNI native method registration
 * 
 * This demonstrates how to use the JNI system to register and execute
 * native methods in the JVM.js implementation.
 */

const { JVM } = require('../jvm');
const nativeLibrary = require('./nativeLibrary');

async function demonstrateJNI() {
  console.log('=== JNI Native Method Demonstration ===\n');
  
  // Create JVM instance with verbose output
  const jvm = new JVM({ verbose: true });
  
  console.log('1. Loading native library...');
  jvm.loadNativeLibrary('mathlib', nativeLibrary);
  
  console.log('\n2. Registering individual native methods...');
  // Register a custom native method
  jvm.registerNativeMethod(
    'com/example/CustomMath', 
    'power', 
    '(II)D',
    (jniEnv, thisObj, args) => {
      const base = args[0];
      const exponent = args[1];
      return Math.pow(base, exponent);
    }
  );
  
  console.log('\n3. Testing native method execution...');
  
  // Test library methods
  console.log('\nTesting MathUtils.isqrt(100):');
  const isqrtMethod = jvm._jreFindMethod('com/example/MathUtils', 'isqrt', '(I)I');
  if (isqrtMethod) {
    const result = isqrtMethod(jvm, null, [100], null);
    console.log(`Result: ${result} (expected: 10)`);
  }
  
  console.log('\nTesting MathUtils.isPrime(17):');
  const isPrimeMethod = jvm._jreFindMethod('com/example/MathUtils', 'isPrime', '(I)Z');
  if (isPrimeMethod) {
    const result = isPrimeMethod(jvm, null, [17], null);
    console.log(`Result: ${result} (expected: true)`);
  }
  
  console.log('\nTesting StringUtils.reverse("hello"):');
  const reverseMethod = jvm._jreFindMethod('com/example/StringUtils', 'reverse', '(Ljava/lang/String;)Ljava/lang/String;');
  if (reverseMethod) {
    const inputString = jvm.internString('hello');
    const result = reverseMethod(jvm, null, [inputString], null);
    console.log(`Result: "${result}" (expected: "olleh")`);
  }
  
  console.log('\nTesting custom power method (2^8):');
  const powerMethod = jvm._jreFindMethod('com/example/CustomMath', 'power', '(II)D');
  if (powerMethod) {
    const result = powerMethod(jvm, null, [2, 8], null);
    console.log(`Result: ${result} (expected: 256)`);
  }
  
  console.log('\n4. Testing built-in native methods...');
  
  console.log('\nTesting System.currentTimeMillis():');
  const timeMethod = jvm._jreFindMethod('java/lang/System', 'currentTimeMillis', '()J');
  if (timeMethod) {
    const result = timeMethod(jvm, null, [], null);
    console.log(`Current time: ${result}`);
  }
  
  console.log('\nTesting Object.hashCode():');
  const hashMethod = jvm._jreFindMethod('java/lang/Object', 'hashCode', '()I');
  if (hashMethod) {
    const testObj = { type: 'java/lang/Object' };
    const result = hashMethod(jvm, testObj, [], null);
    console.log(`Hash code: ${result}`);
  }
  
  console.log('\n5. Listing all registered native methods...');
  const nativeMethods = jvm.getNativeMethods();
  console.log(`Total native methods registered: ${nativeMethods.length}`);
  nativeMethods.forEach(method => {
    console.log(`  - ${method.className}.${method.methodName}${method.descriptor}`);
  });
  
  console.log('\n=== JNI Demonstration Complete ===');
}

// Run the demonstration
if (require.main === module) {
  demonstrateJNI().catch(console.error);
}

module.exports = { demonstrateJNI };