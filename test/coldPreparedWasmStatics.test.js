'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const frontend = require('../src/java-frontend');
const {execFileSync} = require('child_process');

for (const structured of [false, true]) {
test(`cold Wasm static accesses preserve initialization (structured=${structured})`, async t => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-wasm-statics-'));
  t.teardown(() => fs.rmSync(outputDir, {recursive: true, force: true}));
  frontend.compileJavaFile(path.resolve(__dirname, '../sources/ColdPreparedStatics.java'),
    {outputDir, sourceFileName: 'ColdPreparedStatics.java'});
  execFileSync('javac', ['-g', '-d', outputDir,
    path.resolve(__dirname, '../sources/ColdPreparedInherited.java')]);
  const jvm = new JVM({classpath: outputDir, wasmFields: true, jit: {
    compileWorker: false, wasmStructured: structured,
  }});
  await jvm.preloadClasspathClasses();
  const owner = jvm.classes.ColdPreparedArray;
  const method = await jvm.findMethodInHierarchy('ColdPreparedStatics', 'fill', '(I)V');
  const wasm = jvm.jit.wasmJit;
  const state = wasm.methodState({method});
  wasm.compile({className: 'ColdPreparedStatics', method}, state);
  t.equal(state.status, 'ready', 'the cold method compiles');
  t.equal(state.meta?.normalFlowFullyCompiled, true,
    'cold declared fields do not permanently demote the array loop');
  t.ok(state.meta?.deoptableCalls > 0,
    'linked callers are told that initialization may exit');
  if (state.status !== 'ready') { t.end(); return; }
  const makeFrame = () => {
    const frame = new Frame(method);
    frame.className = 'ColdPreparedStatics'; frame.locals[0] = 3;
    return frame;
  };
  const cold = makeFrame();
  const thread = {status: 'runnable', callStack: new Stack()};
  thread.callStack.push(cold);
  wasm.execute(cold, thread, state, 0);
  t.equal(cold.pc, 0, 'the guard exits before any effects in the first block');
  t.equal(owner.staticFields.has('values:[I'), false,
    'the cold write did not populate the static store');
  t.notEqual(jvm.classInitializationState.get('ColdPreparedArray'), 'INITIALIZED',
    'preparation and guards run no guest initializer');

  owner.staticFields.set('values:[I', null);
  jvm.classInitializationState.set('ColdPreparedArray', 'INITIALIZED');
  const warm = makeFrame();
  thread.callStack.items.length = 0; thread.callStack.push(warm);
  const result = wasm.execute(warm, thread, state, 0);
  t.equal(result.returned, true, 'the same module completes after initialization');
  t.deepEqual(Array.from(owner.staticFields.get('values:[I')), [7, 8, 9],
    'compiled static writes and array stores produce exact results');

  // A value selected in predecessor blocks must survive the cold-owner exit.
  // The referenced subclass is not the class that declares the static field.
  const declaring = jvm.classes.ColdInheritedParent;
  const inherited = await jvm.findMethodInHierarchy('ColdPreparedInherited',
    'storeInherited', '(ZI)I');
  const inheritedState = wasm.methodState({method: inherited});
  wasm.compile({className: 'ColdPreparedInherited', method: inherited}, inheritedState,
    {asCallee: true});
  if (inheritedState.status !== 'ready') t.comment(JSON.stringify({
    error: inheritedState.lastCompileError, structured: inheritedState.structuredFail,
  }));
  t.equal(inheritedState.status, 'ready', 'inherited static store compiles');
  if (inheritedState.status === 'ready') {
    for (const choose of [0, 1]) {
      jvm.classInitializationState.delete('ColdInheritedParent');
      jvm.classInitializationState.delete('ColdInheritedChild');
      declaring.staticFields.delete('number:I');
      const frame = new Frame(inherited);
      frame.className = 'ColdPreparedInherited';
      frame.locals[0] = choose; frame.locals[1] = 17;
      thread.callStack.items.length = 0; thread.callStack.push(frame);
      wasm.execute(frame, thread, inheritedState, 0);
      t.ok(frame.pc > 0, 'initialization exits at the reached join block');
      t.equal(declaring.staticFields.has('number:I'), false,
        'the declaring class remains untouched before initialization');
      t.ok(frame.stack.items.includes(choose ? 17 : 18),
        'the selected operand survives the cold exit');
      t.notEqual(jvm.classInitializationState.get('ColdInheritedChild'), 'INITIALIZED',
        'compilation and the guard leave the referenced subclass cold');
      declaring.staticFields.set('number:I', 0);
      jvm.classInitializationState.set('ColdInheritedParent', 'INITIALIZED');
      const resumeBlock = inheritedState.meta.blockOfItem.get(frame.pc);
      if (inheritedState.meta.externalEntry.has(resumeBlock)) {
        const resumed = wasm.execute(frame, thread, inheritedState, resumeBlock);
        t.equal(resumed.returned, true, 'the guarded continuation resumes');
      } else {
        // The dispatcher backend only admits empty-stack external entries.
        // Use the normal interpreter continuation for a nonempty join stack.
        let steps = 0;
        while (!thread.callStack.isEmpty() && ++steps < 20) {
          const instruction = frame.instructions[frame.pc++].instruction;
          if (instruction) await jvm.executeInstruction(instruction, frame, thread);
        }
        t.ok(thread.callStack.isEmpty(), 'the interpreter continuation returns');
      }
      t.equal(declaring.staticFields.get('number:I'), choose ? 17 : 18,
        'the declaring class receives the preserved value');
    }
  }
  t.end();
});
}
