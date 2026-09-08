'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const frontend = require('../src/java-frontend');

test('prepared SSA static writes preserve cold class initialization', async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-statics-'));
  t.teardown(() => fs.rmSync(outputDir, {recursive: true, force: true}));
  frontend.compileJavaFile(path.resolve(__dirname, '../sources/ColdPreparedStatics.java'),
    {outputDir, sourceFileName: 'ColdPreparedStatics.java'});
  const jvm = new JVM({classpath: outputDir, jit: {
    compileWorker: false, warmupThreshold: 0, structuredSsa: true,
  }});
  await jvm.loadClassByName('ColdPreparedStatics');
  const owner = await jvm.loadClassByName('ColdPreparedArray');
  const method = await jvm.findMethodInHierarchy('ColdPreparedStatics', 'fill', '(I)V');
  // Storage may already be resolved by another tier before SSA compilation.
  owner.staticFields.set('values:[I', null);
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa, 'the cold method compiles to structured SSA');
  const frame = new Frame(method);
  frame.className = 'ColdPreparedStatics';
  frame.locals[0] = 3;
  const thread = {status: 'runnable', pendingException: null, callStack: new Stack()};
  thread.callStack.push(frame);
  let result = generated(frame, thread, jvm.jit, false);
  if (result?.next) {
    let step;
    do { step = result.next(); } while (!step.done && !step.value?.deopt);
    result = step.value;
  }
  t.equal(result?.deopt, true, 'cold putstatic yields to class initialization');
  t.equal(owner.staticFields.get('values:[I'), null,
    'no write happens before the owning class initializer');
  t.equal(frame.stack.items.at(-1)?.length, 3,
    'the allocated array survives the class-initialization handoff');
  t.notEqual(jvm.classInitializationState.get('ColdPreparedArray'), 'INITIALIZED',
    'compilation and the guard run no guest initializer');
  jvm.classInitializationState.set('ColdPreparedArray', 'INITIALIZED');
  const warmFrame = new Frame(method);
  warmFrame.className = 'ColdPreparedStatics';
  warmFrame.locals[0] = 3;
  thread.callStack.items.length = 0;
  thread.callStack.push(warmFrame);
  let warmResult = generated(warmFrame, thread, jvm.jit, false);
  if (warmResult?.next) {
    let step;
    do { step = warmResult.next(); } while (!step.done && !step.value?.deopt);
    warmResult = step.value;
  }
  t.notEqual(warmResult?.deopt, true, 'the same prepared body runs after initialization');
  t.deepEqual(Array.from(owner.staticFields.get('values:[I')), [7, 8, 9],
    'post-initialization writes and reads preserve array contents');
  t.end();
});
