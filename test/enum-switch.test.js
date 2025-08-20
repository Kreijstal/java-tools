const tape = require('tape');
const path = require('path');
const { JVM } = require('../src/jvm');

tape('JVM should handle enum switch statements', async (t) => {
  const jvm = new JVM({ classpath: 'sources' });
  
  // Test the original problematic case
  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(Ljava/lang/String;)V': (jvm, obj, args) => {
        output += args[0] + '\n';
      }
    }
  });

  const classFilePath = path.join('sources', 'EnumSwitchCrash.class');
  
  try {
    await jvm.run(classFilePath);
    t.equal(output.trim(), 'It is red', 'EnumSwitchCrash should print "It is red"');
  } catch (e) {
    t.fail(`EnumSwitchCrash should not crash: ${e.message}`);
  }
  
  // Test comprehensive enum switch
  output = '';
  const testClassFilePath = path.join('sources', 'EnumSwitchTest.class');
  
  try {
    await jvm.run(testClassFilePath);
    const lines = output.trim().split('\n');
    t.equal(lines[0], 'Testing RED: It is red', 'RED case should work');
    t.equal(lines[1], 'Testing GREEN: It is green', 'GREEN case should work');
    t.equal(lines[2], 'Testing BLUE: It is blue', 'BLUE case should work');
    t.equal(lines[3], 'Testing YELLOW: Unknown color', 'Default case should work');
  } catch (e) {
    t.fail(`EnumSwitchTest should not crash: ${e.message}`);
  }

  t.end();
});