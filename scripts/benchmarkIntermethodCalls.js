#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'benchmarks', 'IntermethodCallBenchmark.java');
const iterations = positiveInteger('INTERMETHOD_ITERATIONS', 50000);
const rounds = positiveInteger('INTERMETHOD_ROUNDS', 5);
const warmups = positiveInteger('INTERMETHOD_WARMUPS', 3);
const profileJit = process.env.INTERMETHOD_PROFILE_JIT === '1';
const className = 'IntermethodCallBenchmark';
const workerType = 'IntermethodCallBenchmark$Worker';
const shapes = [
  { name: 'monolith', method: 'runMonolith', descriptor: '(II)I', object: false },
  { name: 'static', method: 'runStatic', descriptor: '(II)I', object: false },
  { name: 'virtual', method: 'runVirtual',
    descriptor: '(LIntermethodCallBenchmark$VirtualWorker;II)I', object: true },
  { name: 'interface', method: 'runInterface',
    descriptor: '(LIntermethodCallBenchmark$InterfaceWorker;II)I', object: true },
];

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function compileFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-intermethod-'));
  execFileSync('javac', ['-source', '8', '-target', '8', '-d', directory, source], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return directory;
}

function nativeResults(directory) {
  const output = execFileSync('java', [
    '-Xbatch', '-cp', directory, className, String(iterations), String(rounds), String(warmups),
  ], { encoding: 'utf8' });
  const byName = new Map(shapes.map((shape) => [shape.name, []]));
  const checksums = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^RESULT (\w+) (\d+) (\d+) (-?\d+)$/.exec(line);
    if (!match) continue;
    byName.get(match[1]).push(Number(match[3]));
    checksums.set(match[1], Number(match[4]));
  }
  return shapes.map((shape) => summarize(shape.name, iterations, byName.get(shape.name),
    checksums.get(shape.name)));
}

async function createRuntime(directory, tier) {
  const previousWasm = process.env.JVM_WASM_JIT;
  if (tier === 'wasm') process.env.JVM_WASM_JIT = '1';
  else delete process.env.JVM_WASM_JIT;
  const jvm = new JVM({ classpath: [directory], jit: {
    enabled: tier !== 'wasm',
    warmupThreshold: 0,
    preferWholeMethodJs: tier === 'javascript',
    profileMethods: profileJit,
  } });
  if (previousWasm === undefined) delete process.env.JVM_WASM_JIT;
  else process.env.JVM_WASM_JIT = previousWasm;
  for (const name of [className, `${className}$VirtualWorker`,
    `${className}$InterfaceWorker`, workerType]) {
    const classData = await jvm.loadClassByName(name);
    if (!classData.staticFields) classData.staticFields = new Map();
    classData.staticFieldsInitialized = true;
    jvm.classInitializationState.set(name, 'INITIALIZED');
  }
  const thread = {
    id: 1, name: `intermethod-${tier}`, status: 'runnable',
    pendingException: null, callStack: new Stack(),
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return { jvm, thread, worker: { type: workerType, fields: {} } };
}

function sentinelFrame() {
  return new Frame({ name: 'sentinel', descriptor: '()V', attributes: [{
    type: 'code', code: { codeItems: [{ labelDef: 'L0:', instruction: 'return' }],
      localsSize: '0', stackSize: '1', exceptionTable: [] },
  }] });
}

async function invoke(runtime, shape, count, seed) {
  const method = await runtime.jvm.findMethodInHierarchy(
    className, shape.method, shape.descriptor);
  const caller = sentinelFrame();
  const frame = new Frame(method);
  frame.className = className;
  const args = shape.object ? [runtime.worker, count, seed] : [count, seed];
  args.forEach((value, index) => { frame.locals[index] = value; });
  runtime.thread.status = 'runnable';
  runtime.thread.callStack.push(caller);
  runtime.thread.callStack.push(frame);
  let ticks = 0;
  while (runtime.thread.callStack.size() > 1) {
    await runtime.jvm.executeTick();
    if (++ticks > count * 500 + 100000) {
      const activeFrames = runtime.thread.callStack.items;
      const active = activeFrames.map((item) =>
        `${item.className || '?'}.${item.method.name}${item.method.descriptor}@${item.pc}`).join(' -> ');
      const compileErrors = activeFrames.map((item) => {
        const error = runtime.jvm.jit.codegenCompileErrors.get(item.method);
        return error ? `${item.method.name}${item.method.descriptor}: ${error.message}` : null;
      }).filter(Boolean).join('; ');
      throw new Error(`${tierLabel(runtime)} ${shape.name} tick limit; frames=${active}; ` +
        `compileErrors=${compileErrors || 'none'}`);
    }
  }
  const value = caller.stack.pop();
  runtime.thread.callStack.pop();
  return { value: value | 0, method };
}

function tierLabel(runtime) {
  return runtime.jvm.jit.wasmJit.enabled ? 'wasm' : 'javascript';
}

function summarize(name, count, elapsed, checksum) {
  const medianNs = median(elapsed);
  return {
    name, iterations: count, rounds: elapsed.length,
    medianMs: medianNs / 1e6,
    nanosecondsPerIteration: medianNs / count,
    iterationsPerSecond: count * 1e9 / medianNs,
    checksum,
  };
}

function callSiteTargetKinds(jit) {
  const counts = { inlined: 0, generated: 0, intrinsic: 0, unresolved: 0 };
  for (const site of jit.syncCallSites.filter(Boolean)) {
    const targets = [...site.targets.values()];
    if (!targets.length) counts.unresolved += 1;
    for (const target of targets) {
      if (target.inlineIntegerRegion) counts.inlined += 1;
      else if (target.intrinsic) counts.intrinsic += 1;
      else if (target.generated) counts.generated += 1;
      else counts.unresolved += 1;
    }
  }
  return counts;
}

function compiledMethodKinds(runtime) {
  const classData = runtime.jvm.classes[className];
  const methods = classData.ast.classes[0].items
    .filter((item) => item.type === 'method').map((item) => item.method);
  return methods.reduce((out, method) => {
    const generated = runtime.jvm.jit.codegenCache.get(method);
    if (generated) out[method.name] = generated.jvmSynchronous ? 'sync' : 'async';
    return out;
  }, {});
}

function directInlineSiteCount(runtime) {
  const classData = runtime.jvm.classes[className];
  return classData.ast.classes[0].items
    .filter((item) => item.type === 'method')
    .map((item) => runtime.jvm.jit.codegenCache.get(item.method))
    .filter(Boolean)
    .reduce((total, generated) => total + (generated.jvmDirectInlineCount || 0), 0);
}

async function tierResults(directory, tier) {
  const runtime = await createRuntime(directory, tier);
  const results = [];
  for (const shape of shapes) {
    let last;
    for (let warmup = 0; warmup < warmups; warmup++) {
      last = await invoke(runtime, shape, iterations, 123 + warmup);
    }
    const generatedRunsBefore = runtime.jvm.jit.syncGeneratedRunCount;
    const inlinedCallsBefore = runtime.jvm.jit.syncInlinedCallCount;
    const elapsed = [];
    for (let round = 0; round < rounds; round++) {
      const started = process.hrtime.bigint();
      last = await invoke(runtime, shape, iterations, 0x12345678 + round);
      elapsed.push(Number(process.hrtime.bigint() - started));
    }
    const summary = summarize(shape.name, iterations, elapsed, last.value);
    if (tier === 'javascript') {
      if (profileJit) {
        const key = `${className}.${shape.method}${shape.descriptor}`;
        summary.generatedRuns = runtime.jvm.jit.generatedMethodRunCounts.get(key) || 0;
        summary.measuredInlinedCalls = runtime.jvm.jit.syncInlinedCallCount - inlinedCallsBefore;
        summary.measuredGeneratedCalls = runtime.jvm.jit.syncGeneratedRunCount - generatedRunsBefore;
      }
      summary.callSiteTargets = callSiteTargetKinds(runtime.jvm.jit);
      summary.compiledMethods = compiledMethodKinds(runtime);
      summary.directInlineSites = directInlineSiteCount(runtime);
    } else {
      const state = runtime.jvm.jit.wasmJit.state.get(last.method);
      summary.wasm = state ? {
        status: state.status,
        runs: state.runs,
        exits: state.exits,
        fuelExits: state.fuelExits,
        reason: state.failReason || null,
        supportedBlocks: state.meta?.supportedBlocks?.size || 0,
        blocks: state.meta?.blockCount || 0,
      } : null;
    }
    results.push(summary);
  }
  return results;
}

function javaVersion() {
  const result = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (result.error) return result.error.message;
  return (result.stderr || result.stdout || '').split(/\r?\n/, 1)[0];
}

(async () => {
  const directory = compileFixture();
  try {
    const native = nativeResults(directory);
    const javascript = await tierResults(directory, 'javascript');
    const wasm = await tierResults(directory, 'wasm');
    const nativeByName = new Map(native.map((row) => [row.name, row]));
    for (const rows of [javascript, wasm]) {
      for (const row of rows) {
        const expected = nativeByName.get(row.name).checksum;
        if (row.checksum !== expected) {
          throw new Error(`${row.name} checksum mismatch: ${row.checksum} !== ${expected}`);
        }
        row.slowdownVsNative = row.nanosecondsPerIteration /
          nativeByName.get(row.name).nanosecondsPerIteration;
      }
    }
    process.stdout.write(`${JSON.stringify({
      node: process.version,
      java: javaVersion(),
      iterations, rounds, warmups, profileJit,
      native, javascript, wasm,
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
