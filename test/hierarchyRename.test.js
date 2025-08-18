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

    const detailsA = execSync(`javap -public ${path.join(tempDir, 'HierarchyA.class')}`).toString();
    t.ok(detailsA.includes('renamedMethod'), 'HierarchyA.class should contain renamedMethod');

    const detailsB = execSync(`javap -public ${path.join(tempDir, 'HierarchyB.class')}`).toString();
    t.ok(detailsB.includes('renamedMethod'), 'HierarchyB.class should contain renamedMethod');

    const detailsC = execSync(`javap -c ${path.join(tempDir, 'HierarchyC.class')}`).toString();
    t.equal((detailsC.match(/renamedMethod/g) || []).length, 2, 'HierarchyC.class should have two calls to renamedMethod');

    const output = execSync(`java -cp ${tempDir} HierarchyC`).toString().trim();
    t.equal(output, "A\nB", 'Output of HierarchyC should be correct');

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

    const detailsA = execSync(`javap -public ${path.join(tempDir, 'HierarchyA.class')}`).toString();
    t.ok(detailsA.includes('renamedMethod'), 'HierarchyA.class should contain renamedMethod');

    const detailsB = execSync(`javap -public ${path.join(tempDir, 'HierarchyB.class')}`).toString();
    t.ok(detailsB.includes('renamedMethod'), 'HierarchyB.class should contain renamedMethod');

    const detailsC = execSync(`javap -c ${path.join(tempDir, 'HierarchyC.class')}`).toString();
    t.equal((detailsC.match(/renamedMethod/g) || []).length, 2, 'HierarchyC.class should have two calls to renamedMethod');

    const output = execSync(`java -cp ${tempDir} HierarchyC`).toString().trim();
    t.equal(output, "A\nB", 'Output of HierarchyC should be correct');

  } catch (error) {
    t.fail(error.toString());
  } finally {
    teardown(tempDir);
    t.end();
  }
});
