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

function collectBytecodeUnsupportedArtifacts(result) {
  const artifacts = [];
  for (const classIr of (result.bytecodeIr && result.bytecodeIr.classes) || []) {
    for (const method of classIr.methods || []) {
      for (const instruction of method.instructions || []) {
        if (instruction.opcode === 'unsupported') {
          artifacts.push(`${classIr.internalName}.${method.name}${method.descriptor}: ${instruction.operands && instruction.operands[0]}`);
        }
      }
    }
  }
  return artifacts;
}

function collectJavaIrUnsupportedOps(result) {
  const artifacts = [];
  for (const classIr of (result.javaIr && result.javaIr.classes) || []) {
    for (const method of classIr.methods || []) {
      if ((method.access || []).includes('abstract') || (method.access || []).includes('native')) continue;
      for (const block of method.blocks || []) {
        for (const op of block.ops || []) {
          if (op.op === 'unsupported' || op.op === 'expression') {
            artifacts.push(`${classIr.internalName}.${method.name}${method.descriptor}: ${op.op}${op.text ? ` (${op.text})` : ''}`);
          }
        }
      }
    }
  }
  return artifacts;
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
      fallbackUnsupportedTypes: false,
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

    const bytecodeArtifacts = [];
    const javaIrArtifacts = [];
    for (const inputPath of inputPaths) {
      const singleResult = frontend.compileJavaFile(inputPath, {
        sourceFileName: path.basename(inputPath),
        fallbackUnsupportedTypes: false,
      });
      bytecodeArtifacts.push(...collectBytecodeUnsupportedArtifacts(singleResult));
      javaIrArtifacts.push(...collectJavaIrUnsupportedOps(singleResult));
    }
    t.equal(bytecodeArtifacts.length, 0, 'no unsupported bytecode lowering artifacts in any class file');
    t.equal(javaIrArtifacts.length, 0, 'no unsupported Java IR artifacts in any class file');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  t.end();
});
