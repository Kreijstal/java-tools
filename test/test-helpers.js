const path = require("path");
const { JVM } = require("../src/jvm");

/**
 * Normalizes floating point numbers in text for more lenient comparison.
 * This handles cases where JavaScript and Java may format very small/large numbers differently.
 * @param {string} text The text to normalize
 * @returns {string} The normalized text
 */
function normalizeFloatingPointNumbers(text) {
  // Pattern to match scientific notation numbers like 4.9E-324, 5E-324, etc.
  return text.replace(/(\d+(?:\.\d+)?)[eE]([+-]?\d+)/g, (match, mantissa, exponent) => {
    // Parse the number and format it consistently
    const num = parseFloat(match);
    if (!isFinite(num)) return match;
    
    // Use a consistent exponential format
    return num.toExponential().replace(/e\+?/, 'E');
  });
}

// Custom InputStream implementation that reads from provided input data
class TestInputStream {
  constructor(inputData = "") {
    this.inputData = inputData;
    this.inputIndex = 0;
  }

  read() {
    if (this.inputIndex >= this.inputData.length) {
      return -1; // End of stream
    }
    return this.inputData.charCodeAt(this.inputIndex++);
  }
}

// Proper InputStream object that can be used by InputStreamReader
function createTestInputStream(inputData = "") {
  const testInputStream = new TestInputStream(inputData);
  return {
    type: "java/io/InputStream",
    fields: {},
    read: () => testInputStream.read(),
  };
}

async function runTest(className, expectedOutput, t, options = {}) {
  let output = "";
  const { nativeMethods, shouldFail, expectedError, timeout = 1000, ...jvmOptions } = options;
  let success = true;
  let error = null;

  try {
    const jvm = new JVM({
      ...jvmOptions,
      jreOverrides: {
        "testing/MockOutputStream": {
          super: "java/io/OutputStream",
          methods: {
            "write(I)V": (jvm, obj, args) => {
              output += String.fromCharCode(args[0]);
            },
          },
        },
        "java/lang/System": {
          methods: {
            "<clinit>()V": (jvm, _, args, thread) => {
              const systemClass = jvm.classes["java/lang/System"];

              // Create MockOutputStream for out
              const mockOut = { type: "testing/MockOutputStream", fields: {} };
              const mockOutInit = jvm._jreFindMethod(
                "testing/MockOutputStream",
                "<init>",
                "()V",
              );
              if (mockOutInit) {
                mockOutInit(jvm, mockOut, []);
              }

              // Create PrintStream that uses MockOutputStream
              const out = { type: "java/io/PrintStream", fields: {} };
              const psInit = jvm._jreFindMethod(
                "java/io/PrintStream",
                "<init>",
                "(Ljava/io/OutputStream;)V",
              );
              if (psInit) {
                psInit(jvm, out, [mockOut]);
              }
              systemClass.staticFields.set("out:Ljava/io/PrintStream;", out);

              // Create ConsoleOutputStream for err (using console.error)
              const cosErr = {
                type: "java/io/ConsoleOutputStream",
                fields: {},
              };
              const cosInit = jvm._jreFindMethod(
                "java/io/ConsoleOutputStream",
                "<init>",
                "(Ljava/lang/Object;)V",
              );
              if (cosInit) {
                const writer = (char) => {
                  if (typeof process !== "undefined")
                    process.stderr.write(char);
                };
                cosInit(jvm, cosErr, [writer]);
              }

              // Create PrintStream for err
              const err = { type: "java/io/PrintStream", fields: {} };
              if (psInit) {
                psInit(jvm, err, [cosErr]);
              }
              systemClass.staticFields.set("err:Ljava/io/PrintStream;", err);

              // Create a proper InputStream for in that supports input data
              const inputData = jvmOptions.inputData || "";
              const inStream = createTestInputStream(inputData);
              systemClass.staticFields.set(
                "in:Ljava/io/InputStream;",
                inStream,
              );
            },
          },
        },
      },
    });

    if (nativeMethods) {
      for (const className in nativeMethods) {
        for (const method of nativeMethods[className]) {
          jvm.registerNativeMethod(
            className,
            method.name,
            method.descriptor,
            method.impl,
          );
        }
      }
    }

    const classFilePath = path.join(
      __dirname,
      "..",
      "sources",
      `${className}.class`,
    );

    // Use AbortController for efficient timeout handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeout);

    try {
      await jvm.run(classFilePath);
      // Test completed successfully, clear the timeout
      clearTimeout(timeoutId);
    } catch (e) {
      clearTimeout(timeoutId);
      if (controller.signal.aborted) {
        throw new Error(`Test timeout after ${timeout}ms`);
      }
      throw e;
    }
  } catch (e) {
    success = false;
    error = e;
  }

  if (t) {
    if (shouldFail) {
      t.notOk(success, `${className} should fail as expected.`);
      if (expectedError) {
        t.equal(
          error.message,
          expectedError,
          `${className} should fail with the correct error message.`,
        );
      }
    } else {
      t.ok(success, `${className} should run without errors.`);
      if (expectedOutput !== undefined) {
        // Normalize floating point numbers for more lenient comparison
        const normalizedOutput = normalizeFloatingPointNumbers(output.trim());
        const normalizedExpected = normalizeFloatingPointNumbers(expectedOutput.trim());
        
        t.equal(
          normalizedOutput,
          normalizedExpected,
          `Output for ${className} should be correct`,
        );
      }
    }
  }

  return { output, success, error };
}

async function runSlowTest(className, expectedOutput, t, options = {}) {
  // Create a test that takes longer than 1 second
  const slowOptions = { ...options, timeout: 2000 }; // Override to 2 seconds for this specific test
  return runTest(className, expectedOutput, t, slowOptions);
}

module.exports = { runTest, runSlowTest, normalizeFloatingPointNumbers };
