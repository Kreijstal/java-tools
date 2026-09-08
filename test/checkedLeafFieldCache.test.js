'use strict';
// Kreijstal/java-tools#403: a checked-leaf positional body for a nested
// reference-field predicate (`return this.a.b != null`) read the compiler's
// field-cache temporaries (`ssaFieldCache0Value`, `ssaFieldCache1Valid`, ...)
// without declaring or initializing them. The host ReferenceError escaped as
// an unhandled guest exception and terminated the calling Java thread.
//
// The structured and restoring bodies always carried those declarations; the
// transactional *read* shape of the checked leaf dropped them. These tests
// pin the checked-leaf tier against the interpreter and against HotSpot for
// a non-null terminal field, a null terminal field and a null intermediate
// receiver, on locally generated and transported bodies, and prove that the
// corrected tier is what actually executes.
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const CLASS_NAME = 'FieldCacheLeaf';
const SOURCE = `
public final class FieldCacheLeaf {
  Payload payload = new Payload();
  final boolean ready() { return this.payload.bytes != null; }
  static int drive(FieldCacheLeaf leaf, int rounds) {
    int hits = 0;
    for (int i = 0; i < rounds; i++) {
      if (leaf.ready()) hits++;
    }
    return hits;
  }
  public static void main(String[] args) {
    FieldCacheLeaf leaf = new FieldCacheLeaf();
    int present = drive(leaf, 384);
    leaf.payload.bytes = null;
    int absent = drive(leaf, 384);
    leaf.payload = null;
    int broken;
    try {
      broken = drive(leaf, 384);
    } catch (NullPointerException e) {
      broken = -1;
    }
    System.out.println(present + " " + absent + " " + broken);
  }
}
final class Payload {
  byte[] bytes = new byte[1];
}
`;

const JIT_OPTIONS = {
  compileWorker: false,
  warmupThreshold: 0,
  structuredSsa: true,
  checkedLeafDirectPositional: true,
};

function compileFixture(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checked-leaf-field-cache-'));
  t.teardown(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const sourcePath = path.join(tempDir, `${CLASS_NAME}.java`);
  fs.writeFileSync(sourcePath, SOURCE);
  execFileSync('javac', ['-g', '-d', tempDir, sourcePath], { stdio: 'inherit' });
  return tempDir;
}

async function bootJvm(classpath, jit) {
  const jvm = new JVM({ classpath, jit });
  for (const className of [CLASS_NAME, 'Payload']) {
    await jvm.loadClassByName(className);
    jvm.classInitializationState.set(className, 'INITIALIZED');
  }
  return jvm;
}

function bytesArray(length) {
  const bytes = new Int8Array(length);
  bytes.type = '[B';
  return bytes;
}

// Receivers for the three predicate outcomes. The interpreter reads the same
// host objects, so a body and the interpreter see identical guest state.
function receivers() {
  const payload = (bytes) => ({ type: 'Payload', fields: { 'Payload.bytes': bytes } });
  const leaf = (fieldPayload) => ({
    type: CLASS_NAME, fields: { [`${CLASS_NAME}.payload`]: fieldPayload },
  });
  return {
    present: leaf(payload(bytesArray(1))),
    absent: leaf(payload(null)),
    broken: leaf(null),
  };
}

function freshThread() {
  return { status: 'runnable', pendingException: null, callStack: new Stack() };
}

// Runs `ready()` through the interpreter on a JVM whose JIT never warms up,
// reporting the returned value or the exception type it raised.
async function interpretReady(jvm, receiver) {
  const method = await jvm.findMethodInHierarchy(CLASS_NAME, 'ready', '()Z');
  const thread = {
    id: 0, name: 'interpreter', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const frame = new Frame(method);
  frame.className = CLASS_NAME;
  frame.locals[0] = receiver;
  // The caller frame receives the value `ready()` returns.
  const caller = new Frame(await jvm.findMethodInHierarchy(CLASS_NAME, 'drive', `(L${CLASS_NAME};I)I`));
  caller.className = CLASS_NAME;
  caller.pc = Number.MAX_SAFE_INTEGER;
  thread.callStack.push(caller);
  thread.callStack.push(frame);
  let error = null;
  const handle = jvm.handleException;
  jvm.handleException = function (exception, ...rest) {
    error = exception;
    thread.callStack.items.length = 0;
    thread.status = 'terminated';
    return true;
  };
  try {
    for (let ticks = 0; thread.callStack.size() > 1 && thread.status === 'runnable'; ticks += 1) {
      const result = await jvm.executeTick();
      if (result.completed || ticks > 100000) break;
    }
  } finally {
    jvm.handleException = handle;
  }
  if (error) return { threw: error.type || error.name || String(error) };
  return { value: caller.stack.items[caller.stack.items.length - 1] };
}

test('checked-leaf bodies declare and initialize the field caches they read', async (t) => {
  const classpath = compileFixture(t);
  const jvm = await bootJvm(classpath, JIT_OPTIONS);
  const reference = await bootJvm(classpath, { compileWorker: false, warmupThreshold: 1e9 });
  const method = await jvm.findMethodInHierarchy(CLASS_NAME, 'ready', '()Z');
  const generated = jvm.jit.getGeneratedFunction(method, { compileLocally: true });
  t.equal(generated?.jvmStructuredTransactionalAcyclicCheckedLeaf, true,
    'the nested reference read is a transactional acyclic checked leaf');
  t.equal(generated?.jvmStructuredFieldReadCacheCount, 2,
    'the predicate owns one eager (entry-receiver) and one nested field cache');

  const transported = jvm.jit.materializeGeneratedResult(
    JSON.parse(JSON.stringify(jvm.jit.serializeGeneratedResult(generated))), method);
  t.ok(transported, 'the compile result survives the worker transport');

  const bodies = [];
  for (const [origin, result] of [['local', generated], ['transported', transported]]) {
    for (const key of ['jvmCheckedLeafDirectPositionalBody',
      'jvmTrustedCheckedLeafDirectPositionalBody']) {
      t.equal(typeof result[key], 'function', `${origin} ${key} is published`);
      bodies.push([`${origin} ${key}`, result[key]]);
    }
  }
  for (const key of ['jvmCheckedLeafDirectPositionalSource',
    'jvmTrustedCheckedLeafDirectPositionalSource']) {
    const source = generated[key];
    for (const name of source.match(/ssaFieldCache\w+/g) || []) {
      t.ok(new RegExp(`(?:let|const) ${name}\\b`).test(source),
        `${key} declares ${name} before reading it`);
    }
  }

  const cases = receivers();
  const expected = {};
  for (const [name, receiver] of Object.entries(cases)) {
    expected[name] = await interpretReady(reference, receiver);
  }
  t.deepEqual(expected, {
    present: { value: 1 },
    absent: { value: 0 },
    broken: { threw: 'java/lang/NullPointerException' },
  }, 'the interpreter establishes the Java results for the three receivers');

  const bail = jvm.jit.asyncInvokeSentinel();
  for (const [label, body] of bodies) {
    const observed = {};
    for (const [name, receiver] of Object.entries(cases)) {
      const thread = freshThread();
      try {
        const value = body(jvm.jit, receiver, thread, true);
        observed[name] = value === bail ? 'bail' : value;
      } catch (error) {
        observed[name] = `host error: ${error.message}`;
      }
      t.equal(thread.callStack.size(), 0, `${label} leaves no frame behind for ${name}`);
    }
    // A checked leaf answers the two well-formed predicates itself and hands
    // the throwing receiver back to the canonical path before any effect.
    t.deepEqual(observed, { present: 1, absent: 0, broken: 'bail' },
      `${label} matches the interpreter and bails on the null receiver`);
  }
  t.end();
});

test('the corrected checked-leaf tier executes end to end and matches HotSpot', async (t) => {
  const classpath = compileFixture(t);
  const hotspot = spawnSync('java', ['-cp', classpath, CLASS_NAME], { encoding: 'utf8' });
  t.equal(hotspot.status, 0, `HotSpot runs the fixture: ${hotspot.stderr}`);
  const expected = hotspot.stdout.trim();
  t.equal(expected, '384 0 -1', 'HotSpot reports the reference counts');

  const jvm = new JVM({ classpath, jit: JIT_OPTIONS });
  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(Ljava/lang/String;)V': (_jvm, _obj, args) => { output += `${args[0]}\n`; },
    },
  });
  const hostErrors = [];
  const handle = jvm.handleException;
  jvm.handleException = function (exception, ...rest) {
    if (exception instanceof Error && !exception.type) hostErrors.push(exception.message);
    return handle.call(this, exception, ...rest);
  };
  await jvm.run(CLASS_NAME);
  t.deepEqual(hostErrors, [], 'no host error reaches the guest exception dispatcher');
  t.equal(output.trim(), expected, 'jvm.js prints what HotSpot prints');

  const ready = await jvm.findMethodInHierarchy(CLASS_NAME, 'ready', '()Z');
  const generated = jvm.jit.codegenCache.get(ready);
  t.equal(typeof generated?.jvmTrustedCheckedLeafDirectPositionalBody, 'function',
    'the run compiled ready() with a trusted checked leaf');
  const site = jvm.jit.syncCallSites.find((candidate) =>
    candidate?.methodName === 'ready' && candidate.fastPositional?.invoke);
  t.ok(site, 'drive() links ready() through a positional call');
  t.equal(site?.fastPositional?.invoke?.jvmCheckedLeaf, true,
    'the positional entry selected is the checked-leaf tier');
  t.equal(site?.fastPositional?.invoke?.jvmRawInvoke,
    generated?.jvmTrustedCheckedLeafDirectPositionalBody,
    'the raw entry is the trusted checked-leaf body itself');

  // Prove the tier executes: route the published entry through a counter and
  // drive the loop again on the same receiver shapes.
  const raw = site.fastPositional.invoke.jvmRawInvoke;
  let entries = 0;
  const counting = function (...args) { entries += 1; return raw(...args); };
  counting.jvmCheckedLeaf = true;
  site.fastPositional.rawInvoke = counting;
  site.fastPositional.invoke = counting;
  const drive = await jvm.findMethodInHierarchy(CLASS_NAME, 'drive', `(L${CLASS_NAME};I)I`);
  const thread = jvm.threads[0];
  thread.status = 'runnable';
  const cases = receivers();
  const frame = new Frame(drive);
  frame.className = CLASS_NAME;
  frame.locals[0] = cases.present;
  frame.locals[1] = 64;
  const caller = new Frame(drive);
  caller.className = CLASS_NAME;
  caller.pc = Number.MAX_SAFE_INTEGER;
  thread.callStack.push(caller);
  thread.callStack.push(frame);
  for (let ticks = 0; thread.callStack.size() > 1 && ticks < 100000; ticks += 1) {
    const result = await jvm.executeTick();
    if (result.completed) break;
  }
  t.equal(caller.stack.items[caller.stack.items.length - 1], 64,
    'the re-driven loop counts every present payload');
  t.ok(entries > 0, `the checked-leaf entry executed (${entries} calls)`);
  t.end();
});
