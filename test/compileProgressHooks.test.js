'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { compileJavaFiles } = require('../src/java-frontend/compiler');
const { createZenFSWorkspace } = require('../src/io/ZenFSWorkspace');
const { browserJavaTools } = require('../src/platform/browser-entry');
const { createCompileProgressReporter } = require('../scripts/compile-progress');

function makeSourceTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-progress-'));
  const inputPaths = [];
  for (const [name, source] of Object.entries(files)) {
    const filePath = path.join(root, name);
    fs.writeFileSync(filePath, source, 'utf8');
    inputPaths.push(filePath);
  }
  return { root, inputPaths };
}

function classSource(name) {
  return `public class ${name} { static int value() { return ${name.length}; } }\n`;
}

test('compileJavaFiles reports every file of a batch through onProgress', (t) => {
  const { root, inputPaths } = makeSourceTree({
    'A.java': classSource('A'),
    'B.java': classSource('B'),
    'C.java': classSource('C'),
  });
  const events = [];
  const result = compileJavaFiles(inputPaths, {
    outputDir: path.join(root, 'out'),
    sourceLevel: '8',
    onProgress: (event) => events.push(event),
  });

  t.equal(result.status, 'complete', 'the batch still compiles');

  const phases = [...new Set(events.map((event) => event.phase))];
  t.deepEqual(phases, ['scan', 'compile'], 'the scan pre-pass is reported before the compile pass');

  for (const phase of phases) {
    const phaseEvents = events.filter((event) => event.phase === phase);
    t.equal(phaseEvents[0].event, 'start', `${phase} opens with a start event`);
    t.equal(phaseEvents[phaseEvents.length - 1].event, 'end', `${phase} closes with an end event`);
    t.deepEqual(
      phaseEvents.filter((event) => event.event === 'file-end').map((event) => event.inputPath),
      inputPaths,
      `${phase} reports each input once, in order`,
    );
    t.deepEqual(
      phaseEvents.filter((event) => event.event === 'file-end').map((event) => event.completed),
      [1, 2, 3],
      `${phase} counts completions up to the total`,
    );
    t.ok(
      phaseEvents.every((event) => event.total === inputPaths.length),
      `${phase} carries the batch size on every event`,
    );
    t.ok(
      phaseEvents.every((event) => event.completed <= event.total),
      `${phase} never reports more completions than files`,
    );
  }

  const fileStarts = events.filter((event) => event.phase === 'compile' && event.event === 'file-start');
  t.deepEqual(fileStarts.map((event) => event.index), [0, 1, 2], 'file-start carries the input index');
  t.ok(
    events.some((event) => event.phase === 'compile' && event.event === 'file-end' && event.classes === 1),
    'a compile file-end reports how many classes the file produced',
  );

  fs.rmSync(root, { recursive: true, force: true });
  t.end();
});

test('a failing file is named by a file-error event before the error propagates', (t) => {
  const { root, inputPaths } = makeSourceTree({
    'Good.java': classSource('Good'),
    'Bad.java': 'public class Bad { static int value() { return; } }\n',
  });
  const events = [];
  t.throws(
    () => compileJavaFiles(inputPaths, {
      outputDir: path.join(root, 'out'),
      sourceLevel: '8',
      onProgress: (event) => events.push(event),
    }),
    /Bad\.java/,
    'the compile still fails',
  );

  const errors = events.filter((event) => event.event === 'file-error');
  t.equal(errors.length, 1, 'exactly one file is blamed');
  t.equal(errors[0].inputPath, inputPaths[1], 'the failing input is named');
  t.ok(errors[0].error instanceof Error, 'the event carries the error');
  t.notOk(
    events.some((event) => event.phase === 'compile'
      && event.event === 'file-end'
      && event.inputPath === inputPaths[1]),
    'the failing file is not also reported as finished',
  );

  fs.rmSync(root, { recursive: true, force: true });
  t.end();
});

test('a batch without onProgress compiles exactly as before', (t) => {
  const { root, inputPaths } = makeSourceTree({ 'Solo.java': classSource('Solo') });
  const options = { outputDir: path.join(root, 'out'), sourceLevel: '8' };
  const withoutHook = compileJavaFiles(inputPaths, options);
  const withHook = compileJavaFiles(inputPaths, { ...options, onProgress: () => {} });
  t.deepEqual(
    withHook.classes.map((entry) => entry.jasmin),
    withoutHook.classes.map((entry) => entry.jasmin),
    'the hook does not change what is emitted',
  );
  fs.rmSync(root, { recursive: true, force: true });
  t.end();
});

test('the browser workspace compile reports its artifact pass too', async (t) => {
  const workspace = await createZenFSWorkspace({ name: 'compile-progress-artifacts' });
  workspace.mkdirSync('/src', { recursive: true });
  workspace.writeFileSync('/src/One.java', classSource('One'));
  workspace.writeFileSync('/src/Two.java', classSource('Two'));

  const events = [];
  const result = browserJavaTools.compileJavaFiles(['/src/One.java', '/src/Two.java'], {
    fileSystem: workspace,
    pathModule: path.posix,
    sourceRoot: '/src',
    outputDir: '/classes',
    sourceLevel: '8',
    onProgress: (event) => events.push(event),
  });

  t.equal(result.artifacts.length, 2, 'both artifacts come back');
  const artifactEvents = events.filter((event) => event.phase === 'artifact');
  t.equal(artifactEvents[0].event, 'start', 'the artifact pass opens with a start event');
  t.deepEqual(
    artifactEvents.filter((event) => event.event === 'file-end').map((event) => event.internalName),
    ['One', 'Two'],
    'each emitted class is reported by internal name',
  );
  t.ok(
    artifactEvents.every((event) => event.total === 2),
    'the artifact pass reports the class count, not the input count',
  );
  t.ok(
    events.findIndex((event) => event.phase === 'artifact')
      > events.findIndex((event) => event.phase === 'compile'),
    'the artifact pass is reported after the compile pass',
  );
  t.end();
});

test('the CLI progress reporter renders one line per file', (t) => {
  const lines = [];
  const report = createCompileProgressReporter({ write: (text) => lines.push(text) });
  report({ phase: 'compile', event: 'start', total: 352, completed: 0 });
  report({ phase: 'compile', event: 'file-end', index: 0, total: 352, completed: 1, inputPath: 'src/A.java', classes: 2, unsupported: 0, durationMs: 7 });
  report({ phase: 'compile', event: 'file-error', index: 1, total: 352, completed: 1, inputPath: 'src/B.java' });
  report({ phase: 'compile', event: 'end', total: 352, completed: 352, durationMs: 1200 });
  report({ phase: 'compile', event: 'file-start', index: 2, total: 352, completed: 1, inputPath: 'src/C.java' });

  t.equal(lines.length, 4, 'file-start does not add a line of its own');
  t.equal(lines[0], 'compile  352 files\n', 'the start line names the batch size');
  t.ok(lines[1].includes('[  1/352] src/A.java -> 2 classes (7 ms)'), 'a finished file shows its counter and result');
  t.ok(lines[2].includes('FAILED src/B.java'), 'a failing file is called out');
  t.ok(lines[3].includes('done in 1200 ms'), 'the end line reports the elapsed time');
  t.end();
});
