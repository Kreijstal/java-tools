#!/usr/bin/env node
'use strict';

// Firefox counterpart to benchmarkTileDispatchHotLoop.js. It runs the exact
// same class file through three generic runtime configurations so Node's tier
// ranking is never substituted for the browser's:
//   js         structured JavaScript, Wasm gate disabled after JVM reset
//   wasm       structured Wasm over ordinary guest objects/arrays
//   wasm-heap  structured Wasm with canonical linear primitive storage/slabs

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const { firefox } = require('playwright');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'benchmarks', 'TileDispatchHotLoop.java');
const className = 'TileDispatchHotLoop';
const iterations = positiveInteger('TILE_FIREFOX_ITERATIONS', 100000);
const rounds = positiveInteger('TILE_FIREFOX_ROUNDS', 3);
const warmups = positiveInteger('TILE_FIREFOX_WARMUPS', 3);
const executablePath = process.env.FIREFOX_EXECUTABLE_PATH;
const shapeNames = ['arith', 'iface', 'poly', 'tile'];
const variants = [
  {name: 'js', wasm: false, heap: false},
  {name: 'wasm-dispatch', wasm: true, heap: false, structured: false},
  {name: 'wasm', wasm: true, heap: false},
  {name: 'wasm-heap', wasm: true, heap: true},
];

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function compileFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-tile-firefox-'));
  const classes = path.join(directory, 'classes');
  fs.mkdirSync(classes);
  execFileSync('javac', ['-source', '8', '-target', '8', '-d', classes, source], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const jar = path.join(directory, 'tile-dispatch.jar');
  execFileSync('jar', ['cf', jar, '-C', classes, '.']);
  return {directory, jar};
}

function nativeResults(classes) {
  const output = execFileSync('java', [
    '-Xbatch', '-cp', classes, className,
    String(iterations), String(rounds), String(warmups),
  ], {encoding: 'utf8'});
  const elapsed = new Map(shapeNames.map((name) => [name, []]));
  const checksums = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^RESULT (\w+) \d+ (\d+) (-?\d+)$/.exec(line);
    if (!match) continue;
    elapsed.get(match[1]).push(Number(match[2]));
    checksums.set(match[1], Number(match[3]));
  }
  return Object.fromEntries(shapeNames.map((name) => [name, {
    nanosecondsPerIteration: median(elapsed.get(name)) / iterations,
    checksum: checksums.get(name),
  }]));
}

async function runVariant(browser, fixture, variant) {
  const page = await browser.newPage({viewport: {width: 1000, height: 800}});
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  try {
    await page.goto(pathToFileURL(path.join(root, 'dist', 'index.html')).href);
    await page.waitForFunction(() => Boolean(window.JVMDebug?.BrowserJVMDebug));
    const encoded = fs.readFileSync(fixture.jar).toString('base64');
    return await page.evaluate(async ({encodedJar, variant, iterations,
      rounds, warmups, className, shapeNames}) => {
      const bytes = Uint8Array.from(atob(encodedJar), (character) =>
        character.charCodeAt(0));
      const file = new File([bytes], 'tile-dispatch.jar', {
        type: 'application/java-archive',
      });
      const debug = new window.JVMDebug.BrowserJVMDebug();
      await debug.initialize();
      await debug.loadFile(file);
      debug.debugController.options.wasmHeap = variant.heap;
      debug.debugController.options.wasmHeapMb = 64;
      debug.debugController.options.wasmFields = variant.heap;
      debug.debugController.options.jit = {
        enabled: variant.wasm ? false : true,
        warmupThreshold: 0,
        codegen: true,
        preferWholeMethodJs: true,
        rendererPipeline: true,
        scalarLoops: true,
        scalarGuestBodies: true,
        structuredSsa: true,
        compiledCallChains: true,
        wasmStructured: variant.structured !== false,
        wasmCheckcast: true,
        wasmRelaxedReferenceReturns: true,
        wasmDirectStaticLink: true,
        wasmDirectInstanceLink: true,
        profileMethods: false,
        profileTimings: false,
      };
      await debug.run(className, {
        args: [String(iterations), String(rounds), String(warmups)],
        beforeRun({jvm}) {
          jvm.jit.wasmJit.enabled = variant.wasm;
        },
      });
      const jvm = debug.debugController.jvm;
      const fields = jvm.classes[className].staticFields;
      const arrayData = (value) => value?.elements || value || [];
      const nanos = arrayData(fields.get('measuredNanos:[I')).map(Number);
      const checksums = arrayData(fields.get('measuredChecksums:[I')).map(
        (value) => value | 0);
      const rows = {};
      for (let shape = 0; shape < shapeNames.length; shape += 1) {
        const start = shape * rounds;
        const samples = nanos.slice(start, start + rounds);
        rows[shapeNames[shape]] = {
          samples,
          nanosecondsPerIteration: samples.sort((left, right) => left - right)[
            Math.floor(samples.length / 2)] / iterations,
          checksum: checksums[start + rounds - 1],
        };
      }
      const tiers = {};
      for (const [shape, methodName] of Object.entries({
        arith: 'runArith', iface: 'runIface', poly: 'runPoly', tile: 'runTile',
      })) {
        const method = await jvm.findMethodInHierarchy(
          className, methodName, '(II)I');
        const state = jvm.jit.wasmJit.state.get(method);
        const generated = jvm.jit.codegenCache.get(method);
        tiers[shape] = {
          generated: generated?.jvmStructuredSsa ? 'structured-js'
            : generated ? 'other-js' : null,
          wasm: state ? {
            status: state.status,
            runs: state.runs,
            exits: state.exits,
            fuelExits: state.fuelExits,
            structured: Boolean(state.meta?.structured),
            fullyCompiled: Boolean(state.meta?.fullyCompiled),
            normalFlowFullyCompiled: Boolean(
              state.meta?.normalFlowFullyCompiled),
            supportedBlocks: state.meta?.supportedBlocks?.size || 0,
            blocks: state.meta?.blockCount || 0,
            uncoveredItems: state.meta?.uncoveredItems || 0,
            deoptableCalls: state.meta?.deoptableCalls || 0,
            structuredFailReason: state.structuredFailReason || null,
            failReason: state.failReason || state.lastCompileError || null,
            partialDeps: Boolean(state.partialDeps),
            partialDepsStructured: Boolean(state.partialDepsStructured),
            partialDepsUnserviceable: Boolean(state.partialDepsUnserviceable),
            depRecompiles: state.depRecompiles || 0,
            blockers: state.blockers || null,
            blockerSignature: state.blockerSig || null,
            currentBlockerSignature: state.blockers
              ? jvm.jit.wasmJit.blockerSignature(state.blockers) : null,
            demotes: [...(state.meta?.demoteReasons || new Map()).entries()],
            candidateCoverage: state.wasmCandidateCoverage || null,
            directLinks: state.meta?.directLinks || 0,
            inlinedCalls: state.meta?.inlinedCalls || 0,
          } : null,
        };
      }
      tiers.children = {};
      for (const [owner, name, descriptor] of [
        [className, 'makeTile',
          '(ILTileDispatchHotLoop$Cell;IZ)LTileDispatchHotLoop$Tile;'],
        [`${className}$Cache`, 'get',
          '(IJ)LTileDispatchHotLoop$Entry;'],
        [`${className}$Cache`, 'put',
          '(ILTileDispatchHotLoop$Entry;J)V'],
        [`${className}$Tile`, '<init>', '(II)V'],
        [`${className}$Tile`, 'blend',
          '(IILTileDispatchHotLoop$Cell;I)I'],
        [`${className}$Tile`, 'hashCode', '()I'],
      ]) {
        const method = await jvm.findMethodInHierarchy(
          owner, name, descriptor).catch(() => null);
        const state = method && jvm.jit.wasmJit.state.get(method);
        tiers.children[`${owner}.${name}${descriptor}`] = !state ? null : {
          status: state.status,
          entries: state.entries,
          retryAfter: state.retryAfter || null,
          deferredEpoch: state.deferredEpoch ?? null,
          calleeDeferredEpoch: state.calleeDeferredEpoch ?? null,
          calleeBlockers: state.calleeBlockers || null,
          calleeBlockerSignature: state.calleeBlockerSig || null,
          currentCalleeBlockerSignature: state.calleeBlockers
            ? jvm.jit.wasmJit.blockerSignature(state.calleeBlockers) : null,
          calleeRetryEpoch: state.calleeRetryEpoch ?? null,
          blockers: state.blockers || null,
          blockerSignature: state.deferredBlockerSig || state.blockerSig || null,
          runs: state.runs,
          exits: state.exits,
          failReason: state.failReason || state.lastCompileError || null,
          structuredFailReason: state.structuredFailReason || null,
          referenceReturnRejection: state.referenceReturnRejection || null,
          coverage: state.wasmCandidateCoverage || null,
          meta: state.meta ? {
            structured: Boolean(state.meta.structured),
            fullyCompiled: Boolean(state.meta.fullyCompiled),
            normalFlowFullyCompiled: Boolean(
              state.meta.normalFlowFullyCompiled),
            uncoveredItems: state.meta.uncoveredItems || 0,
            deoptableCalls: state.meta.deoptableCalls || 0,
            demotes: [...(state.meta.demoteReasons || new Map()).entries()],
          } : null,
        };
      }
      tiers.classStates = Object.fromEntries([
        className, `${className}$Cache`, `${className}$Entry`,
        `${className}$Tile`, `${className}$PlainCell`,
        `${className}$ScaledCell`, `${className}$ClippedCell`,
      ].map((name) => [name,
        jvm.classInitializationState.get(name) || null]));
      return {rows, tiers, userAgent: navigator.userAgent};
    }, {encodedJar: encoded, variant, iterations, rounds, warmups,
      className, shapeNames});
  } finally {
    await page.close();
  }
}

(async () => {
  const bundle = path.join(root, 'dist', 'jvm-debug.js');
  if (!fs.existsSync(bundle)) {
    throw new Error('dist/jvm-debug.js is missing; run npm run build:bundle first');
  }
  const fixture = compileFixture();
  const native = nativeResults(path.join(fixture.directory, 'classes'));
  const launchOptions = {headless: true};
  if (executablePath) launchOptions.executablePath = executablePath;
  let browser;
  try {
    browser = await firefox.launch(launchOptions);
    const measured = {};
    for (const variant of variants) {
      measured[variant.name] = await runVariant(browser, fixture, variant);
    }
    for (const result of Object.values(measured)) {
      for (const name of shapeNames) {
        if (result.rows[name].checksum !== native[name].checksum) {
          throw new Error(`${name} checksum mismatch: ${
            result.rows[name].checksum} !== ${native[name].checksum}`);
        }
        result.rows[name].slowdownVsHotSpot =
          result.rows[name].nanosecondsPerIteration /
          native[name].nanosecondsPerIteration;
      }
    }
    process.stdout.write(`${JSON.stringify({
      iterations, rounds, warmups, native, measured,
    }, null, 2)}\n`);
  } finally {
    if (browser) await browser.close();
    fs.rmSync(fixture.directory, {recursive: true, force: true});
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
