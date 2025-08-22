const test = require("tape");
const { runTest } = require("./test-helpers");

const SELDOM_USED_FEATURE_TESTS = [
  {
    name: "MethodHandlesTest",
    description: "MethodHandles and MethodType - should pass",
    shouldFail: false,
    // TODO: This test is expected to fail until MethodHandles are implemented in the JVM.
    expectedOutput: `=== Method Handles Test ===
Invoking static method via MethodHandle:
Static method called: Hello from MethodHandle!
Invoking instance method via MethodHandle:
Result: Instance method called with: 42
Field access via MethodHandle:
Field value: 100`,
  },
  {
    name: "AnnotationReflectionTest",
    description: "Annotation processing with reflection - should pass",
    shouldFail: false,
    // TODO: This test is expected to fail until annotation reflection is fully implemented.
    expectedOutput: `=== Annotation Reflection Test ===
Class annotations:
No class annotation found
Field annotations:
Field annotation: field, 10
Method annotations:
Method annotation: method, 99
Method result: Processed: test
Field modifiers:
Is private: true
Is static: false`,
  },
  {
    name: "TryWithResourcesTest",
    description: "Try-with-resources and suppressed exceptions - should pass",
    shouldFail: false,
    // TODO: This test is expected to fail until try-with-resources is fully implemented.
    expectedOutput: `=== Try-With-Resources Test ===
Single resource:
Created resource: Resource1
Working with resource: Resource1
Work completed successfully
Closing resource: Resource1
Multiple resources:
Created resource: Resource1
Created resource: Resource2
Working with resource: Resource1
Working with resource: Resource2
Multiple resources work completed
Closing resource: Resource2
Closing resource: Resource1
Exception handling:
Created resource: FailingResource
Working with resource: FailingResource
Closing resource: FailingResource
Caught exception: Work failed for FailingResource
Suppressed exceptions: 1
  - Failed to close FailingResource`,
  },
  {
    name: "MultiCatchTest",
    description: "Multi-catch exception handling - should pass",
    shouldFail: false,
    expectedOutput: `=== Multi-Catch Exception Test ===
Test case 1:
Caught multi-catch exception: ArithmeticException
Message: / by zero
Finally block executed for test case 1

Test case 2:
Caught multi-catch exception: ArrayIndexOutOfBoundsException
Message: Index 10 out of bounds for length 3
Finally block executed for test case 2

Test case 3:
Caught multi-catch exception: NullPointerException
Message: Cannot invoke "String.length()" because "<local4>" is null
Finally block executed for test case 3

Test case 4:
Normal execution - no exception
Finally block executed for test case 4`,
  },
  {
    name: "VarargsGenericTest",
    description: "Varargs with generic types - should pass",
    shouldFail: false,
    expectedOutput: `=== Varargs with Generics Test ===
Simple varargs:
Received 3 items:
  - apple
  - banana
  - cherry
Generic varargs:
Generic items (type: String):
  - first
  - second
  - third
Generic items (type: Integer):
  - 1
  - 2
  - 3
  - 4
  - 5
Varargs with arrays:
Received 2 items:
  - orange
  - grape
Safe varargs:
Safe varargs method with 3 items:
  - safe1
  - safe2
  - safe3
Mixed generic types:
Processing 4 mixed items:
  - Process (type: String)
  - 42 (type: Integer)
  - true (type: Boolean)
  - 3.14 (type: Double)`,
  },
  {
    name: "StaticInitializationTest",
    description: "Static initialization block ordering - should pass",
    shouldFail: false,
    expectedOutput: `Static block 1 executed
Initializing CONSTANT2
Static block 2 executed
=== Static Initialization Order Test ===
CONSTANT1: First constant
Counter after static blocks: 35
Dynamic value: Initialized in static block 1 and modified in static block 2
CONSTANT2: Second constant (counter was 15)
Creating first instance...
Instance initialization block executed
Constructor executed
Instance field: Instance field: First constant (modified in instance block) (modified in constructor)
Creating second instance...
Instance initialization block executed
Constructor executed
Instance field: Instance field: First constant (modified in instance block) (modified in constructor)
Calling static method...
Static method called, counter = 35`,
  },
  {
    name: "JaggedArrayTest",
    description:
      "Jagged (non-rectangular) multi-dimensional arrays - should pass",
    shouldFail: false,
    expectedOutput: `=== Jagged Array Test ===
Basic jagged array:
Row 0: 1 2 3 4\x20
Row 1: 5 6\x20
Row 2: 7 8 9\x20
Jagged array with direct initialization:
Row 0: 10 20 30\x20
Row 1: 40 50\x20
Row 2: 60 70 80 90 100\x20
3D jagged array:
Level 0:
Row 0: 1 2\x20
Row 1: 3 4 5\x20
Level 1:
Row 0: 6\x20
Row 1: 7 8 9\x20
Row 2: 10 11\x20
Array with null subarrays:
Row 0: hello world\x20
Row 1: null
Row 2: java test\x20
Dynamic jagged array:
Row 0: 10\x20
Row 1: 20 21\x20
Row 2: 30 31 32\x20
Row 3: 40 41 42 43`,
  },
  {
    name: "NestedClassPrivateAccessTest",
    description: "Nested class access to private members - should pass",
    shouldFail: false,
    expectedOutput: `=== Nested Class Private Access Test ===
Testing static nested class:
Static nested accessing static private field: 42
Static nested calling static private method: Private static: test
Static nested accessing instance private field: 99
Static nested calling instance private method: Private instance: 123

Testing inner class:
Inner class accessing static private field: 42
Inner class accessing instance private field: 99
Inner class calling static private method: Private static: inner
Inner class calling instance private method: Private instance: 456`,
  },
  {
    name: "ClassLiteralTest", 
    description: "Class literals and Class.forName - currently fails due to array class loading issues",
    shouldFail: true,
    expectedOutput: `=== Class Literal Test ===
int.class: int
String.class: java.lang.String
int[].class: [I
int[][].class: [[I
int.class == Integer.TYPE: true
Integer.class: java.lang.Integer
void.class: void
Void.TYPE: void
void.class == Void.TYPE: true
Class.forName("java.lang.String"): java.lang.String
forName == String.class: true
Class.forName("[I"): [I
forName array == int[].class: true
String.class.getSuperclass(): java.lang.Object
int.class.isPrimitive(): true
String.class.isPrimitive(): false
int[].class.isArray(): true
String.class.isArray(): false`,
  },
  {
    name: "HexFloatLiteralsTest",
    description: "Hexadecimal float literals - currently has issues with small values and boolean methods",
    shouldFail: true,
    expectedOutput: `=== Hexadecimal Float Literals Test ===
0x1.0p0 = 1.0
0x1.8p0 = 1.5
0x1.0p1 = 2.0
0x1.0p-1 = 0.5
Hex Pi approximation: 3.141592653589793
Hex E approximation: 2.718281828459045
Math.PI: 3.141592653589793
Math.E: 2.718281828459045
Hex float: 1.0
Max value (hex): 1.7976931348623157E308
Double.MAX_VALUE: 1.7976931348623157E308
Min normal (hex): 2.2250738585072014E-308
Double.MIN_NORMAL: 2.2250738585072014E-308
Min subnormal (hex): 4.9E-324
Double.MIN_VALUE: 4.9E-324
Positive infinity: Infinity
Is positive infinite: true
Negative infinity: -Infinity
Is negative infinite: true
NaN: NaN
Is NaN: true`,
  },
  {
    name: "ReflectiveArrayTest",
    description: "Reflective array creation - currently fails due to missing reflection support",
    shouldFail: true,
    expectedOutput: `=== Reflective Array Creation Test ===
Created int array, length: 5
Element 0: 42
Element 1: 99
Element 2: -1
Multi-dimensional array [2][3]:
Hello World ! 
Java Array Test 
Double array:
  [0] = 3.14
  [1] = 2.71
  [2] = 1.41
Int array class: [I
Is array: true
Component type: int
Multi array class: [[Ljava.lang.String;
Multi array component type: [Ljava.lang.String;
Zero-length array length: 0
Jagged array created with different row sizes:
  Row 0 length: 2
  Row 1 length: 4
  Row 2 length: 1`,
  },
  {
    name: "StringInternTest",
    description: "String interning - currently fails due to missing String.intern() implementation",
    shouldFail: true,
    expectedOutput: `=== String Intern Test ===
Literal strings s1 == s2: true
s1 == new String("hello"): false
s1.equals(s3): true
s1 == s3.intern(): true
"hel" + "lo" == "he" + "llo": true
concat1 == s1: true
Runtime concat1 == runtime concat2: false
Runtime concat1 == literal: false
Runtime concat1.intern() == literal: true
StringBuilder result == literal: false
StringBuilder result.intern() == literal: true
Number literal "123" == Integer.toString(123): false
Number literal == new String("123"): false
Integer.toString(123).intern() == "123": true
Empty literal "" == new String("").intern(): true
null.intern() threw NullPointerException: NullPointerException
Two unique strings == : false
unique1.intern() == unique2.intern(): true
unique1.intern() == unique1: false`,
  },
];

test("Seldom-used Java Features", async function (t) {
  for (const testCase of SELDOM_USED_FEATURE_TESTS) {
    const options = {
      shouldFail: testCase.shouldFail,
    };
    await runTest(testCase.name, testCase.expectedOutput, t, options);
  }
  t.end();
});
