const test = require('tape');
const { JVM } = require('../src/jvm');
const path = require('path');

test('JVM should handle inter-class method calls', async function(t) {
  t.plan(1);

  const sourcesPath = path.join(__dirname, '..', 'sources');
  const jvm = new JVM({ classpath: sourcesPath });
  const classFilePath = path.join(sourcesPath, 'Caller.class');

  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream.println(Ljava/lang/String;)V': (j, o, a) => {
      output += a[0];
    }
  });

  await jvm.run(classFilePath, { silent: true });

  t.equal(output, 'Hello from Callee!', 'The JVM should correctly handle method calls between classes');
});
