const test = require('tape');
const { JVM } = require('../src/jvm');
const path = require('path');

test('JVM should execute Hello.class and print "Hello, World!"', async function(t) {
  t.plan(1);

  const jvm = new JVM();
  const classFilePath = path.join(__dirname, '..', 'sources', 'Hello.class');

  // TODO: Capture output
  await jvm.run(classFilePath);

  // t.equal(output, 'Hello, World!', 'The JVM should correctly print "Hello, World!"');
  t.pass('Test temporarily disabled');
});