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
// Wasm work counts: how many sites emitted a direct wasm->wasm link, and how
// many calls still crossed into the generic JS dispatch bridge during the
// measured rounds. Opt-in, because counting bridge entries adds a JS
// increment to every bridge call -- a cost the arm that avoids the bridge
// does not pay, which would bias exactly the comparison it is there to
// explain. A run with counters on reports `wasmCounters: true` and is a
// diagnostic run, never acceptance timing.
const wasmCounters = process.env.INTERMETHOD_WASM_COUNTERS === '1';
// Java-level calls each iteration of a shape performs, from the fixture:
// runStatic calls the eight steps; runVirtual/runInterface call apply, which
// calls chain, which calls the eight steps.
const CALLS_PER_ITERATION = { monolith: 0, static: 8, virtual: 10, interface: 10 };
const className = 'IntermethodCallBenchmark';
const workerType = 'IntermethodCallBenchmark$Worker';
const allShapes = [
  { name: 'monolith', method: 'runMonolith', descriptor: '(II)I', object: false },
  { name: 'static', method: 'runStatic', descriptor: '(II)I', object: false },
  { name: 'virtual', method: 'runVirtual',
    descriptor: '(LIntermethodCallBenchmark$VirtualWorker;II)I', object: true },
  { name: 'interface', method: 'runInterface',
    descriptor: '(LIntermethodCallBenchmark$InterfaceWorker;II)I', object: true },
];
// INTERMETHOD_SHAPES selects and orders the shapes, so one shape can be
// measured alone and shape ordering effects can be tested without editing
// this file.
const shapes = (process.env.INTERMETHOD_SHAPES || '')
  .split(',').map((entry) => entry.trim()).filter(Boolean)
  .map((name) => {
    const shape = allShapes.find((entry) => entry.name === name);
    if (!shape) throw new Error(`unknown shape ${name}`);
    return shape;
  });
if (!shapes.length) shapes.push(...allShapes);

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
    if (!match || !byName.has(match[1])) continue;
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
    // Match the production renderer pipeline. Without this explicit setting,
    // the benchmark measures the legacy baseline generator for call-only
    // numeric loops and mislabels that result as the current JavaScript JIT.
    structuredSsa: tier === 'javascript',
    profileMethods: profileJit,
  } });
  if (previousWasm === undefined) delete process.env.JVM_WASM_JIT;
  else process.env.JVM_WASM_JIT = previousWasm;
  // The generic instance-dispatch bridge reads this map when a site is
  // emitted, so it has to exist before anything compiles.
  if (tier === 'wasm' && wasmCounters) jvm.jit.wasmJit.siteStats = new Map();
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
    if (generated) out[method.name] = generated.jvmStructuredSsa
      ? 'structured' : generated.jvmSynchronous ? 'baseline' : 'async';
    return out;
  }, {});
}

// Sites that emitted a direct wasm->wasm link, over every module built for
// this run -- the caller's own instance sites and its callees' alike.
function directLinkTotal(runtime) {
  let total = 0;
  for (const state of runtime.jvm.jit.wasmJit.compiled) {
    total += (state.meta && state.meta.directLinks) || 0;
  }
  return total;
}

// Entries into the generic JS dispatch bridge, summed over every instance
// site. Zero without INTERMETHOD_WASM_COUNTERS, which is what allocates the
// map the bridge counts into.
function bridgeCallTotal(runtime) {
  const stats = runtime.jvm.jit.wasmJit.siteStats;
  if (!stats) return 0;
  let total = 0;
  for (const entry of stats.values()) total += entry.calls;
  return total;
}

// Static sites lowered to a direct wasm->wasm link. Counted separately from
// directLinks: a static site has no per-call fallback arm, so its emission
// count IS its crossing count, while an instance site keeps the generic
// dispatch import for every receiver its guard refuses.
function directStaticLinkTotal(runtime) {
  let total = 0;
  for (const state of runtime.jvm.jit.wasmJit.compiled) {
    total += (state.meta && state.meta.directStaticLinks) || 0;
  }
  return total;
}

function directInlineSiteCount(runtime) {
  const classData = runtime.jvm.classes[className];
  return classData.ast.classes[0].items
    .filter((item) => item.type === 'method')
    .map((item) => runtime.jvm.jit.codegenCache.get(item.method))
    .filter(Boolean)
    .reduce((total, generated) => total + (generated.jvmDirectInlineCount || 0), 0);
}

let effectiveLinkFlags = null;

async function tierResults(directory, tier) {
  const runtime = await createRuntime(directory, tier);
  if (!effectiveLinkFlags) {
    const wasmJit = runtime.jvm.jit.wasmJit;
    effectiveLinkFlags = {
      directInstanceLink: !!wasmJit.directInstanceLinkEnabled,
      directStaticLink: !!wasmJit.directStaticLinkEnabled,
    };
  }
  const results = [];
  for (const shape of shapes) {
    let last;
    for (let warmup = 0; warmup < warmups; warmup++) {
      last = await invoke(runtime, shape, iterations, 123 + warmup);
    }
    const generatedRunsBefore = runtime.jvm.jit.syncGeneratedRunCount;
    const inlinedCallsBefore = runtime.jvm.jit.syncInlinedCallCount;
    const runnerRunsBefore = runtime.jvm.jit.runnerRunCount;
    const safePointsBefore = runtime.jvm.jit.structuredSsa.safePointCount;
    const structuredRunsBefore = runtime.jvm.jit.structuredSsa.totalRunCount;
    const bridgeCallsBefore = bridgeCallTotal(runtime);
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
        // How much of the measured region ran in the bytecode interpreter
        // rather than in the generated body, and how often the structured
        // body suspended: a tier that is compiled is not a tier that runs.
        summary.measuredRunnerRuns = runtime.jvm.jit.runnerRunCount - runnerRunsBefore;
        summary.measuredSafePoints =
          runtime.jvm.jit.structuredSsa.safePointCount - safePointsBefore;
        summary.measuredStructuredRuns =
          runtime.jvm.jit.structuredSsa.totalRunCount - structuredRunsBefore;
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
        // Direct wasm->wasm links across every module this shape reaches:
        // the caller's own sites plus its callees'. A link is emitted, not
        // executed -- measuredBridgeCalls below is what says which path ran.
        directLinks: directLinkTotal(runtime),
        directStaticLinks: directStaticLinkTotal(runtime),
      } : null;
      summary.callsPerIteration = CALLS_PER_ITERATION[shape.name] ?? null;
      if (wasmCounters && summary.wasm) {
        const bridged = bridgeCallTotal(runtime) - bridgeCallsBefore;
        summary.wasm.measuredBridgeCalls = bridged;
        summary.wasm.bridgeCallsPerIteration = bridged / (iterations * rounds);
      }
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

// INTERMETHOD_TIERS narrows the run to the tiers under investigation, so a
// profile of one tier is not dominated by the other arms (the native arm is a
// `java` subprocess). Dropping `native` drops the checksum oracle with it, so
// the report says so.
const tiers = (process.env.INTERMETHOD_TIERS || 'native,javascript,wasm')
  .split(',').map((entry) => entry.trim()).filter(Boolean);

(async () => {
  const directory = compileFixture();
  try {
    const native = tiers.includes('native') ? nativeResults(directory) : [];
    const javascript = tiers.includes('javascript')
      ? await tierResults(directory, 'javascript') : [];
    const wasm = tiers.includes('wasm') ? await tierResults(directory, 'wasm') : [];
    const nativeByName = new Map(native.map((row) => [row.name, row]));
    for (const rows of [javascript, wasm]) {
      for (const row of rows) {
        const reference = nativeByName.get(row.name);
        if (!reference) continue;
        if (row.checksum !== reference.checksum) {
          throw new Error(`${row.name} checksum mismatch: ${row.checksum} !== ${reference.checksum}`);
        }
        row.slowdownVsNative = row.nanosecondsPerIteration /
          reference.nanosecondsPerIteration;
      }
    }
    process.stdout.write(`${JSON.stringify({
      node: process.version,
      java: javaVersion(),
      iterations, rounds, warmups, profileJit, tiers,
      checksumOracle: tiers.includes('native'),
      wasmCounters,
      ...(effectiveLinkFlags || {}),
      native, javascript, wasm,
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
