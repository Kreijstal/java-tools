#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

const classpath = path.resolve(process.argv[2] || '');
const iterations = Number(process.argv[3] || 200);
if (!process.argv[2] || !fs.statSync(classpath, { throwIfNoEntry: false })?.isDirectory() ||
    !Number.isInteger(iterations) || iterations <= 0) {
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

async function createRuntime() {
  const jvm = new JVM({ classpath: [classpath], jit: {
    warmupThreshold: 0,
    preferWholeMethodJs: true,
    fusedRegions: false,
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
    writeTarget(region.staticTargets[rasterPlan.heightStatic], 48);
    writeTarget(region.staticTargets[rasterPlan.widthStatic], 64);
    writeTarget(region.staticTargets[rasterPlan.rowsStatic],
      Array.from({ length: 48 }, (_, row) => row * 64));
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

function argumentsFor(family, random, region) {
  const coordinate = () => 2 + nextRandom(random) % 60;
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

(async () => {
  const baseline = await createRuntime();
  const fused = await createRuntime();
  const descriptors = ['(IIIIIIIIIIIIZIII)V', '(IIIIIIII)V'];
  const report = [];
  for (const descriptor of descriptors) {
    const baselineCandidate = findWrapper(baseline, descriptor);
    const fusedCandidate = findWrapper(fused, descriptor);
    if (process.env.JVM_DEBUG_FUSED_DIFFERENTIAL === '1') {
      console.error(`differential ${descriptor}: ` +
        `${baselineCandidate.owner}.${baselineCandidate.method.name} -> ` +
        `${baselineCandidate.discovered.rasterOwner}.` +
        `${baselineCandidate.discovered.rasterMethod.name}`);
    }
    const baselinePixels = new Array(64 * 64);
    const fusedPixels = new Array(64 * 64);
    configureRegion(baseline, baselineCandidate, baselinePixels);
    const region = configureRegion(fused, fusedCandidate, fusedPixels);
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
    const random = { value: descriptor.length * 0x9e3779b1 >>> 0 };
    let changedPixels = 0;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      for (let index = 0; index < baselinePixels.length; index += 1) {
        const value = Math.imul(index + 1, 0x10203) & 0xffffff;
        baselinePixels[index] = value;
        fusedPixels[index] = value;
      }
      const args = argumentsFor(baselineCandidate.family, random, region);
      await invokeBaseline(baseline, baselineCandidate, args,
        `${descriptor} iteration ${iteration}`);
      const state = region.executionState;
      const kernel = region.handwrittenWrapperKernel || region.wrapperKernel;
      kernel(state, region, fused.jvm.jit, ...args);
      assertPixels(baselinePixels, fusedPixels,
        `${descriptor} iteration ${iteration}`);
      changedPixels += fusedPixels.reduce((count, value, index) =>
        count + ((value | 0) !== (Math.imul(index + 1, 0x10203) & 0xffffff) ? 1 : 0), 0);
    }
    report.push({ descriptor, iterations, changedPixels,
      compactGradientInstalled: Boolean(region.semanticGradientRasterPlan),
      compactFlatInstalled: Boolean(region.semanticFlatRasterPlan),
      handwrittenWrapperInstalled: Boolean(region.handwrittenWrapperKernel),
      compactGradientRuns: (fused.jvm.jit.semanticFusedRasterRunCount | 0) - beforeGradient,
      compactFlatRuns: (fused.jvm.jit.semanticFusedFlatRasterRunCount | 0) - beforeFlat,
      compactFlatRejection: region.semanticFlatRasterRejection || null });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, classpath, report }, null, 2)}\n`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
