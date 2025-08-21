const test = require('tape');
const { JVM } = require('../src/jvm');
const path = require('path');

async function runJvmTest(testName) {
    const jvm = new JVM();
    const sourcesPath = path.join(__dirname, '..', 'sources');
    const classFilePath = path.join(sourcesPath, `${testName}.class`);
    jvm.classpath = sourcesPath;
    let output = '';
    jvm.registerJreMethods({
        'java/io/PrintStream': {
            'println(I)V': (jvm, obj, args) => {
                output += args[0] + '\n';
            },
        },
    });
    await jvm.run(classFilePath);
    return output;
}

test('JVM Crash Tests - SwitchCrash', async function (t) {
    const output = await runJvmTest('SwitchCrash');
    t.equal(output, '2\n4\n', 'SwitchCrash test should produce the correct output');
    t.end();
});
