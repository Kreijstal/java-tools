#!/usr/bin/env node

/**
 * Health check script for CI environment
 * Verifies that all required dependencies are available
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔍 Running environment health check...\n');

// Check Node.js version
console.log('📋 Node.js version:');
try {
  const nodeVersion = process.version;
  console.log(`   ✅ ${nodeVersion}`);
} catch (error) {
  console.log(`   ❌ Node.js not found: ${error.message}`);
  process.exit(1);
}

// Check npm version
console.log('\n📋 npm version:');
try {
  const npmVersion = execSync('npm --version', { encoding: 'utf8' }).trim();
  console.log(`   ✅ v${npmVersion}`);
} catch (error) {
  console.log(`   ❌ npm not found: ${error.message}`);
  process.exit(1);
}

// Check Java version
console.log('\n📋 Java version:');
try {
  const javaVersion = execSync('java -version', { encoding: 'utf8', stderr: 'inherit' });
  console.log('   ✅ Java found');
} catch (error) {
  console.log(`   ❌ Java not found: ${error.message}`);
  process.exit(1);
}

// Check javac (Java compiler)
console.log('\n📋 Java compiler:');
try {
  const javacVersion = execSync('javac -version', { encoding: 'utf8', stderr: 'inherit' });
  console.log('   ✅ javac found');
} catch (error) {
  console.log(`   ❌ javac not found: ${error.message}`);
  process.exit(1);
}

// Check package.json exists
console.log('\n📋 Project configuration:');
const packageJsonPath = path.join(process.cwd(), 'package.json');
if (fs.existsSync(packageJsonPath)) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  console.log(`   ✅ package.json found (${packageJson.name}@${packageJson.version})`);
} else {
  console.log('   ❌ package.json not found');
  process.exit(1);
}

// Check if Java sources exist
console.log('\n📋 Java sources:');
const sourcesPath = path.join(process.cwd(), 'sources');
if (fs.existsSync(sourcesPath)) {
  const javaFiles = fs.readdirSync(sourcesPath).filter(file => file.endsWith('.java'));
  console.log(`   ✅ Found ${javaFiles.length} Java source files`);
} else {
  console.log('   ❌ sources directory not found');
  process.exit(1);
}

// Check if test files exist
console.log('\n📋 Test files:');
const testPath = path.join(process.cwd(), 'test');
if (fs.existsSync(testPath)) {
  const testFiles = fs.readdirSync(testPath).filter(file => file.endsWith('.test.js'));
  console.log(`   ✅ Found ${testFiles.length} test files`);
} else {
  console.log('   ❌ test directory not found');
  process.exit(1);
}

console.log('\n🎉 Environment health check passed! All dependencies are available.');