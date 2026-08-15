#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Stack = require('../src/core/stack');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'benchmarks', 'SsaRasterKernelBenchmark.java');
const className = 'SsaRasterKernelBenchmark';
const descriptor = '([I[IIIIIIII)V';
const iterations = positiveInteger('SSA_RASTER_ITERATIONS', 4000);
const rounds = positiveInteger('SSA_RASTER_ROUNDS', 7);
const warmups = positiveInteger('SSA_RASTER_WARMUPS', 4);
const width = positiveInteger('SSA_RASTER_WIDTH', 64);
const height = positiveInteger('SSA_RASTER_HEIGHT', 32);
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-ssa-raster-'));
  execFileSync('javac', [
    '-source', '8', '-target', '8', '-d', directory, source,
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  return directory;
}

function intArray(length, initialize) {
  const result = Array.from(
    {length},
    (_unused, index) => initialize(index) | 0,
  );
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

async function createRuntime(directory, guestKernelOracles) {
  const jvm = new JVM({classpath: [directory], jit: {
    warmupThreshold: 0,
    preferWholeMethodJs: true,
    profileMethods: false,
    structuredSsa: true,
    fusedRegions: false,
    guestKernelOracles,
  }});
  const classData = await jvm.loadClassByName(className);
  classData.staticFieldsInitialized = true;
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className,
    'transparentBlit',
    descriptor,
  );
  return {jvm, method};
}

function summarize(name, elapsed, result, source) {
  const medianNs = median(elapsed);
  return {
    name,
    rounds,
    iterations,
    samplesPerRound,
    pixelsPerInvocation: width * height,
    medianMs: medianNs / 1e6,
    nanosecondsPerInvocation: medianNs / (iterations * samplesPerRound),
    nanosecondsPerPixel:
      medianNs / (iterations * samplesPerRound) / width / height,
    checksum: result,
    sourceChecksum: checksum(source),
  };
}

function benchmarkPair(generic, oracle, source) {
  // Keep the two measured call sites monomorphic while retaining ABBA batch
  // order. Switching a shared `target.invoke()` site deoptimizes the harness.
  const batches = new Map([
    [generic, () => {
      for (let call = 0; call < iterations; call += 1) generic.invoke();
    }],
    [oracle, () => {
      for (let call = 0; call < iterations; call += 1) oracle.invoke();
    }],
  ]);
  for (let warmup = 0; warmup < warmups; warmup += 1) {
    const first = warmup % 2 === 0 ? generic : oracle;
    const second = first === generic ? oracle : generic;
    batches.get(first)();
    batches.get(second)();
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
    generic: summarize(
      'generic-ssa', generic.elapsed, generic.result, source),
    oracle: summarize(
      'structural-kernel-oracle', oracle.elapsed, oracle.result, source),
    pairedRatios,
    medianPairedRatio: median(pairedRatios),
  };
}

(async () => {
  const directory = compileFixture();
  try {
    const generic = await createRuntime(directory, false);
    const oracle = await createRuntime(directory, true);
    if (process.env.SSA_RASTER_ATOMIC === '1') {
      generic.method.jvmStructuredAtomicRegionMaxIterations = 4096;
    }
    const recognized = oracle.jvm.jit.getSynchronousIntrinsic(
      oracle.method,
      descriptor,
    );
    const oracleRecognized =
      recognized?.jvmDirectKind === 'transparentIntBlit';
    const generated = generic.jvm.jit.structuredSsa.compile(generic.method);
    if (!generated?.jvmStructuredSsa ||
        typeof generated.jvmRestoringDirectPositionalBody !== 'function') {
      throw new Error('generic SSA did not publish a restoring positional body');
    }

    const length = width * height;
    const sourcePixels = intArray(length, index =>
      index % 5 === 0 ? 0 : Math.imul(index + 1, 0x10203));
    const genericDestination = intArray(length, () => 0);
    const oracleDestination = intArray(length, () => 0);
    const thread = {
      id: 1,
      name: 'ssa-raster-benchmark',
      status: 'runnable',
      pendingException: null,
      callStack: new Stack(),
    };
    const plan = {
      target: {freeFrame: null},
      lookupClass: className,
      method: generic.method,
      restoreFrame(currentThread, frame, depth) {
        currentThread.callStack.items.splice(depth, 0, frame);
      },
    };
    const invokeGeneric = generated.jvmRestoringDirectPositionalBody.bind(
      null,
      generic.jvm.jit,
      plan,
      genericDestination,
      sourcePixels,
      0,
      0,
      0,
      width,
      height,
      0,
      0,
      thread,
      trustedNestedEntry,
    );
    const invokeOracle = oracle.jvm.jit.transparentIntBlitDirect.bind(
      oracle.jvm.jit,
      oracleDestination,
      sourcePixels,
      0,
      0,
      0,
      width,
      height,
      0,
      0,
    );

    // Resolve any cold class-initialization guard before timing.
    invokeGeneric();
    invokeOracle();
    const measured = benchmarkPair({
      invoke: invokeGeneric,
      destination: genericDestination,
    }, {
      invoke: invokeOracle,
      destination: oracleDestination,
    }, sourcePixels);
    const genericResult = measured.generic;
    const oracleResult = measured.oracle;
    if (genericResult.checksum !== oracleResult.checksum) {
      throw new Error(
        `checksum mismatch: SSA=${genericResult.checksum}, oracle=${oracleResult.checksum}`,
      );
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
      generic: genericResult,
      oracle: oracleResult,
      ssaToOracleRatio:
        genericResult.nanosecondsPerPixel / oracleResult.nanosecondsPerPixel,
      medianPairedRatio: measured.medianPairedRatio,
      pairedRatios: measured.pairedRatios,
      generated: {
        oracleRecognized,
        sourceBytes: Buffer.byteLength(generated.jvmRestoringDirectPositionalSource),
        source: process.env.SSA_RASTER_PRINT_SOURCE === '1'
          ? generated.jvmRestoringDirectPositionalSource
          : undefined,
      },
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
