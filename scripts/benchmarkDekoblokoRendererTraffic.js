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
const source = path.join(root, 'benchmarks', 'DekoblokoRendererTrafficBenchmark.java');
const className = 'DekoblokoRendererTrafficBenchmark';
const modelClass = `${className}$Model`;
const invocations = positiveInteger('DEKOBLOKO_TRAFFIC_INVOCATIONS', 10);
const passes = positiveInteger('DEKOBLOKO_TRAFFIC_PASSES', 2);
const rounds = positiveInteger('DEKOBLOKO_TRAFFIC_ROUNDS', 5);
const warmups = positiveInteger('DEKOBLOKO_TRAFFIC_WARMUPS', 3);
const trafficUnits = 192;
const copyCallsPerUnit = 22;
const width = 512;
const height = 256;
const bufferSize = 16384;
const descriptor = `(L${modelClass};II)I`;
const shapes = [
  { name: 'spans', method: 'benchmarkSpans',
    operations: invocations * passes * trafficUnits,
    trafficUnits: invocations * passes * trafficUnits },
  { name: 'copies', method: 'benchmarkCopies',
    operations: invocations * passes * trafficUnits * copyCallsPerUnit,
    trafficUnits: invocations * passes * trafficUnits },
  { name: 'composed', method: 'renderTraffic',
    operations: invocations * passes * trafficUnits * (copyCallsPerUnit + 1),
    trafficUnits: invocations * passes * trafficUnits },
];
const tiers = [
  { name: 'generated', jit: { scalarLoops: false, scalarGuestBodies: false,
    structuredSsa: false, fusedRegions: false } },
  { name: 'scalar', jit: { scalarLoops: true, scalarGuestBodies: true,
    scalarSsaOptimizations: false, structuredSsa: false, fusedRegions: false } },
  { name: 'structured', jit: { scalarLoops: true, scalarGuestBodies: true,
    scalarSsaOptimizations: false, structuredSsa: true, fusedRegions: false } },
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-dekobloko-renderer-traffic-'));
  execFileSync('javac', ['-source', '8', '-target', '8', '-d', directory, source], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return directory;
}

function summarize(shape, elapsed, checksum) {
  const medianNs = median(elapsed);
  return {
    name: shape.name,
    rounds: elapsed.length,
    operations: shape.operations,
    trafficUnits: shape.trafficUnits,
    medianMs: medianNs / 1e6,
    nanosecondsPerOperation: medianNs / shape.operations,
    nanosecondsPerTrafficUnit: medianNs / shape.trafficUnits,
    operationsPerSecond: shape.operations * 1e9 / medianNs,
    checksum,
  };
}

function nativeResults(directory) {
  const output = execFileSync('java', ['-Xbatch', '-cp', directory, className,
    String(invocations), String(passes), String(rounds), String(warmups)], { encoding: 'utf8' });
  const elapsed = new Map(shapes.map((shape) => [shape.name, []]));
  const checksums = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^RESULT (\w+) (\d+) (-?\d+)$/.exec(line);
    if (!match || !elapsed.has(match[1])) continue;
    elapsed.get(match[1]).push(Number(match[2]));
    checksums.set(match[1], Number(match[3]));
  }
  return shapes.map((shape) => summarize(shape, elapsed.get(shape.name), checksums.get(shape.name)));
}

function intArray(length, initialize) {
  const result = Array.from({ length }, (_unused, index) => initialize(index) | 0);
  result.type = '[I';
  return result;
}

function createHeap() {
  return {
    model: { type: modelClass, fields: {
      [`${modelClass}.buckets`]: intArray(bufferSize,
        (index) => Math.imul(index, 0x45d9f3b) ^ (index >>> 3)),
    } },
    pixels: intArray(width * height, () => 0),
  };
}

function installStaticFields(runtime, pixels) {
  const fields = runtime.jvm.classes[className].staticFields;
  fields.set('clipLeft:I', 0);
  fields.set('clipRight:I', width);
  fields.set('clipTop:I', 0);
  fields.set('clipBottom:I', height);
  fields.set('surfaceWidth:I', width);
  fields.set('pixels:[I', pixels);
}

async function createRuntime(directory, tier) {
  const jvm = new JVM({ classpath: [directory], jit: {
    warmupThreshold: 0,
    preferWholeMethodJs: true,
    profileMethods: false,
    ...tier.jit,
  } });
  for (const name of [className, modelClass]) {
    const classData = await jvm.loadClassByName(name);
    if (!classData.staticFields) classData.staticFields = new Map();
    classData.staticFieldsInitialized = true;
    jvm.classInitializationState.set(name, 'INITIALIZED');
  }
  const thread = {
    id: 1, name: `dekobloko-traffic-${tier.name}`, status: 'runnable',
    pendingException: null, callStack: new Stack(),
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const methods = new Map();
  for (const shape of shapes) {
    methods.set(shape.name, await jvm.findMethodInHierarchy(className, shape.method, descriptor));
  }
  const copyMethod = await jvm.findMethodInHierarchy(className, 'copyInts', '([II[III)V');
  const spanMethod = await jvm.findMethodInHierarchy(className, 'fillSpan', '(IIII)V');
  return {
    jvm, thread, methods, model: null,
    copyIntrinsicRecognized: Boolean(jvm.jit.getSynchronousIntrinsic(copyMethod, '([II[III)V')),
    spanIntrinsicRecognized: Boolean(jvm.jit.getSynchronousIntrinsic(spanMethod, '(IIII)V')),
  };
}

function sentinelFrame() {
  return new Frame({ name: 'sentinel', descriptor: '()V', attributes: [{
    type: 'code', code: { codeItems: [{ labelDef: 'L0:', instruction: 'return' }],
      localsSize: '0', stackSize: '1', exceptionTable: [] },
  }] });
}

async function invoke(runtime, shape, seed) {
  const caller = sentinelFrame();
  const frame = new Frame(runtime.methods.get(shape.name));
  frame.className = className;
  frame.locals[0] = runtime.model;
  frame.locals[1] = passes;
  frame.locals[2] = seed | 0;
  runtime.thread.status = 'runnable';
  runtime.thread.callStack.push(caller);
  runtime.thread.callStack.push(frame);
  let ticks = 0;
  while (runtime.thread.callStack.size() > 1) {
    await runtime.jvm.executeTick();
    if (++ticks > 1000000) throw new Error(`${shape.name} exceeded the scheduler tick limit`);
  }
  const value = caller.stack.pop() | 0;
  runtime.thread.callStack.pop();
  return value;
}

function compiledKinds(runtime) {
  const result = {};
  for (const item of runtime.jvm.classes[className].ast.classes[0].items) {
    if (item.type !== 'method') continue;
    const generated = runtime.jvm.jit.codegenCache.get(item.method);
    if (!generated) continue;
    result[item.method.name] = generated.jvmStructuredSsa ? 'structured'
      : generated.jvmScalarLoop ? 'scalar' : generated.jvmSynchronous ? 'generated' : 'async';
  }
  return result;
}

function compiledCode(runtime) {
  const result = {};
  for (const item of runtime.jvm.classes[className].ast.classes[0].items) {
    if (item.type !== 'method') continue;
    const generated = runtime.jvm.jit.codegenCache.get(item.method);
    const sourceText = generated?.jvmStructuredSource;
    if (!sourceText) continue;
    result[item.method.name] = {
      bytes: Buffer.byteLength(sourceText),
      synchronousCallSites: (sourceText.match(/helpers\.tryInvokeSyncAt/g) || []).length,
      materializations: (sourceText.match(/helpers\.materialize/g) || []).length,
    };
  }
  return result;
}

async function tierResults(directory, tier) {
  const runtime = await createRuntime(directory, tier);
  const results = [];
  for (const shape of shapes) {
    const heap = createHeap();
    runtime.model = heap.model;
    installStaticFields(runtime, heap.pixels);
    for (let warmup = 0; warmup < warmups; warmup++) {
      for (let call = 0; call < invocations; call++) {
        await invoke(runtime, shape, 123 + warmup + call);
      }
    }
    const elapsed = [];
    let checksum = 0;
    const structuredBefore = runtime.jvm.jit.structuredSsa.runCount;
    const scalarBefore = runtime.jvm.jit.scalarLoopRunCount;
    for (let round = 0; round < rounds; round++) {
      const started = process.hrtime.bigint();
      checksum = 0;
      for (let call = 0; call < invocations; call++) {
        checksum ^= await invoke(runtime, shape, 0x12345678 + round + call);
      }
      elapsed.push(Number(process.hrtime.bigint() - started));
    }
    const summary = summarize(shape, elapsed, checksum);
    summary.structuredEntries = runtime.jvm.jit.structuredSsa.runCount - structuredBefore;
    summary.scalarEntries = runtime.jvm.jit.scalarLoopRunCount - scalarBefore;
    summary.compiledMethods = compiledKinds(runtime);
    summary.structuredCode = compiledCode(runtime);
    summary.copyIntrinsicRecognized = runtime.copyIntrinsicRecognized;
    summary.spanIntrinsicRecognized = runtime.spanIntrinsicRecognized;
    results.push(summary);
  }
  return results;
}

function javaVersion() {
  const result = spawnSync('java', ['-version'], { encoding: 'utf8' });
  return (result.stderr || result.stdout || '').split(/\r?\n/, 1)[0];
}

(async () => {
  const directory = compileFixture();
  try {
    const hotspot = nativeResults(directory);
    const hotspotByName = new Map(hotspot.map((row) => [row.name, row]));
    const results = {};
    for (const tier of tiers) {
      results[tier.name] = await tierResults(directory, tier);
      for (const row of results[tier.name]) {
        const native = hotspotByName.get(row.name);
        if (row.checksum !== native.checksum) {
          throw new Error(`${tier.name}/${row.name} checksum ${row.checksum} !== ${native.checksum}`);
        }
        row.slowdownVsHotSpot = row.nanosecondsPerOperation / native.nanosecondsPerOperation;
      }
    }
    process.stdout.write(`${JSON.stringify({
      node: process.version,
      java: javaVersion(),
      invocations, passes, rounds, warmups,
      trafficUnits,
      copyCallsPerUnit,
      observedFirefoxRatio: {
        primitiveCopiesPer20Changes: 1096656,
        spanFillsPer20Changes: 48951,
        copiesPerSpan: 1096656 / 48951,
      },
      features: [
        'clipped static int[] span fills',
        'overlap-safe eight-way-unrolled primitive copies',
        '22 copy calls per synthetic traffic unit',
        'nested composed callers',
        'structurally verified intrinsic call sites',
      ],
      hotspot,
      ...results,
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
