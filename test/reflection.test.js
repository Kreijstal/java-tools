const test = require('tape');
const { execSync } = require('child_process');

test('Reflection test', (t) => {
  // Compile the Java file
  try {
    execSync('mkdir -p build && javac -d build sources/ReflectionTest.java');
  } catch (error) {
    t.fail(`Compilation failed: ${error.stderr.toString()}`);
    t.end();
    return;
  }

  // Run with standard java to get expected output
  const expectedOutput = execSync('java -cp build ReflectionTest').toString();

  // Run with runJvm.js
  let actualOutput;
  try {
    actualOutput = execSync('node scripts/runJvm.js -cp build ReflectionTest').toString();
  } catch (error) {
    actualOutput = error.stdout.toString() + error.stderr.toString();
  }

  // Normalize outputs
  const normalize = (str) => str.replace(/\r\n/g, '\n').trim();
  const normalizedExpected = normalize(expectedOutput);
  const normalizedActual = normalize(actualOutput);

  t.equal(normalizedActual, normalizedExpected, 'The output of runJvm.js should match the standard java output for ReflectionTest');
  t.end();
});
