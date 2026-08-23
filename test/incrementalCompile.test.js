'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { compileJavaFiles } = require('../src/java-frontend/compiler');
const { CACHE_DIRECTORY_NAME } = require('../src/java-frontend/buildCache');
const { createZenFSWorkspace } = require('../src/io/ZenFSWorkspace');

function classSource(name, body = 'return 1;') {
  return `public class ${name} { static int value() { ${body} } }\n`;
}

function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-compile-'));
  const sourceDir = path.join(root, 'src');
  fs.mkdirSync(sourceDir);
  const inputPaths = [];
  for (const [name, source] of Object.entries(files)) {
    const filePath = path.join(sourceDir, name);
    fs.writeFileSync(filePath, source, 'utf8');
    inputPaths.push(filePath);
  }
  return {
    root,
    sourceDir,
    inputPaths,
    outputDir: path.join(root, 'classes'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function compile(project, extra = {}) {
  return compileJavaFiles(project.inputPaths, {
    sourceRoot: project.sourceDir,
    outputDir: project.outputDir,
    sourceLevel: '8',
    incremental: true,
    ...extra,
  });
}

function classDigests(outputDir) {
  const digests = {};
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === CACHE_DIRECTORY_NAME) continue;
        walk(full);
      } else if (entry.name.endsWith('.class')) {
        digests[path.relative(outputDir, full)] = fs.readFileSync(full).toString('base64');
      }
    }
  };
  walk(outputDir);
  return digests;
}

test('a second incremental build reuses every class file and returns the same result', (t) => {
  const project = makeProject({ 'A.java': classSource('A'), 'B.java': classSource('B') });
  const first = compile(project);
  const second = compile(project);

  t.equal(first.reused, 0, 'the first build has nothing to reuse');
  t.equal(second.reused, 2, 'the second build reuses both files');
  t.deepEqual(second.classes, first.classes, 'reused classes are indistinguishable from compiled ones');
  t.deepEqual(second.written, first.written, 'the written class files are reported the same way');
  t.equal(second.status, first.status, 'the batch status is unchanged');

  project.cleanup();
  t.end();
});

test('an interrupted build resumes and lands the same class files as a clean one', (t) => {
  const project = makeProject({
    'A.java': classSource('A'),
    'B.java': classSource('B'),
    'C.java': classSource('C'),
  });
  const clean = compile(project);
  const expected = classDigests(project.outputDir);

  // A batch killed after B is exactly this state: A and B recorded, C not, and
  // C's class file never written.
  const cacheDir = path.join(project.outputDir, CACHE_DIRECTORY_NAME);
  const entries = fs.readdirSync(cacheDir);
  const entryFor = (name) => entries.find((entry) => {
    const text = fs.readFileSync(path.join(cacheDir, entry));
    const json = entry.endsWith('.gz') ? require('zlib').gunzipSync(text) : text;
    return JSON.parse(String(json)).inputPath.endsWith(name);
  });
  fs.rmSync(path.join(cacheDir, entryFor('C.java')));
  fs.rmSync(path.join(project.outputDir, 'C.class'));

  const resumed = compile(project);
  t.equal(resumed.reused, 2, 'only the interrupted file is compiled again');
  t.deepEqual(classDigests(project.outputDir), expected, 'the resumed tree matches a clean build byte for byte');
  t.deepEqual(
    resumed.classes.map((entry) => entry.jasmin),
    clean.classes.map((entry) => entry.jasmin),
    'the resumed result carries the same Jasmin for every class',
  );

  project.cleanup();
  t.end();
});

test('editing any source invalidates the whole batch', (t) => {
  const project = makeProject({ 'A.java': classSource('A'), 'B.java': classSource('B') });
  compile(project);
  t.equal(compile(project).reused, 2, 'the batch is warm to begin with');

  // B's declarations decide what A is allowed to resolve, so a change to B has
  // to be able to change A's class file. The cache does not try to prove it did
  // not.
  fs.writeFileSync(path.join(project.sourceDir, 'B.java'), classSource('B', 'return 2;'), 'utf8');
  t.equal(compile(project).reused, 0, 'one edited source invalidates every input');
  t.equal(compile(project).reused, 2, 'and the batch is warm again afterwards');

  project.cleanup();
  t.end();
});

test('a source that is not part of the batch still invalidates it', (t) => {
  const project = makeProject({ 'A.java': classSource('A') });
  compile(project);
  t.equal(compile(project).reused, 1, 'the batch is warm to begin with');

  // Name resolution reads the source root off the filesystem, not the input
  // list, so a sibling nobody asked to compile can still change the output.
  fs.writeFileSync(path.join(project.sourceDir, 'Sibling.java'), classSource('Sibling'), 'utf8');
  t.equal(compile(project).reused, 0, 'a new sibling source invalidates the cache');

  project.cleanup();
  t.end();
});

test('a deleted or truncated class file is rebuilt without touching the rest', (t) => {
  const project = makeProject({ 'A.java': classSource('A'), 'B.java': classSource('B') });
  compile(project);
  fs.rmSync(path.join(project.outputDir, 'A.class'));
  t.equal(compile(project).reused, 1, 'the input whose class file vanished is compiled again');

  fs.writeFileSync(path.join(project.outputDir, 'B.class'), Buffer.alloc(3));
  t.equal(compile(project).reused, 1, 'a truncated class file is not accepted as up to date');
  t.ok(fs.statSync(path.join(project.outputDir, 'B.class')).size > 3, 'and it is rewritten in full');

  project.cleanup();
  t.end();
});

test('force recompiles everything and still produces the cached result', (t) => {
  const project = makeProject({ 'A.java': classSource('A') });
  const first = compile(project);
  const forced = compile(project, { incremental: { force: true } });
  t.equal(forced.reused, 0, 'force ignores the cache');
  t.deepEqual(forced.classes, first.classes, 'and produces the same classes');
  t.equal(compile(project).reused, 1, 'the forced run refreshed the cache it ignored');

  project.cleanup();
  t.end();
});

test('incremental compilation without an output directory is refused', (t) => {
  const project = makeProject({ 'A.java': classSource('A') });
  t.throws(
    () => compileJavaFiles(project.inputPaths, { sourceRoot: project.sourceDir, incremental: true }),
    /requires an outputDir/,
    'there is nothing to reuse when no class files are written',
  );
  project.cleanup();
  t.end();
});

test('a batch compiled without the cache is unaffected by it', (t) => {
  const project = makeProject({ 'A.java': classSource('A') });
  const cached = compile(project);
  const plain = compileJavaFiles(project.inputPaths, {
    sourceRoot: project.sourceDir,
    outputDir: path.join(project.root, 'plain'),
    sourceLevel: '8',
  });
  t.equal(plain.reused, 0, 'a non-incremental build reuses nothing');
  t.deepEqual(
    plain.classes.map((entry) => entry.jasmin),
    cached.classes.map((entry) => entry.jasmin),
    'and emits exactly what the incremental build did',
  );
  t.notOk(
    fs.existsSync(path.join(project.root, 'plain', CACHE_DIRECTORY_NAME)),
    'it does not leave a cache directory behind',
  );
  project.cleanup();
  t.end();
});

test('the browser workspace can reuse its own class files', async (t) => {
  const workspace = await createZenFSWorkspace({ name: 'incremental-workspace-test' });
  workspace.mkdirSync('/src', { recursive: true });
  workspace.writeFileSync('/src/One.java', classSource('One'));
  const options = {
    fileSystem: workspace,
    pathModule: path.posix,
    sourceRoot: '/src',
    outputDir: '/classes',
    sourceLevel: '8',
    incremental: true,
  };
  const first = compileJavaFiles(['/src/One.java'], options);
  const second = compileJavaFiles(['/src/One.java'], options);
  t.equal(first.reused, 0, 'the first workspace build compiles');
  t.equal(second.reused, 1, 'the second reuses the emitted class file');
  t.deepEqual(second.classes, first.classes, 'with the same result');
  t.end();
});
