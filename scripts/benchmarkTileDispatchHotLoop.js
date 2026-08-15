#!/usr/bin/env node
'use strict';

// Reduced-hot-loop harness for the Tomb Racer post-logo loading gap.
//
// Runs benchmarks/TileDispatchHotLoop.java on HotSpot and on jvm.js and prints
// a per-shape slowdown. The shapes isolate the call-boundary kinds that
// dominate loading in a boot CPU profile but that CallBoundaryHotLoop (static
// calls only) does not exercise: interface dispatch, polymorphic receivers,
// and a virtual call behind a checkcast inside a nested grid walk.
//
// Environment:
//   TILE_DISPATCH_ITERATIONS  total cells / loop trips (default 2000000)
//   TILE_DISPATCH_ROUNDS      measured rounds (default 5)
//   TILE_DISPATCH_WARMUPS     discarded rounds (default 3)
//   TILE_DISPATCH_SHAPES      comma-separated subset of arith,iface,poly,tile
// Any JVM_* flag set in the environment is passed through untouched, so this
// can be pointed at the same tier configuration the game launcher uses.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'benchmarks', 'TileDispatchHotLoop.java');
const className = 'TileDispatchHotLoop';
const iterations = Number(process.env.TILE_DISPATCH_ITERATIONS || 2000000);
const rounds = Number(process.env.TILE_DISPATCH_ROUNDS || 5);
const warmups = Number(process.env.TILE_DISPATCH_WARMUPS || 3);
const allShapes = [
  { name: 'arith', method: 'runArith' },
  { name: 'iface', method: 'runIface' },
  { name: 'poly', method: 'runPoly' },
  { name: 'tile', method: 'runTile' },
];
const selected = process.env.TILE_DISPATCH_SHAPES
  ? new Set(process.env.TILE_DISPATCH_SHAPES.split(',').map((s) => s.trim()))
  : null;
const shapes = selected
  ? allShapes.filter((shape) => selected.has(shape.name))
  : allShapes;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function compileFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-tiledispatch-'));
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
  const byName = new Map(allShapes.map((shape) => [shape.name, []]));
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
  // The game launcher constructs the JVM with the JIT *enabled* and lets the
  // JVM_* environment flags pick the tiers, so the boot profile is dominated by
  // the generated-sync / structured-ssa / hot-call-graph-region ladder and
  // never reaches a wasm tier. Mirror that here: forcing the wasm tier (as
  // benchmarkCallBoundaryHotLoop does) would measure a tier the boot does not
  // actually use.
  const jvm = new JVM({
    classpath: [directory],
    jit: { enabled: process.env.TILE_DISPATCH_JIT !== '0' },
  });
  const classData = await jvm.loadClassByName(className);
  if (!classData.staticFields) classData.staticFields = new Map();
  classData.staticFieldsInitialized = true;
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = {
    id: 1,
    name: 'tile-dispatch',
    status: 'runnable',
    pendingException: null,
    callStack: new Stack(),
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return { jvm, thread };
}

function sentinelFrame() {
  return new Frame({
    name: 'sentinel',
    descriptor: '()V',
    attributes: [{
      type: 'code',
      code: {
        codeItems: [{ labelDef: 'L0:', instruction: 'return' }],
        localsSize: '0',
        stackSize: '1',
        exceptionTable: [],
      },
    }],
  });
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
    if (runtime.thread.pendingException) {
      const exception = runtime.thread.pendingException;
      throw new Error(`${shape.name}: guest exception ${
        exception && exception.type ? exception.type : exception}`);
    }
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
      throw new Error(`${shape.name}: checksum mismatch js=${checksum} `
        + `native=${nativeChecksum}`);
    }
    rows.push({
      name: shape.name,
      checksum,
      nativeNsPerIteration: nativeMedian / iterations,
      jsNsPerIteration: jsMedian / iterations,
      slowdown: jsMedian / nativeMedian,
    });
  }
  for (const row of rows) {
    console.log(`${row.name.padEnd(6)} native=${
      row.nativeNsPerIteration.toFixed(2).padStart(8)} ns/iter  js=${
      row.jsNsPerIteration.toFixed(2).padStart(9)} ns/iter  slowdown=${
      row.slowdown.toFixed(1).padStart(7)}x  checksum=${row.checksum}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
