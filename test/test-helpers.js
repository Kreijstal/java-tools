const path = require('path');
const { JVM } = require('../src/jvm');

async function runTest(className, expectedOutput, t, options = {}) {
  let output = '';
  const { nativeMethods, ...jvmOptions } = options;

  const jvm = new JVM({
    ...jvmOptions,
    jreOverrides: {
      'testing/MockPrintStream': {
        super: 'java/io/PrintStream',
        methods: {
          'println(Ljava/lang/String;)V': (jvm, obj, args) => { output += args[0] + '\n'; },
          'println(I)V': (jvm, obj, args) => { output += args[0] + '\n'; },
          'println(C)V': (jvm, obj, args) => { output += String.fromCharCode(args[0]) + '\n'; },
          'println(J)V': (jvm, obj, args) => { output += args[0] + '\n'; },
          'println(F)V': (jvm, obj, args) => { output += args[0] + '\n'; },
          'println(D)V': (jvm, obj, args) => { output += args[0] + '\n'; },
          'println()V': (jvm, obj, args) => { output += '\n'; },
          'print(Ljava/lang/String;)V': (jvm, obj, args) => { output += args[0]; },
          'print(I)V': (jvm, obj, args) => { output += args[0]; },
          'print(C)V': (jvm, obj, args) => { output += String.fromCharCode(args[0]); },
        }
      },
      'java/lang/System': {
        methods: {
          '<clinit>()V': (jvm, _, args, thread) => {
            const systemClass = jvm.classes['java/lang/System'];

            const mockOut = { type: 'testing/MockPrintStream', fields: {} };
            systemClass.staticFields.set('out:Ljava/io/PrintStream;', mockOut);

            const cosErr = { type: 'java/io/ConsoleOutputStream', fields: {} };
            const cosInit = jvm._jreFindMethod('java/io/ConsoleOutputStream', '<init>', '(Ljava/lang/Object;)V');
            if (cosInit) {
              const writer = () => {};
              cosInit(jvm, cosErr, [writer]);
            }
            const err = { type: 'java/io/PrintStream', fields: {} };
            const psInit = jvm._jreFindMethod('java/io/PrintStream', '<init>', '(Ljava/io/OutputStream;)V');
            if (psInit) {
              psInit(jvm, err, [cosErr]);
            }
            systemClass.staticFields.set('err:Ljava/io/PrintStream;', err);

            const inStream = { type: 'java/io/InputStream', fields: {} };
            systemClass.staticFields.set('in:Ljava/io/InputStream;', inStream);
          }
        }
      }
    }
  });

  if (nativeMethods) {
    for (const className in nativeMethods) {
      for (const method of nativeMethods[className]) {
        jvm.registerNativeMethod(className, method.name, method.descriptor, method.impl);
      }
    }
  }

  const classFilePath = path.join(__dirname, '..', 'sources', `${className}.class`);
  await jvm.run(classFilePath);

  if (expectedOutput !== undefined && t) {
    t.equal(output.trim(), expectedOutput.trim(), `Output for ${className} should be correct`);
  }

  return { output, jvm };
}

module.exports = { runTest };
