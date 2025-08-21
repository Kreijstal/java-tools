const test = require('tape');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');
const { SymbolIdentifier } = require('../src/symbols');
const { renameField } = require('../src/renameField');

function teardown(testDir) {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

test('rename field functionality', async (t) => {
  const tempDir = path.join(__dirname, 'temp_rename_field_test');
  const sourcesDir = path.join(__dirname, '../sources');

  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir);

    fs.copyFileSync(path.join(sourcesDir, 'FieldTest.java'), path.join(tempDir, 'FieldTest.java'));
    fs.copyFileSync(path.join(sourcesDir, 'FieldTestRunner.java'), path.join(tempDir, 'FieldTestRunner.java'));

    execSync(`javac ${path.join(tempDir, '*.java')}`);

    const workspace = await KrakatauWorkspace.create(tempDir);
    const symbolIdentifier = new SymbolIdentifier('FieldTest', 'myField');
    await workspace.applyFieldRenameAndSave(symbolIdentifier, 'myRenamedField', tempDir);


    const verificationWorkspace = await KrakatauWorkspace.create(tempDir);

    const fieldTestAst = verificationWorkspace.getClassAST('FieldTest');
    const fields = fieldTestAst.classes[0].items.filter(item => item.type === 'field');
    const renamedField = fields.find(f => f.field.name === 'myRenamedField');
    t.ok(renamedField, 'FieldTest.class should contain myRenamedField');

    const runnerAst = verificationWorkspace.getClassAST('FieldTestRunner');
    const mainMethod = runnerAst.classes[0].items.find(item => item.method.name === 'main');
    const code = mainMethod.method.attributes.find(attr => attr.type === 'code').code;
    const fieldAccessInstructions = code.codeItems.filter(item => item.instruction && (item.instruction.op === 'getfield' || item.instruction.op === 'putfield'));
    t.equal(fieldAccessInstructions.length, 3, 'FieldTestRunner should have three field access instructions');
    t.equal(fieldAccessInstructions[0].instruction.arg[2][0], 'myRenamedField', 'getfield should access myRenamedField');
    t.equal(fieldAccessInstructions[1].instruction.arg[2][0], 'myRenamedField', 'putfield should access myRenamedField');
    t.equal(fieldAccessInstructions[2].instruction.arg[2][0], 'myRenamedField', 'second getfield should access myRenamedField');

    const output = execSync(`java -cp ${tempDir} FieldTestRunner`).toString().trim();
    t.equal(output, "10\n20", 'Output of FieldTestRunner should be correct');

  } catch (error) {
    t.fail(error.toString());
  } finally {
    teardown(tempDir);
    t.end();
  }
});
