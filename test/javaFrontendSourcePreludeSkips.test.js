// Regression test for the source-prelude OOM: compiling a single .java file
// whose directory also contains huge hidden/generated trees (.work, .git,
// node_modules, ...) must not recursively parse every .java file in them.
//
// The prelude (sourceDirectoryMetadata) exists to resolve SIBLING references
// in the same source tree, so it still recurses into ordinary subdirectories,
// but it must skip hidden directories and node_modules.
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const frontend = require('../src/java-frontend');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'src-prelude-'));
  const files = {
    'Probe.java': 'public class Probe { Sibling s; int run() { return s.value; } }\n',
    'Sibling.java': 'public class Sibling { int value; }\n',
    '.hidden/Buried.java': 'public class Buried { }\n',
    'node_modules/Dep.java': 'public class Dep { }\n',
    'pkg/Nested.java': 'public class Nested { }\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { root, files };
}

test('source prelude skips hidden dirs and node_modules but finds siblings',
  (t) => {
  const { root } = makeTree();
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  const readDirs = [];
  const readFiles = [];
  const fileSystem = {
    readdirSync(dir, options) {
      readDirs.push(dir);
      return fs.readdirSync(dir, options);
    },
    readFileSync(file, encoding) {
      readFiles.push(file);
      return fs.readFileSync(file, encoding);
    },
    statSync(...args) { return fs.statSync(...args); },
  };

  const source = fs.readFileSync(path.join(root, 'Probe.java'), 'utf8');
  const document = frontend.parseJava(source);
  frontend.lowerAstToJavaIr(document, {
    sourcePath: path.join(root, 'Probe.java'),
    fileSystem,
  });

  const normalized = readDirs.map((dir) => dir.replaceAll('\\', '/'));
  const readNormalized = readFiles.map((file) => file.replaceAll('\\', '/'));

  // The sibling in the same directory must be scanned (that is the prelude's
  // job), and an ordinary subpackage directory must still be walked.
  t.ok(readNormalized.some((file) => file.endsWith('/Sibling.java')),
    'same-directory sibling is scanned');
  t.ok(normalized.some((dir) => dir.endsWith('/pkg')),
    'ordinary subdirectory is still recursed into');

  // Hidden dirs and node_modules must never be entered or read.
  t.ok(!normalized.some((dir) => dir.includes('.hidden')),
    '.hidden directory is not scanned');
  t.ok(!normalized.some((dir) => dir.includes('node_modules')),
    'node_modules is not scanned');
  t.ok(!readNormalized.some((file) => file.includes('.hidden') ||
    file.includes('node_modules')),
    'no file under a skipped directory is read');
  t.end();
});

test('compileJavaFile against a directory with a huge hidden tree is fast',
  (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'src-prelude-big-'));
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }));
  // A poison hidden tree: many files, one of them large. Before the fix this
  // was recursively parsed (the OOM shape); now it must be skipped entirely.
  const hiddenDir = path.join(root, '.work');
  fs.mkdirSync(hiddenDir, { recursive: true });
  for (let i = 0; i < 500; i++) {
    fs.writeFileSync(path.join(hiddenDir, `Game${i}.java`),
      `class Game${i} { int f; void m() { f = ${i}; } }\n`);
  }
  fs.writeFileSync(path.join(root, 'Probe.java'),
    'public class Probe { }\n');

  const started = Date.now();
  const result = frontend.compileJavaFile(path.join(root, 'Probe.java'), {
    outputDir: root,
    sourceFileName: 'Probe.java',
  });
  const elapsed = Date.now() - started;

  t.ok(result && (result.written || []).length === 1,
    'the single file compiles');
  t.ok(elapsed < 5000,
    `compile finishes quickly despite the hidden tree (${elapsed} ms)`);
  t.end();
});
