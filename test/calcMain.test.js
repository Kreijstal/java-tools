const test = require('tape');
const { JVM } = require('../src/jvm');
const path = require('path');

test('JVM should execute CalcMain.class and print "4"', async function(t) {
  t.plan(1);

  const jvm = new JVM({ classpath: 'sources' });
  const classFilePath = path.join(__dirname, '..', 'sources', 'CalcMain.class');

  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(I)V': (jvm, obj, args) => {
        output += args[0];
      },
    },
  });

  await jvm.run(classFilePath);

  t.equal(output, '4', 'The JVM should correctly print "4"');
});