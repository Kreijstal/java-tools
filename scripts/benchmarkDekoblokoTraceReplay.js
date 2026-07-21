#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const tracePath = path.resolve(process.argv[2] || process.env.DEKOBLOKO_TRACE || '');
const classpath = path.resolve(process.argv[3] || process.env.DEKOBLOKO_CLASSES || '');
const iterations = positiveInteger('DEKOBLOKO_REPLAY_ITERATIONS', 40);
const rounds = positiveInteger('DEKOBLOKO_REPLAY_ROUNDS', 5);
const warmups = positiveInteger('DEKOBLOKO_REPLAY_WARMUPS', 2);
const profileMethods = process.env.DEKOBLOKO_REPLAY_PROFILE === '1';
const structuredIrreducibleSplitting =
  process.env.DEKOBLOKO_REPLAY_STRUCTURED_SPLIT === '1';

if (!fs.statSync(tracePath, { throwIfNoEntry: false })?.isFile() ||
    !fs.statSync(classpath, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('Usage: node scripts/benchmarkDekoblokoTraceReplay.js <trace.json> <class-directory>');
  process.exit(2);
}

const tiers = [
  { name: 'generated', jit: { scalarLoops: false, scalarGuestBodies: false,
    structuredSsa: false, fusedRegions: false } },
  { name: 'scalar', jit: { scalarLoops: true, scalarGuestBodies: true,
    scalarSsaOptimizations: false, structuredSsa: false, fusedRegions: false } },
  { name: 'structured', jit: { rendererPipeline: true,
    scalarSsaOptimizations: false, structuredIrreducibleSplitting } },
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

function ranked(map, limit = 20) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function methodKey(jvm, frame) {
  return `${frame.className || jvm.findClassNameForMethod(frame.method)}.` +
    `${frame.method.name}${frame.method.descriptor}`;
}

function describeMethod(jvm, method) {
  const items = jvm.jit.getCodeItems(method);
  const opcodes = new Map();
  let instructions = 0;
  let invokes = 0;
  let fields = 0;
  let arrays = 0;
  let allocations = 0;
  let branches = 0;
  for (const item of items) {
    const instruction = item?.instruction;
    const op = typeof instruction === 'string' ? instruction : instruction?.op;
    if (!op) continue;
    instructions += 1;
    opcodes.set(op, (opcodes.get(op) || 0) + 1);
    if (op.startsWith('invoke')) invokes += 1;
    if (op.endsWith('field') || op.endsWith('static')) fields += 1;
    if (/^[a-z]aload$/.test(op) || /^[a-z]astore$/.test(op) || op === 'arraylength') arrays += 1;
    if (op === 'new' || op === 'newarray' || op === 'anewarray' || op === 'multianewarray') {
      allocations += 1;
    }
    if (op === 'goto' || op.startsWith('if') || op === 'tableswitch' || op === 'lookupswitch') {
      branches += 1;
    }
  }
  const code = method.attributes.find((attribute) => attribute.type === 'code');
  return {
    instructions,
    distinctOpcodes: opcodes.size,
    invokes,
    fields,
    arrayAccesses: arrays,
    allocations,
    branches,
    backwardBranch: jvm.jit.hasBackwardBranch(method),
    exceptionHandlers: code?.code?.exceptionTable?.length || 0,
    topOpcodes: ranked(opcodes, 20),
  };
}

function arrayData(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.elements) || ArrayBuffer.isView(value.elements)) return value.elements;
  if (ArrayBuffer.isView(value)) return value;
  return null;
}

function hashArray(value) {
  const data = arrayData(value);
  if (!data) return null;
  let hash = 2166136261;
  for (let index = 0; index < data.length; index += 1) {
    hash = Math.imul(hash ^ (Number(data[index]) | 0), 16777619) >>> 0;
  }
  return { length: data.length, hash };
}

function mixString(hash, value) {
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
  }
  return hash;
}

function hashStaticScalarsAndPrimitiveArrays(jvm) {
  let hash = 2166136261;
  let fields = 0;
  for (const [className, classData] of Object.entries(jvm.classes).sort(([a], [b]) =>
    a.localeCompare(b))) {
    if (!(classData?.staticFields instanceof Map)) continue;
    const entries = [...classData.staticFields.entries()].sort(([a], [b]) =>
      String(a).localeCompare(String(b)));
    for (const [key, value] of entries) {
      const descriptor = String(key).slice(String(key).lastIndexOf(':') + 1);
      const scalar = /^[ZBCSIJFD]$/.test(descriptor);
      const primitiveArray = /^\[[ZBCSIJFD]$/.test(descriptor);
      if (!scalar && !primitiveArray) continue;
      fields += 1;
      hash = mixString(hash, `${className}.${key}`);
      if (primitiveArray) {
        const data = arrayData(value) || [];
        hash = Math.imul(hash ^ data.length, 16777619) >>> 0;
        for (const item of data) {
          hash = mixString(hash, typeof item === 'bigint' ? item.toString() : String(item));
        }
      } else {
        hash = mixString(hash, typeof value === 'bigint' ? value.toString() : String(value));
      }
    }
  }
  return { fields, hash };
}

function findSurface(jvm) {
  const candidates = [];
  for (const classData of Object.values(jvm.classes)) {
    for (const item of classData?.ast?.classes?.[0]?.items || []) {
      if (item.type !== 'method' || item.method.descriptor !== '(IIII)V') continue;
      const intrinsic = jvm.jit.getSynchronousIntrinsic(item.method, '(IIII)V');
      if (intrinsic?.jvmDirectKind !== 'clippedStaticSpan') continue;
      const pixelsField = intrinsic.jvmDirectData?.staticFields?.[5];
      if (!pixelsField) continue;
      const pixels = jvm.jit.getStaticSync(pixelsField);
      const data = arrayData(pixels);
      if (data) candidates.push({ pixels, length: data.length, field: pixelsField });
    }
  }
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || null;
}

async function createRuntime(trace, tier) {
  const jvm = new JVM({ classpath: [classpath], jit: {
    warmupThreshold: 0,
    preferWholeMethodJs: true,
    profileMethods,
    structuredIrreducibleSplitting,
    ...tier.jit,
  } });
  trace.state.classpath = [classpath];
  await jvm.loadState(trace.state);
  const restoredFrames = jvm.threads.flatMap((thread) => thread.callStack.items
    .map((frame) => ({ thread, frame })));
  const restored = restoredFrames.find(({ frame }) => methodKey(jvm, frame) === trace.methodKey);
  if (!restored) throw new Error(`Trace does not contain entry frame ${trace.methodKey}`);
  const className = restored.frame.className || jvm.findClassNameForMethod(restored.frame.method);
  const method = restored.frame.method;
  const locals = restored.frame.locals.slice();
  const thread = {
    id: restored.thread.id,
    name: `trace-replay-${tier.name}`,
    status: 'runnable',
    pendingException: null,
    callStack: new Stack(),
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return { jvm, thread, className, method, locals, surface: findSurface(jvm),
    schedulerFrames: new Map(), schedulerSites: new Map() };
}

async function invoke(runtime) {
  const frame = new Frame(runtime.method);
  frame.className = runtime.className;
  frame.locals = runtime.locals.slice();
  runtime.thread.status = 'runnable';
  runtime.thread.pendingException = null;
  runtime.thread.callStack.push(frame);
  let ticks = 0;
  while (!runtime.thread.callStack.isEmpty()) {
    if (profileMethods) {
      const active = runtime.thread.callStack.peek();
      const key = methodKey(runtime.jvm, active);
      const instruction = active.instructions?.[active.pc]?.instruction;
      const op = typeof instruction === 'string' ? instruction : instruction?.op || '<none>';
      runtime.schedulerFrames.set(key, (runtime.schedulerFrames.get(key) || 0) + 1);
      const site = `${key}@${active.pc}:${op}`;
      runtime.schedulerSites.set(site, (runtime.schedulerSites.get(site) || 0) + 1);
    }
    const result = await runtime.jvm.executeTick();
    if (result.completed && !runtime.thread.callStack.isEmpty()) {
      throw new Error(`Replay terminated early in ${runtime.className}.${runtime.method.name}`);
    }
    // Mirror the production driver (JVM.execute): once the wall-clock yield
    // deadline passes, control returns to the host event loop and the deadline
    // is re-armed. Without this the deadline expires once and safe points
    // behave as if the host loop were permanently starved.
    if (Date.now() >= runtime.jvm._nextEventLoopYieldAt) {
      await new Promise((resolve) => setImmediate(resolve));
      runtime.jvm._nextEventLoopYieldAt = Date.now() + runtime.jvm.eventLoopYieldMs;
    }
    if (++ticks > 1000000) throw new Error('Replay exceeded scheduler tick limit');
  }
  if (runtime.thread.pendingException) {
    throw new Error(`Replay left pending exception ${JSON.stringify(runtime.thread.pendingException)}`);
  }
  return ticks;
}

async function benchmark(trace, tier) {
  const runtime = await createRuntime(trace, tier);
  for (let warmup = 0; warmup < warmups; warmup += 1) {
    for (let iteration = 0; iteration < iterations; iteration += 1) await invoke(runtime);
  }
  const elapsed = [];
  let totalTicks = 0;
  const roundHashes = [];
  const roundStaticHashes = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = process.hrtime.bigint();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      totalTicks += await invoke(runtime);
    }
    elapsed.push(Number(process.hrtime.bigint() - started));
    roundHashes.push(hashArray(runtime.surface?.pixels));
    roundStaticHashes.push(hashStaticScalarsAndPrimitiveArrays(runtime.jvm));
  }
  const medianNs = median(elapsed);
  const generated = runtime.jvm.jit.codegenCache.get(runtime.method);
  const result = {
    name: tier.name,
    iterations,
    rounds,
    medianMs: medianNs / 1e6,
    nanosecondsPerInvocation: medianNs / iterations,
    invocationsPerSecond: iterations * 1e9 / medianNs,
    averageSchedulerTicks: totalTicks / (iterations * rounds),
    targetTier: generated?.jvmStructuredSsa ? 'structured'
      : generated?.jvmScalarLoop ? 'scalar'
        : generated?.jvmSynchronous ? 'generated-sync' : generated ? 'generated-async' : 'none',
    surfaceField: runtime.surface?.field || null,
    roundHashes,
    roundStaticHashes,
    fusedRuns: runtime.jvm.jit.fusedRunCount,
    structuredRuns: runtime.jvm.jit.structuredSsa.runCount,
    structuredSplitBlocks: generated?.jvmStructuredSplitBlocks || 0,
    scalarRuns: runtime.jvm.jit.scalarLoopRunCount,
    targetShape: describeMethod(runtime.jvm, runtime.method),
  };
  if (profileMethods) {
    result.topGeneratedEntries = ranked(runtime.jvm.jit.generatedMethodRunCounts);
    result.topDeopts = ranked(runtime.jvm.jit.methodDeoptCounts).map(([methodKey, count]) => [
      methodKey, count, runtime.jvm.jit.methodDeoptReasons.get(methodKey),
    ]);
    result.topRunnerEntries = ranked(runtime.jvm.jit.runnerMethodRunCounts);
    result.topSchedulerFrames = ranked(runtime.schedulerFrames);
    result.topSchedulerSites = ranked(runtime.schedulerSites, 40);
  }
  return result;
}

(async () => {
  const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
  if (!trace?.state || !trace.methodKey) throw new Error('Invalid Dekobloko entry trace');
  const results = [];
  for (const tier of tiers) results.push(await benchmark(trace, tier));
  const reference = JSON.stringify(results[0].roundHashes);
  const staticReference = JSON.stringify(results[0].roundStaticHashes);
  for (const result of results.slice(1)) {
    if (JSON.stringify(result.roundHashes) !== reference) {
      throw new Error(`${result.name} surface hashes differ from generated baseline`);
    }
    if (JSON.stringify(result.roundStaticHashes) !== staticReference) {
      throw new Error(`${result.name} scalar/static-array hashes differ from generated baseline`);
    }
  }
  process.stdout.write(`${JSON.stringify({
    node: process.version,
    trace: { methodKey: trace.methodKey, bytes: fs.statSync(tracePath).size },
    classpath,
    iterations,
    rounds,
    warmups,
    profileMethods,
    structuredIrreducibleSplitting,
    results,
  }, null, 2)}\n`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
