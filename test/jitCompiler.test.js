const test = require('tape');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const awt = require('../src/platform/awt');

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
