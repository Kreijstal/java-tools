const test = require('tape');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');
const { SymbolIdentifier } = require('../src/symbols');

async function setup(testDir) {
  const sourcesDir = path.join(__dirname, '../sources');
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir);

  fs.copyFileSync(path.join(sourcesDir, 'HierarchyA.java'), path.join(testDir, 'HierarchyA.java'));
  fs.copyFileSync(path.join(sourcesDir, 'HierarchyB.java'), path.join(testDir, 'HierarchyB.java'));
  fs.copyFileSync(path.join(sourcesDir, 'HierarchyC.java'), path.join(testDir, 'HierarchyC.java'));

  execSync(`javac ${path.join(testDir, '*.java')}`);
}

function teardown(testDir) {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

test('rename method down hierarchy', async (t) => {
  const tempDir = path.join(__dirname, 'temp_rename_down_test');
  await setup(tempDir);

  try {
    const workspace = await KrakatauWorkspace.create(tempDir);
    const symbolIdentifier = new SymbolIdentifier('HierarchyA', 'methodToRename');
    await workspace.applyRenameAndSave(symbolIdentifier, 'renamedMethod', tempDir);

    const verificationWorkspace = await KrakatauWorkspace.create(tempDir);

    const astA = verificationWorkspace.getClassAST('HierarchyA');
    t.ok(astA.classes[0].items.some(item => item.type === 'method' && item.method.name === 'renamedMethod'), 'HierarchyA.class should contain renamedMethod');

    const astB = verificationWorkspace.getClassAST('HierarchyB');
    t.ok(astB.classes[0].items.some(item => item.type === 'method' && item.method.name === 'renamedMethod'), 'HierarchyB.class should contain renamedMethod');

    const astC = verificationWorkspace.getClassAST('HierarchyC');
    const mainMethodC = astC.classes[0].items.find(item => item.method.name === 'main');
    const codeC = mainMethodC.method.attributes.find(attr => attr.type === 'code').code;
    const calls = codeC.codeItems.filter(item => item.instruction && item.instruction.op === 'invokevirtual' && item.instruction.arg[2][0] === 'renamedMethod');
    t.equal(calls.length, 2, 'HierarchyC.class should have two calls to renamedMethod');

    const output = execSync(`java -cp ${tempDir} HierarchyC`).toString().trim();
    t.equal(output, "A\nB", 'Output of HierarchyC should be correct');

  } catch (error) {
    t.fail(error.toString());
  } finally {
    teardown(tempDir);
    t.end();
  }
});

test('rename method in sibling implementations', async (t) => {
    const tempDir = path.join(__dirname, 'temp_rename_sibling_test');
    const sourcesDir = path.join(__dirname, '../sources');

    try {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        fs.mkdirSync(tempDir);

        fs.copyFileSync(path.join(sourcesDir, 'I.java'), path.join(tempDir, 'I.java'));
        fs.copyFileSync(path.join(sourcesDir, 'A.java'), path.join(tempDir, 'A.java'));
        fs.copyFileSync(path.join(sourcesDir, 'B.java'), path.join(tempDir, 'B.java'));
        fs.copyFileSync(path.join(sourcesDir, 'Runner.java'), path.join(tempDir, 'Runner.java'));

        execSync(`javac ${path.join(tempDir, '*.java')}`);

        const workspace = await KrakatauWorkspace.create(tempDir);
        const symbolIdentifier = new SymbolIdentifier('A', 'myMethod');
        await workspace.applyRenameAndSave(symbolIdentifier, 'myRenamedMethod', tempDir);

        const verificationWorkspace = await KrakatauWorkspace.create(tempDir);

        const astI = verificationWorkspace.getClassAST('I');
        t.ok(astI.classes[0].items.some(item => item.type === 'method' && item.method.name === 'myRenamedMethod'), 'I.java should contain myRenamedMethod');

        const astA = verificationWorkspace.getClassAST('A');
        t.ok(astA.classes[0].items.some(item => item.type === 'method' && item.method.name === 'myRenamedMethod'), 'A.java should contain myRenamedMethod');

        const astB = verificationWorkspace.getClassAST('B');
        t.ok(astB.classes[0].items.some(item => item.type === 'method' && item.method.name === 'myRenamedMethod'), 'B.java should contain myRenamedMethod');

        const runnerAst = verificationWorkspace.getClassAST('Runner');
        const mainMethod = runnerAst.classes[0].items.find(item => item.method.name === 'main');
        const code = mainMethod.method.attributes.find(attr => attr.type === 'code').code;
        const invokeInstructions = code.codeItems.filter(item => item.instruction && item.instruction.op === 'invokeinterface');
        t.equal(invokeInstructions.length, 2, 'Runner.java should have two invokeinterface instructions');
        t.equal(invokeInstructions[0].instruction.arg[2][0], 'myRenamedMethod', 'first invokeinterface should call myRenamedMethod');
        t.equal(invokeInstructions[1].instruction.arg[2][0], 'myRenamedMethod', 'second invokeinterface should call myRenamedMethod');

        const output = execSync(`java -cp ${tempDir} Runner`).toString().trim();
        t.equal(output, "A\nB", 'Output of Runner should be correct');

    } catch (error) {
        t.fail(error.toString());
    } finally {
        teardown(tempDir);
        t.end();
    }
});

test('rename method in interface', async (t) => {
    const tempDir = path.join(__dirname, 'temp_rename_interface_test');
    const sourcesDir = path.join(__dirname, '../sources');

    try {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        fs.mkdirSync(tempDir);

        fs.copyFileSync(path.join(sourcesDir, 'RenameableInterface.java'), path.join(tempDir, 'RenameableInterface.java'));
        fs.copyFileSync(path.join(sourcesDir, 'MyImplementation.java'), path.join(tempDir, 'MyImplementation.java'));
        fs.copyFileSync(path.join(sourcesDir, 'InterfaceRunner.java'), path.join(tempDir, 'InterfaceRunner.java'));

        execSync(`javac ${path.join(tempDir, '*.java')}`);

        const workspace = await KrakatauWorkspace.create(tempDir);
        const symbolIdentifier = new SymbolIdentifier('RenameableInterface', 'methodToRename');
        await workspace.applyRenameAndSave(symbolIdentifier, 'renamedMethod', tempDir);

        const verificationWorkspace = await KrakatauWorkspace.create(tempDir);

        const interfaceAst = verificationWorkspace.getClassAST('RenameableInterface');
        t.ok(interfaceAst.classes[0].items.some(item => item.type === 'method' && item.method.name === 'renamedMethod'), 'RenameableInterface.java should contain renamedMethod');

        const implementationAst = verificationWorkspace.getClassAST('MyImplementation');
        t.ok(implementationAst.classes[0].items.some(item => item.type === 'method' && item.method.name === 'renamedMethod'), 'MyImplementation.java should contain renamedMethod');

        const runnerAst = verificationWorkspace.getClassAST('InterfaceRunner');
        const mainMethod = runnerAst.classes[0].items.find(item => item.method.name === 'main');
        const code = mainMethod.method.attributes.find(attr => attr.type === 'code').code;
        const invokeInstruction = code.codeItems.find(item => item.instruction && item.instruction.op === 'invokeinterface');
        t.ok(invokeInstruction, 'InterfaceRunner.java should have an invokeinterface instruction');
        t.equal(invokeInstruction.instruction.arg[2][0], 'renamedMethod', 'invokeinterface should call renamedMethod');

        const output = execSync(`java -cp ${tempDir} InterfaceRunner`).toString().trim();
        t.equal(output, "Implemented method", 'Output of InterfaceRunner should be correct');

    } catch (error) {
        t.fail(error.toString());
    } finally {
        teardown(tempDir);
        t.end();
    }
});

test('rename method up hierarchy', async (t) => {
  const tempDir = path.join(__dirname, 'temp_rename_up_test');
  await setup(tempDir);

  try {
    const workspace = await KrakatauWorkspace.create(tempDir);
    const symbolIdentifier = new SymbolIdentifier('HierarchyB', 'methodToRename');
    await workspace.applyRenameAndSave(symbolIdentifier, 'renamedMethod', tempDir);

    const verificationWorkspace = await KrakatauWorkspace.create(tempDir);

    const astA = verificationWorkspace.getClassAST('HierarchyA');
    t.ok(astA.classes[0].items.some(item => item.type === 'method' && item.method.name === 'renamedMethod'), 'HierarchyA.class should contain renamedMethod');

    const astB = verificationWorkspace.getClassAST('HierarchyB');
    t.ok(astB.classes[0].items.some(item => item.type === 'method' && item.method.name === 'renamedMethod'), 'HierarchyB.class should contain renamedMethod');

    const astC = verificationWorkspace.getClassAST('HierarchyC');
    const mainMethodC = astC.classes[0].items.find(item => item.method.name === 'main');
    const codeC = mainMethodC.method.attributes.find(attr => attr.type === 'code').code;
    const calls = codeC.codeItems.filter(item => item.instruction && item.instruction.op === 'invokevirtual' && item.instruction.arg[2][0] === 'renamedMethod');
    t.equal(calls.length, 2, 'HierarchyC.class should have two calls to renamedMethod');

    const output = execSync(`java -cp ${tempDir} HierarchyC`).toString().trim();
    t.equal(output, "A\nB", 'Output of HierarchyC should be correct');

  } catch (error) {
    t.fail(error.toString());
  } finally {
    teardown(tempDir);
    t.end();
  }
});
