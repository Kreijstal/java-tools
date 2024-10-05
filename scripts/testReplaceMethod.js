const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { replaceMethod } = require('./replaceMethod');

function runTest() {
  const tempDir = path.join(__dirname, 'tempTestDir');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  // Copy original class files to temp directory
  const sourceDir = path.join(__dirname, '../sources');
  fs.readdirSync(sourceDir).forEach(file => {
    const srcFile = path.join(sourceDir, file);
    const destFile = path.join(tempDir, file);
    fs.copyFileSync(srcFile, destFile);
  });

  // Perform the method renaming
  replaceMethod('TestMethods', sourceDir, 'publicMethod1', 'newMethodName');

  // Verify the method has been renamed
  const classFilePath = path.join(sourceDir, 'TestMethods.class');
  const classDetails = execSync(`node scripts/listClassDetails.js ${classFilePath}`).toString();
  if (!classDetails.includes('newMethodName')) {
    console.error('Method renaming failed.');
    process.exit(1);
  }

  // Run the Java class
  try {
    const output = execSync(`java -cp ${sourceDir} TestMethods`).toString();
    console.log('Java program output:', output);
  } catch (error) {
    console.error('Error running Java program:', error);
    process.exit(1);
  }
}

runTest();
