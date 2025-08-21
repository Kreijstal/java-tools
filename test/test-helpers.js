const path = require("path");
const { JVM } = require("../src/jvm");

async function runTest(className, expectedOutput, t, options = {}) {
  let output = "";
  const { nativeMethods, shouldFail, expectedError, ...jvmOptions } = options;
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

              // Create a dummy InputStream for in
              const inStream = { type: "java/io/InputStream", fields: {} };
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
    await jvm.run(classFilePath);
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
        t.equal(
          output.trim(),
          expectedOutput.trim(),
          `Output for ${className} should be correct`,
        );
      }
    }
  }

  return { output, success, error };
}

module.exports = { runTest };
