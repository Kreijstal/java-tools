const test = require('tape');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { KrakatauWorkspace } = require("../src/KrakatauWorkspace");
const { SymbolIdentifier } = require("../src/symbols");

// Test re-enabled after fixing KrakatauWorkspace.applyRenameAndSave
test('replaceMethod functionality', async function(t) {
  const tempDir = path.join(__dirname, 'tempTestDir');

  // Clean up and create temp directory
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir);

  try {
    // Copy original class files to temp directory
    const sourceDir = path.join(__dirname, '../sources');
    ['TestMethods.class', 'TestMethodsRunner.class'].forEach(file => {
      const srcFile = path.join(sourceDir, file);
      const destFile = path.join(tempDir, file);
      fs.copyFileSync(srcFile, destFile);
    });

    // Perform the method renaming using KrakatauWorkspace API
    console.log(`Calling applyRenameAndSave with: className=TestMethods, oldMethodName=publicMethod1, newMethodName=newMethodName`);

    const workspace = await KrakatauWorkspace.create(path.join(__dirname, '..','sources'));
    const symbolIdentifier = new SymbolIdentifier('TestMethods', 'publicMethod1');
    workspace.applyRenameAndSave(symbolIdentifier, 'newMethodName', tempDir);

    // Verify the method has been renamed
    const classFilePath = path.join(tempDir, 'TestMethods.class');
    const classDetails = execSync(`javap -public ${classFilePath}`).toString();
    t.ok(classDetails.includes('newMethodName'), 'TestMethods.class should contain newMethodName');
    t.notOk(classDetails.includes('publicMethod1'), 'TestMethods.class should not contain publicMethod1');

    // Run the Java class to verify it still works
    const originalDir = process.cwd();
    process.chdir(tempDir);
    try {
      const output = execSync(`java -cp . TestMethodsRunner`).toString();
      console.log('Java program output:', output);
      t.ok(output.includes('Public Method 1'), 'Program should still print "Public Method 1"');
    } finally {
      process.chdir(originalDir);
    }

    t.end();
  } catch (error) {
    t.fail(`Test failed: ${error.message}`);
    t.end();
  } finally {
    // Clean up
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
