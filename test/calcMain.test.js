const test = require('tape');
const JVM = require('../src/jvm');
const path = require('path');

test('JVM should execute CalcMain.class and print "4"', function(t) {
  t.plan(1);

  const jvm = new JVM();
  const classFilePath = path.join(__dirname, '..', 'sources', 'CalcMain.class');

  let output = '';
  const originalLog = console.log;
  console.log = function(message) {
    output += message;
  };

  jvm.run(classFilePath, { silent: true });

  console.log = originalLog;

  t.equal(output, '4', 'The JVM should correctly print "4"');
});