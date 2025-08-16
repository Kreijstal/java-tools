const test = require('tape');
const { JVM } = require('../src/jvm');

test('JVM should execute ProducerConsumer.class and demonstrate wait/notify', async (t) => {
  const jvm = new JVM({ classpath: 'sources' });
  const output = [];
  jvm.registerJreMethods({
    'java/io/PrintStream.println(Ljava/lang/String;)V': (jvm, obj, args) => {
      output.push(args[0]);
    },
  });

  await jvm.run('sources/ProducerConsumer.class');

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
  t.end();
});
