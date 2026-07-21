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
const source = path.join(root, 'benchmarks', 'DekoblokoHotLoopBenchmark.java');
const className = 'DekoblokoHotLoopBenchmark';
const modelClass = `${className}$Model`;
const invocations = positiveInteger('DEKOBLOKO_TOY_INVOCATIONS', 100);
const passes = positiveInteger('DEKOBLOKO_TOY_PASSES', 40);
const rounds = positiveInteger('DEKOBLOKO_TOY_ROUNDS', 5);
const warmups = positiveInteger('DEKOBLOKO_TOY_WARMUPS', 3);
const vertices = 128;
const faces = 192;
const descriptor = `(L${modelClass};II)I`;
const shapes = [
  { name: 'vertices', method: 'benchmarkVertices',
    work: invocations * passes * vertices },
  { name: 'faces', method: 'benchmarkFaces',
    work: invocations * (passes * faces + vertices) },
  { name: 'combined', method: 'renderModel',
    work: invocations * passes * (vertices + faces) },
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-dekobloko-hot-loops-'));
  execFileSync('javac', ['-source', '8', '-target', '8', '-d', directory, source], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return directory;
}

function summarize(name, work, elapsed, checksum) {
  const medianNs = median(elapsed);
  return {
    name,
    rounds: elapsed.length,
    workUnits: work,
    medianMs: medianNs / 1e6,
    nanosecondsPerElement: medianNs / work,
    elementsPerSecond: work * 1e9 / medianNs,
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
  return shapes.map((shape) => summarize(shape.name, shape.work,
    elapsed.get(shape.name), checksums.get(shape.name)));
}

function intArray(length, initialize) {
  const result = Array.from({ length }, (_unused, index) => initialize(index) | 0);
  result.type = '[I';
  return result;
}

function shortArray(length, initialize) {
  const result = Array.from({ length }, (_unused, index) => (initialize(index) << 16) >> 16);
  result.type = '[S';
  return result;
}

function createModel() {
  return { type: modelClass, fields: {
    [`${modelClass}.x`]: intArray(vertices, (index) => ((index * 37) & 1023) - 512),
    [`${modelClass}.y`]: intArray(vertices, (index) => ((index * 53) & 511) - 256),
    [`${modelClass}.z`]: intArray(vertices, (index) => ((index * 97) & 1023) + 256),
    [`${modelClass}.faceA`]: shortArray(faces, (index) => index % vertices),
    [`${modelClass}.faceB`]: shortArray(faces, (index) => (index * 7 + 3) % vertices),
    [`${modelClass}.faceC`]: shortArray(faces, (index) => (index * 13 + 11) % vertices),
    [`${modelClass}.projectedX`]: intArray(vertices, () => 0),
    [`${modelClass}.projectedY`]: intArray(vertices, () => 0),
    [`${modelClass}.colors`]: intArray(faces, () => 0),
  } };
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
    id: 1, name: `dekobloko-toy-${tier.name}`, status: 'runnable',
    pendingException: null, callStack: new Stack(),
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const methods = new Map();
  for (const shape of shapes) {
    methods.set(shape.name, await jvm.findMethodInHierarchy(className, shape.method, descriptor));
  }
  return { jvm, thread, model: createModel(), methods };
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
    if (++ticks > 100000) throw new Error(`${shape.name} exceeded the scheduler tick limit`);
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
    const source = generated?.jvmStructuredSource;
    if (!source) continue;
    result[item.method.name] = {
      bytes: Buffer.byteLength(source),
      arraySlowPaths: (source.match(/helpers\.arrayLoad|helpers\.arrayStore/g) || []).length,
      materializations: (source.match(/helpers\.materialize/g) || []).length,
    };
  }
  return result;
}

async function tierResults(directory, tier) {
  const runtime = await createRuntime(directory, tier);
  const results = [];
  for (const shape of shapes) {
    for (let warmup = 0; warmup < warmups; warmup++) {
      let checksum = 0;
      for (let call = 0; call < invocations; call++) {
        checksum ^= await invoke(runtime, shape, 123 + warmup + call);
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
    const summary = summarize(shape.name, shape.work, elapsed, checksum);
    summary.structuredEntries = runtime.jvm.jit.structuredSsa.runCount - structuredBefore;
    summary.scalarEntries = runtime.jvm.jit.scalarLoopRunCount - scalarBefore;
    summary.compiledMethods = compiledKinds(runtime);
    summary.structuredCode = compiledCode(runtime);
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
        row.slowdownVsHotSpot = row.nanosecondsPerElement / native.nanosecondsPerElement;
      }
    }
    process.stdout.write(`${JSON.stringify({
      node: process.version,
      java: javaVersion(),
      invocations, passes, rounds, warmups,
      features: [
        'nested loops', 'instance fields', 'int[]/short[] loads', 'int[] stores',
        'fixed-point multiply/shift/divide', 'visibility branches', 'small static helper',
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
