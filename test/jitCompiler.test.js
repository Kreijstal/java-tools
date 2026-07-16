const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const awt = require('../src/platform/awt');

function compileJavaFixture(t, className, source) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jit-fixture-'));
  t.teardown(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const sourcePath = path.join(tempDir, `${className}.java`);
  fs.writeFileSync(sourcePath, source);
  execFileSync('javac', ['-g', '-d', tempDir, sourcePath], { stdio: 'inherit' });
  return tempDir;
}

async function invoke(jvm, thread, className, methodName, descriptor, locals) {
  const method = await jvm.findMethodInHierarchy(className, methodName, descriptor);
  const frame = new Frame(method);
  frame.className = className;
  locals.forEach((value, index) => {
    frame.locals[index] = value;
  });
  const before = thread.callStack.size();
  thread.callStack.push(frame);
  let ticks = 0;
  while (thread.callStack.size() > before) {
    const result = await jvm.executeTick();
    ticks += 1;
    if (result.completed) break;
    if (ticks > 50000000) throw new Error('tick limit');
  }
  return ticks;
}

async function createPyramidHarness(jitOptions) {
  const jvm = new JVM({ classpath: 'sources', jit: jitOptions });
  await jvm.loadClassByName('PyramidApplet');
  const thread = {
    id: 0,
    name: 'jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const applet = await jvm.createAppletInstance('PyramidApplet');
  await invoke(jvm, thread, 'PyramidApplet', '<init>', '()V', [applet]);
  jvm._jreFindMethod('java/awt/Component', 'setSize', '(II)V')(jvm, applet, [800, 600]);
  await invoke(jvm, thread, 'PyramidApplet', 'init', '()V', [applet]);
  return { jvm, thread, applet };
}

test('JIT produces same PyramidApplet mock drawing operations as interpreter', async (t) => {
  const interpreted = await createPyramidHarness({ enabled: false });
  const jitted = await createPyramidHarness({ warmupThreshold: 0 });

  const interpretedGraphics = { type: 'java/awt/Graphics', _awtGraphics: new awt.MockGraphics() };
  const jittedGraphics = { type: 'java/awt/Graphics', _awtGraphics: new awt.MockGraphics() };

  await invoke(
    interpreted.jvm,
    interpreted.thread,
    'PyramidApplet',
    'paint',
    '(Ljava/awt/Graphics;)V',
    [interpreted.applet, interpretedGraphics],
  );
  await invoke(
    jitted.jvm,
    jitted.thread,
    'PyramidApplet',
    'paint',
    '(Ljava/awt/Graphics;)V',
    [jitted.applet, jittedGraphics],
  );

  t.deepEqual(
    jittedGraphics._awtGraphics.operations,
    interpretedGraphics._awtGraphics.operations,
    'JIT and interpreter should emit identical mock graphics operations',
  );
  t.end();
});

test('JIT bytecode safe point deopts at breakpoint with materialized frame state', async (t) => {
  const jvm = new JVM({ classpath: 'sources', jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('PyramidApplet');
  const method = await jvm.findMethodInHierarchy('PyramidApplet', 'dot', '([D[D)D');
  const frame = new Frame(method);
  frame.className = 'PyramidApplet';
  frame.locals[1] = [1, 2, 3];
  frame.locals[2] = [4, 5, 6];

  const thread = {
    id: 0,
    name: 'jit-breakpoint-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  thread.callStack.push(frame);
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  jvm.debugManager.addBreakpoint(3);

  await jvm.executeTick();

  t.equal(frame.pc, 3, 'JIT should materialize the frame at the breakpoint PC');
  t.deepEqual(frame.stack.items, [1], 'JIT should preserve operand stack at deopt point');
  t.deepEqual(frame.locals.slice(1, 3), [[1, 2, 3], [4, 5, 6]], 'JIT should preserve locals at deopt point');
  t.end();
});

test('generated JIT runs numeric hotpaths', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedNumericHarness', `
public class GeneratedNumericHarness {
  public static void compute(int[] out, int a, int b) {
    out[0] = a * b + 3;
    double x = (double) out[0] / 2.0;
    out[1] = (int) x;
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('GeneratedNumericHarness');
  const thread = {
    id: 0,
    name: 'generated-numeric-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0, 0];
  out.type = '[I';
  out.length = 2;
  out.hashCode = jvm.nextHashCode++;

  await invoke(jvm, thread, 'GeneratedNumericHarness', 'compute', '([III)V', [out, 4, 5]);

  t.deepEqual(out.slice(0, 2), [23, 11], 'generated JIT should preserve numeric results');
  t.ok(jvm.jit.generatedRunCount > 0, 'numeric method should run through generated code');
  t.equal(jvm.jit.runnerRunCount, 0, 'numeric method should not need bytecode-runner fallback');
  t.end();
});

test('generated JIT falls back when Function codegen is unavailable', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedFallbackHarness', `
public class GeneratedFallbackHarness {
  public static void compute(int[] out, int a) {
    double x = (double) a + 2.0;
    out[0] = (int) x;
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  jvm.jit.codegenUnavailable = true;
  await jvm.loadClassByName('GeneratedFallbackHarness');
  const thread = {
    id: 0,
    name: 'generated-fallback-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0];
  out.type = '[I';
  out.length = 1;
  out.hashCode = jvm.nextHashCode++;

  await invoke(jvm, thread, 'GeneratedFallbackHarness', 'compute', '([II)V', [out, 6]);

  t.deepEqual(out.slice(0, 1), [8], 'runner fallback should preserve behavior');
  t.equal(jvm.jit.generatedRunCount, 0, 'generated code should not run when unavailable');
  t.ok(jvm.jit.runnerRunCount > 0, 'bytecode runner should handle the fallback');
  t.end();
});

test('generated JIT accelerates integer bitwise loops on their first invocation', async (t) => {
  const classpath = compileJavaFixture(t, 'IntegerLoopJitHarness', `
public class IntegerLoopJitHarness {
  public static void compute(int[] out, int n) {
    for (int i = 0; i < n; i++) {
      out[i] = -((i ^ -1) >> 1);
    }
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('IntegerLoopJitHarness');
  const thread = {
    id: 0,
    name: 'integer-loop-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0, 0, 0, 0];
  out.type = '[I';
  out.length = 4;
  out.hashCode = jvm.nextHashCode++;
  await invoke(jvm, thread, 'IntegerLoopJitHarness', 'compute', '([II)V', [out, 4]);

  t.deepEqual(out.slice(0, 4), [1, 1, 2, 2], 'integer bitwise loop preserves interpreter semantics');
  t.equal(jvm.jit.generatedRunCount, 1, 'backward bitwise loop compiles without warmup calls');
  t.equal(jvm.jit.runnerRunCount, 0, 'generated bitwise loop bypasses the bytecode runner');
  t.end();
});

test('generated callers dispatch supported child methods through generated code', async (t) => {
  const classpath = compileJavaFixture(t, 'NestedGeneratedJitHarness', `
public class NestedGeneratedJitHarness {
  private static int scale(int value) { return value * 3; }
  public static void compute(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = scale(i);
  }
}
`);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('NestedGeneratedJitHarness');
  const thread = {
    id: 0,
    name: 'nested-generated-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0, 0, 0, 0];
  await invoke(jvm, thread, 'NestedGeneratedJitHarness', 'compute', '([I)V', [out]);
  t.deepEqual(out, [0, 3, 6, 9], 'nested generated calls preserve results');
  t.equal(jvm.jit.generatedRunCount, 5, 'outer loop and four child calls use generated code');
  t.equal(jvm.jit.runnerRunCount, 0, 'nested generated calls avoid the bytecode runner');
  t.end();
});

test('generated callers resume after one interpreted unsupported invocation', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedTransientCallJitHarness', `
public class GeneratedTransientCallJitHarness {
  private static int selected(int value) {
    switch (value) {
      case 0: return 10;
      case 1: return 20;
      default: return 30;
    }
  }
  public static void compute(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = selected(i) + 1;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 100,
    resumeMethodAllowlist: ['GeneratedTransientCallJitHarness.compute([I)V'],
  } });
  await jvm.loadClassByName('GeneratedTransientCallJitHarness');
  const thread = {
    id: 0,
    name: 'transient-call-generated-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0, 0, 0];
  out.type = '[I';
  await invoke(jvm, thread, 'GeneratedTransientCallJitHarness', 'compute', '([I)V', [out]);
  t.deepEqual(out.slice(0, 3), [11, 21, 31], 'unsupported child calls preserve results');
  t.ok(jvm.jit.generatedRunCount > 1, 'generated caller resumes after interpreted child calls');
  t.notOk(jvm.jit.deoptedMethods.has(
    await jvm.findMethodInHierarchy('GeneratedTransientCallJitHarness', 'compute', '([I)V')),
  'transient child exits do not permanently deopt the caller');
  t.end();
});

test('generated short helpers dispatch interface methods without runner fallback', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedInterfaceJitHarness', `
public class GeneratedInterfaceJitHarness {
  interface Value { int get(); }
  static class Fixed implements Value {
    private final int value;
    Fixed(int value) { this.value = value; }
    public int get() { return value; }
  }
  public static void compute(int[] out, Value value) {
    for (int i = 0; i < out.length; i++) out[i] = value.get();
  }
}
`);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('GeneratedInterfaceJitHarness');
  await jvm.loadClassByName('GeneratedInterfaceJitHarness$Fixed');
  const thread = {
    id: 0,
    name: 'interface-generated-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0, 0, 0, 0];
  const value = {
    type: 'GeneratedInterfaceJitHarness$Fixed',
    fields: { 'GeneratedInterfaceJitHarness$Fixed.value': 7 },
  };
  await invoke(jvm, thread, 'GeneratedInterfaceJitHarness', 'compute',
    '([ILGeneratedInterfaceJitHarness$Value;)V', [out, value]);
  t.deepEqual(out, [7, 7, 7, 7], 'invokeinterface preserves dynamic dispatch and return values');
  t.equal(jvm.jit.runnerRunCount, 0, 'interface accessors avoid the bytecode runner');
  t.equal(jvm.jit.generatedRunCount, 5, 'outer loop and interface accessor use generated code');
  t.end();
});

test('generated JIT accelerates integer byte-array loops', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedIntegerArrayLoopHarness', `
public class GeneratedIntegerArrayLoopHarness {
  public static void compute(int[] out, byte[][] left, byte[][] right, int length) {
    int score = 100;
    for (int i = 0; i < length; i++) {
      int value = left[0][i] + right[1][i];
      if (value < score) score = value;
    }
    out[0] = -score;
    out[1] = 2147483647 + length;
    out[2] = -7 / length;
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('GeneratedIntegerArrayLoopHarness');
  const thread = {
    id: 0,
    name: 'generated-integer-array-loop-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0, 0, 0];
  const left = [[5, 4, 3]];
  const right = [[0, 0, 0], [2, 1, 0]];
  await invoke(jvm, thread, 'GeneratedIntegerArrayLoopHarness', 'compute', '([I[[B[[BI)V',
    [out, left, right, 3]);

  t.deepEqual(out, [-3, -2147483646, -2],
    'generated integer array loop preserves int overflow and truncating division semantics');
  t.equal(jvm.jit.generatedRunCount, 1, 'backward integer array loop compiles on first invocation');
  t.equal(jvm.jit.runnerRunCount, 0, 'generated loop bypasses the bytecode runner');
  t.end();
});

test('generated JIT supports short-array loads and checked casts', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedShortArrayJitHarness', `
public class GeneratedShortArrayJitHarness {
  public static void compute(int[] out, short[] values, Object checked) {
    int sum = 0;
    for (int i = 0; i < values.length; i++) sum += values[i];
    out[0] = sum + ((int[]) checked).length;
  }
}
`);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('GeneratedShortArrayJitHarness');
  const thread = {
    id: 0,
    name: 'short-array-generated-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0];
  out.type = '[I';
  const values = [300, -20, 7];
  values.type = '[S';
  const checked = [1, 2];
  checked.type = '[I';
  await invoke(jvm, thread, 'GeneratedShortArrayJitHarness', 'compute',
    '([I[SLjava/lang/Object;)V', [out, values, checked]);
  t.equal(out[0], 289, 'short loads and a valid array cast preserve results');
  t.equal(jvm.jit.generatedRunCount, 1, 'short-array loop uses generated code');
  t.equal(jvm.jit.runnerRunCount, 0, 'short-array loop avoids runner fallback');
  t.end();
});

test('generated JIT preserves long division, xor, and comparison semantics', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedLongJitHarness', `
public class GeneratedLongJitHarness {
  public static void compute(int[] out, int value) {
    out[0] = ((((long) value / 3L) ^ -1L) == -5L) ? 1 : 0;
  }
}
`);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('GeneratedLongJitHarness');
  const thread = {
    id: 0,
    name: 'long-generated-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'GeneratedLongJitHarness', 'compute', '([II)V', [out, 12]);
  t.equal(out[0], 1, 'long expression preserves BigInt-backed JVM semantics');
  t.equal(jvm.jit.generatedRunCount, 1, 'long expression uses generated code');
  t.end();
});

test('generated JIT preserves float32 arithmetic in hot array loops', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedFloatLoopHarness', `
public class GeneratedFloatLoopHarness {
  public static float mix(float[] values, int rounds) {
    float total = 0.0f;
    for (int round = 0; round < rounds; round++) {
      for (int i = 0; i < values.length; i++) {
        values[i] = values[i] * 1.25f - 0.5f;
        total += values[i];
      }
    }
    return total;
  }
}
`);

  async function run(jit) {
    const jvm = new JVM({ classpath, jit });
    await jvm.loadClassByName('GeneratedFloatLoopHarness');
    const thread = {
      id: 0,
      name: 'generated-float-loop-test',
      callStack: new Stack(),
      status: 'runnable',
      pendingException: null,
    };
    jvm.threads = [thread];
    jvm.currentThreadIndex = 0;
    const values = [0.1, -2.25, 3.5];
    const ticks = await invoke(jvm, thread, 'GeneratedFloatLoopHarness', 'mix', '([FI)F',
      [values, 4]);
    return { jvm, values, ticks, result: thread.callStack.isEmpty() ? undefined : thread.callStack.peek() };
  }

  const interpreted = await run({ enabled: false });
  const jitted = await run({ warmupThreshold: 100 });
  t.deepEqual(jitted.values, interpreted.values,
    'generated loop should match interpreter float32 rounding after every operation');
  t.equal(jitted.jvm.jit.generatedRunCount, 1, 'backward float loop compiles on its first invocation');
  t.equal(jitted.jvm.jit.runnerRunCount, 0, 'generated float loop bypasses the bytecode runner');
  t.equal(jitted.ticks, 1, 'generated float loop completes in one scheduler tick');
  t.end();
});

test('debug mode keeps JIT off so executeTick remains one-instruction stepping', async (t) => {
  const classpath = compileJavaFixture(t, 'DebugJitHarness', `
public class DebugJitHarness {
  public static void compute(int[] out, int a) {
    double x = (double) a + 2.0;
    out[0] = (int) x;
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('DebugJitHarness');
  const method = await jvm.findMethodInHierarchy('DebugJitHarness', 'compute', '([II)V');
  const frame = new Frame(method);
  frame.className = 'DebugJitHarness';

  const out = [0];
  out.type = '[I';
  out.length = 1;
  out.hashCode = jvm.nextHashCode++;
  frame.locals[0] = out;
  frame.locals[1] = 6;

  const thread = {
    id: 0,
    name: 'debug-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  thread.callStack.push(frame);
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  jvm.enableDebugMode();

  await jvm.executeTick();

  t.equal(jvm.jit.generatedRunCount, 0, 'generated JIT should not run in debug mode');
  t.equal(jvm.jit.runnerRunCount, 0, 'bytecode-runner JIT should not run in debug mode');
  t.ok(thread.callStack.size() > 0, 'one debug tick should not finish the whole method');
  t.equal(out[0], 0, 'one debug tick should not run through later stores');
  t.end();
});

test('debug continue only deopts classes that own breakpoints', async (t) => {
  const classpath = compileJavaFixture(t, 'SelectiveDeoptHarness', `
public class SelectiveDeoptHarness {
  public static void compute(int[] out, int a) {
    double x = (double) a + 2.0;
    out[0] = (int) x;
  }
}

class SelectiveOtherHotClass {
  public static void compute(int[] out, int a) {
    double x = (double) a + 3.0;
    out[0] = (int) x;
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('SelectiveDeoptHarness');
  await jvm.loadClassByName('SelectiveOtherHotClass');
  const thread = {
    id: 0,
    name: 'selective-deopt-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  jvm.enableDebugMode();
  jvm.debugManager.setRunMode('continuing');
  jvm.debugManager.addBreakpoint(3, { className: 'SelectiveDeoptHarness' });

  const otherOut = [0];
  otherOut.type = '[I';
  otherOut.length = 1;
  otherOut.hashCode = jvm.nextHashCode++;
  await invoke(jvm, thread, 'SelectiveOtherHotClass', 'compute', '([II)V', [otherOut, 4]);

  t.deepEqual(otherOut.slice(0, 1), [7], 'non-breakpointed class should execute correctly');
  t.ok(jvm.jit.generatedRunCount > 0, 'non-breakpointed class should still use generated JIT');

  const generatedAfterOther = jvm.jit.generatedRunCount;
  const runnerAfterOther = jvm.jit.runnerRunCount;
  const deoptedOut = [0];
  deoptedOut.type = '[I';
  deoptedOut.length = 1;
  deoptedOut.hashCode = jvm.nextHashCode++;
  await invoke(jvm, thread, 'SelectiveDeoptHarness', 'compute', '([II)V', [deoptedOut, 4]);

  t.deepEqual(deoptedOut.slice(0, 1), [6], 'breakpointed class should execute correctly');
  t.equal(jvm.jit.generatedRunCount, generatedAfterOther, 'breakpointed class should not use generated JIT');
  t.equal(jvm.jit.runnerRunCount, runnerAfterOther, 'breakpointed class should not use bytecode-runner JIT');
  t.end();
});

test('JIT routes thrown Java exceptions through exception tables', async (t) => {
  const classpath = compileJavaFixture(t, 'JitExceptionHarness', `
public class JitExceptionHarness {
  static class Box { int value; }

  public static void catchDivide(int[] out, int a, int b) {
    try {
      out[0] = a / b;
    } catch (ArithmeticException e) {
      out[0] = 42;
    }

    double x = (double) a + 1.0;
    out[1] = (int) x;
  }

  public static void catchNull(int[] out, Box box) {
    try {
      out[0] = box.value;
    } catch (NullPointerException e) {
      out[0] = 77;
    }
    double x = 3.0;
    out[1] = (int) x;
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('JitExceptionHarness');
  const thread = {
    id: 0,
    name: 'jit-exception-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0, 0];
  out.type = '[I';
  out.length = 2;
  out.hashCode = jvm.nextHashCode++;

  await invoke(jvm, thread, 'JitExceptionHarness', 'catchDivide', '([III)V', [out, 10, 0]);

  t.deepEqual(out.slice(0, 2), [42, 11], 'JIT exception should be caught and execution should continue');
  const nullOut = [0, 0];
  nullOut.type = '[I';
  nullOut.length = 2;
  nullOut.hashCode = jvm.nextHashCode++;
  await invoke(jvm, thread, 'JitExceptionHarness', 'catchNull',
    '([ILJitExceptionHarness$Box;)V', [nullOut, null]);
  t.deepEqual(nullOut.slice(0, 2), [77, 3],
    'generated getfield should throw a catchable JVM NullPointerException');
  t.ok(jvm.jit.generatedRunCount > 0, 'exception test should exercise generated code');
  t.end();
});

test('generated JIT rejects synchronized methods outside its safe subset', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedRejectHarness', `
public class GeneratedRejectHarness {
  static class Box {
    int value;
  }

  public static void compute(int[] out) {
    synchronized (out) {
      Box box = new Box();
      box.value = 7;
      double x = 2.0 + 3.0;
      out[0] = box.value + (int) x;
    }
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('GeneratedRejectHarness');
  const method = await jvm.findMethodInHierarchy('GeneratedRejectHarness', 'compute', '([I)V');

  t.notOk(jvm.jit.isCodegenSupported(method), 'monitor bytecodes stay out of generated JIT');
  t.end();
});

test('generated JIT preserves monitors for explicitly allowed hot methods', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedMonitorJitHarness', `
public class GeneratedMonitorJitHarness {
  public static void compute(int[] out, int value) {
    synchronized (out) {
      for (int i = 0; i < out.length; i++) out[i] += value;
    }
  }
}
`);
  const methodKey = 'GeneratedMonitorJitHarness.compute([II)V';
  const jvm = new JVM({
    classpath,
    jit: {
      warmupThreshold: 100,
      exceptionMethodAllowlist: [methodKey],
      monitorMethodAllowlist: [methodKey],
    },
  });
  await jvm.loadClassByName('GeneratedMonitorJitHarness');
  const thread = {
    id: 0,
    name: 'monitor-generated-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [1, 2, 3];
  out.type = '[I';
  await invoke(jvm, thread, 'GeneratedMonitorJitHarness', 'compute', '([II)V', [out, 4]);
  t.deepEqual(out.slice(0, 3), [5, 6, 7], 'generated synchronized loop preserves results');
  t.notOk(out.isLocked, 'generated monitorexit releases the monitor');
  t.equal(out.lockOwner, null, 'released monitor clears its owner');
  t.equal(jvm.jit.generatedRunCount, 1, 'explicitly allowed synchronized loop uses generated code');
  t.end();
});
