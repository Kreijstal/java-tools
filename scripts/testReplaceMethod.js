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

  // Change directory to temp directory
  process.chdir(tempDir);

  // Perform the method renaming
  replaceMethod('TestMethods', '.', 'publicMethod1', 'newMethodName');

  // Verify the method has been renamed
  const classFileContent = fs.readFileSync('TestMethods.java', 'utf8');
  if (!classFileContent.includes('newMethodName')) {
    console.error('Method renaming failed.');
    process.exit(1);
  }

  // Compile and run the Java class
  try {
    execSync('javac TestMethods.java');
    const output = execSync('java TestMethods').toString();
    console.log('Java program output:', output);
  } catch (error) {
    console.error('Error running Java program:', error);
    process.exit(1);
  }

  // Clean up
  process.chdir(__dirname);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

runTest();
