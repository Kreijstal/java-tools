'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const frontend = require('../src/java-frontend');


function collectClassFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.class')) {
        files.push(entryPath);
      }
    }
  }
  return files.sort();
}

function collectJavaFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.java')) {
        files.push(entryPath);
      }
    }
  }
  return files.sort();
}

test('repository Java frontend builds every provided .java file without host compiler fallback', (t) => {
  const roots = [
    path.join(__dirname, '..', 'sources'),
    path.join(__dirname, '..', 'examples', 'sources', 'java'),
    path.join(__dirname, 'fixtures', 'cfr', 'expected'),
  ];
  const inputPaths = roots.flatMap(collectJavaFiles);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-frontend-all-'));

  try {
    const result = frontend.compileJavaFiles(inputPaths, {
      outputDir,
      tolerant: true,
      stubUnsupportedMethods: true,
      fallbackUnsupportedTypes: true,
    });

    t.equal(inputPaths.length, 148, 'all provided Java sources are covered by the regression set');
    t.equal(result.backend, 'java-frontend', 'batch compile uses the repository Java frontend backend');
    t.equal(result.results.length, inputPaths.length, 'one frontend compile result is recorded per source file');
    const writtenPaths = result.written.map((entry) => entry.outputPath);
    const classFiles = collectClassFiles(outputDir);
    t.ok(result.written.length >= inputPaths.length, 'frontend emits at least one class file per Java source');
    t.equal(new Set(writtenPaths).size, writtenPaths.length, 'duplicate binary names are isolated to conflict-safe output paths');
    t.equal(classFiles.length, result.written.length, 'every reported class file exists as a distinct file');
    t.equal(result.status, 'complete', 'the full provided corpus lowers without unsupported frontend bodies');
    t.equal(result.unsupported.length, 0, 'no unsupported frontend diagnostics remain for the provided corpus');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  t.end();
});
