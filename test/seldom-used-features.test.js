const test = require("tape");
const { runTest } = require("./test-helpers");

const SELDOM_USED_FEATURE_TESTS = [
  {
    name: "MethodHandlesTest",
    description: "MethodHandles and MethodType - should pass",
    shouldFail: false,

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
Message: Cannot invoke "String.length()" because the object reference is null
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
