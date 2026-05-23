'use strict';

const JVM_OUTPUT_EXPECTATIONS = Object.freeze({
  RuntimeArithmetic: '5\n2\n6',
  ArithmeticTest: 'Integer Arithmetic:\nSum: 13\nDifference: 7\nProduct: 30\nQuotient: 3\nRemainder: 1\n\nDouble Arithmetic:\nSum: 22222.2221\nDifference: 2469.1357000000007\nProduct: 1.219326309891785E8\nQuotient: 1.249999989875\n\nFloat Arithmetic:\nSum: 16.0\nDifference: 9.0\nProduct: 43.75\nQuotient: 3.5714285373687744',
  BitwiseOperationsTest: '-2\n536870910\n8\n14\n6',
  VerySimple: '1',
  SmallDivisionTest: '2\n1\n2\n0',
  SimpleArithmetic: '5\n1\n6',
  MethodInvocationValidationTest: 'Testing method invocation validation\nStatic method result: 8\nInstance method result: 15\nAll validations passed',
  ConversionTest: '10',
  LongArithmeticTest: '8000000000\n2000000000\n15000000000000000000\n1',
  LongBitwiseTest: '8\n14\n6\n-40\n-3\n4611686018427387901',
  ObjectCreationTest: 'Testing object creation...\nCreated object with value: 42\nUpdated value: 100\nSecond object value: 200',
  ObscureNumbers: 'Demonstrating underscores in numeric literals.\nLarge number: 1000000000000\nBinary number: 255\nHex number: 4095',
  StaticVsInstanceTest: 'Testing static vs instance methods\nStatic method result: 8\nInstance method result: 15',
  TypeConversionTest: '123456789\n1.23456789E8\n1.23456789E8',
  StringConcat: 'Hello World',
  SimpleStringTest: 's1.equals(s3): true\ns3.equals(s1): true\ns1: hello\ns3: hello',
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
