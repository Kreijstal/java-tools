const test = require('tape');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

test('data.zip should be generated and contain all sample class files', function(t) {
  t.plan(4);

  // First, ensure the build has been run
  const distDir = path.join(__dirname, '..', 'dist');
  const dataZipPath = path.join(distDir, 'data.zip');

  // Build if data.zip doesn't exist
  if (!fs.existsSync(dataZipPath)) {
    console.log('Building project to generate data.zip...');
    execSync('npm run build', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
  }

  // Test 1: Check if data.zip file exists
  t.ok(fs.existsSync(dataZipPath), 'data.zip file should exist in dist directory');

  // Test 2: Check if data.zip is not empty
  const stats = fs.statSync(dataZipPath);
  t.ok(stats.size > 0, 'data.zip should not be empty');


  // Test 4: Verify that data.zip can be read and contains class files
  const JSZip = require('jszip');
  const zipData = fs.readFileSync(dataZipPath);
  
  JSZip.loadAsync(zipData).then(function(zip) {
    const classFiles = Object.keys(zip.files).filter(filename => filename.endsWith('.class'));
    t.ok(classFiles.length >= 20, `data.zip should contain at least 20 class files, found ${classFiles.length}`);
    t.end();
  }).catch(function(err) {
    t.fail('Failed to read data.zip: ' + err.message);
    t.end();
  });
});

test('main debug interface HTML should contain download link for data.zip', function(t) {
  t.plan(2);

  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  
  // Ensure the file exists
  if (!fs.existsSync(indexPath)) {
    console.log('Building project to generate index.html...');
    execSync('npm run build', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
  }

  // Test 1: Check if index.html exists
  t.ok(fs.existsSync(indexPath), 'dist/index.html should exist');

  // Test 2: Check if index.html contains the download link for data.zip
  const htmlContent = fs.readFileSync(indexPath, 'utf8');
  t.ok(htmlContent.includes('href="./data.zip"'), 'index.html should contain a download link for data.zip');
  
  t.end();
});