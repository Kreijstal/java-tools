const test = require('tape');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { KrakatauWorkspace, SymbolIdentifier } = require('../src/KrakatauWorkspace');

test.skip('rename method functionality', async (t) => {
  const tempDir = path.join(__dirname, 'temp_rename_test');
  const sourcesDir = path.join(__dirname, '../sources');

  try {
    // 1. Setup: Create temp directory and copy source files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir);

    fs.copyFileSync(path.join(sourcesDir, 'TestMethods.java'), path.join(tempDir, 'TestMethods.java'));
    fs.copyFileSync(path.join(sourcesDir, 'TestMethodsRunner.java'), path.join(tempDir, 'TestMethodsRunner.java'));

    // 2. Compile the java sources in the temporary directory
    execSync(`javac ${path.join(tempDir, '*.java')}`);

    // 3. Perform the rename operation
    const workspace = await KrakatauWorkspace.create(tempDir);
    const symbolIdentifier = new SymbolIdentifier('TestMethods', 'publicMethod1');
    await workspace.applyRenameAndSave(symbolIdentifier, 'renamedPublicMethod', tempDir);

    // 4. Verify the rename
    const classFilePath = path.join(tempDir, 'TestMethods.class');
    const classDetails = execSync(`javap -public ${classFilePath}`).toString();
    t.ok(classDetails.includes('renamedPublicMethod'), 'TestMethods.class should contain renamedPublicMethod');
    t.notOk(classDetails.includes('publicMethod1'), 'TestMethods.class should not contain publicMethod1');

    // Also verify that the runner was updated
    const runnerClassFilePath = path.join(tempDir, 'TestMethodsRunner.class');
    const runnerDetails = execSync(`javap -c ${runnerClassFilePath}`).toString();
    t.ok(runnerDetails.includes('invokevirtual'), 'TestMethodsRunner should have an invokevirtual instruction');
    t.ok(runnerDetails.includes('// Method TestMethods.renamedPublicMethod:()V'), 'TestMethodsRunner should call renamedPublicMethod');


    // 5. Run the modified code and check the output
    const output = execSync(`java -cp ${tempDir} TestMethodsRunner`).toString().trim();
    const expectedOutput = [
      'Public Method 1',
      'Public Method 2'
    ].join('\n');
    t.equal(output, expectedOutput, 'Output of TestMethodsRunner should be correct');

  } catch (error) {
    t.fail(error.toString());
  } finally {
    // 6. Teardown: Clean up the temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    t.end();
  }
});
