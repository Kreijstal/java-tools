'use strict';
// Every virtual call site asks the closed world which loaded classes can
// receive it. The answer is cached per target, and a class loaded later must
// still be seen: a stale list would dispatch past the new override.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { JVM } = require('../src/core/jvm');

test('the receiver list for a call target sees classes loaded after it was cached', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-subclasses-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'Shape.java');
  fs.writeFileSync(file, 'abstract class Shape { abstract int area(); }\n' +
    'class Square extends Shape { int area() { return 4; } }\n' +
    'class Circle extends Shape { int area() { return 3; } }\n');
  execFileSync('javac', ['--release', '8', '-d', directory, file]);
  const jvm = new JVM({ classpath: directory, closedWorld: true, jit: { compileWorker: false } });
  const world = jvm.jit.closedWorld;
  if (!world) return t.skip('this engine has no JS Promise Integration');
  const names = () => world.subclassIds('Shape').map((c) => c.name).sort();
  await jvm.loadClassByName('Square');
  assert.deepEqual(names(), ['Square']);
  assert.deepEqual(names(), ['Square'], 'cached');
  await jvm.loadClassByName('Circle');
  assert.deepEqual(names(), ['Circle', 'Square']);
});
