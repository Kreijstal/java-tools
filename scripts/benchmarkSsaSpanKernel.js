#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const root = path.resolve(__dirname, '..');
const source = path.join(
  root, 'benchmarks', 'DekoblokoRendererTrafficBenchmark.java');
const className = 'DekoblokoRendererTrafficBenchmark';
const descriptor = '(IIII)V';
const width = positiveInteger('SSA_SPAN_WIDTH', 512);
const height = positiveInteger('SSA_SPAN_HEIGHT', 256);
const iterations = positiveInteger('SSA_SPAN_ITERATIONS', 100000);
const rounds = positiveInteger('SSA_SPAN_ROUNDS', 7);
const warmups = positiveInteger('SSA_SPAN_WARMUPS', 4);
const caseCount = 1024;
const samplesPerRound = 2;
const trustedNestedEntry = process.env.SSA_TRUSTED_NESTED !== '0';

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function compileFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-ssa-span-'));
  execFileSync('javac', [
    '-source', '8', '-target', '8', '-d', directory, source,
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  return directory;
}

function intArray(length, initialize) {
  const result = Array.from(
    {length}, (_unused, index) => initialize(index) | 0);
  result.type = '[I';
  return result;
}

function checksum(values) {
  let value = 0;
  for (let index = 0; index < values.length; index += 1) {
    value = (Math.imul(value, 31) + values[index]) | 0;
  }
  return value;
}

async function createRuntime(directory, pixels) {
  const jvm = new JVM({classpath: [directory], jit: {
    warmupThreshold: 0,
    preferWholeMethodJs: true,
    profileMethods: false,
    structuredSsa: true,
    fusedRegions: false,
    guestKernelOracles: false,
  }});
  const classData = await jvm.loadClassByName(className);
  classData.staticFieldsInitialized = true;
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const fields = classData.staticFields;
  fields.set('clipLeft:I', 0);
  fields.set('clipRight:I', width);
  fields.set('clipTop:I', 0);
  fields.set('clipBottom:I', height);
  fields.set('surfaceWidth:I', width);
  fields.set('pixels:[I', pixels);
  const method = await jvm.findMethodInHierarchy(
    className, 'fillSpan', descriptor);
  return {jvm, method};
}

function summarize(name, elapsed, result) {
  const medianNs = median(elapsed);
  return {
    name,
    iterations,
    samplesPerRound,
    rounds,
    medianMs: medianNs / 1e6,
    nanosecondsPerInvocation: medianNs / (iterations * samplesPerRound),
    invocationsPerSecond: iterations * samplesPerRound * 1e9 / medianNs,
    checksum: result,
  };
}

function benchmarkPair(generic, oracle) {
  // ABBA should alternate batches, not the inner call-site identity. A shared
  // `target.invoke()` site makes V8 deoptimize the harness itself when the
  // target changes, which obscures the generated-kernel comparison.
  const batches = new Map([
    [generic, () => {
      for (let call = 0; call < iterations; call += 1) generic.invoke();
    }],
    [oracle, () => {
      for (let call = 0; call < iterations; call += 1) oracle.invoke();
    }],
  ]);
  for (let warmup = 0; warmup < warmups; warmup += 1) {
    const order = warmup % 2 === 0
      ? [generic, oracle] : [oracle, generic];
    for (const target of order) {
      target.cursor = 0;
      batches.get(target)();
    }
  }
  for (const target of [generic, oracle]) {
    target.elapsed = [];
    target.result = 0;
  }
  for (let round = 0; round < rounds; round += 1) {
    const order = round % 2 === 0
      ? [generic, oracle, oracle, generic]
      : [oracle, generic, generic, oracle];
    for (const target of [generic, oracle]) {
      target.destination.fill(round);
      target.cursor = 0;
      target.roundElapsed = 0;
    }
    for (const target of order) {
      const started = process.hrtime.bigint();
      batches.get(target)();
      target.roundElapsed += Number(process.hrtime.bigint() - started);
    }
    for (const target of [generic, oracle]) {
      target.elapsed.push(target.roundElapsed);
      target.result ^= checksum(target.destination);
    }
  }
  const pairedRatios = generic.elapsed.map(
    (elapsed, index) => elapsed / oracle.elapsed[index]);
  return {
    generic: summarize('generic-ssa', generic.elapsed, generic.result),
    oracle: summarize(
      'handwritten-clipped-span-kernel', oracle.elapsed, oracle.result),
    pairedRatios,
    medianPairedRatio: median(pairedRatios),
  };
}

(async () => {
  const directory = compileFixture();
  try {
    const genericPixels = intArray(width * height, () => 0);
    const oraclePixels = intArray(width * height, () => 0);
    const runtime = await createRuntime(directory, genericPixels);
    const oracleRuntime = await createRuntime(directory, oraclePixels);
    const generated = runtime.jvm.jit.structuredSsa.compile(runtime.method);
    oracleRuntime.jvm.jit.structuredSsa.compile(oracleRuntime.method);
    if (!generated?.jvmStructuredSsa ||
        typeof generated.jvmRestoringDirectPositionalBody !== 'function') {
      throw new Error(
        'generic SSA did not publish a restoring positional span body');
    }
    const thread = {
      id: 1,
      name: 'ssa-span-benchmark',
      status: 'runnable',
      pendingException: null,
      callStack: new Stack(),
    };
    const plan = {
      target: {freeFrame: null},
      Frame,
      lookupClass: className,
      method: runtime.method,
      restoreFrame(currentThread, frame, depth) {
        currentThread.callStack.items.splice(depth, 0, frame);
      },
    };
    const cases = Array.from({length: caseCount}, (_unused, index) => ({
      x: ((Math.imul(index, 17) + 11) & (width + 63)) - 32,
      y: ((Math.imul(index, 29) + 7) % (height + 32)) - 16,
      count: 8 + (index & 63),
      color: (Math.imul(index + 1, 65793) | 0xff000000) | 0,
    }));
    const fieldSite = (fieldName) => {
      const index = oracleRuntime.jvm.jit.fieldSites.findIndex((site) =>
        site?.className === className && site?.fieldName === fieldName);
      if (index < 0) throw new Error(`missing compiled field site ${fieldName}`);
      return index;
    };
    const clipTopSite = fieldSite('clipTop');
    const clipBottomSite = fieldSite('clipBottom');
    const clipLeftSite = fieldSite('clipLeft');
    const clipRightSite = fieldSite('clipRight');
    const surfaceWidthSite = fieldSite('surfaceWidth');
    const pixelsSite = fieldSite('pixels');
    const generic = {
      destination: genericPixels,
      cursor: 0,
      invoke() {
        const item = cases[this.cursor++ & (caseCount - 1)];
        return generated.jvmRestoringDirectPositionalBody(
          runtime.jvm.jit, plan,
          item.x, item.y, item.count, item.color, thread, trustedNestedEntry);
      },
    };
    const oracle = {
      destination: oraclePixels,
      cursor: 0,
      invoke() {
        const item = cases[this.cursor++ & (caseCount - 1)];
        return oracleRuntime.jvm.jit.clippedStaticSpanDirectAt(
          item.x, item.y, item.count, item.color,
          clipTopSite, clipBottomSite, clipLeftSite, clipRightSite,
          surfaceWidthSite, pixelsSite);
      },
    };
    const measured = benchmarkPair(generic, oracle);
    if (measured.generic.checksum !== measured.oracle.checksum ||
        checksum(genericPixels) !== checksum(oraclePixels)) {
      throw new Error(
        `span checksum mismatch: SSA=${measured.generic.checksum}, ` +
        `oracle=${measured.oracle.checksum}`);
    }
    process.stdout.write(`${JSON.stringify({
      node: process.version,
      width,
      height,
      iterations,
      samplesPerRound,
      rounds,
      warmups,
      trustedNestedEntry,
      generic: measured.generic,
      oracle: measured.oracle,
      ssaToOracleRatio:
        measured.generic.nanosecondsPerInvocation /
        measured.oracle.nanosecondsPerInvocation,
      medianPairedRatio: measured.medianPairedRatio,
      pairedRatios: measured.pairedRatios,
      generated: {
        sourceBytes: Buffer.byteLength(
          generated.jvmRestoringDirectPositionalSource),
        source: process.env.SSA_SPAN_PRINT_SOURCE === '1'
          ? generated.jvmRestoringDirectPositionalSource
          : undefined,
      },
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
