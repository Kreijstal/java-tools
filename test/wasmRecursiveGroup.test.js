'use strict';

// docs/phase1-linked-call-abi.md 6, "recursive group": two methods in two
// classes that call each other, neither linkable at the other's codegen.
//
// Before this test the group never converged. Each arm's only exit was the
// late-bound site naming the other arm; that site can deopt as long as its
// slot may hold the stub, so each arm counted one deoptable call, so neither
// satisfied the never-exits contract the other needed, so both slots stayed on
// the JS trampoline for the life of the process (and every later caller
// bridged into the group through JS as well). The linker now judges the group
// as a whole: WasmLinker.sealGroups finds the largest set of otherwise
// never-exits modules whose every slot names a never-exits export or another
// member, binds all of those slots at once, and only then calls the members
// never-exits. A sealed edge is pinned across the callee's withdrawal instead
// of reverting to the stub, which is what keeps the members' deopt paths dead.

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const WasmLinker = require('../src/jit/WasmLinker');
const { sealedNeverExits } = require('../src/jit/wasmShared');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

function compileJavaFixture(t, className, source) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recursive-group-'));
  t.teardown(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempDir, `${className}.java`), source);
  execFileSync('javac', ['-g', '-d', tempDir, path.join(tempDir, `${className}.java`)],
    { stdio: 'inherit' });
  return tempDir;
}

function withEnv(t, vars) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.teardown(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// Two classes, each with its own <clinit> (the static field), each arm larger
// than the inliner will absorb: a callee small enough to inline never reaches
// the linking path and the test would pass proving nothing.
const SOURCE = `
class GroupA {
  static int SALT = 17;
  static int ping(int n, int acc) {
    if (n <= 0) return acc + SALT;
    acc += (n & 1) * 3 + ((n >> 1) & 1) * 5 + ((n >> 2) & 1) * 7 + ((n >> 3) & 1) * 11;
    acc ^= acc << 3; acc ^= acc >>> 5; acc += n * 17;
    acc ^= acc << 7; acc ^= acc >>> 9; acc += n * 19;
    acc ^= acc << 11; acc ^= acc >>> 13; acc += n * 23;
    return GroupB.pong(n - 1, acc);
  }
}
class GroupB {
  static int SALT = 29;
  static int pong(int n, int acc) {
    if (n <= 0) return acc + SALT;
    acc += (n & 1) * 13 + ((n >> 1) & 1) * 17 + ((n >> 2) & 1) * 19 + ((n >> 3) & 1) * 23;
    acc ^= acc << 4; acc ^= acc >>> 6; acc += n * 29;
    acc ^= acc << 8; acc ^= acc >>> 10; acc += n * 31;
    acc ^= acc << 12; acc ^= acc >>> 14; acc += n * 37;
    return GroupA.ping(n - 1, acc);
  }
}
public class GroupDrive {
  static void drive(int[] out, int rounds) {
    int total = 0;
    for (int i = 0; i < rounds; i++) total += GroupA.ping(24, i);
    out[0] = total;
  }
  // Compiled only after the group is sealed: a fresh caller must link the
  // sealed arm directly, not bridge into it.
  static void later(int[] out, int rounds) {
    int total = 0;
    for (int i = 0; i < rounds; i++) total += GroupB.pong(23, i * 3);
    out[0] = total;
  }
}
`;

const PING = 'GroupA.ping(II)I';
const PONG = 'GroupB.pong(II)I';

async function bootJvm(classpath, jvmOptions) {
  const jvm = new JVM({ classpath, ...jvmOptions });
  await jvm.loadClassByName('GroupDrive');
  jvm.classInitializationState.set('GroupDrive', 'INITIALIZED');
  const thread = {
    id: 0, name: 'recursive-group', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return { jvm, thread };
}

// Drive one activation of GroupDrive.<name> to completion through the
// scheduler; results come back through the int[] because the harness has no
// return-value channel.
async function driveOnce({ jvm, thread }, name, rounds) {
  const out = [0];
  out.type = '[I';
  const method = await jvm.findMethodInHierarchy('GroupDrive', name, '([II)V');
  const frame = new Frame(method);
  frame.className = 'GroupDrive';
  frame.locals[0] = out;
  frame.locals[1] = rounds;
  const before = thread.callStack.size();
  thread.callStack.push(frame);
  let ticks = 0;
  while (thread.callStack.size() > before) {
    const step = await jvm.executeTick();
    ticks += 1;
    if (step && step.completed) break;
    if (ticks > 50000000) throw new Error('tick limit');
  }
  return out[0];
}

async function stateOf(jvm, className, name, descriptor) {
  const method = await jvm.findMethodInHierarchy(className, name, descriptor);
  return jvm.jit.wasmJit.state.get(method);
}

const stubCalls = (linker, key) =>
  (linker.slotsByCallee.get(key) || []).map((slot) => slot.stubCalls);

test('a two-class recursive group seals into wasm->wasm edges and stays sealed', async (t) => {
  withEnv(t, {
    JVM_WASM_JIT: '1',
    JVM_WASM_STRUCTURED: '1',
    JVM_WASM_JIT_WARMUP: '1',
    JVM_WASM_DIRECT_STATIC_LINK: '1',
  });
  const classpath = compileJavaFixture(t, 'GroupDrive', SOURCE);
  const rounds = 200;

  const interpreter = await bootJvm(classpath, { jit: { enabled: false } });
  const expectedDrive = await driveOnce(interpreter, 'drive', rounds);
  const expectedLater = await driveOnce(interpreter, 'later', rounds);
  t.equal(typeof expectedDrive, 'number', 'the interpreter produced a number');
  t.notEqual(expectedDrive, 0, 'and a non-trivial one');

  const jitted = await bootJvm(classpath, { jit: { compileWorker: false, warmupThreshold: 10 } });
  const wasm = jitted.jvm.jit.wasmJit;
  const linker = wasm.linker;
  t.ok(linker && linker.enabled, 'the runtime linker is on');

  // 1. both arms compile and the group seals during the first activation
  t.equal(await driveOnce(jitted, 'drive', rounds), expectedDrive,
    'the compiled group agrees with the interpreter');
  const ping = await stateOf(jitted.jvm, 'GroupA', 'ping', '(II)I');
  const pong = await stateOf(jitted.jvm, 'GroupB', 'pong', '(II)I');
  t.equal(ping && ping.status, 'ready', (ping && ping.lastCompileError) || 'ping compiled');
  t.equal(pong && pong.status, 'ready', (pong && pong.lastCompileError) || 'pong compiled');
  const pingMeta = (ping.callee || ping).meta;
  const pongMeta = (pong.callee || pong).meta;
  t.ok(pingMeta.fullyCompiled && pongMeta.fullyCompiled, 'both arms are fully compiled');
  t.equal(pingMeta.slotSites, 1, 'ping\'s one deoptable site is its slot call to pong');
  t.equal(pongMeta.slotSites, 1, 'pong\'s one deoptable site is its slot call to ping');
  t.equal(pingMeta.deoptableCalls, 1, 'ping has no other exit');
  t.equal(pongMeta.deoptableCalls, 1, 'pong has no other exit');
  t.ok(pingMeta.groupSealed && pongMeta.groupSealed, 'the linker sealed both arms');
  t.ok(sealedNeverExits(pingMeta) && sealedNeverExits(pongMeta),
    'a sealed arm counts as a never-exits module');
  t.ok(WasmLinker.directLinkable(ping, '(II)I') && WasmLinker.directLinkable(pong, '(II)I'),
    'both arms now satisfy the direct-link contract');
  t.deepEqual(linker.slotState(PING), ['direct'], 'pong -> ping is a bound table slot');
  t.deepEqual(linker.slotState(PONG), ['direct'], 'ping -> pong is a bound table slot');
  t.equal(linker.table.get(pongMeta.linkSlots[0]), pingMeta.runv,
    'pong\'s slot IS ping\'s runv export');
  t.equal(linker.table.get(pingMeta.linkSlots[0]), pongMeta.runv,
    'ping\'s slot IS pong\'s runv export');
  const census = linker.census();
  t.equal(census.sealed, 2, `two members sealed (${JSON.stringify(census)})`);
  t.equal(census.stub, 0, 'no slot is left on the stub');

  // 2. after the seal nothing crosses into JS: the stub counters freeze
  const stubsBefore = [...stubCalls(linker, PING), ...stubCalls(linker, PONG)];
  const driveRuns = (await stateOf(jitted.jvm, 'GroupDrive', 'drive', '([II)V')).runs;
  t.equal(await driveOnce(jitted, 'drive', rounds), expectedDrive,
    'a second activation still agrees with the interpreter');
  t.ok((await stateOf(jitted.jvm, 'GroupDrive', 'drive', '([II)V')).runs > driveRuns,
    'and it ran on the wasm tier');
  t.deepEqual([...stubCalls(linker, PING), ...stubCalls(linker, PONG)], stubsBefore,
    `no call reached a trampoline after the seal (${stubsBefore.join(',')} before)`);

  // 3. a caller compiled after the seal links the sealed arm directly
  t.equal(await driveOnce(jitted, 'later', rounds), expectedLater,
    'a later caller of the group agrees with the interpreter');
  const later = await stateOf(jitted.jvm, 'GroupDrive', 'later', '([II)V');
  t.equal(later && later.status, 'ready', (later && later.lastCompileError) || 'later compiled');
  const laterBinding = later.meta.linkBindings.find((b) => b.key === PONG);
  t.ok(laterBinding && !laterBinding.lateBound && laterBinding.classification === 'compatible',
    'its call into the group is a direct dcall_, not a slot and not a bridge');
  t.equal(later.meta.deoptableCalls, 0, 'so the later caller has no deoptable site of its own');

  // 4. withdrawing a member pins the sealed edge instead of reviving the stub
  wasm.withdrawModule(pong);
  t.deepEqual(linker.slotState(PONG), ['pinned'], 'ping -> pong is pinned, not stubbed');
  t.equal(linker.table.get(pingMeta.linkSlots[0]), pongMeta.runv,
    'the table still holds the withdrawn module\'s export');
  t.equal(await driveOnce(jitted, 'drive', rounds), expectedDrive,
    'the pinned group still agrees with the interpreter');
  t.deepEqual([...stubCalls(linker, PING), ...stubCalls(linker, PONG)], stubsBefore,
    'and still nothing reached a trampoline');

  // 5. a republished member takes the edge back over, and is sealed again
  const pongMethod = await jitted.jvm.findMethodInHierarchy('GroupB', 'pong', '(II)I');
  wasm.compile({ className: 'GroupB', method: pongMethod }, pong,
    { asCallee: true, entryPath: 'recursive-group-test' });
  t.equal(pong.status, 'ready', pong.lastCompileError || 'pong recompiled');
  const pongMeta2 = (pong.callee || pong).meta;
  t.notEqual(pongMeta2, pongMeta, 'with a new artifact');
  t.deepEqual(linker.slotState(PONG), ['direct'], 'ping -> pong follows the new module');
  t.equal(linker.table.get(pingMeta.linkSlots[0]), pongMeta2.runv,
    'the table holds the NEW export');
  // Lowered against a sealed ping, the new pong needs no seal of its own:
  // its call is a direct import and it never exits outright.
  const pongBinding = pongMeta2.linkBindings.find((b) => b.key === PING);
  t.ok(pongBinding && !pongBinding.lateBound && pongBinding.classification === 'compatible',
    'the recompiled arm links the sealed ping through a direct import');
  t.equal(pongMeta2.deoptableCalls, 0, 'and has no deoptable site at all');
  t.ok(WasmLinker.directLinkable(pong, '(II)I'), 'so it satisfies the contract by itself');
  t.deepEqual(linker.slotState(PING).filter((s) => s !== 'direct'), [],
    'every slot naming ping is direct (the old pong\'s and the new pong\'s)');
  t.equal(await driveOnce(jitted, 'drive', rounds), expectedDrive,
    'the re-sealed group agrees with the interpreter');
  t.equal(await driveOnce(jitted, 'later', rounds), expectedLater,
    'and so does the later caller through its pinned dcall_');
  t.end();
});

test('the seal is off with direct static links off, and the group still runs right', async (t) => {
  withEnv(t, {
    JVM_WASM_JIT: '1',
    JVM_WASM_STRUCTURED: '1',
    JVM_WASM_JIT_WARMUP: '1',
    JVM_WASM_DIRECT_STATIC_LINK: undefined,
  });
  const classpath = compileJavaFixture(t, 'GroupDrive', SOURCE);
  const interpreter = await bootJvm(classpath, { jit: { enabled: false } });
  const expected = await driveOnce(interpreter, 'drive', 120);
  const jitted = await bootJvm(classpath, { jit: { compileWorker: false, warmupThreshold: 10 } });
  t.equal(await driveOnce(jitted, 'drive', 120), expected, 'the group agrees with the interpreter');
  const ping = await stateOf(jitted.jvm, 'GroupA', 'ping', '(II)I');
  t.equal(ping && ping.status, 'ready', 'ping reached the wasm tier');
  const census = jitted.jvm.jit.wasmJit.linker.census();
  t.equal(census.sealed, 0, `nothing sealed without direct links (${JSON.stringify(census)})`);
  t.end();
});
