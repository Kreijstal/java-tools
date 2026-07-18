const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

function compileFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-state-fixture-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'SaveStateHarness.java');
  fs.writeFileSync(source, `
public class SaveStateHarness {
  public static int counter;
  public static Object root;
  public static void compute() {
    for (int i = 0; i < 20; i++) counter = counter * 3 + i;
  }
}
`);
  execFileSync('javac', ['-g', '-d', dir, source]);
  return dir;
}

async function drain(jvm, limit = 10000) {
  for (let i = 0; i < limit && jvm.threads.some((thread) => !thread.callStack.isEmpty()); i++) {
    await jvm.executeTick();
  }
}

test('portable JVM save states preserve heap identity and deterministic execution', async (t) => {
  const classpath = compileFixture(t);
  const jvm = new JVM({ classpath, jit: { enabled: false } });
  const classData = await jvm.loadClassByName('SaveStateHarness');
  classData.staticFields.set('counter:I', 0);
  jvm.classInitializationState.set('SaveStateHarness', 'INITIALIZED');

  const shared = { type: 'SaveStateHarness', fields: {}, hashCode: 42 };
  const dataPath = path.join(classpath, 'state-data.bin');
  fs.writeFileSync(dataPath, Buffer.from([10, 20, 30]));
  const raf = {
    type: 'java/io/RandomAccessFile',
    path: dataPath,
    mode: 'r',
    position: 2,
    fileHandle: await fs.promises.open(dataPath, 'r'),
  };
  const array = [shared, 7n];
  array.type = '[Ljava/lang/Object;';
  shared.fields.self = shared;
  shared.fields.array = array;
  shared.fields.raf = raf;
  classData.staticFields.set('root:Ljava/lang/Object;', shared);

  const method = await jvm.findMethodInHierarchy('SaveStateHarness', 'compute', '()V');
  const frame = new Frame(method);
  frame.className = 'SaveStateHarness';
  frame.locals[1] = shared;
  const thread = {
    id: 0,
    name: 'save-state-test',
    status: 'runnable',
    callStack: new Stack(),
    pendingException: null,
    sleepUntil: Date.now() + 5000,
  };
  thread.callStack.push(frame);
  shared.waitSet = [thread];
  jvm.threads = [thread];

  for (let i = 0; i < 12; i++) await jvm.executeTick();
  const state = jvm.saveState();
  const json = JSON.stringify(state);
  t.ok(json.length > 0, 'save state is JSON portable');

  const restored = new JVM({ classpath, jit: { enabled: false } });
  const result = await restored.loadState(JSON.parse(json));
  t.equal(result.status, 'restored', 'save state restores into a fresh JVM');
  const restoredClass = restored.classes.SaveStateHarness;
  const restoredRoot = restoredClass.staticFields.get('root:Ljava/lang/Object;');
  t.equal(restoredRoot.fields.self, restoredRoot, 'cyclic Java object identity survives');
  t.equal(restoredRoot.fields.array[0], restoredRoot, 'shared array reference survives');
  t.equal(restoredRoot.fields.array[1], 7n, 'long/BigInt values survive');
  t.equal(typeof restoredRoot.fields.raf.fileHandle.read, 'function',
    'portable file metadata reopens its host handle');
  t.equal(restored.threads[0].callStack.peek().locals[1], restoredRoot,
    'frame locals share the restored heap object');
  t.equal(restoredRoot.waitSet[0], restored.threads[0],
    'monitor wait sets point at restored internal threads');
  const remaining = restored.threads[0].sleepUntil - Date.now();
  t.ok(remaining > 4000 && remaining <= 5000, 'sleep deadlines restore as relative time');

  await drain(jvm);
  await drain(restored);
  t.equal(restoredClass.staticFields.get('counter:I'), classData.staticFields.get('counter:I'),
    'restored execution reaches the same deterministic result');
  await raf.fileHandle.close();
  await restoredRoot.fields.raf.fileHandle.close();
  t.end();
});
