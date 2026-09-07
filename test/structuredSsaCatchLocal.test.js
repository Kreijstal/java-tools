'use strict';

// A local assigned only inside a catch block was silently lost.
//
// The structured-SSA tier proves a local "immutable at entry" by scanning the
// method for stores to its slot, and then spills that entry constant back into
// `locals[]` at every materialization instead of the live variable. The scan
// consulted `normalReachableItems`, which deliberately excludes exception
// handlers -- they are not successors in the normal CFG. So `caught++` inside
// a catch was invisible, the slot was declared immutable, and every deopt
// overwrote the interpreter's accumulated count with the entry literal 0.
//
// The result was a wrong answer with no exception, no deopt loop and no
// diagnostic: `catch (E e) { caught++; }` around a loop finished with
// caught == 0 while the interpreter returned 57.

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const SOURCE = `
public class CatchLocalCount {
  static int mayThrow(int n) {
    int acc = n;
    for (int i = 0; i < 8; i++) acc = acc * 13 + i;
    if (n < 0) throw new IllegalStateException("neg");
    return acc;
  }
  // 'caught' is written ONLY in the catch block. That is the whole fixture:
  // add any store to it on the try path and the bug disappears.
  public static void run(int[] out, int n) {
    int caught = 0, sum = 0;
    for (int i = 0; i < n; i++) {
      try { sum += mayThrow(i % 7 == 3 ? -i : i); }
      catch (IllegalStateException e) { caught++; }
    }
    out[0] = sum;
    out[1] = caught;
  }
}
`;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catchlocal-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'CatchLocalCount.java'), SOURCE);
  execFileSync('javac', ['-g', '-d', dir, path.join(dir, 'CatchLocalCount.java')],
    { stdio: 'inherit' });
  return dir;
}

async function runArm(dir, jitOptions) {
  const jvm = new JVM({ classpath: dir, jit: jitOptions });
  await jvm.loadClassByName('CatchLocalCount');
  jvm.classInitializationState.set('CatchLocalCount', 'INITIALIZED');
  const thread = {
    id: 0, name: 'catchlocal', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0, 0];
  out.type = '[I';
  const method = await jvm.findMethodInHierarchy('CatchLocalCount', 'run', '([II)V');
  const frame = new Frame(method);
  frame.className = 'CatchLocalCount';
  frame.locals[0] = out;
  frame.locals[1] = 400;
  const before = thread.callStack.size();
  thread.callStack.push(frame);
  while (thread.callStack.size() > before) {
    const result = await jvm.executeTick();
    if (result.completed) break;
  }
  return { out, jvm, method };
}

test('a local written only in a catch block survives compiled materialization', async (t) => {
  const dir = fixture(t);
  const saved = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '0';
  t.teardown(() => {
    if (saved === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = saved;
  });

  const interpreted = await runArm(dir,
    { compileWorker: false, enabled: false, warmupThreshold: 1e9 });
  const compiled = await runArm(dir, { compileWorker: false, warmupThreshold: 100 });

  t.ok(interpreted.out[1] > 0, 'the interpreter really did take the catch path');
  t.equal(compiled.out[0], interpreted.out[0],
    'the sum accumulated on the try path matches the interpreter');
  t.equal(compiled.out[1], interpreted.out[1],
    'and so does the counter incremented only inside the catch');

  // The fix must not work by refusing to compile the method: that would make
  // the assertions above pass while proving nothing about the generated body.
  const tier = compiled.jvm.jit.classifyGeneratedTier(
    compiled.jvm.jit.codegenCache.get(compiled.method));
  t.equal(tier, 'structured-ssa',
    'and the method is still compiled by the tier that had the defect');
  t.end();
});
