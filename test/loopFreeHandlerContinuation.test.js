'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const fixture = makeJavaFixtureCompiler('loop-free-handler-continuation-');

// Obfuscated games wrap whole methods in catch (RuntimeException) and rethrow.
// A loop-free method of that shape whose non-void call can suspend has no
// loop continuation, so its only framed entry used to be the baseline body.
// A generator continuation owns the child's return in the same way.
const source = `public class LoopFreeHandled {
  static int sleeps;
  static int slow(int v) {
    try { Thread.sleep(1); } catch (InterruptedException e) { }
    sleeps++;
    return v * 3;
  }
  static int fail(int v) {
    if (v == 2) throw new IllegalStateException("x");
    return v + 1;
  }
  static int parent(int a, int b) {
    try {
      int x = slow(a) + 7;
      int y = b * 10 + slow(b);
      return x + y + fail(a);
    } catch (RuntimeException e) {
      return -1000 - a;
    }
  }
  public static void main(String[] args) {
    long sum = 0;
    for (int i = 0; i < 6; i++) sum = sum * 31 + parent(i, i + 1);
    System.out.println(sum);
    System.out.println(sleeps);
  }
}`;

const jit = {compileWorker: false, warmupThreshold: 0, structuredSsa: true};

async function parentMethod(classpath, options) {
  const jvm = new JVM({classpath, jit: {...jit, ...options}});
  await jvm.loadClassByName('LoopFreeHandled');
  jvm.classInitializationState.set('LoopFreeHandled', 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    'LoopFreeHandled', 'parent', '(II)I');
  return {jvm, method};
}

async function run(classpath, options) {
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try {
    await new JVM({classpath, jit: options}).run('LoopFreeHandled');
  } finally {
    process.stdout.write = originalWrite;
  }
  return output.trim();
}

test('a loop-free handler-protected caller of a suspending non-void child ' +
  'gets a structured continuation instead of the baseline body', async (t) => {
  const classpath = fixture(t, 'LoopFreeHandled', source);
  const {jvm, method} = await parentMethod(classpath, {});
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa, 'parent compiles to structured SSA');
  t.equal(generated.jvmStructuredContinuation, true,
    'the protected non-void calls are owned by a continuation');
  t.notOk(generated.jvmStructuredRequiresBaselineFramedEntry,
    'the framed entry no longer needs the baseline body');
  const selected = jvm.jit.compileMethod(method);
  t.ok(selected?.jvmStructuredSsa && selected.jvmTier !== 'generated-sync',
    'tier selection installs the structured body');

  const off = await parentMethod(classpath,
    {structuredLoopFreeHandlerContinuations: false});
  const before = off.jvm.jit.compileMethod(off.method);
  t.equal(before?.jvmTier, 'generated-sync',
    'with the switch off the method falls back to the baseline body');

  const interpreted = await run(classpath, {compileWorker: false, enabled: false});
  t.equal(interpreted.split('\n')[1], '12',
    'the interpreter runs every suspending child');
  t.equal(await run(classpath, jit), interpreted,
    'compiled results, handler results and suspensions match the interpreter');
  t.end();
});
