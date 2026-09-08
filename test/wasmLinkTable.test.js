'use strict';

// Runtime linker (src/jit/WasmLinker.js): a caller lowered against an
// unresolved static callee calls through a table slot, and the linker rebinds
// that slot as the callee's module comes and goes. The contract under test:
//
//   1. the caller compiles while the callee is cold, and the site is a slot;
//   2. the callee becoming ready binds the slot to its runv export -- the
//      caller artifact is untouched, the call is now wasm->wasm;
//   3. withdrawing the callee's module puts the stub back, and execution
//      stays correct through the whole cycle;
//   4. a callee that can hand the call back (partial) never binds directly,
//      and its side effects still happen exactly once per call;
//   5. with the linker off the old JS trampoline is used.
//
// The caller is compiled and ENTERED through the Wasm backend directly
// (wasm.compile / wasm.execute), the way wasmNormalFlowCalls.test.js does:
// driven through the scheduler, the JS tier can take the frame and the slot
// path is never exercised, which would make every assertion below vacuous.
//
// Fixture rule from docs/phase1-linked-call-abi.md 9: every callee must be
// too large to inline, or the site never reaches the linking path.

const test = require('tape');
const { makeJavaFixtureCompiler } = require('./javaFixture');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');
const WasmLinker = require('../src/jit/WasmLinker');

const compileJavaFixture = makeJavaFixtureCompiler('wasm-link-table-');
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

// On-demand callee compilation is off, which is the state a compile worker
// is in (it holds bytecode, not the owning runtime's tier state): a callee
// that is cold when the caller is lowered stays UNKNOWN at codegen.
async function makeHarness(t, className, source, extraEnv = {}) {
  withEnv(t, {
    JVM_WASM_JIT: '1',
    JVM_WASM_STRUCTURED: '1',
    JVM_WASM_DIRECT_STATIC_LINK: '1',
    JVM_WASM_NO_ONDEMAND_CALLEE: '1',
    ...extraEnv,
  });
  const classpath = compileJavaFixture(t, className, source);
  const jvm = new JVM({ classpath, jit: { compileWorker: false } });
  await jvm.preloadClasspathClasses();
  for (const name of Object.keys(jvm.classes)) {
    if (name.startsWith(className)) jvm.classInitializationState.set(name, 'INITIALIZED');
  }
  return jvm;
}

async function methodOf(jvm, className, name, descriptor) {
  return jvm.findMethodInHierarchy(className, name, descriptor);
}

// Enter the compiled module at pc 0 and, if it hands the frame back (a
// deopt or a parked callee), finish the activation interpreted.
async function runCompiled(jvm, wasm, st, className, method, locals) {
  const frame = new Frame(method);
  frame.className = className;
  locals.forEach((v, i) => { frame.locals[i] = v; });
  const thread = { id: 1, name: 'link-table', status: 'runnable', callStack: new CallStack() };
  thread.callStack.push(frame);
  const result = wasm.execute(frame, thread, st, 0);
  let steps = 0;
  while (!thread.callStack.isEmpty() && ++steps < 5_000_000) {
    const f = thread.callStack.peek();
    const ins = f.instructions[f.pc++].instruction;
    if (ins) await jvm.executeInstruction(ins, f, thread);
  }
  return { returned: !!(result && result.returned), interpretedSteps: steps };
}

const CALLEE_BODY = `
    int v = x * 0x9E3775 + 1;
    for (int k = 0; k < 8; k++) { v ^= v >>> 7; v += k * 0x27D4EB; v ^= v << 5; v += x; }
    return v;`;

function calleeJs(x) {
  let v = (Math.imul(x, 0x9E3775) + 1) | 0;
  for (let k = 0; k < 8; k++) {
    v ^= v >>> 7;
    v = (v + Math.imul(k, 0x27D4EB)) | 0;
    v ^= v << 5;
    v = (v + x) | 0;
  }
  return v;
}

function driveJs(n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum = (Math.imul(sum, 31) + calleeJs(i & 15)) | 0;
  return sum;
}

const SOURCE = `
public class LinkTable {
  public static int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) sum = sum * 31 + LinkTableCallee.callee(i & 15);
    out[0] = sum;
    return sum;
  }
}
class LinkTableCallee {
  static int callee(int x) {${CALLEE_BODY}
  }
}
`;

test('a late-bound site is a table slot, bound when the callee compiles and withdrawn with it', async (t) => {
  const jvm = await makeHarness(t, 'LinkTable', SOURCE);
  const wasm = jvm.jit.wasmJit;
  const linker = wasm.linker;
  t.ok(linker && linker.enabled, 'the runtime linker is on by default');
  const calleeKey = 'LinkTableCallee.callee(I)I';
  const n = 4000;
  const expected = driveJs(n);
  const out = [0];
  out.type = '[I';

  // 1. the caller compiles against a cold callee; the site is a slot
  const caller = await methodOf(jvm, 'LinkTable', 'drive', '([II)I');
  const callee = await methodOf(jvm, 'LinkTableCallee', 'callee', '(I)I');
  const callerSt = wasm.methodState({ method: caller });
  wasm.compile({ className: 'LinkTable', method: caller }, callerSt);
  t.equal(callerSt.status, 'ready', callerSt.lastCompileError || 'the caller compiled');
  const artifact = callerSt.meta;
  const binding = (artifact.linkBindings || []).find((b) => b.key === calleeKey);
  t.ok(binding && binding.lateBound, 'the callee site was lowered late-bound');
  t.equal(typeof binding.slot, 'number', `the site owns a table slot (${binding.slot})`);
  t.deepEqual(linker.slotState(calleeKey), ['stub'], 'the slot starts on the stub');
  t.equal(linker.census().slots, 1, 'discarded translations gave their slots back');
  const calleeBefore = wasm.state.get(callee);
  t.ok(!calleeBefore || calleeBefore.status !== 'ready', 'the callee is not compiled at codegen');

  // 2. the first run resolves the callee in the owning runtime; publication
  //    binds the slot and the rest of the loop runs wasm->wasm
  const first = await runCompiled(jvm, wasm, callerSt, 'LinkTable', caller, [out, n]);
  t.ok(first.returned, 'the module ran to completion');
  t.equal(out[0], expected, 'the guest result is right');
  const calleeSt = wasm.state.get(callee);
  t.equal(calleeSt && calleeSt.status, 'ready', 'the stub compiled the callee on demand');
  t.deepEqual(linker.slotState(calleeKey), ['direct'], 'the slot now holds the callee');
  t.equal(linker.table.get(binding.slot), (calleeSt.callee || calleeSt).meta.runv,
    'the table entry IS the callee\'s runv export');
  t.equal(callerSt.meta, artifact, 'the caller artifact was not recompiled to bind');

  const second = await runCompiled(jvm, wasm, callerSt, 'LinkTable', caller, [out, n]);
  t.ok(second.returned, 'the module ran to completion through the direct binding');
  t.equal(out[0], expected, 'and produced the right result');
  t.equal(callerSt.meta, artifact, 'and the caller artifact is still the same one');

  // The binding made the caller a sealed singleton group (WasmLinker.
  // sealGroups, test/wasmRecursiveGroup.test.js): its one deoptable site is
  // a slot holding a never-exits export, so the caller itself is now a
  // never-exits module others may enter directly.
  const callerMeta = artifact;
  t.ok(callerMeta.groupSealed, 'the caller was sealed once its only slot held a never-exits export');
  t.ok(WasmLinker.directLinkable(callerSt, '([II)I'), 'and satisfies the direct-link contract');

  // 3. withdrawing the callee's module PINS the sealed edge: the caller may
  //    already be entered as a never-exits module, so its slot cannot fall
  //    back to a trampoline that could deopt. The withdrawn export is still
  //    a correct compilation of the callee -- the same "correct, possibly
  //    stale" pin a dcall_ import keeps.
  const oldRunv = (calleeSt.callee || calleeSt).meta.runv;
  wasm.withdrawModule(calleeSt);
  t.deepEqual(linker.slotState(calleeKey), ['pinned'], 'the withdrawn callee\'s edge is pinned');
  t.equal(linker.table.get(binding.slot), oldRunv, 'the table entry is still the old export');
  const third = await runCompiled(jvm, wasm, callerSt, 'LinkTable', caller, [out, n]);
  t.ok(third.returned, 'the module ran to completion after the withdrawal');
  t.equal(out[0], expected, 'the guest result is right after the withdrawal');
  t.equal(calleeSt.status, 'cold', 'nothing re-entered the callee through the runtime');
  // A republished callee takes the edge back over.
  wasm.compile({ className: 'LinkTableCallee', method: callee }, calleeSt,
    { asCallee: true, entryPath: 'link-table-test' });
  const recompiled = wasm.state.get(callee);
  t.equal(recompiled && recompiled.status, 'ready', 'the callee recompiled');
  t.deepEqual(linker.slotState(calleeKey), ['direct'], 'and the slot follows the new module');
  t.equal(linker.table.get(binding.slot), (recompiled.callee || recompiled).meta.runv,
    'pointing at the NEW runv export');
  t.notEqual(linker.table.get(binding.slot), oldRunv, 'which is not the old one');
  const fourth = await runCompiled(jvm, wasm, callerSt, 'LinkTable', caller, [out, n]);
  t.ok(fourth.returned && out[0] === expected, 'and the caller runs right through it');
  t.equal(callerSt.meta, artifact, 'the caller artifact survived the whole cycle');
  const census = linker.census();
  t.equal(census.bound, 2, `two bindings in the census (${JSON.stringify(census)})`);
  t.equal(census.pinned, 1, 'one pinned withdrawal');
  t.equal(census.unbound, 0, 'and no stub revival');
  t.end();
});

test('a partial callee stays behind the stub and runs its side effects exactly once', async (t) => {
  const jvm = await makeHarness(t, 'LinkPartial', `
public class LinkPartial {
  public static int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) sum = 17 + LinkPartialCallee.callee(out, i);
    out[0] = sum;
    return sum;
  }
}
class LinkPartialCallee {
  static int callee(int[] out, int x) {
    out[1]++;
    int v = x * 0x9E3775 + 1;
    for (int k = 0; k < 8; k++) { v ^= v >>> 7; v += k * 0x27D4EB; v ^= v << 5; v += x; }
    // demoted block: a virtual call on a JRE class the backend cannot link
    if ((x & 1023) == 7) return Integer.toString(x).length() + v;
    return v;
  }
}
`);
  const wasm = jvm.jit.wasmJit;
  const linker = wasm.linker;
  const calleeKey = 'LinkPartialCallee.callee([II)I';
  const n = 3000;
  let expected = 0;
  for (let i = 0; i < n; i++) {
    expected = (17 + (((i & 1023) === 7) ? String(i).length + calleeJs(i) : calleeJs(i))) | 0;
  }
  const out = [0, 0];
  out.type = '[I';
  const caller = await methodOf(jvm, 'LinkPartial', 'drive', '([II)I');
  const callee = await methodOf(jvm, 'LinkPartialCallee', 'callee', '([II)I');
  const callerSt = wasm.methodState({ method: caller });
  wasm.compile({ className: 'LinkPartial', method: caller }, callerSt);
  t.equal(callerSt.status, 'ready', callerSt.lastCompileError || 'the caller compiled');
  const binding = (callerSt.meta.linkBindings || []).find((b) => b.key === calleeKey);
  t.ok(binding && typeof binding.slot === 'number', 'the site owns a table slot');

  await runCompiled(jvm, wasm, callerSt, 'LinkPartial', caller, [out, n]);
  t.equal(out[0], expected, 'the 17 under the call survived every deopt');
  t.equal(out[1], n, 'the callee ran exactly once per iteration');
  const calleeSt = wasm.state.get(callee);
  t.equal(calleeSt && calleeSt.status, 'ready', 'the callee compiled on demand');
  const meta = calleeSt && (calleeSt.callee || calleeSt).meta;
  t.ok(meta && !(meta.fullyCompiled && !meta.deoptableCalls),
    'and it is partial: it can hand a call back');
  t.deepEqual(linker.slotState(calleeKey), ['stub'], 'a partial callee never binds directly');

  out[1] = 0;
  await runCompiled(jvm, wasm, callerSt, 'LinkPartial', caller, [out, n]);
  t.equal(out[0], expected, 'the result is right with the callee compiled and partial');
  t.equal(out[1], n, 'the callee still ran exactly once per iteration');
  t.deepEqual(linker.slotState(calleeKey), ['stub'], 'and the slot is still the stub');
  t.end();
});

test('JVM_WASM_LINK_TABLE=0 keeps the JS trampoline', async (t) => {
  const jvm = await makeHarness(t, 'LinkTable', SOURCE, { JVM_WASM_LINK_TABLE: '0' });
  const wasm = jvm.jit.wasmJit;
  t.equal(wasm.linker, null, 'no linker');
  const n = 4000;
  const out = [0];
  out.type = '[I';
  const caller = await methodOf(jvm, 'LinkTable', 'drive', '([II)I');
  const callerSt = wasm.methodState({ method: caller });
  wasm.compile({ className: 'LinkTable', method: caller }, callerSt);
  t.equal(callerSt.status, 'ready', callerSt.lastCompileError || 'the caller compiled');
  const binding = (callerSt.meta.linkBindings || []).find((b) => b.key === 'LinkTableCallee.callee(I)I');
  t.ok(binding && binding.lateBound && binding.slot === undefined,
    'the site is late-bound through an import, not a slot');
  t.ok(callerSt.meta.importObject.env.lcall_LinkTableCallee_callee_I_I,
    'the lcall_ import is present');
  const run = await runCompiled(jvm, wasm, callerSt, 'LinkTable', caller, [out, n]);
  t.ok(run.returned, 'the module ran to completion');
  t.equal(out[0], driveJs(n), 'the result is right');
  t.end();
});
