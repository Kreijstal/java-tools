const test = require('tape');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');
const { SymbolIdentifier } = require('../src/symbols');

test('rename method functionality', async (t) => {
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

    // 4. Verify the rename using KrakatauWorkspace
    const verificationWorkspace = await KrakatauWorkspace.create(tempDir);

    // Verify TestMethods.class
    const testMethodsAst = verificationWorkspace.getClassAST('TestMethods');
    const methods = testMethodsAst.classes[0].items.filter(item => item.type === 'method');
    const renamedMethod = methods.find(m => m.method.name === 'renamedPublicMethod');
    const oldMethod = methods.find(m => m.method.name === 'publicMethod1');
    t.ok(renamedMethod, 'TestMethods.class should contain renamedPublicMethod');
    t.notOk(oldMethod, 'TestMethods.class should not contain publicMethod1');

    // Verify TestMethodsRunner.class
    const runnerAst = verificationWorkspace.getClassAST('TestMethodsRunner');
    const mainMethod = runnerAst.classes[0].items.find(item => item.method.name === 'main');
    const code = mainMethod.method.attributes.find(attr => attr.type === 'code').code;
    const invokeVirtualInstructions = code.codeItems.filter(item => item.instruction && item.instruction.op === 'invokevirtual');
    t.ok(invokeVirtualInstructions.length > 0, 'TestMethodsRunner should have at least one invokevirtual instruction');

    const renamedCall = invokeVirtualInstructions.find(instr => instr.instruction.arg[2][0] === 'renamedPublicMethod');
    t.ok(renamedCall, 'TestMethodsRunner should call renamedPublicMethod');


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
