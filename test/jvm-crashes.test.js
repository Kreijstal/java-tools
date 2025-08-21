const test = require("tape");
const { runTest } = require("./test-helpers");

// Consolidated list of JVM crash tests
const tests = [
  // Basic functionality
  {
    name: "RecursionTest",
    description: "Factorial calculation using recursion",
    expectedOutput: "Testing recursion without static fields...\n5! = 120",
  },

  // Array tests
  {
    name: "ArrayTest",
    description: "Complex array operations",
    expectedOutput:
      "=== Basic Array Test ===\narr[0] = 10\narr[1] = 20\n=== Array Initialization ===\narr2[0] = 1\narr2[1] = 2\narr2[2] = 3\narr2[3] = 4\narr2[4] = 5\n=== Multi-dimensional Arrays ===\nmatrix[0][0] = 1\nmatrix[0][1] = 2\nmatrix[1][0] = 3\n=== Array Bounds Test ===\nAccessing arr[10]...\nCaught expected exception: ArrayIndexOutOfBoundsException",
  },
  {
    name: "AdvancedArrayCrash",
    description: "System.arraycopy functionality",
    expectedOutput:
      "Testing advanced array operations...\nMatrix[0][0] = 10\nMatrix[2][3] = 20\nString: Hello\nString: World\nString: !\nTotal length: 11\nArraycopy result: dst[3] = 2",
  },

  // Class and object features
  {
    name: "StaticFieldTest",
    description: "Static field access (getstatic)",
    expectedOutput:
      "Testing static field access...\nStatic field value: 100\nStatic field updated: 200",
  },
  {
    name: "InstanceofTest",
    description: "instanceof instruction for array types",
    expectedOutput:
      "=== instanceof Test ===\nString instanceof String: 1\nString instanceof Object: 1\nInteger instanceof Integer: 1\nInteger instanceof Number: 1\nint[] instanceof Object: 0\nnull instanceof String: 0\nnull instanceof Object: 0\n=== Class Hierarchy Test ===\nParent instanceof Parent: 1\nChild instanceof Parent: 1\nChild instanceof Child: 1\nParent ref to Child instanceof Child: 1",
  },
  {
    name: "InnerClassTest",
    description: "Inner class support",
    expectedOutput:
      "=== Inner Class Test ===\nInner field: 10\nOuter field: 42\nStatic outer field: 100\nNested field: 20\nStatic outer field: 100\n=== Local Inner Class ===\nLocal variable: 30\nOuter field: 42\n=== Anonymous Inner Class ===\nAnonymous inner class running\nOuter field: 42",
  },
  {
    name: "ReflectionCrash",
    description: "Basic reflection support",
    expectedOutput:
      "Testing reflection operations that might crash...\nString class: java.lang.String\nString has 17 methods\nString has 0 public fields",
  },

  // Data types and conversions
  {
    name: "BoxingUnboxingTest",
    description: "Boxing and unboxing of primitive types",
    expectedOutput:
      "=== Boxing/Unboxing Test ===\nAutoboxed Integer: 42\nUnboxed int: 42\n=== Method Call Boxing ===\nInteger method received: 100\nint method received: 200\n=== Arithmetic with Boxed Types ===\n10 + 20 = 30\n=== Null Unboxing Test ===\nCaught expected NPE during unboxing",
  },
  {
    name: "SipushTest",
    description: "sipush instruction for 16-bit integers",
    expectedOutput: "1000",
  },
  {
    name: "DoubleComparisonTest",
    description: "Double comparison operations (dcmpl)",
    expectedOutput:
      "=== Double Comparison Test ===\nd1 > d2: true\nd1 < d2: false\nd1 == d3: true\nNaN > d1: false\nNaN < d1: false\nNaN == NaN: false\nTest completed successfully!",
  },
  {
    name: "ConversionTest",
    description: "l2i (long to int) conversion",
    expectedOutput: "10",
  },
  {
    name: "PotentialCrash3",
    description: "Type conversion and checking instructions",
    expectedOutput:
      "Type conversion test completed\nlcmp works\nCaught: Test exception\nCheckcast works: Hello\ninstanceof works",
  },
  {
    name: "MathInstructions",
    description: "Arithmetic instructions for various types",
    expectedOutput:
      "Long arithmetic:\n100 + 50 = 150\n100 - 50 = 50\n100 * 50 = 5000\n100 / 50 = 2\n100 % 50 = 0\nFloat arithmetic:\n3.5 + 1.5 = 5.0\n3.5 - 1.5 = 2.0\n3.5 * 1.5 = 5.25\n3.5 / 1.5 = 2.3333333\n3.5 % 1.5 = 0.5\nDouble arithmetic:\n10.5 + 2.5 = 13.0\n10.5 - 2.5 = 8.0\n10.5 * 2.5 = 26.25\n10.5 / 2.5 = 4.2\n10.5 % 2.5 = 0.5\nInteger bitwise:\n15 & 7 = 7\n15 | 7 = 15\n15 ^ 7 = 8\nLong bitwise:\n15 & 7 = 7\n15 | 7 = 15\n15 ^ 7 = 8\nShift instructions:\n8 << 2 = 32\n8 >> 1 = 4\n-8 >>> 1 = 2147483644\n8L << 2 = 32\n8L >> 1 = 4\n-8L >>> 1 = 9223372036854775804",
  },
  {
    name: "ComparisonInstructions",
    description: "Comparison instructions (long/float/double)",
    expectedOutput:
      "100 < 200\n100 == 100\n1.5 < 2.5\n1.5 != NaN\n1.5 < 2.5 (double)\n1.5 != NaN (double)",
  },

  // Concurrency
  {
    name: "SynchronizationTest",
    description: "Monitorenter/monitorexit for synchronization",
    expectedOutput:
      "=== Synchronization Test ===\nIn synchronized method\nCounter after synchronized method: 10\nBefore synchronized block\nIn synchronized block\nCounter after synchronized block: 15\n=== Multi-threaded Test ===\nFinal counter value: 15",
  },
  {
    name: "ConcurrencyCrash",
    description: "ReentrantLock support",
    expectedOutput:
      "Testing concurrency features that might crash...\nFinal counter value: 2000",
  },

  // Enums and modern Java features
  {
    name: "EnumTest",
    description: "Enum constants and methods",
    expectedOutput:
      "=== Enum Test ===\nColor: RED\nRed value: 255\nHex: 255,0,0\nRED == RED: 1\nRED equals RED: 1\n=== Enum Switch Test ===\nIt's red!\nIt's green!\nIt's blue!\n=== valueOf Test ===\nvalueOf(BLUE): BLUE\nCaught expected exception for invalid enum: IllegalArgumentException",
  },
  {
    name: "MissingBytecodeCrash",
    description: "instanceof with an interface",
    expectedOutput:
      "Testing various bytecode instructions...\nDouble result: 5.85987\nLong result: 11111111101110\nd1 is greater than d2\nobj is CharSequence",
  },
  {
    name: "MethodReferenceCrash",
    description: "Method reference support (StringBuilder.reverse)",
    expectedOutput: "olleH",
  },
  {
    name: "NewLambdaCrash",
    description: "Simple lambda expression support",
    expectedOutput: "Hello from lambda!",
  },
  {
    name: "LambdaCrash",
    description: "Lambda expressions with captured variables",
    expectedOutput:
      "This test demonstrates lambda expressions ('invokedynamic').\nHello, World\nLambda expressions are working correctly.",
  },
];

test("JVM Crash and Functionality Tests", async function (t) {
  for (const testCase of tests) {
    await runTest(testCase.name, testCase.expectedOutput, t);
  }
  t.end();
});
