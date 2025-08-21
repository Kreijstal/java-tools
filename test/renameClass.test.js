const test = require('tape');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');
const { SymbolIdentifier } = require('../src/symbols');

function teardown(testDir) {
  // if (fs.existsSync(testDir)) {
  //   fs.rmSync(testDir, { recursive: true, force: true });
  // }
}

test('rename class functionality', async (t) => {
  const tempDir = path.join(__dirname, 'temp_rename_class_test');
  const sourcesDir = path.join(__dirname, '../sources');

  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir);

    fs.copyFileSync(path.join(sourcesDir, 'ClassToRename.java'), path.join(tempDir, 'ClassToRename.java'));
    fs.copyFileSync(path.join(sourcesDir, 'ClassRenamingTestRunner.java'), path.join(tempDir, 'ClassRenamingTestRunner.java'));

    execSync(`javac ${path.join(tempDir, '*.java')}`);

    const workspace = await KrakatauWorkspace.create(tempDir);
    await workspace.applyClassRenameAndSave('ClassToRename', 'RenamedClass', tempDir);


    const verificationWorkspace = await KrakatauWorkspace.create(tempDir);

    t.ok(verificationWorkspace.getClassAST('RenamedClass'), 'RenamedClass should exist in workspace');
    t.throws(() => verificationWorkspace.getClassAST('ClassToRename'), /not found/, 'ClassToRename should not exist in workspace');

    const runnerAst = verificationWorkspace.getClassAST('ClassRenamingTestRunner');
    const mainMethod = runnerAst.classes[0].items.find(item => item.method.name === 'main');
    const code = mainMethod.method.attributes.find(attr => attr.type === 'code').code;
    const newInstruction = code.codeItems.find(item => item.instruction && item.instruction.op === 'new');
    t.ok(newInstruction, 'should have new instruction');
    t.equal(newInstruction.instruction.arg, 'RenamedClass', 'new instruction should reference RenamedClass');

    const output = execSync(`java -cp ${tempDir} ClassRenamingTestRunner`).toString().trim();
    t.equal(output, "This is the ClassToRename", 'Output of ClassRenamingTestRunner should be correct');

  } catch (error) {
    t.fail(error.toString());
  } finally {
    teardown(tempDir);
    t.end();
  }
});
