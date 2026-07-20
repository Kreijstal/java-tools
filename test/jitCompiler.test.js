const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const { _test: wasmJitTest } = require('../src/jit/WasmJit');
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

test('Wasm value imports preserve JavaScript boolean fields', (t) => {
  t.equal(wasmJitTest.toWasmValue(wasmJitTest.T.i32, true), 1,
    'true is imported as Java boolean 1');
  t.equal(wasmJitTest.toWasmValue(wasmJitTest.T.i32, false), 0,
    'false is imported as Java boolean 0');
  t.end();
});

test('initialized static fields stay on the synchronous generated fast path', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  jvm.classes.FastStatics = {
    staticFields: new Map([['value:I', 41]]),
    ast: { classes: [{ superClassName: null }] },
  };
  jvm.classInitializationState.set('FastStatics', 'INITIALIZED');
  const field = [null, 'FastStatics', ['value', 'I']];
  const value = jvm.jit.getStatic(field, {});

  t.equal(value, 41, 'warm getstatic returns its value directly');
  t.notOk(value && typeof value.then === 'function', 'warm getstatic creates no Promise');
  const changed = jvm.jit.putStatic(field, 42, {});
  t.equal(changed, true, 'warm putstatic completes synchronously');
  t.equal(jvm.classes.FastStatics.staticFields.get('value:I'), 42,
    'warm putstatic updates the field');
  t.end();
});

test('structural primitive array-copy intrinsic preserves overlap semantics', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const prefix = [
    'aload_0', 'aload_2', 'if_acmpne', 'iload_1', 'iload_3',
    'if_icmpne', 'return', 'iload_3', 'iload_1', 'if_icmple',
  ];
  const body = [];
  for (let i = 0; i < 16; i += 1) body.push('iaload', 'iastore');
  const method = {
    attributes: [{
      type: 'code',
      code: { codeItems: [...prefix, ...body].map((instruction) => ({ instruction })) },
    }],
  };
  const intrinsic = jvm.jit.getSynchronousIntrinsic(method, '([II[III)V');
  t.equal(typeof intrinsic, 'function', 'unrolled primitive copy shape is recognized');

  const source = [1, 2, 3, 4];
  const destination = [0, 0, 0, 0];
  intrinsic([source, 1, destination, 0, 3], 0);
  t.deepEqual(destination, [2, 3, 4, 0], 'distinct arrays copy the selected range');

  const overlapping = [1, 2, 3, 4, 5];
  intrinsic([overlapping, 0, overlapping, 1, 4], 0);
  t.deepEqual(overlapping, [1, 1, 2, 3, 4], 'overlapping copies retain memmove ordering');
  t.end();
});

test('structural packed-color scanline intrinsic preserves pixel arithmetic', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  jvm.classes.Flags = {
    staticFields: new Map([['enabled:Z', 0]]),
    ast: { classes: [{ superClassName: null }] },
  };
  jvm.classInitializationState.set('Flags', 'INITIALIZED');
  const flag = ['Field', 'Flags', ['enabled', 'Z']];
  const integerAnd = () => ({
    instruction: { op: 'invokestatic', arg: ['Method', 'Masks', ['and', '(II)I']] },
  });
  const items = [
    { instruction: { op: 'getstatic', arg: flag } },
    ...['istore', 'iload', 'bipush', 'if_icmpeq', 'bipush'].map((instruction) => ({ instruction })),
    integerAnd(),
    ...['goto', 'athrow', 'iinc', 'iaload'].map((instruction) => ({ instruction })),
    integerAnd(), integerAnd(),
    { instruction: 'iastore' },
    ...[
      9, 8355711, -852264639, 65280, -1295343735,
      1494704929, 16711680, 200866833, 255,
    ].map((arg) => ({ instruction: { op: 'ldc', arg } })),
  ];
  const method = {
    attributes: [{ type: 'code', code: { codeItems: items } }],
  };
  const intrinsic = jvm.jit.getSynchronousIntrinsic(method, '(IIIIIII[III)V');
  t.equal(typeof intrinsic, 'function', 'packed-color scanline shape is recognized');

  const pixels = [0x123456, 0xabcdef];
  intrinsic([0x224400, 0, 0x200, 2, 0x6688aa, 2, 9, pixels, 0x336699, 0x20000], 0);
  t.deepEqual(pixels, [0x3c2b44, 0x887791],
    'native scanline loop matches generated integer shifts, masks, and overflow');
  t.end();
});

test('structural constant-color scanline intrinsic preserves pixel arithmetic', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  jvm.classes.Flags = {
    staticFields: new Map([['enabled:Z', 0]]),
    ast: { classes: [{ superClassName: null }] },
  };
  jvm.classInitializationState.set('Flags', 'INITIALIZED');
  const flag = ['Field', 'Flags', ['enabled', 'Z']];
  const prefix = [
    { instruction: { op: 'getstatic', arg: flag } },
    ...[
      'istore', 'iload_1', 'bipush', 'if_icmpeq', 'bipush', 'bipush',
      'aconst_null', 'checkcast', 'bipush', 'bipush',
    ].map((instruction) => ({ instruction })),
    { instruction: {
      op: 'invokestatic', arg: ['Method', 'Masks', ['and', '(II)I']],
    } },
    ...['goto', 'athrow', 'iinc', 'iaload', 'iastore'].map((instruction) => ({ instruction })),
    ...[57, 16711422, -59233087].map((arg) => ({ instruction: { op: 'ldc', arg } })),
  ];
  const method = {
    attributes: [{ type: 'code', code: { codeItems: prefix } }],
  };
  const intrinsic = jvm.jit.getSynchronousIntrinsic(method, '(IB[III)V');
  t.equal(typeof intrinsic, 'function', 'constant-color scanline shape is recognized');

  const pixels = [0x123456, 0xabcdef];
  intrinsic([0, 57, pixels, 0x10203, 2], 0);
  t.deepEqual(pixels, [0x0a1c2e, 0x56687a],
    'native constant-color loop matches generated mask, shift, and addition');
  t.end();
});

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

test('generated JIT resolves inherited instance fields from subclass references', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedInheritedFieldHarness', `
class GeneratedInheritedFieldBase {
  int cursor;
}
public class GeneratedInheritedFieldHarness extends GeneratedInheritedFieldBase {
  int output;
  public void sync() {
    output = 8 * cursor;
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('GeneratedInheritedFieldHarness');
  await jvm.loadClassByName('GeneratedInheritedFieldBase');
  const thread = {
    id: 0,
    name: 'generated-inherited-field-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const object = {
    type: 'GeneratedInheritedFieldHarness',
    _className: 'GeneratedInheritedFieldHarness',
    fields: {
      'GeneratedInheritedFieldBase.cursor': 7,
      'GeneratedInheritedFieldHarness.output': 0,
    },
  };

  await invoke(jvm, thread, 'GeneratedInheritedFieldHarness', 'sync', '()V', [object]);

  t.equal(object.fields['GeneratedInheritedFieldHarness.output'], 56,
    'subclass-owned getfield resolves the inherited storage slot');
  t.ok(jvm.jit.generatedRunCount > 0, 'method runs through generated code');
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
  t.equal(jvm.jit.generatedRunCount, 2,
    'caller and first helper cross the initial class-initialization boundary');
  t.equal(jvm.jit.syncGeneratedRunCount, 2,
    'generated caller and helper complete synchronously without Promise handoffs');
  t.equal(jvm.jit.syncInlinedCallCount, 3,
    'remaining integer leaf calls execute inline without child frames');
  t.equal(jvm.jit.runnerRunCount, 0, 'nested generated calls avoid the bytecode runner');
  t.end();
});

test('Wasm leaves constructors and class initializers atomic', (t) => {
  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });
  const jvm = new JVM({ jit: { warmupThreshold: 100 } });
  const frame = (name) => ({ method: { name }, instructions: [{}] });
  const method = (name) => ({
    name,
    attributes: [{ type: 'code', code: { codeItems: [{ instruction: 'return' }] } }],
  });

  t.equal(jvm.jit.wasmJit.prepare(frame('<init>')), null,
    'instance constructor stays outside partial Wasm');
  t.equal(jvm.jit.wasmJit.prepare(frame('<clinit>')), null,
    'class initializer stays outside partial Wasm');
  t.notOk(jvm.jit.isSupported(method('<init>')),
    'instance constructor stays outside JavaScript JIT');
  t.notOk(jvm.jit.isSupported(method('<clinit>')),
    'class initializer stays outside JavaScript JIT');
  t.end();
});

test('generated callers resume around unsupported interpreted callees', async (t) => {
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
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
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
  t.equal(jvm.jit.generatedRunCount, 4,
    'caller resumes generated execution after each interpreted child');
  t.notOk(jvm.jit.deoptedMethods.has(
    await jvm.findMethodInHierarchy('GeneratedTransientCallJitHarness', 'compute', '([I)V')),
  'unsupported child does not permanently deopt its caller');
  t.end();
});

test('generated invokevirtual resolves Object methods on arrays', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedArrayCloneJitHarness', `
public class GeneratedArrayCloneJitHarness {
  public static void copy(int[] input, int[][] out) {
    for (int i = 0; i < out.length; i++) out[i] = (int[]) input.clone();
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: { warmupThreshold: 0, experimentalControlFlow: true },
  });
  await jvm.loadClassByName('GeneratedArrayCloneJitHarness');
  const thread = {
    id: 0,
    name: 'array-clone-generated-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const input = [3, 5, 8];
  input.type = '[I';
  const out = [null];
  out.type = '[[I';

  await invoke(jvm, thread, 'GeneratedArrayCloneJitHarness', 'copy',
    '([I[[I)V', [input, out]);

  t.deepEqual(out[0].slice(), [3, 5, 8], 'array clone preserves its elements');
  t.notEqual(out[0], input, 'array clone returns a distinct array');
  t.equal(out[0].type, '[I', 'array clone preserves runtime type metadata');
  t.ok(jvm.jit.generatedRunCount > 0, 'array clone call executes from generated code');
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
  t.equal(jvm.jit.syncReusedFrameCount, 3,
    'repeated interface calls recycle their completed child frame');
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

test('Wasm JIT carries category-2 values across control-flow merges', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmLongCarryHarness', `
public class WasmLongCarryHarness {
  public static void compute(long[] out, long[] state, long[] input) {
    for (int i = 0; i < out.length; i++) {
      out[i] = state[i] > input[i] ? state[i] : input[i];
    }
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('WasmLongCarryHarness');
  jvm.classInitializationState.set('WasmLongCarryHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'wasm-long-carry-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0n, 0n, 0n];
  const state = [1n, 2n, 3n];
  const input = [4n, 6n, 7n];
  for (const array of [out, state, input]) array.type = '[J';
  await invoke(jvm, thread, 'WasmLongCarryHarness', 'compute', '([J[J[J)V',
    [out, state, input]);

  t.deepEqual(out.slice(0, 3), [4n, 6n, 7n], 'merged long branch values are preserved');
  const compiled = jvm.jit.wasmJit.compiled.map((entry) => entry.key);
  t.ok(compiled.includes('WasmLongCarryHarness.compute([J[J[J)V'), 'loop uses the Wasm tier');
  t.end();
});

test('Wasm JIT links loop-free static numeric helpers into hot loops', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmLinkedHelperHarness', `
public class WasmLinkedHelperHarness {
  private static int mix(int[] values, int index, int salt) {
    int value = values[index];
    return (value * 31 + salt) ^ (value >>> 3);
  }
  public static void compute(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = mix(out, i, i + 7);
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('WasmLinkedHelperHarness');
  jvm.classInitializationState.set('WasmLinkedHelperHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'wasm-linked-helper-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [3, 5, 8];
  out.type = '[I';

  await invoke(jvm, thread, 'WasmLinkedHelperHarness', 'compute', '([I)V', [out]);

  t.deepEqual(out.slice(0, 3), [100, 163, 256], 'linked helper preserves JVM integer results');
  const compiled = new Map(jvm.jit.wasmJit.compiled.map((entry) => [entry.key, entry]));
  t.ok(compiled.has('WasmLinkedHelperHarness.mix([III)I'),
    'loop-free helper with a reference argument compiles on demand');
  t.ok(compiled.has('WasmLinkedHelperHarness.compute([I)V'), 'caller loop compiles with the linked helper');
  t.equal(compiled.get('WasmLinkedHelperHarness.compute([I)V').exits, 0,
    'linked call does not bounce through the interpreter');
  t.end();
});

test('Wasm JIT links helpers whose only unsupported blocks are exception reporters', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmLinkedReporterHelperHarness', `
public class WasmLinkedReporterHelperHarness {
  private static int mix(int value) {
    try {
      return value * 31 + 7;
    } catch (RuntimeException failure) {
      throw new IllegalStateException("mix(" + value + ")", failure);
    }
  }
  public static void compute(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = mix(out[i]);
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('WasmLinkedReporterHelperHarness');
  jvm.classInitializationState.set('WasmLinkedReporterHelperHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'wasm-linked-reporter-helper-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [2, 4, 6];
  out.type = '[I';

  await invoke(jvm, thread, 'WasmLinkedReporterHelperHarness', 'compute', '([I)V', [out]);

  t.deepEqual(out.slice(0, 3), [69, 131, 193],
    'linked reporter helper preserves normal-flow results');
  const compiled = new Map(jvm.jit.wasmJit.compiled.map((entry) => [entry.key, entry]));
  t.ok(compiled.has('WasmLinkedReporterHelperHarness.mix(I)I'),
    'normal-flow-complete helper links despite handler-only blocks');
  t.equal(compiled.get('WasmLinkedReporterHelperHarness.compute([I)V').exits, 0,
    'linked reporter helper does not force caller exits');
  t.end();
});

test('Wasm JIT recognizes forward-branching wrap-and-rethrow reporters', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmReporterHarness', `
public class WasmReporterHarness {
  public static void compute(int[] out, String site) {
    try {
      for (int i = 0; i < out.length; i++) out[i] = out[i] * 3 + i;
    } catch (RuntimeException failure) {
      String detail = site == null ? "null" : "{...}";
      throw new IllegalStateException("compute(" + detail + ")", failure);
    }
  }

  public static void recover(int[] out) {
    try {
      for (int i = 0; i <= out.length; i++) out[i]++;
    } catch (RuntimeException failure) {
      out[0] = 42;
    }
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('WasmReporterHarness');
  jvm.classInitializationState.set('WasmReporterHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'wasm-reporter-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [2, 4, 6];
  out.type = '[I';

  await invoke(jvm, thread, 'WasmReporterHarness', 'compute',
    '([ILjava/lang/String;)V', [out, null]);

  t.deepEqual(out.slice(0, 3), [6, 13, 20], 'normal reporter-covered loop preserves results');
  const compiled = new Map(jvm.jit.wasmJit.compiled.map((entry) => [entry.key, entry]));
  t.ok(compiled.has('WasmReporterHarness.compute([ILjava/lang/String;)V'),
    'forward-only diagnostic formatting does not poison the protected loop');
  t.equal(compiled.get('WasmReporterHarness.compute([ILjava/lang/String;)V').exits, 0,
    'successful protected loop remains in wasm');
  const recover = await jvm.findMethodInHierarchy('WasmReporterHarness', 'recover', '([I)V');
  const recoverFrame = new Frame(recover);
  recoverFrame.className = 'WasmReporterHarness';
  t.equal(jvm.jit.wasmJit.prepare(recoverFrame), null,
    'a handler that writes a recovery value remains interpreted');
  t.end();
});

test('Wasm JIT reporter scan skips unreachable throws before a forward join', (t) => {
  const codeItems = [
    { instruction: { op: 'astore', varnum: 1 } },
    { instruction: { op: 'aload', varnum: 2 } },
    { instruction: { op: 'ifnull', arg: 'Lnull' } },
    { instruction: { op: 'ldc', arg: '{...}' } },
    { instruction: { op: 'goto', arg: 'Ljoin' } },
    { instruction: 'athrow' },
    { labelDef: 'Lnull:' },
    { instruction: { op: 'ldc', arg: 'null' } },
    { labelDef: 'Ljoin:' },
    { instruction: { op: 'invokestatic', arg: [null, 'Reporter', ['wrap', '()V']] } },
    { instruction: 'athrow' },
  ];
  const labels = new Map([['Lnull', 6], ['Ljoin', 8]]);

  t.ok(wasmJitTest.isNoOpExceptionHandler(codeItems, 0, labels),
    'an unreachable trap before the pending join is not mistaken for handler recovery');
  t.end();
});

test('whole-method JS tier accepts invoke loops with rethrow-only handlers', (t) => {
  const codeItems = [
    { labelDef: 'Lstart:' },
    { instruction: { op: 'invokestatic', arg: [null, 'Helper', ['mix', '(I)I']] } },
    { instruction: { op: 'goto', arg: 'Lstart' } },
    { labelDef: 'Lend:' },
    { instruction: 'return' },
    { labelDef: 'Lhandler:' },
    { instruction: { op: 'astore', varnum: 1 } },
    { instruction: { op: 'aload', varnum: 1 } },
    { instruction: 'athrow' },
  ];
  const method = {
    name: 'render',
    descriptor: '()V',
    attributes: [{ type: 'code', code: {
      codeItems,
      exceptionTable: [{ startLbl: 'Lstart', endLbl: 'Lend', handlerLbl: 'Lhandler' }],
    } }],
  };
  const jvm = new JVM({ jit: { preferWholeMethodJs: true } });

  t.ok(jvm.jit.hasOnlyNoOpExceptionHandlers(method, codeItems),
    'bare rethrow handler is proven semantically transparent');
  t.ok(jvm.jit.hasJitSafeControlFlow(method, codeItems),
    'normal-flow invokes are eligible when every handler only rethrows');
  t.end();
});

test('Wasm JIT retries a deferred loop after its static helper becomes available', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmDeferredHarness', `
public class WasmDeferredHarness {
  static class Helper {
    static int marker;
    static { marker = 1; }
    static int mix(int value) { return value * 3 + 1; }
  }
  public static void compute(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = Helper.mix(out[i]);
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('WasmDeferredHarness');
  jvm.classInitializationState.set('WasmDeferredHarness', 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy('WasmDeferredHarness', 'compute', '([I)V');
  const frame = new Frame(method);
  frame.className = 'WasmDeferredHarness';

  t.equal(jvm.jit.wasmJit.prepare(frame), null,
    'caller initially defers while the helper class is unavailable');
  t.equal(jvm.jit.wasmJit.methodState(frame).status, 'cold',
    'a dependency miss does not permanently reject the caller');

  await jvm.loadClassByName('WasmDeferredHarness$Helper');
  jvm.classInitializationState.set('WasmDeferredHarness$Helper', 'INITIALIZED');
  // The first retry observes the adaptive two-entry backoff.
  jvm.jit.wasmJit.prepare(frame);
  const prepared = jvm.jit.wasmJit.prepare(frame);
  t.ok(prepared, 'caller recompiles after its helper becomes linkable');
  t.equal(jvm.jit.wasmJit.methodState(frame).status, 'ready',
    'successfully retried caller remains ready');
  t.end();
});

test('Wasm JIT compiles loops protected only by checked-exception handlers', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmCheckedHandlerHarness', `
import java.io.IOException;

public class WasmCheckedHandlerHarness {
  private static void maybeFail(boolean fail) throws IOException {
    if (fail) throw new IOException("expected");
  }

  public static void checked(int[] out, boolean fail) {
    try {
      for (int i = 0; i < out.length; i++) out[i] = out[i] * 3 + i;
      maybeFail(fail);
    } catch (IOException expected) {
      out[0] = 42;
    }
  }

  public static void broad(int[] out) {
    try {
      for (int i = 0; i <= out.length; i++) out[i]++;
    } catch (Exception expected) {
      out[0] = 99;
    }
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('WasmCheckedHandlerHarness');
  jvm.classInitializationState.set('WasmCheckedHandlerHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'wasm-checked-handler-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const success = [2, 4, 6];
  success.type = '[I';
  await invoke(jvm, thread, 'WasmCheckedHandlerHarness', 'checked', '([IZ)V', [success, 0]);
  t.deepEqual(success.slice(0, 3), [6, 13, 20],
    'normal protected loop preserves its result');

  const failure = [1, 2, 3];
  failure.type = '[I';
  await invoke(jvm, thread, 'WasmCheckedHandlerHarness', 'checked', '([IZ)V', [failure, 1]);
  t.deepEqual(failure.slice(0, 3), [42, 7, 11],
    'checked exception still exits at the invoke and reaches its handler');

  const compiled = new Map(jvm.jit.wasmJit.compiled.map((entry) => [entry.key, entry]));
  t.ok(compiled.has('WasmCheckedHandlerHarness.checked([IZ)V'),
    'checked-exception protection does not poison the numeric loop');

  const broad = await jvm.findMethodInHierarchy('WasmCheckedHandlerHarness', 'broad', '([I)V');
  const broadFrame = new Frame(broad);
  broadFrame.className = 'WasmCheckedHandlerHarness';
  t.equal(jvm.jit.wasmJit.prepare(broadFrame), null,
    'broad Exception recovery remains interpreted');
  t.end();
});

test('generated JS callers use proven rethrow-only children without deoptimizing', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmBeforeDeoptHarness', `
public class WasmBeforeDeoptHarness {
  private static int increment(int value) {
    return value + 1;
  }

  private static void wrappedLoop(int[] out) {
    try {
      for (int i = 0; i < out.length; i++) out[i] = increment(out[i]);
    } catch (RuntimeException failure) {
      throw new IllegalStateException("wrappedLoop", failure);
    }
  }

  public static void caller(int[] out) {
    wrappedLoop(out);
    out[0] += 10;
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({
    classpath,
    jit: { warmupThreshold: 0, preferWholeMethodJs: true },
  });
  await jvm.loadClassByName('WasmBeforeDeoptHarness');
  jvm.classInitializationState.set('WasmBeforeDeoptHarness', 'INITIALIZED');
  const wrapped = await jvm.findMethodInHierarchy(
    'WasmBeforeDeoptHarness', 'wrappedLoop', '([I)V');
  t.ok(jvm.jit.isCodegenSupported(wrapped),
    'rethrow-only handler permits whole-method generated code');

  const thread = {
    id: 0,
    name: 'wasm-before-deopt-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [1, 2, 3];
  out.type = '[I';

  await invoke(jvm, thread, 'WasmBeforeDeoptHarness', 'caller', '([I)V', [out]);

  t.deepEqual(out.slice(0, 3), [12, 3, 4], 'generated child and caller preserve results');
  const caller = await jvm.findMethodInHierarchy('WasmBeforeDeoptHarness', 'caller', '([I)V');
  t.notOk(jvm.jit.deoptedMethods.has(caller),
    'a generated child does not permanently deopt its generated caller');
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

  public static void catchExplicit(int[] out, RuntimeException failure) {
    try {
      if (failure != null) throw failure;
    } catch (RuntimeException e) {
      out[0] = 91;
    }
    for (int i = 1; i < out.length; i++) out[i] = i + 10;
  }
}
`);

  const jvm = new JVM({
    classpath,
    jit: { warmupThreshold: 0, experimentalControlFlow: true },
  });
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
  const explicitOut = [0, 0];
  explicitOut.type = '[I';
  explicitOut.length = 2;
  explicitOut.hashCode = jvm.nextHashCode++;
  await invoke(jvm, thread, 'JitExceptionHarness', 'catchExplicit',
    '([ILjava/lang/RuntimeException;)V', [explicitOut, { type: 'java/lang/RuntimeException' }]);
  t.deepEqual(explicitOut.slice(0, 2), [91, 11],
    'generated athrow should route through the method exception table');
  t.ok(jvm.jit.generatedRunCount > 0, 'exception test should exercise generated code');
  t.end();
});

test('generated JIT derives leaf exception and monitor control flow from bytecodes', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedRejectHarness', `
public class GeneratedRejectHarness implements Runnable {
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

  public static int leafWrapped(int value, int divisor) {
    try {
      return value / divisor;
    } catch (RuntimeException failure) {
      throw new IllegalStateException(failure);
    }
  }

  public static void leafSynchronized(int[] out) {
    synchronized (out) {
      for (int i = 0; i < out.length; i++) out[i] += 2;
    }
  }

  public void run() {
    int[] out = new int[2];
    synchronized (out) {
      for (int i = 0; i < out.length; i++) out[i]++;
    }
  }
}
`);

  const safeJvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await safeJvm.loadClassByName('GeneratedRejectHarness');
  const safeMethod = await safeJvm.findMethodInHierarchy('GeneratedRejectHarness', 'compute', '([I)V');
  t.notOk(safeJvm.jit.isCodegenSupported(safeMethod),
    'normal-flow constructor calls keep effectful control flow interpreted');
  const leafWrappedMethod = await safeJvm.findMethodInHierarchy(
    'GeneratedRejectHarness', 'leafWrapped', '(II)I');
  t.ok(safeJvm.jit.isCodegenSupported(leafWrappedMethod),
    'an invoke reachable only from the exception handler does not reject a leaf body');
  const leafSynchronizedMethod = await safeJvm.findMethodInHierarchy(
    'GeneratedRejectHarness', 'leafSynchronized', '([I)V');
  t.ok(safeJvm.jit.isCodegenSupported(leafSynchronizedMethod),
    'a leaf synchronized numeric loop is derived without a signature allowlist');
  const safeRunMethod = await safeJvm.findMethodInHierarchy('GeneratedRejectHarness', 'run', '()V');
  t.notOk(safeJvm.jit.isCodegenSupported(safeRunMethod),
    'thread lifecycle entrypoint remains interpreted by default');

  const experimentalJvm = new JVM({
    classpath,
    jit: { warmupThreshold: 0, experimentalControlFlow: true },
  });
  await experimentalJvm.loadClassByName('GeneratedRejectHarness');
  const experimentalMethod = await experimentalJvm.findMethodInHierarchy(
    'GeneratedRejectHarness', 'compute', '([I)V');
  t.ok(experimentalJvm.jit.isCodegenSupported(experimentalMethod),
    'capability gate enables supported bytecodes without naming the method');
  const experimentalRunMethod = await experimentalJvm.findMethodInHierarchy(
    'GeneratedRejectHarness', 'run', '()V');
  t.ok(experimentalJvm.jit.isCodegenSupported(experimentalRunMethod),
    'explicit experimental gate can enable lifecycle control flow');
  t.end();
});

test('generated JIT leaves monitor-parking methods in the interpreter', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedMonitorWaitHarness', `
public class GeneratedMonitorWaitHarness {
  public static void compute(int[] out) throws InterruptedException {
    synchronized (out) {
      out.wait();
      for (int i = 0; i < out.length; i++) out[i]++;
    }
  }
}
`);

  const jvm = new JVM({
    classpath,
    jit: { warmupThreshold: 0, experimentalControlFlow: true },
  });
  await jvm.loadClassByName('GeneratedMonitorWaitHarness');
  const method = await jvm.findMethodInHierarchy('GeneratedMonitorWaitHarness', 'compute', '([I)V');

  t.notOk(jvm.jit.isCodegenSupported(method),
    'a wait while holding a monitor requires interpreter scheduler semantics');
  t.end();
});

test('generated JIT preserves monitors for structurally supported hot methods', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedMonitorJitHarness', `
public class GeneratedMonitorJitHarness {
  public static void compute(int[] out, int value) {
    try {
      synchronized (out) {
        for (int i = 0; i < out.length; i++) out[i] += value;
      }
    } catch (RuntimeException failure) {
      throw new IllegalStateException(
        new StringBuilder().append("compute(").append(out).append(")").toString(),
        failure);
    }
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: { warmupThreshold: 100 },
  });
  await jvm.loadClassByName('GeneratedMonitorJitHarness');
  const method = await jvm.findMethodInHierarchy(
    'GeneratedMonitorJitHarness', 'compute', '([II)V');
  t.ok(jvm.jit.isCodegenSupported(method),
    'constructor calls reachable only from a monitor exception reporter do not reject the hot body');
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
  t.equal(jvm.jit.generatedRunCount, 1, 'structurally supported synchronized loop uses generated code');
  t.end();
});

test('generated synchronized regions resume around unsupported interpreted callees', async (t) => {
  const classpath = compileJavaFixture(t, 'MonitorCallIslandHarness', `
public class MonitorCallIslandHarness {
  private static int opaque(int value) {
    switch (value) {
      case 1: return 7;
      case 2: return 11;
      case 3: return 13;
      default: return value * 3;
    }
  }

  public static void compute(int[] out) {
    synchronized (out) {
      for (int i = 0; i < out.length; i++) out[i] = opaque(out[i]) + i;
    }
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('MonitorCallIslandHarness');
  jvm.classInitializationState.set('MonitorCallIslandHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'monitor-call-island-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [1, 2, 3, 4];
  out.type = '[I';
  out.isLocked = false;
  out.lockOwner = null;
  out.lockCount = 0;
  out.waitSet = [];

  await invoke(jvm, thread, 'MonitorCallIslandHarness', 'compute', '([I)V', [out]);

  t.deepEqual(out.slice(0, 4), [7, 12, 15, 15],
    'compiled parent and interpreted switch helper preserve results');
  const compute = await jvm.findMethodInHierarchy('MonitorCallIslandHarness', 'compute', '([I)V');
  t.notOk(jvm.jit.deoptedMethods.has(compute),
    'interpreted call islands do not permanently deopt the synchronized parent');
  t.ok(jvm.jit.generatedMethodRunCounts.get('MonitorCallIslandHarness.compute([I)V') >= 2,
    'generated parent resumes after interpreted children');
  t.notOk(out.isLocked, 'resumed generated monitorexit releases the monitor');
  t.end();
});

test('generated JIT resolves class literals for native-only JRE classes', async (t) => {
  const classpath = compileJavaFixture(t, 'JitClassLiteralHarness', `
public class JitClassLiteralHarness {
  public static void store(Object[] out) {
    for (int i = 0; i < out.length; i++) {
      out[i] = javax.sound.sampled.SourceDataLine.class;
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 1 } });
  await jvm.loadClassByName('JitClassLiteralHarness');
  const thread = {
    id: 0,
    name: 'jit-class-literal-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [null, null];
  out.type = '[Ljava/lang/Object;';
  out.length = 2;
  out.hashCode = jvm.nextHashCode++;

  await invoke(jvm, thread, 'JitClassLiteralHarness', 'store', '([Ljava/lang/Object;)V', [out]);
  await invoke(jvm, thread, 'JitClassLiteralHarness', 'store', '([Ljava/lang/Object;)V', [out]);

  t.equal(out[0]._classData.ast.classes[0].className,
    'javax/sound/sampled/SourceDataLine', 'class literal becomes a usable java.lang.Class object');
  t.ok(jvm.jit.generatedRunCount + jvm.jit.runnerRunCount > 0,
    'class literal executes through a JIT tier');
  t.end();
});
