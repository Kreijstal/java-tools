const test = require('tape');
const { JVM } = require('../src/jvm');

test('JVM should execute ProducerConsumer.class, demonstrate wait/notify, and not hang', async (t) => {
  t.plan(2);

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
    const jvm = new JVM({ classpath: ['sources'] });
    const output = [];
    jvm.registerJreMethods({
      'java/io/PrintStream': {
        'println(Ljava/lang/String;)V': (jvm, obj, args) => {
          output.push(String(args[0]));
        },
      },
    });

    const startTime = Date.now();
    await jvm.run('ProducerConsumer');
    const endTime = Date.now();
    const executionTime = endTime - startTime;
    return { executionTime, output };
  };

  try {
    const { executionTime, output } = await timeout(5000, runTest());
    t.ok(executionTime < 1200, `Execution time should be less than 1200ms, but was ${executionTime}ms`);
    t.deepEqual(output, [
      'Producer produced-0',
      'Consumer consumed-0',
      'Producer produced-1',
      'Consumer consumed-1',
      'Producer produced-2',
      'Consumer consumed-2',
      'Producer produced-3',
      'Consumer consumed-3',
      'Producer produced-4',
      'Consumer consumed-4',
    ]);
  } catch (error) {
    t.fail(error.message);
  }
});
