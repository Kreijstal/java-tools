'use strict';

// Compiling a .java fixture with the real javac, for the tests that need real
// classfiles rather than assembled ones.
//
// Every suite that does this had its own copy of the same eight lines, differing
// only in the temp-directory prefix it used and in brace style.
// `makeJavaFixtureCompiler` binds that prefix and returns the same
// (t, className, source) function those suites already call, so no call site
// changed and each suite's temp directories keep their own recognisable name.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function makeJavaFixtureCompiler(prefix) {
  return function compileJavaFixture(t, className, source) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.teardown(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const sourcePath = path.join(tempDir, `${className}.java`);
    fs.writeFileSync(sourcePath, source);
    execFileSync('javac', ['-g', '-d', tempDir, sourcePath], { stdio: 'inherit' });
    return tempDir;
  };
}

module.exports = { makeJavaFixtureCompiler };
