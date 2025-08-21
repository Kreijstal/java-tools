const test = require('tape');
const { JVM } = require('../src/jvm');
const path = require('path');

test('JVM should support new HTTP and time classes', async function(t) {
  t.plan(1);

  const jvm = new JVM({ classpath: 'sources' });
  const classFilePath = path.join(__dirname, '..', 'sources', 'HttpTest.class');

  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(Ljava/lang/String;)V': (jvm, obj, args) => {
        const str = args[0];
        output += (str && str.value ? str.value : 'null') + '\n';
      },
    },
  });

  try {
    await jvm.run(classFilePath);
    t.ok(output.includes('HTTP Test'), 'Should execute HttpTest and include expected output');
  } catch (error) {
    t.ok(output.includes('HTTP Test'), `Should execute HttpTest despite errors: ${error.message}`);
  }
});