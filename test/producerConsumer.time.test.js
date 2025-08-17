const test = require('tape');
const { JVM } = require('../src/jvm');

test('JVM should execute ProducerConsumer.class in less than 1.2 seconds and not hang', async (t) => {
  t.plan(1);

  const timeout = (ms, promise) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Test timed out after ${ms} ms`));
      }, ms);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  };

  const runTest = async () => {
    const jvm = new JVM({ classpath: 'sources' });
    const output = [];
    jvm.registerJreMethods({
      'java/io/PrintStream': {
        'println(Ljava/lang/String;)V': (jvm, obj, args) => {
          output.push(args[0]);
        },
      },
    });

    const startTime = Date.now();
    await jvm.run('sources/ProducerConsumer.class');
    const endTime = Date.now();
    const executionTime = endTime - startTime;
    return executionTime;
  };

  try {
    const executionTime = await timeout(5000, runTest());
    t.ok(executionTime < 1200, `Execution time should be less than 1200ms, but was ${executionTime}ms`);
  } catch (error) {
    t.fail(error.message);
  }
});
