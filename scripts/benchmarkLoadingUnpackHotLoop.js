#!/usr/bin/env node
'use strict';

// Minimal reproducer harness for an archive-unpacking slowdown.
//
// Loading is JS-region-tier bound (~20:1 region-tier runs vs wasm runs), so
// unlike benchmarkCallBoundaryHotLoop.js (which isolates the wasm-tier call
// boundary) this runs benchmarks/LoadingUnpackHotLoop.java on:
//   - HotSpot (javac/java -Xbatch), the reference;
//   - the JS region tier with the production loading config
//     (structuredSsa + hotCallGraphRegions + loop outlining, warmup 0);
//   - the production wasm tier with direct static+instance links, as the
//     "what if loading ran here" comparison column.
// Checksums are compared against HotSpot for every tier and shape.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'benchmarks', 'LoadingUnpackHotLoop.java');
const className = 'LoadingUnpackHotLoop';
const bufferClass = 'LoadingUnpackHotLoop$Buffer';
const iterations = Number(process.env.LOADING_UNPACK_ITERATIONS || 2000000);
const rounds = Number(process.env.LOADING_UNPACK_ROUNDS || 5);
const warmups = Number(process.env.LOADING_UNPACK_WARMUPS || 3);
const shapes = [
  { name: 'arith', method: 'runArith' },
  { name: 'array', method: 'runArray' },
  { name: 'field', method: 'runField' },
  { name: 'call', method: 'runCall' },
  { name: 'unpack', method: 'runUnpack' },
];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function compileFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-loadingunpack-'));
  execFileSync('javac', ['-source', '8', '-target', '8', '-d', directory, source], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return directory;
}

function nativeResults(directory) {
  const output = execFileSync('java', [
    '-Xbatch', '-cp', directory, className,
    String(iterations), String(rounds), String(warmups),
  ], { encoding: 'utf8' });
  const byName = new Map(shapes.map((shape) => [shape.name, []]));
  const checksums = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^RESULT (\w+) (\d+) (\d+) (-?\d+)$/.exec(line);
    if (!match) continue;
    byName.get(match[1]).push(Number(match[3]));
    checksums.set(match[1], Number(match[4]));
  }
  return { byName, checksums };
}

async function createRuntime(directory, tier) {
  // 'hybrid' = the full production game config: wasm tier AND the JS tiers
  // together, so wasm bridges fall back to generated JS instead of the
  // interpreter.
  if (tier === 'wasm' || tier === 'hybrid') {
    process.env.JVM_WASM_JIT = '1';
    process.env.JVM_WASM_STRUCTURED = '1';
    process.env.JVM_WASM_DIRECT_STATIC_LINK = '1';
    process.env.JVM_WASM_DIRECT_INSTANCE_LINK = '1';
  } else {
    delete process.env.JVM_WASM_JIT;
  }
  const jit = tier === 'wasm'
    ? { enabled: false, warmupThreshold: 0 }
    : {
      enabled: true,
      warmupThreshold: 0,
      structuredSsa: true,
      hotCallGraphRegions: true,
      hotCallGraphLoopOutlining: true,
    };
  const jvm = new JVM({ classpath: [directory], jit });
  for (const name of [className, bufferClass]) {
    const classData = await jvm.loadClassByName(name);
    if (!classData.staticFields) classData.staticFields = new Map();
    classData.staticFieldsInitialized = true;
    jvm.classInitializationState.set(name, 'INITIALIZED');
  }
  const thread = {
    id: 1, name: `loading-unpack-${tier}`, status: 'runnable',
    pendingException: null, callStack: new Stack(),
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return { jvm, thread, tier };
}

function sentinelFrame() {
  return new Frame({ name: 'sentinel', descriptor: '()V', attributes: [{
    type: 'code', code: { codeItems: [{ labelDef: 'L0:', instruction: 'return' }],
      localsSize: '0', stackSize: '1', exceptionTable: [] },
  }] });
}

async function invoke(runtime, shape) {
  const method = await runtime.jvm.findMethodInHierarchy(
    className, shape.method, '(II)I');
  const caller = sentinelFrame();
  const frame = new Frame(method);
  frame.className = className;
  frame.locals[0] = iterations;
  frame.locals[1] = 12345;
  runtime.thread.status = 'runnable';
  runtime.thread.callStack.push(caller);
  runtime.thread.callStack.push(frame);
  let ticks = 0;
  while (runtime.thread.callStack.size() > 1) {
    await runtime.jvm.executeTick();
    if (++ticks > iterations * 500 + 100000) {
      throw new Error(`${runtime.tier} ${shape.name}: tick limit exceeded`);
    }
  }
  const value = caller.stack.pop();
  runtime.thread.callStack.pop();
  return { value: value | 0, method };
}

async function tierResults(runtime, native) {
  const rows = new Map();
  for (const shape of shapes) {
    const regions = runtime.jvm.jit.hotCallGraphRegions;
    const regionRunsBefore = regions.runCount;
    const generatedRunsBefore = runtime.jvm.jit.syncGeneratedRunCount;
    const elapsed = [];
    let last = null;
    for (let round = 0; round < warmups + rounds; round += 1) {
      const started = process.hrtime.bigint();
      last = await invoke(runtime, shape);
      const nanos = Number(process.hrtime.bigint() - started);
      if (round >= warmups) elapsed.push(nanos);
    }
    const nativeChecksum = native.checksums.get(shape.name);
    if (last.value !== nativeChecksum) {
      throw new Error(`${runtime.tier} ${shape.name}: checksum mismatch js=${
        last.value} native=${nativeChecksum}`);
    }
    const row = {
      nsPerIteration: median(elapsed) / iterations,
      slowdown: median(elapsed) / median(native.byName.get(shape.name)),
    };
    if (runtime.tier !== 'wasm') {
      row.regionRuns = regions.runCount - regionRunsBefore;
      row.regionModules = regions.moduleCompileCount;
      row.generatedRuns =
        runtime.jvm.jit.syncGeneratedRunCount - generatedRunsBefore;
    }
    if (runtime.tier !== 'jsregion') {
      const state = runtime.jvm.jit.wasmJit.state.get(last.method);
      row.wasmStatus = state ? state.status : 'none';
      row.wasmRuns = state ? state.runs : 0;
    }
    rows.set(shape.name, row);
  }
  if (runtime.tier === 'wasm' && process.env.LOADING_UNPACK_WASM_DIAG === '1') {
    const interesting = [
      [className, 'runArith', '(II)I'], [className, 'runArray', '(II)I'],
      [className, 'runField', '(II)I'], [className, 'runCall', '(II)I'],
      [className, 'runUnpack', '(II)I'], [className, 'fill', '(II)[B'],
      [bufferClass, 'readUByte', '()I'], [bufferClass, 'readUShort', '()I'],
      [bufferClass, 'step', '(I)I'], [bufferClass, '<init>', '([B)V'],
    ];
    for (const [owner, name, descriptor] of interesting) {
      const method = await runtime.jvm.findMethodInHierarchy(
        owner, name, descriptor).catch(() => null);
      const state = method && runtime.jvm.jit.wasmJit.state.get(method);
      if (!state) {
        console.log(`[wasm] ${owner}.${name}${descriptor} state=none`);
        continue;
      }
      const meta = state.meta || {};
      const demotes = meta.demoteReasons instanceof Map
        ? [...meta.demoteReasons.entries()].map(([id, why]) => `${id}:${why}`)
        : [];
      console.log(`[wasm] ${owner}.${name}${descriptor} status=${
        state.status} runs=${state.runs} exits=${state.exits} fuelExits=${
        state.fuelExits} fullyCompiled=${meta.fullyCompiled ?? '?'} ` +
        `deoptableCalls=${meta.deoptableCalls ?? '?'} directLinks=${
        meta.directLinks ?? '?'} deoptStubs=${
        meta.deoptStubCount ?? '?'} uncovered=${meta.uncoveredItems ?? '?'} ` +
        `usedEh=${meta.usedEh ?? '?'} structured=${meta.structured ?? '?'} ` +
        `demotes=[${demotes.join(', ')}] reason=${state.failReason || ''}`);
      if (meta.importStats instanceof Map) {
        const hot = [...meta.importStats.entries()].filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1]).slice(0, 12)
          .map(([n, c]) => `${n}=${c}`).join(' ');
        if (hot) console.log(`       imports: ${hot}`);
      }
    }
  }
  return rows;
}

async function main() {
  const directory = compileFixture();
  const native = nativeResults(directory);
  // jsregion first: its runtime must be constructed without the wasm env
  // flags, which stay set once the wasm runtime needs them.
  const jsregion = await tierResults(
    await createRuntime(directory, 'jsregion'), native);
  const hybrid = await tierResults(
    await createRuntime(directory, 'hybrid'), native);
  const wasm = await tierResults(
    await createRuntime(directory, 'wasm'), native);
  console.log(`shape    native ns/iter | jsregion ns/iter  slow |` +
    ` hybrid ns/iter  slow | wasm ns/iter  slow`);
  for (const shape of shapes) {
    const nativeNs = median(native.byName.get(shape.name)) / iterations;
    const js = jsregion.get(shape.name);
    const hy = hybrid.get(shape.name);
    const ws = wasm.get(shape.name);
    console.log(`${shape.name.padEnd(8)} ${nativeNs.toFixed(2).padStart(8)}` +
      `        | ${js.nsPerIteration.toFixed(2).padStart(10)} ${
        (js.slowdown.toFixed(1) + 'x').padStart(9)} | ${
        hy.nsPerIteration.toFixed(2).padStart(9)} ${
        (hy.slowdown.toFixed(1) + 'x').padStart(9)} | ${
        ws.nsPerIteration.toFixed(2).padStart(9)} ${
        (ws.slowdown.toFixed(1) + 'x').padStart(7)}`);
  }
  for (const shape of shapes) {
    const js = jsregion.get(shape.name);
    const hy = hybrid.get(shape.name);
    const ws = wasm.get(shape.name);
    console.log(`[diag] ${shape.name}: jsregion regionRuns=${js.regionRuns} ` +
      `modules=${js.regionModules} generatedRuns=${js.generatedRuns}; ` +
      `hybrid wasmRuns=${hy.wasmRuns} regionRuns=${hy.regionRuns}; ` +
      `wasm status=${ws.wasmStatus} runs=${ws.wasmRuns}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
