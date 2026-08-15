#!/usr/bin/env node
'use strict';

// Minimal reproducer harness for the Tomb Racer post-logo ~11x gap.
//
// Runs benchmarks/CallBoundaryHotLoop.java on HotSpot and on the JS JVM's
// production wasm tier (JVM_WASM_JIT=1), and prints per-shape slowdowns.
// The three shapes decompose the gap: arith is near-native, call is the
// pathological dispatch-boundary ingredient, and blend (a handful of
// arithmetic ops per call) reproduces the whole-app ratio.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'benchmarks', 'CallBoundaryHotLoop.java');
const className = 'CallBoundaryHotLoop';
const iterations = Number(process.env.CALL_BOUNDARY_ITERATIONS || 2000000);
const rounds = Number(process.env.CALL_BOUNDARY_ROUNDS || 5);
const warmups = Number(process.env.CALL_BOUNDARY_WARMUPS || 3);
const shapes = [
  { name: 'arith', method: 'runArith' },
  { name: 'call', method: 'runCall' },
  { name: 'blend', method: 'runBlend' },
];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function compileFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-callboundary-'));
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

async function createRuntime(directory) {
  const previousWasm = process.env.JVM_WASM_JIT;
  const previousStructured = process.env.JVM_WASM_STRUCTURED;
  process.env.JVM_WASM_JIT = '1';
  // The launcher runs games with JVM_WASM_STRUCTURED=1, so leaving it off
  // here did not measure the production tier — it measured the dispatcher
  // tier, whose block-dispatch br_table and per-block fuel checks cost 30x
  // on this shape. Set it explicitly to 0 to compare the two.
  if (previousStructured === undefined) process.env.JVM_WASM_STRUCTURED = '1';
  const jvm = new JVM({ classpath: [directory], jit: {
    enabled: false,
    warmupThreshold: 0,
  } });
  if (previousWasm === undefined) delete process.env.JVM_WASM_JIT;
  else process.env.JVM_WASM_JIT = previousWasm;
  if (previousStructured === undefined) delete process.env.JVM_WASM_STRUCTURED;
  else process.env.JVM_WASM_STRUCTURED = previousStructured;
  const classData = await jvm.loadClassByName(className);
  if (!classData.staticFields) classData.staticFields = new Map();
  classData.staticFieldsInitialized = true;
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = {
    id: 1, name: 'call-boundary', status: 'runnable',
    pendingException: null, callStack: new Stack(),
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return { jvm, thread };
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
      throw new Error(`${shape.name}: tick limit exceeded`);
    }
  }
  const value = caller.stack.pop();
  runtime.thread.callStack.pop();
  return value | 0;
}

async function main() {
  const directory = compileFixture();
  const native = nativeResults(directory);
  const runtime = await createRuntime(directory);
  const rows = [];
  for (const shape of shapes) {
    const elapsed = [];
    let checksum = null;
    for (let round = 0; round < warmups + rounds; round += 1) {
      const started = process.hrtime.bigint();
      checksum = await invoke(runtime, shape);
      const nanos = Number(process.hrtime.bigint() - started);
      if (round >= warmups) elapsed.push(nanos);
    }
    const nativeMedian = median(native.byName.get(shape.name));
    const jsMedian = median(elapsed);
    const nativeChecksum = native.checksums.get(shape.name);
    if (checksum !== nativeChecksum) {
      throw new Error(`${shape.name}: checksum mismatch js=${checksum} ` +
        `native=${nativeChecksum}`);
    }
    rows.push({
      name: shape.name,
      checksum,
      nativeNsPerIteration: nativeMedian / iterations,
      wasmNsPerIteration: jsMedian / iterations,
      slowdown: jsMedian / nativeMedian,
    });
  }
  for (const row of rows) {
    console.log(`${row.name.padEnd(6)} native=${
      row.nativeNsPerIteration.toFixed(2).padStart(8)} ns/iter  wasm=${
      row.wasmNsPerIteration.toFixed(2).padStart(8)} ns/iter  slowdown=${
      row.slowdown.toFixed(1).padStart(6)}x  checksum=${row.checksum}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
