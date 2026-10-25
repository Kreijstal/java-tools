'use strict';
// run() prepares before main(). By default it prepares what the main class
// can reach, not every class file on the classpath: a directory holding many
// unrelated programs must not cost each of them the whole directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { JVM } = require('../src/core/jvm');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-scope-'));
execFileSync('javac', ['--release', '8', '-nowarn', '-d', directory,
  path.join(__dirname, 'fixtures', 'prepare', 'PrepMain.java')], { stdio: ['ignore', 'ignore', 'pipe'] });

async function run(options) {
  const jvm = new JVM({ classpath: [directory], jit: { compileWorker: false }, ...options });
  const output = [];
  jvm.registerJreMethods({ 'java/io/PrintStream': {
    'println(Ljava/lang/String;)V': (_jvm, _obj, args) => { output.push(String(args[0])); },
    'println(I)V': (_jvm, _obj, args) => { output.push(String(args[0])); },
  } });
  let atMain = null;
  const mark = jvm.jit.markMainStarted.bind(jvm.jit);
  jvm.jit.markMainStarted = () => { atMain = new Set(Object.keys(jvm.classes)); mark(); };
  await jvm.run('PrepMain');
  return { jvm, output, atMain };
}

test('reachable preparation loads what main reaches, including literal Class.forName', async () => {
  const { jvm, output, atMain } = await run({});
  assert.deepEqual(output, ['7', 'PrepNamed', 'PrepLate']);
  assert.ok(atMain.has('PrepUsed'), 'a direct reference is prepared');
  assert.ok(atMain.has('PrepNamed'), 'a literal Class.forName name is prepared');
  assert.ok(!atMain.has('PrepLate'), 'a name built at run time is not visible before main');
  assert.ok(!atMain.has('PrepUnrelated'), 'an unrelated classpath class is not loaded');
  assert.ok(!jvm.classes.PrepUnrelated, 'nor later');
  const frozen = jvm.jit.wasmJit?.frozenClassNames;
  if (frozen) {
    assert.ok(frozen.has('PrepMain'), 'prepared classes are frozen');
    assert.ok(!frozen.has('PrepLate'), 'a class loaded after preparation can still warm up');
  }
});

test("prepareScope 'classpath' keeps the old whole-classpath preload", async () => {
  const { output, atMain } = await run({ prepareScope: 'classpath' });
  assert.deepEqual(output, ['7', 'PrepNamed', 'PrepLate']);
  for (const name of ['PrepUsed', 'PrepNamed', 'PrepLate', 'PrepUnrelated']) {
    assert.ok(atMain.has(name), `${name} is loaded before main`);
  }
});

test('prepareScope rejects unknown values', () => {
  assert.throws(() => new JVM({ prepareScope: 'everything' }), TypeError);
});
