#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const HandwrittenAffineSpriteRaster =
  require('../src/jit/HandwrittenAffineSpriteRaster');

const classDirectory = process.argv[2];
const semanticClassDirectory = process.argv[3] || classDirectory;
if (!classDirectory) {
  console.error(
    'Usage: node scripts/benchmarkSsaAffineSpriteKernel.js ' +
    '<class-directory> [oracle-class-directory]');
  process.exit(2);
}

const iterations = positiveInteger('SSA_AFFINE_ITERATIONS', 3000);
const rounds = positiveInteger('SSA_AFFINE_ROUNDS', 7);
const warmups = positiveInteger('SSA_AFFINE_WARMUPS', 4);
const width = positiveInteger('SSA_AFFINE_WIDTH', 64);
const height = positiveInteger('SSA_AFFINE_HEIGHT', 64);

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

function classNames(directory) {
  const names = [];
  const visit = (absolute, relative = '') => {
    for (const entry of fs.readdirSync(absolute, {withFileTypes: true})) {
      const child = path.join(absolute, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        visit(child, childRelative);
      } else if (entry.isFile() && entry.name.endsWith('.class')) {
        names.push(childRelative.slice(0, -6).split(path.sep).join('/'));
      }
    }
  };
  visit(directory);
  return names;
}

function hashClassTree(directory) {
  const digest = crypto.createHash('sha256');
  const names = classNames(directory).sort();
  for (const name of names) {
    digest.update(name);
    digest.update('\0');
    digest.update(fs.readFileSync(path.join(directory, `${name}.class`)));
    digest.update('\0');
  }
  return {sha256: digest.digest('hex'), files: names.length};
}

function repositoryMetadata(directory) {
  const git = (...args) => execFileSync(
    'git', ['-C', directory, ...args],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const status = git('status', '--porcelain');
  const trackedDiff = execFileSync(
    'git', ['-C', directory, 'diff', '--binary', 'HEAD']);
  return {
    commitSha1: git('rev-parse', 'HEAD'),
    treeSha1: git('rev-parse', 'HEAD^{tree}'),
    trackedDirty: Boolean(git(
      'status', '--porcelain', '--untracked-files=no')),
    anyDirty: Boolean(status),
    trackedDiffSha256:
      crypto.createHash('sha256').update(trackedDiff).digest('hex'),
  };
}

function writeStatic(jvm, ref, value) {
  const owner = ref[1];
  const [name, descriptor] = ref[2];
  jvm.classes[owner].staticFields.set(`${name}:${descriptor}`, value);
}

function intArray(length, initialize) {
  const value = Array.from(
    {length}, (_unused, index) => initialize(index) | 0);
  value.type = '[I';
  return value;
}

function checksum(values) {
  let result = 0;
  for (let index = 0; index < values.length; index += 1) {
    result = (Math.imul(result, 31) + values[index]) | 0;
  }
  return result;
}

async function loadRuntime(directory, semanticFallback = null) {
  const jvm = new JVM({classpath: [directory], jit: {
    warmupThreshold: 0,
    preferWholeMethodJs: true,
    profileMethods: false,
    structuredSsa: true,
    fusedRegions: false,
    guestKernelOracles: false,
  }});
  for (const name of classNames(directory)) {
    try {
      await jvm.loadClassByName(name);
    } catch (_) {
      // The structural target cannot depend on an unloadable owner. Continue
      // scanning the independent classes in mixed diagnostic directories.
    }
  }
  for (const [name, classData] of Object.entries(jvm.classes)) {
    classData.staticFieldsInitialized = true;
    jvm.classInitializationState.set(name, 'INITIALIZED');
    jvm.getClassInitializationToken(name).initialized = true;
  }
  const matches = [];
  for (const [owner, classData] of Object.entries(jvm.classes)) {
    for (const item of classData.ast?.classes?.[0]?.items || []) {
      if (item?.type !== 'method') continue;
      const method = item.method;
      if (!HandwrittenAffineSpriteRaster.DESCRIPTOR.test(method.descriptor)) {
        continue;
      }
      const semantic = HandwrittenAffineSpriteRaster.analyze(
        jvm.jit, method, method.descriptor);
      if (semantic) matches.push({owner, method, semantic});
    }
  }
  if (matches.length === 0 && semanticFallback) {
    for (const [owner, classData] of Object.entries(jvm.classes)) {
      for (const item of classData.ast?.classes?.[0]?.items || []) {
        if (item?.type !== 'method' ||
            item.method.descriptor !== semanticFallback.method.descriptor) {
          continue;
        }
        const calls = jvm.jit.getCodeItems(item.method)
          .map((codeItem) => codeItem?.instruction)
          .filter((instruction) =>
            instruction?.op === 'invokestatic' &&
            instruction.arg?.[2]?.[1] === '(III)I');
        if (calls.length !== 2 ||
            JSON.stringify(calls[0].arg) !== JSON.stringify(calls[1].arg)) {
          continue;
        }
        const fieldsAvailable = Object.values(semanticFallback.semantic.fields)
          .every((ref) => Boolean(jvm.classes[ref[1]]));
        if (fieldsAvailable) {
          matches.push({
            owner,
            method: item.method,
            semantic: semanticFallback.semantic,
          });
        }
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `expected one structurally verified affine raster, found ${matches.length}`);
  }
  return {jvm, ...matches[0]};
}

function benchmarkPair(generic, oracle) {
  const batches = new Map([
    [generic, () => {
      for (let index = 0; index < iterations; index += 1) generic.invoke();
    }],
    [oracle, () => {
      for (let index = 0; index < iterations; index += 1) oracle.invoke();
    }],
  ]);
  for (let warmup = 0; warmup < warmups; warmup += 1) {
    const order = warmup & 1 ? [oracle, generic] : [generic, oracle];
    for (const target of order) batches.get(target)();
  }
  for (const target of [generic, oracle]) {
    target.elapsed = [];
    target.result = 0;
  }
  for (let round = 0; round < rounds; round += 1) {
    const order = round & 1
      ? [oracle, generic, generic, oracle]
      : [generic, oracle, oracle, generic];
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
  return {
    generic,
    oracle,
    pairedRatios: generic.elapsed.map(
      (elapsed, index) => elapsed / oracle.elapsed[index]),
  };
}

(async () => {
  const resolvedClassDirectory = path.resolve(classDirectory);
  const resolvedSemanticClassDirectory = path.resolve(semanticClassDirectory);
  const semanticRuntime = resolvedSemanticClassDirectory === resolvedClassDirectory
    ? null : await loadRuntime(resolvedSemanticClassDirectory);
  const {jvm, owner, method, semantic} = await loadRuntime(
    resolvedClassDirectory, semanticRuntime);
  const sourcePixels = intArray(width * height, index =>
    index % 11 === 0 ? 0 : Math.imul(index + 1, 0x10203));
  const genericDestination = intArray(width * height, () => 0);
  const oracleDestination = intArray(width * height, () => 0);
  const maskPixels = Array.from(
    {length: width * height}, (_unused, index) => index % 7 ? 1 : 0);
  maskPixels.type = '[B';
  const fields = semantic.fields;
  writeStatic(jvm, fields.clipOuterStart, 0);
  writeStatic(jvm, fields.clipOuterEnd, width);
  writeStatic(jvm, fields.clipInnerStart, 0);
  writeStatic(jvm, fields.clipInnerEnd, height);
  writeStatic(jvm, fields.surfaceStride, width);
  writeStatic(jvm, fields.destination, genericDestination);

  const generated = jvm.jit.structuredSsa.compile(method);
  if (!generated?.jvmStructuredSsa ||
      typeof generated.jvmRestoringDirectPositionalBody !== 'function') {
    throw new Error('generic SSA did not publish a restoring positional body');
  }
  // Static fields were deliberately populated after class loading. Link their
  // ordinary direct locations exactly as a warmed generated entry does.
  for (let site = 1; site < jvm.jit.fieldSites.length; site += 1) {
    jvm.jit.registerDirectStaticTarget(site, true);
  }

  const spriteWidthSite = jvm.jit.registerFieldSite(fields.spriteWidth);
  const spriteHeightSite = jvm.jit.registerFieldSite(fields.spriteHeight);
  const spritePixelsSite = jvm.jit.registerFieldSite(fields.spritePixels);
  const maskPixelsSite = jvm.jit.registerFieldSite(fields.maskPixels);
  const sprite = {type: fields.spriteWidth[1], fields: {
    [jvm.jit.fieldSites[spriteWidthSite].directInstanceKey]: width,
    [jvm.jit.fieldSites[spriteHeightSite].directInstanceKey]: height,
    [jvm.jit.fieldSites[spritePixelsSite].directInstanceKey]: sourcePixels,
  }};
  const mask = {type: fields.maskPixels[1], fields: {
    [jvm.jit.fieldSites[maskPixelsSite].directInstanceKey]: maskPixels,
  }};
  const arguments_ = [
    0, width, 0, 0, height, height,
    0, 0, 0, -1,
  ];
  const thread = {
    id: 1,
    name: 'ssa-affine-raster',
    status: 'runnable',
    pendingException: null,
    callStack: new Stack(),
  };
  const plan = {
    target: {freeFrame: null},
    Frame,
    lookupClass: owner,
    method,
    restoreFrame(currentThread, frame, depth) {
      if (!currentThread.callStack.items.includes(frame)) {
        currentThread.callStack.items.splice(depth, 0, frame);
      }
    },
  };

  // Resolve the two identical pure arithmetic helper sites before measuring.
  // This uses the normal method resolver and does not inject an algorithm.
  for (let site = 1; site < jvm.jit.syncCallSites.length; site += 1) {
    if (!jvm.jit.syncCallSites[site]) continue;
    const dummy = new Frame(method);
    dummy.className = owner;
    dummy.stack.items.push(23841, 64, 0);
    thread.callStack.push(dummy);
    jvm.jit.tryInvokeSyncAt(site, dummy, thread);
    thread.callStack.items.length = 0;
  }

  const body = generated.jvmRestoringDirectPositionalBody;
  const generic = {
    destination: genericDestination,
    invoke() {
      return body(jvm.jit, plan, sprite, mask, ...arguments_, thread, true);
    },
  };
  const oracleData = {
    width,
    height,
    source: sourcePixels,
    mask: maskPixels,
    destination: oracleDestination,
    clipOuterStart: 0,
    clipOuterEnd: width,
    clipInnerStart: 0,
    clipInnerEnd: height,
    surfaceStride: width,
  };
  const oracle = {
    destination: oracleDestination,
    invoke() {
      if (!HandwrittenAffineSpriteRaster._test.runRaster(
        oracleData, arguments_)) {
        throw new Error('handwritten oracle rejected benchmark input');
      }
    },
  };
  const coldResult = generic.invoke();
  oracle.invoke();
  if (checksum(genericDestination) !== checksum(oracleDestination)) {
    const firstDifference = genericDestination.findIndex(
      (value, index) => value !== oracleDestination[index]);
    throw new Error(
      `generic SSA and handwritten oracle disagree before timing ` +
      `(first difference ${firstDifference}, generic ` +
      `${genericDestination[firstDifference]}, oracle ` +
      `${oracleDestination[firstDifference]}, result ` +
      `${JSON.stringify(coldResult)})`);
  }

  const measured = benchmarkPair(generic, oracle);
  if (measured.generic.result !== measured.oracle.result) {
    throw new Error(
      `checksum mismatch: SSA=${measured.generic.result}, ` +
      `oracle=${measured.oracle.result}`);
  }
  const genericMedian = median(measured.generic.elapsed);
  const oracleMedian = median(measured.oracle.elapsed);
  process.stdout.write(`${JSON.stringify({
    node: process.version,
    classDirectory: resolvedClassDirectory,
    oracleClassDirectory: resolvedSemanticClassDirectory,
    structuralTarget: {
      owner,
      descriptor: method.descriptor,
      callerFingerprint: semantic.callerFingerprint,
      helperFingerprint: semantic.helperFingerprint,
      suiteFingerprint: semantic.suiteFingerprint,
    },
    width,
    height,
    iterations,
    rounds,
    warmups,
    generic: {
      medianMs: genericMedian / 1e6,
      nanosecondsPerInvocation: genericMedian / (iterations * 2),
      checksum: measured.generic.result,
    },
    oracle: {
      medianMs: oracleMedian / 1e6,
      nanosecondsPerInvocation: oracleMedian / (iterations * 2),
      checksum: measured.oracle.result,
    },
    ssaToOracleRatio: genericMedian / oracleMedian,
    medianPairedRatio: median(measured.pairedRatios),
    pairedRatios: measured.pairedRatios,
    provenance: {
      javaTools: repositoryMetadata(path.resolve(__dirname, '..')),
      measuredClasses: hashClassTree(resolvedClassDirectory),
      oracleClasses: hashClassTree(resolvedSemanticClassDirectory),
      environment: Object.fromEntries(
        Object.entries(process.env)
          .filter(([name]) => name.startsWith('JVM_') ||
            name.startsWith('SSA_AFFINE_'))
          .sort(([left], [right]) => left.localeCompare(right))),
    },
    generated: {
      sourceBytes: Buffer.byteLength(
        generated.jvmRestoringDirectPositionalSource),
      loopCount: generated.jvmStructuredLoopCount,
      coarseLoopCount: generated.jvmStructuredCoarseCountedLoopCount,
      versionedRuntimeLoops:
        (generated.jvmRestoringDirectPositionalSource
          .match(/if \(ssaRuntimeCoarseLoop\d+/g) || []).length,
      eagerEntryFields: generated.jvmStructuredEagerEntryFieldCount,
      recurrenceRanges: generated.jvmStructuredRecurrenceRangeCount,
      specializedRangeAccesses:
        generated.jvmStructuredSpecializedArrayRangeAccessCount,
      source: process.env.SSA_AFFINE_PRINT_SOURCE === '1'
        ? generated.jvmRestoringDirectPositionalSource
        : undefined,
    },
  }, null, 2)}\n`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
