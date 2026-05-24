'use strict';

const JVM_OUTPUT_EXPECTATIONS = Object.freeze({
  RuntimeArithmetic: '5\n2\n6',
  ArithmeticTest: 'Integer Arithmetic:\nSum: 13\nDifference: 7\nProduct: 30\nQuotient: 3\nRemainder: 1\n\nDouble Arithmetic:\nSum: 22222.2221\nDifference: 2469.1357000000007\nProduct: 1.219326309891785E8\nQuotient: 1.249999989875\n\nFloat Arithmetic:\nSum: 16.0\nDifference: 9.0\nProduct: 43.75\nQuotient: 3.5714285373687744',
  BitwiseOperationsTest: '-2\n536870910\n8\n14\n6',
  ComparisonInstructions: '100 < 200\n100 == 100\n1.5 < 2.5\n1.5 != NaN\n1.5 < 2.5 (double)\n1.5 != NaN (double)',
  DoubleComparisonTest: '=== Double Comparison Test ===\nd1 > d2: true\nd1 < d2: false\nd1 == d3: true\nNaN > d1: false\nNaN < d1: false\nNaN == NaN: false\nTest completed successfully!',
  ConcurrencyCrash: 'Testing concurrency features that might crash...\nFinal counter value: 2000',
  ExceptionTest: 'Caught exception',
  FinallyTest: 'Test 1: Normal execution\nIn try block (normal)\nIn finally block (normal)\n\\nTest 2: Exceptional execution\nIn try block (exception)\nIn catch block (exception)\nIn finally block (exception)',
  FizzBuzz: Array.from({ length: 100 }, (_, index) => {
    const value = index + 1;
    if (value % 15 === 0) return 'FizzBuzz';
    if (value % 3 === 0) return 'Fizz';
    if (value % 5 === 0) return 'Buzz';
    return String(value);
  }).join('\n'),
  TryCatchFinallyTest: '--- Test: Exception in finally ---\nOuter try\nInner finally, throwing new exception\nCaught: Exception from finally\n\\n--- Test: Exception in catch ---\nOuter try\nOuter catch, throwing new exception\nCaught: Exception from catch\n\\n--- Test: Return in finally ---\nIn try\nIn finally\nReturned value: 2\n\\n--- Test: Nested try-catch-finally ---\nOuter try\nInner try\nInner catch: Inner exception\nInner finally\nOuter try after inner\nOuter finally\n\\n--- Test: Try-finally without catch ---\nInner try\nInner finally\nCaught: Exception from try-finally',
  TryWithResourcesTest: '=== Try-With-Resources Test ===\nSingle resource:\nCreated resource: Resource1\nWorking with resource: Resource1\nWork completed successfully\nClosing resource: Resource1\nMultiple resources:\nCreated resource: Resource1\nCreated resource: Resource2\nWorking with resource: Resource1\nWorking with resource: Resource2\nMultiple resources work completed\nClosing resource: Resource2\nClosing resource: Resource1\nException handling:\nCreated resource: FailingResource\nWorking with resource: FailingResource\nClosing resource: FailingResource\nCaught exception: Work failed for FailingResource\nSuppressed exceptions: 1\n  - Failed to close FailingResource',
  VerySimple: '1',
  SmallDivisionTest: '2\n1\n2\n0',
  SimpleArithmetic: '5\n1\n6',
  MethodInvocationValidationTest: 'Testing method invocation validation\nStatic method result: 8\nInstance method result: 15\nAll validations passed',
  MathInstructions: 'Long arithmetic:\n100 + 50 = 150\n100 - 50 = 50\n100 * 50 = 5000\n100 / 50 = 2\n100 % 50 = 0\nFloat arithmetic:\n3.5 + 1.5 = 5\n3.5 - 1.5 = 2\n3.5 * 1.5 = 5.25\n3.5 / 1.5 = 2.3333332538604736\n3.5 % 1.5 = 0.5\nDouble arithmetic:\n10.5 + 2.5 = 13\n10.5 - 2.5 = 8\n10.5 * 2.5 = 26.25\n10.5 / 2.5 = 4.2\n10.5 % 2.5 = 0.5\nInteger bitwise:\n15 & 7 = 7\n15 | 7 = 15\n15 ^ 7 = 8\nLong bitwise:\n15 & 7 = 7\n15 | 7 = 15\n15 ^ 7 = 8\nShift instructions:\n8 << 2 = 32\n8 >> 1 = 4\n-8 >>> 1 = 2147483644\n8L << 2 = 32\n8L >> 1 = 4\n-8L >>> 1 = 9223372036854775804',
  ConversionTest: '10',
  LongArithmeticTest: '8000000000\n2000000000\n15000000000000000000\n1',
  LongBitwiseTest: '8\n14\n6\n-40\n-3\n4611686018427387901',
  InvokeVirtualTest: 'Hello World\nTest completed',
  ObjectCreationTest: 'Testing object creation...\nCreated object with value: 42\nUpdated value: 100\nSecond object value: 200',
  PotentialCrash1: 'In synchronized block\ntwo\nhundred',
  NewLambdaCrash: 'Hello from lambda!',
  LambdaCrash: "This test demonstrates lambda expressions ('invokedynamic').\nHello, World\nLambda expressions are working correctly.",
  InvokeDynamicTest: 'Hello World from InvokeDynamic!\nLambda executed!',
  ReflectionCrash: 'Testing reflection operations that might crash...\nString class: java.lang.String\nString length method: length\nString has public fields: false',
  ReflectionCrashTest: 'Testing reflection on private methods...\nReflection result: Hello from private method!',
  AnnotationReflectionTest: '=== Annotation Reflection Test ===\nClass annotations:\nNo class annotation found\nField annotations:\nField annotation: field, 10\nMethod annotations:\nMethod annotation: method, 99\nMethod result: Processed: test\nField modifiers:\nIs private: true\nIs static: false',
  ObscureNumbers: 'Demonstrating underscores in numeric literals.\nLarge number: 1000000000000\nBinary number: 255\nHex number: 4095',
  ObscureUnicode: 'Hello from ObscureUnicode!\nValue of Π: 3.14159\nValue of Javaは最高: true\nPath: C:\\\\users\\\\default',
  StaticVsInstanceTest: 'Testing static vs instance methods\nStatic method result: 8\nInstance method result: 15',
  StringBuilderConcat: 'Hello World',
  TypeConversionTest: '123456789\n1.23456789E8\n1.23456789E8',
  StringConcat: 'Hello World',
  StringConcatMethod: 'Hello World',
  SimpleStringTest: 's1.equals(s3): true\ns3.equals(s1): true\ns1: hello\ns3: hello',
  StringMethodsTest: 'Hello World\nHELLO WORLD\nhello world\nHello Java\nTests completed',
  SimpleStringConcat: 'Hello World',
  SimplestCrash: "This test demonstrates the 'newarray' instruction.\nThe 'newarray' instruction is working correctly.",
  SimplestSipushCrash: "This test demonstrates the 'sipush' instruction.\nThe 'sipush' instruction is working correctly: 128",
  WorkingArithmetic: '5\n2\n6',
  SipushTest: '1000',
});

const CONSTANTS_ICONST_PREFIX = Object.freeze(['0', '1', '3']);

function expectedOutputForClass(className) {
  if (!Object.prototype.hasOwnProperty.call(JVM_OUTPUT_EXPECTATIONS, className)) {
    throw new Error(`No JVM output expectation registered for ${className}`);
  }
  return JVM_OUTPUT_EXPECTATIONS[className];
}

module.exports = {
  JVM_OUTPUT_EXPECTATIONS,
  CONSTANTS_ICONST_PREFIX,
  expectedOutputForClass,
};
