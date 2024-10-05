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
  console.log(`Calling replaceMethod with: className=TestMethods, classPath=${tempDir}, oldMethodName=publicMethod1, newMethodName=newMethodName`);
  replaceMethod('TestMethods', tempDir, 'publicMethod1', 'newMethodName');

  // Verify the method has been renamed
  const classFilePath = path.join(tempDir, 'TestMethods.class');
  const classDetails = execSync(`node scripts/listClassDetails.js ${classFilePath}`).toString();
  if (!classDetails.includes('newMethodName')) {
    console.error('Method renaming failed.');
    process.exit(1);
  }

  // Change directory to temp directory
  process.chdir(tempDir);

  // Run the Java class
  try {
    const output = execSync(`java -cp . TestMethods`).toString();
    console.log('Java program output:', output);
  } catch (error) {
    console.error('Error running Java program:', error);
    process.exit(1);
  } finally {
    // Change back to the original directory
    process.chdir(__dirname);
  }
}

runTest();
