#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const { parseDescriptor } = require('../src/parsing/typeParser');

const classpath = path.resolve(process.argv[2] || '');
const iterations = Number(process.argv[3] || 200);
const benchmarkEnabled =
  process.env.FUSED_DIFFERENTIAL_BENCHMARK === '1';
const benchmarkIterations = Number(
  process.env.FUSED_DIFFERENTIAL_BENCHMARK_ITERATIONS || 2000);
const benchmarkRounds = Number(
  process.env.FUSED_DIFFERENTIAL_BENCHMARK_ROUNDS || 7);
const benchmarkWarmups = Number(
  process.env.FUSED_DIFFERENTIAL_BENCHMARK_WARMUPS || 4);
if (!process.argv[2] || !fs.statSync(classpath, { throwIfNoEntry: false })?.isDirectory() ||
    !Number.isInteger(iterations) || iterations <= 0 ||
    !Number.isInteger(benchmarkIterations) || benchmarkIterations <= 0 ||
    !Number.isInteger(benchmarkRounds) || benchmarkRounds <= 0 ||
    !Number.isInteger(benchmarkWarmups) || benchmarkWarmups <= 0) {
  console.error('Usage: node scripts/differentialFusedRenderers.js <class-directory> [iterations]');
  process.exit(2);
}

function classNames(root, directory = root) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...classNames(root, absolute));
    else if (entry.name.endsWith('.class')) {
      result.push(path.relative(root, absolute).replace(/\\/g, '/').replace(/\.class$/, ''));
    }
  }
  return result;
}

function defaultValue(descriptor) {
  if (descriptor === 'J') return 0n;
  if (descriptor === 'F' || descriptor === 'D') return 0;
  if (/^[ZBCSI]$/.test(descriptor)) return 0;
  return null;
}

async function createRuntime(jitOptions = {}) {
  const jvm = new JVM({ classpath: [classpath], jit: {
    warmupThreshold: 0,
    preferWholeMethodJs: true,
    fusedRegions: false,
    handwrittenFusedKernels: false,
    ...jitOptions,
  } });
  for (const className of classNames(classpath)) {
    const classData = await jvm.loadClassByName(className);
    if (!classData) continue;
    if (!classData.staticFields) classData.staticFields = new Map();
    for (const item of classData.ast?.classes?.[0]?.items || []) {
      const field = item.field;
      if (item.type === 'field' && field?.flags?.includes('static')) {
        classData.staticFields.set(`${field.name}:${field.descriptor}`,
          defaultValue(field.descriptor));
      }
    }
    classData.staticFieldsInitialized = true;
    jvm.classInitializationState.set(className, 'INITIALIZED');
  }
  const thread = {
    id: 1, name: 'fused-differential', status: 'runnable',
    pendingException: null, callStack: new Stack(),
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  return { jvm, thread };
}

function findWrapper(runtime, descriptor) {
  const compiler = runtime.jvm.jit.fusedRegions;
  for (const [owner, classData] of Object.entries(runtime.jvm.classes)) {
    for (const item of classData.ast?.classes?.[0]?.items || []) {
      if (item.type !== 'method' || item.method.descriptor !== descriptor) continue;
      const discovered = compiler.discoverRegion(item.method);
      if (discovered) return { owner, method: item.method,
        family: discovered.family, discovered };
    }
  }
  throw new Error(`No structurally verified wrapper for ${descriptor}`);
}

function setField(runtime, arg, value) {
  const [, owner, [name, descriptor]] = arg;
  const classData = runtime.jvm.classes[owner];
  if (!classData) throw new Error(`Static owner ${owner} is not loaded`);
  classData.staticFields.set(`${name}:${descriptor}`, value);
}

function writeTarget(target, value) {
  if (target.kind === 'map') target.fields.set(target.key, value);
  else target.fields[target.key] = value;
}

function configureRegion(runtime, candidate, pixels) {
  const compiler = runtime.jvm.jit.fusedRegions;
  const { wrapper, raster, rasterMethod, scanlineMethod } = candidate.discovered;
  for (const arg of wrapper.staticRefs) {
    const descriptor = arg[2][1];
    setField(runtime, arg, descriptor === '[I' ? pixels : defaultValue(descriptor));
  }
  for (const arg of raster.staticRefs) {
    const descriptor = arg[2][1];
    const value = descriptor === '[I'
      ? Array.from({ length: 64 }, (_, row) => row * 64)
      : descriptor === 'I' ? 64 : defaultValue(descriptor);
    setField(runtime, arg, value);
  }
  for (const arg of compiler.staticRefs(scanlineMethod)) setField(runtime, arg, defaultValue(arg[2][1]));
  const region = compiler.compile(candidate.method, candidate.owner);
  if (!region) throw new Error(`Could not compile verified ${candidate.family.name} region`);
  const rasterPlan = region.semanticGradientRasterPlan || region.semanticFlatRasterPlan;
  if (rasterPlan) {
    writeTarget(region.staticTargets[rasterPlan.heightStatic], 64);
    writeTarget(region.staticTargets[rasterPlan.widthStatic], 64);
    writeTarget(region.staticTargets[rasterPlan.rowsStatic],
      Array.from({ length: 64 }, (_, row) => row * 64));
    writeTarget(region.staticTargets[rasterPlan.strideStatic], 64);
  }
  return region;
}

async function invokeBaseline(runtime, candidate, args, label) {
  const frame = new Frame(candidate.method);
  frame.className = candidate.owner;
  args.forEach((value, index) => { frame.locals[index] = value; });
  runtime.thread.status = 'runnable';
  runtime.thread.callStack.push(frame);
  let ticks = 0;
  while (!runtime.thread.callStack.isEmpty()) {
    await runtime.jvm.executeTick();
    if (++ticks > 10000) {
      const current = runtime.thread.callStack.peek();
      throw new Error(`baseline tick limit at ${label}: ` +
        `${current && current.className}.${current && current.method && current.method.name}` +
        `@${current && current.pc}`);
    }
  }
}

function nextRandom(state) {
  state.value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0;
  return state.value;
}

function argumentsFor(family, random, region, wideCoordinates = false) {
  const coordinate = () => wideCoordinates
    ? -32 + nextRandom(random) % 128
    : 2 + nextRandom(random) % 60;
  const color = () => nextRandom(random) & 0xffffff;
  let args;
  if (family.wrapper === '(IIIIIIII)V') {
    args = [coordinate(), coordinate(), coordinate(), color(), coordinate(),
      coordinate(), coordinate(), coordinate()];
  } else {
    args = Array.from({ length: 16 }, (_, index) =>
      [1, 2, 3, 4, 5, 8, 11, 14].includes(index) ? coordinate() : color());
  }

  const plan = region.semanticWrapperPlan;
  if (plan) {
    for (const parameter of plan.booleanParameters) args[parameter] = 1;
    const ordered = [
      4 + nextRandom(random) % 12,
      22 + nextRandom(random) % 12,
      40 + nextRandom(random) % 12,
    ];
    for (let index = ordered.length - 1; index > 0; index -= 1) {
      const swap = nextRandom(random) % (index + 1);
      [ordered[index], ordered[swap]] = [ordered[swap], ordered[index]];
    }
    plan.keys.forEach((parameter, index) => { args[parameter] = ordered[index]; });
  }
  return args;
}

function assertPixels(left, right, label) {
  if (left.length !== right.length) throw new Error(`${label}: pixel length changed`);
  for (let index = 0; index < left.length; index += 1) {
    if ((left[index] | 0) !== (right[index] | 0)) {
      throw new Error(`${label}: pixel ${index} differs (${left[index]} !== ${right[index]})`);
    }
  }
}

function checksum(values) {
  let value = 0;
  for (let index = 0; index < values.length; index += 1) {
    value = (Math.imul(value, 31) + (values[index] | 0)) | 0;
  }
  return value;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function benchmarkKernels(generic, oracle, cases, oracleCases = cases) {
  if (cases.length !== oracleCases.length) {
    throw new Error("Benchmark case counts differ");
  }
  let genericCursor = 0;
  let oracleCursor = 0;
  const genericBatch = () => {
    for (let call = 0; call < benchmarkIterations; call += 1) {
      generic.kernel(...cases[genericCursor++ & (cases.length - 1)]);
    }
  };
  const oracleBatch = () => {
    for (let call = 0; call < benchmarkIterations; call += 1) {
      oracle.kernel(...oracleCases[oracleCursor++ & (oracleCases.length - 1)]);
    }
  };
  for (let warmup = 0; warmup < benchmarkWarmups; warmup += 1) {
    generic.destination.fill(warmup);
    oracle.destination.fill(warmup);
    genericCursor = 0;
    oracleCursor = 0;
    if ((warmup & 1) === 0) {
      genericBatch();
      oracleBatch();
    } else {
      oracleBatch();
      genericBatch();
    }
  }
  const genericElapsed = [];
  const oracleElapsed = [];
  let genericChecksum = 0;
  let oracleChecksum = 0;
  for (let round = 0; round < benchmarkRounds; round += 1) {
    generic.destination.fill(round);
    oracle.destination.fill(round);
    genericCursor = 0;
    oracleCursor = 0;
    let genericRound = 0;
    let oracleRound = 0;
    const order = (round & 1) === 0
      ? ['generic', 'oracle', 'oracle', 'generic']
      : ['oracle', 'generic', 'generic', 'oracle'];
    for (const name of order) {
      const started = process.hrtime.bigint();
      if (name === 'generic') genericBatch();
      else oracleBatch();
      const elapsed = Number(process.hrtime.bigint() - started);
      if (name === 'generic') genericRound += elapsed;
      else oracleRound += elapsed;
    }
    assertPixels(generic.destination, oracle.destination,
      `timed round ${round}`);
    genericElapsed.push(genericRound);
    oracleElapsed.push(oracleRound);
    genericChecksum ^= checksum(generic.destination);
    oracleChecksum ^= checksum(oracle.destination);
  }
  const pairedRatios = genericElapsed.map(
    (elapsed, index) => elapsed / oracleElapsed[index]);
  return {
    iterationsPerSample: benchmarkIterations * 2,
    rounds: benchmarkRounds,
    warmups: benchmarkWarmups,
    genericNanosecondsPerInvocation:
      median(genericElapsed) / (benchmarkIterations * 2),
    oracleNanosecondsPerInvocation:
      median(oracleElapsed) / (benchmarkIterations * 2),
    pairedRatios,
    medianPairedRatio: median(pairedRatios),
    checksum: genericChecksum,
    oracleChecksum,
  };
}

function captureRasterArguments(region, helpers, cases) {
  const captured = [];
  const original = region.rasterKernel;
  region.rasterKernel = (_state, _region, _helpers, ...args) => {
    captured.push(args);
  };
  try {
    for (const args of cases) {
      region.wrapperKernel(region.executionState, region, helpers, ...args);
    }
  } finally {
    region.rasterKernel = original;
  }
  return captured.length === cases.length ? captured : null;
}

function readTarget(target) {
  return target.kind === 'map'
    ? target.fields.get(target.key) : target.fields[target.key];
}

function verifyTrustedRasterBridge(region, helpers, family) {
  if (!region.rasterKernel.jvmTrustedRasterBridge) return 0;
  const random = { value: 0x51f15e5d };
  const wrapperArgs = [argumentsFor(family, random, region)];
  const captured = captureRasterArguments(region, helpers, wrapperArgs);
  if (!captured || captured.length !== 1) {
    throw new Error('Could not capture trusted-raster guard operands');
  }
  const plan = region.genericRasterSafetyPlan;
  const rasterArgs = captured[0];
  const destination = rasterArgs[plan.destinationParameter];
  const before = [...destination];
  const originalFallback = region.generatedRasterKernel;
  let fallbacks = 0;
  region.generatedRasterKernel = () => {
    assertPixels(destination, before,
      `trusted bridge fallback ${fallbacks + 1} preceded side effects`);
    fallbacks += 1;
  };
  try {
    const badTag = [...rasterArgs];
    badTag[plan.tagParameter] = (plan.tagValue + 1) | 0;
    region.rasterKernel(region.executionState, region, helpers, ...badTag);

    const shortDestination = [...rasterArgs];
    shortDestination[plan.destinationParameter] = [];
    region.rasterKernel(
      region.executionState, region, helpers, ...shortDestination);

    const rowsTarget = region.staticTargets[plan.rowsStatic];
    const rows = readTarget(rowsTarget);
    const rowParameter = plan.rowParameters[0];
    const row = Math.max(0, rasterArgs[rowParameter] | 0);
    const originalRow = rows[row];
    rows[row] = (originalRow + 1) | 0;
    try {
      region.rasterKernel(region.executionState, region, helpers, ...rasterArgs);
    } finally {
      rows[row] = originalRow;
    }
  } finally {
    region.generatedRasterKernel = originalFallback;
  }
  if (fallbacks !== 3) {
    throw new Error(`Trusted raster bridge performed ${fallbacks}/3 guarded fallbacks`);
  }
  return fallbacks;
}

function generatedShape(region) {
  const wrapper = String(region.wrapperKernel);
  const raster = String(region.rasterKernel);
  const trustedRaster = region.trustedRasterKernel?.jvmLexicalFusedSource || '';
  const scanline = String(region.scanlineKernel);
  const combined = `${wrapper}\n${raster}\n${trustedRaster}\n${scanline}`;
  const forbidden = [
    'new Frame', 'tryInvokeSyncAt', 'runGeneratedFrame', '.stack.items',
  ].filter((token) => combined.includes(token));
  return {
    handwrittenInstalled: Boolean(region.handwrittenWrapperKernel),
    lexicalWrapper: Boolean(region.wrapperKernel.jvmLexicalFusedKernel),
    lexicalRaster: Boolean(region.rasterKernel.jvmLexicalFusedKernel ||
      region.rasterKernel.jvmTrustedRasterBridge),
    trustedRasterBridge: Boolean(region.rasterKernel.jvmTrustedRasterBridge),
    lexicalScanline: Boolean(region.scanlineKernel.jvmLexicalFusedKernel),
    trustedRaster: Boolean(region.trustedRasterKernel?.jvmTrustedFusedRaster),
    verifiedFlatRaster:
      Boolean(region.trustedRasterKernel?.jvmVerifiedFlatRaster),
    trustedScanlineInlines:
      region.trustedRasterKernel?.jvmTrustedScanlineInlineCount || 0,
    trustedConstantArguments:
      region.trustedRasterKernel?.jvmConstantArgumentCount || 0,
    trustedCapturedStatics:
      region.trustedRasterKernel?.jvmCapturedStaticCount || 0,
    trustedRasterSourceBytes:
      region.trustedRasterKernel?.jvmLexicalFusedSource?.length || 0,
    trustedRasterName: region.trustedRasterKernel?.name || null,
    positionalWrapper: region.wrapperKernel.length === 3 +
      parseDescriptor(region.wrapperMethod.descriptor).params.length,
    structuredWrapper: region.semanticWrapperPlan
      ? wrapper.includes('switch(order)')
      : Boolean(region.wrapperKernel.jvmLexicalFusedKernel),
    scalarRasterLocals:
      (region.trustedRasterKernel?.jvmVerifiedFlatRaster ||
       /\blet l\d+/.test(region.rasterKernel.jvmTrustedRasterBridge
         ? trustedRaster : raster)) &&
      (region.rasterKernel.jvmLexicalFusedKernel ||
        region.rasterKernel.jvmTrustedRasterBridge || raster.includes('switch (pc)')),
    rasterPcSwitch: (region.rasterKernel.jvmTrustedRasterBridge
      ? trustedRaster : raster).includes('switch (pc)'),
    countedScalarScanline:
      scanline.includes('for(let offset=0;offset<count;offset+=1)'),
    forbiddenRuntimeDispatch: forbidden,
  };
}

(async () => {
  const baseline = await createRuntime();
  const fused = await createRuntime({ semanticFusedRasters: false });
  // The plan-driven compact raster is the handwritten target. It is enabled
  // only in this differential oracle; the measured/generated runtime above
  // must remain independent from it.
  const target = await createRuntime({ semanticFusedRasters: true });
  const descriptors = ['(IIIIIIIIIIIIZIII)V', '(IIIIIIII)V'];
  const report = [];
  for (const descriptor of descriptors) {
    const baselineCandidate = findWrapper(baseline, descriptor);
    const fusedCandidate = findWrapper(fused, descriptor);
    const targetCandidate = findWrapper(target, descriptor);
    if (process.env.JVM_DEBUG_FUSED_DIFFERENTIAL === '1') {
      console.error(`differential ${descriptor}: ` +
        `${baselineCandidate.owner}.${baselineCandidate.method.name} -> ` +
        `${baselineCandidate.discovered.rasterOwner}.` +
        `${baselineCandidate.discovered.rasterMethod.name}`);
    }
    const baselinePixels = new Array(64 * 64);
    const fusedPixels = new Array(64 * 64);
    const targetPixels = new Array(64 * 64);
    configureRegion(baseline, baselineCandidate, baselinePixels);
    const region = configureRegion(fused, fusedCandidate, fusedPixels);
    const targetRegion = configureRegion(target, targetCandidate, targetPixels);
    if (process.env.JVM_DUMP_FUSED_KERNELS === '1') {
      process.stderr.write(`\n/* ${descriptor} generated wrapper */\n` +
        `${region.wrapperKernel.jvmLexicalFusedSource || region.wrapperKernel}\n` +
        `\n/* ${descriptor} generated raster */\n` +
        `${region.rasterKernel.jvmLexicalFusedSource || region.rasterKernel}\n` +
        `\n/* ${descriptor} generated scanline */\n` +
        `${region.scanlineKernel.jvmLexicalFusedSource || region.scanlineKernel}\n` +
        `\n/* ${descriptor} trusted generic raster */\n` +
        `${region.trustedRasterKernel?.jvmLexicalFusedSource || ''}\n` +
        `\n/* ${descriptor} compact target */\n${targetRegion.rasterKernel}\n`);
    }
    const shape = generatedShape(region);
    if (shape.handwrittenInstalled || shape.forbiddenRuntimeDispatch.length ||
        !shape.positionalWrapper || !shape.structuredWrapper ||
        !shape.lexicalRaster || !shape.scalarRasterLocals ||
        shape.rasterPcSwitch || !shape.countedScalarScanline) {
      throw new Error(`Generated kernel contract failed for ${descriptor}: ` +
        JSON.stringify(shape));
    }
    if (!(targetRegion.semanticGradientRasterPlan ||
        targetRegion.semanticFlatRasterPlan)) {
      throw new Error(`Handwritten target was not structurally derived for ${descriptor}`);
    }
    if (process.env.JVM_DEBUG_FUSED_DIFFERENTIAL === '1') {
      console.error(JSON.stringify({
        keys: region.semanticWrapperPlan?.keys,
        booleanParameters: region.semanticWrapperPlan?.booleanParameters,
        templates: region.semanticWrapperPlan
          ? [...region.semanticWrapperPlan.templates.entries()]
          : [],
      }));
    }
    const beforeGradient = fused.jvm.jit.semanticFusedRasterRunCount | 0;
    const beforeFlat = fused.jvm.jit.semanticFusedFlatRasterRunCount | 0;
    const beforeTargetGradient = target.jvm.jit.semanticFusedRasterRunCount | 0;
    const beforeTargetFlat = target.jvm.jit.semanticFusedFlatRasterRunCount | 0;
    const random = { value: descriptor.length * 0x9e3779b1 >>> 0 };
    let changedPixels = 0;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      for (let index = 0; index < baselinePixels.length; index += 1) {
        const value = Math.imul(index + 1, 0x10203) & 0xffffff;
        baselinePixels[index] = value;
        fusedPixels[index] = value;
        targetPixels[index] = value;
      }
      const args = argumentsFor(
        baselineCandidate.family, random, region, (iteration & 1) !== 0);
      await invokeBaseline(baseline, baselineCandidate, args,
        `${descriptor} iteration ${iteration}`);
      const state = region.executionState;
      const kernel = region.handwrittenWrapperKernel || region.wrapperKernel;
      kernel(state, region, fused.jvm.jit, ...args);
      targetRegion.wrapperKernel(
        targetRegion.executionState, targetRegion, target.jvm.jit, ...args);
      assertPixels(baselinePixels, fusedPixels,
        `${descriptor} iteration ${iteration}`);
      assertPixels(fusedPixels, targetPixels,
        `${descriptor} handwritten target iteration ${iteration} args=${JSON.stringify(args)}`);
      changedPixels += fusedPixels.reduce((count, value, index) =>
        count + ((value | 0) !== (Math.imul(index + 1, 0x10203) & 0xffffff) ? 1 : 0), 0);
    }
    const handwrittenTargetRuns =
      (target.jvm.jit.semanticFusedRasterRunCount | 0) - beforeTargetGradient +
      (target.jvm.jit.semanticFusedFlatRasterRunCount | 0) - beforeTargetFlat;
    if (handwrittenTargetRuns !== iterations) {
      throw new Error(`Handwritten target ran ${handwrittenTargetRuns}/${iterations} ` +
        `times for ${descriptor}`);
    }
    const bridgeGuardChecks = verifyTrustedRasterBridge(
      region, fused.jvm.jit, fusedCandidate.family);
    let benchmark = null;
    let rasterBenchmark = null;
    if (benchmarkEnabled) {
      const benchmarkRandom = {
        value: (descriptor.length * 0x85ebca6b) >>> 0,
      };
      const cases = Array.from({ length: 64 }, () =>
        argumentsFor(fusedCandidate.family, benchmarkRandom, region));
      const genericKernel = region.wrapperKernel.bind(
        null, region.executionState, region, fused.jvm.jit);
      const oracleKernel = targetRegion.wrapperKernel.bind(
        null, targetRegion.executionState, targetRegion, target.jvm.jit);
      benchmark = benchmarkKernels({
        kernel: genericKernel,
        destination: fusedPixels,
      }, {
        kernel: oracleKernel,
        destination: targetPixels,
      }, cases);
      if (benchmark.checksum !== benchmark.oracleChecksum) {
        throw new Error(`Timed checksum mismatch for ${descriptor}`);
      }
      if (region.rasterKernel.jvmTrustedRasterBridge &&
          targetRegion.directRasterKernel) {
        const genericRasterCases = captureRasterArguments(
          region, fused.jvm.jit, cases);
        const targetRasterCases = captureRasterArguments(
          targetRegion, target.jvm.jit, cases);
        if (!genericRasterCases || !targetRasterCases) {
          throw new Error(`Could not capture one raster call per wrapper for ${descriptor}`);
        }
        const captures = region.trustedRasterStaticIndices.map((index) =>
          readTarget(region.staticTargets[index]));
        const targetPlan = targetRegion.semanticGradientRasterPlan ||
          targetRegion.semanticFlatRasterPlan;
        const targetLayout = [
          readTarget(targetRegion.staticTargets[targetPlan.heightStatic]) | 0,
          readTarget(targetRegion.staticTargets[targetPlan.widthStatic]) | 0,
          readTarget(targetRegion.staticTargets[targetPlan.rowsStatic]),
          readTarget(targetRegion.staticTargets[targetPlan.strideStatic]) | 0,
        ];
        rasterBenchmark = benchmarkKernels({
          destination: fusedPixels,
          kernel(...args) {
            return region.trustedRasterKernel(
              region.executionState, region, fused.jvm.jit, ...args, ...captures);
          },
        }, {
          destination: targetPixels,
          kernel(...args) {
            return targetRegion.directRasterKernel(...targetLayout, ...args);
          },
        }, genericRasterCases, targetRasterCases);
        if (rasterBenchmark.checksum !== rasterBenchmark.oracleChecksum) {
          throw new Error(`Timed raster checksum mismatch for ${descriptor}`);
        }
      }
    }
    report.push({ descriptor, iterations, changedPixels,
      compactGradientInstalled: Boolean(region.semanticGradientRasterPlan),
      compactFlatInstalled: Boolean(region.semanticFlatRasterPlan),
      handwrittenWrapperInstalled: Boolean(region.handwrittenWrapperKernel),
      generatedShape: shape,
      lexicalKernelFailures: region.lexicalKernelFailures || {},
      handwrittenTargetDerived: Boolean(targetRegion.semanticGradientRasterPlan ||
        targetRegion.semanticFlatRasterPlan),
      handwrittenTargetRuns,
      compactGradientRuns: (fused.jvm.jit.semanticFusedRasterRunCount | 0) - beforeGradient,
      compactFlatRuns: (fused.jvm.jit.semanticFusedFlatRasterRunCount | 0) - beforeFlat,
      compactFlatRejection: region.semanticFlatRasterRejection || null,
      genericRasterSafetyPlan: region.genericRasterSafetyPlan || null,
      bridgeGuardChecks,
      benchmark, rasterBenchmark });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, classpath, report }, null, 2)}\n`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
