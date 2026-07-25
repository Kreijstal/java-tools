const test = require('tape');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

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
    await jvm.executeTick();
    ticks += 1;
    if (ticks > 1000000) throw new Error('tick limit');
  }
}

test('PyramidApplet start creates animator thread with applet runnable target', async (t) => {
  const jvm = new JVM({ classpath: 'sources', jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('PyramidApplet');
  const thread = {
    id: 0,
    name: 'main',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const applet = await jvm.createAppletInstance('PyramidApplet');
  await invoke(jvm, thread, 'PyramidApplet', '<init>', '()V', [applet]);
  await invoke(jvm, thread, 'PyramidApplet', 'start', '()V', [applet]);

  t.equal(jvm.threads.length, 2, 'start() should create an animator thread');
  const animator = applet.fields['PyramidApplet.animator'];
  t.ok(animator, 'applet should store the animator Thread object');
  t.equal(animator.name, 'GridOrbit', 'Thread(Runnable, String) should preserve the supplied name');
  t.equal(animator.runnable, applet, 'Thread(Runnable, String) should preserve the applet runnable target');
  t.equal(jvm.threads[1].callStack.peek().method.name, 'run', 'animator thread should execute the applet run method');
  t.end();
});
