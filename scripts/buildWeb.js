const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFiles(src, dest) {
  ensureDir(dest);
  const files = fs.readdirSync(src);
  
  for (const file of files) {
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);
    const stat = fs.statSync(srcPath);
    
    if (stat.isDirectory()) {
      copyFiles(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function main() {
  console.log('Building web frontend...');
  
  // Create dist directory
  ensureDir('dist');
  
  // Copy static web files
  if (fs.existsSync('web')) {
    copyFiles('web', 'dist');
  }
  
  // Copy necessary source files for the web demo
  ensureDir('dist/src');
  fs.copyFileSync('src/debugJvm.js', 'dist/src/debugJvm.js');
  fs.copyFileSync('src/stack.js', 'dist/src/stack.js');
  fs.copyFileSync('src/classLoader.js', 'dist/src/classLoader.js');
  fs.copyFileSync('src/typeParser.js', 'dist/src/typeParser.js');
  
  // Copy compiled class files
  ensureDir('dist/classes');
  const classFiles = fs.readdirSync('sources').filter(file => file.endsWith('.class'));
  for (const classFile of classFiles) {
    fs.copyFileSync(`sources/${classFile}`, `dist/classes/${classFile}`);
  }
  
  // Copy sample Java source files for display
  ensureDir('dist/java-sources');
  const javaFiles = fs.readdirSync('sources').filter(file => file.endsWith('.java'));
  for (const javaFile of javaFiles) {
    fs.copyFileSync(`sources/${javaFile}`, `dist/java-sources/${javaFile}`);
  }
  
  console.log('Web build complete!');
}

main();