'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {pathToFileURL} = require('url');
const {firefox} = require('playwright');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'benchmarks', 'RasterDispatchHotLoop.java');
const source = fs.readFileSync(sourcePath, 'utf8');
const className = 'RasterDispatchHotLoop';
const iterations = positiveInteger('RASTER_FIREFOX_ITERATIONS', 100000);
const rounds = positiveInteger('RASTER_FIREFOX_ROUNDS', 3);
const warmups = positiveInteger('RASTER_FIREFOX_WARMUPS', 3);
const executablePath = process.env.FIREFOX_EXECUTABLE_PATH;
const shapeNames = ['raster', 'mono', 'static'];
const variants = [
  {name: 'js', codegen: true, wasm: false, heap: false},
  {name: 'wasm', codegen: false, wasm: true, heap: false},
  {name: 'hybrid', codegen: true, wasm: true, heap: false},
  {name: 'wasm-heap', codegen: false, wasm: true, heap: true},
  {name: 'hybrid-heap', codegen: true, wasm: true, heap: true},
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

function nativeResult() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'raster-hotspot-'));
  try {
    execFileSync('javac', ['-source', '8', '-target', '8', '-d', directory,
      sourcePath], {stdio: ['ignore', 'ignore', 'pipe']});
    const output = execFileSync('java', ['-Xbatch', '-cp', directory, className,
      String(iterations), String(rounds), String(warmups)], {encoding: 'utf8'});
    const samples = new Map(shapeNames.map((name) => [name, []]));
    const checksums = new Map();
    for (const line of output.split(/\r?\n/)) {
      const match = /^RESULT (raster|mono|static) \d+ (\d+) (-?\d+)$/.exec(line);
      if (!match) continue;
      samples.get(match[1]).push(Number(match[2]));
      checksums.set(match[1], Number(match[3]));
    }
    return Object.fromEntries(shapeNames.map((name) => [name, {
      samples: samples.get(name),
      nanosecondsPerDispatch: median(samples.get(name)) / iterations,
      checksum: checksums.get(name),
    }]));
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

async function runVariant(browser, variant) {
  const page = await browser.newPage({viewport: {width: 1000, height: 800}});
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  try {
    await page.goto(pathToFileURL(path.join(root, 'dist', 'index.html')).href);
    await page.waitForFunction(() => Boolean(window.JVMDebug?.BrowserJVMDebug));
    const result = await page.evaluate(async ({source, className, iterations,
      rounds, warmups, variant}) => {
      const debug = new window.JVMDebug.BrowserJVMDebug();
      await debug.initialize();
      await debug.ensureWorkspace();
      debug.writeWorkspaceFile(`/src/${className}.java`, source);
      const compiled = debug.compileWorkspace([`/src/${className}.java`], {
        sourceRoot: '/src', outputDir: '/classes', sourceLevel: '8',
      });
      debug.getFileProvider().addClasspathRoot('/classes');
      debug.debugController.options.wasmHeap = variant.heap;
      debug.debugController.options.wasmHeapMb = 64;
      debug.debugController.options.wasmFields = variant.heap;
      debug.debugController.options.jit = {
        enabled: variant.codegen,
        warmupThreshold: 0,
        codegen: true,
        preferWholeMethodJs: true,
        rendererPipeline: true,
        scalarLoops: true,
        scalarGuestBodies: true,
        structuredSsa: true,
        compiledCallChains: true,
        wasmStructured: true,
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
          jvm.jit.enabled = variant.codegen;
          jvm.jit.wasmJit.enabled = variant.wasm;
        },
      });
      const jvm = debug.debugController.jvm;
      const fields = jvm.classes[className].staticFields;
      const arrayData = (value) => value?.elements || value || [];
      const rows = Object.fromEntries([
        ['raster', 'measured'],
        ['mono', 'measuredMono'],
        ['static', 'measuredStatic'],
      ].map(([name, prefix]) => {
        const samplesMicros = arrayData(fields.get(`${prefix}Micros:[I`))
          .map(Number);
        const checksums = arrayData(fields.get(`${prefix}Checksums:[I`))
          .map((value) => value | 0);
        const ordered = [...samplesMicros].sort((left, right) => left - right);
        return [name, {
          samplesMicros,
          nanosecondsPerDispatch:
            ordered[Math.floor(ordered.length / 2)] * 1000 / iterations,
          checksum: checksums[checksums.length - 1],
        }];
      }));
      const stateDescription = (owner, name, descriptor) => {
        const cd = jvm.classes[owner];
        const method = cd && jvm.findMethod(cd, name, descriptor);
        if (!method) return null;
        const st = jvm.jit.wasmJit.state.get(method);
        const generated = jvm.jit.codegenCache.get(method);
        return {
          generated: generated
            ? (generated.jvmStructuredSsa ? 'structured-js' : 'js') : null,
          wasm: st ? {
            status: st.status,
            runs: st.runs || 0,
            exits: st.exits || 0,
            fullyCompiled: Boolean(st.meta?.fullyCompiled),
            normalFlowFullyCompiled: Boolean(st.meta?.normalFlowFullyCompiled),
            structured: Boolean(st.meta?.structured),
            directLinks: st.meta?.directLinks || 0,
            inlinedCalls: st.meta?.inlinedCalls || 0,
            deoptableCalls: st.meta?.deoptableCalls || 0,
            demotes: [...(st.meta?.demoteReasons || new Map()).values()],
          } : null,
        };
      };
      return {
        compiler: 'javac.js',
        artifacts: compiled.artifacts.map((artifact) => artifact.internalName),
        rows,
        states: {
          root: stateDescription(className, 'runRaster', '(II)I'),
          monoRoot: stateDescription(className, 'runMonomorphic', '(II)I'),
          staticRoot: stateDescription(className, 'runStatic', '(II)I'),
          opaque: stateDescription(`${className}$OpaqueSprite`, 'draw',
            '([III)V'),
          masked: stateDescription(`${className}$MaskedSprite`, 'draw',
            '([III)V'),
          additive: stateDescription(`${className}$AdditiveSprite`, 'draw',
            '([III)V'),
          blitOpaque: stateDescription(className, 'blitOpaque',
            '([I[IIIII)V'),
          blitMasked: stateDescription(className, 'blitMasked',
            '([I[IIIII)V'),
          blitAdditive: stateDescription(className, 'blitAdditive',
            '([I[IIIII)V'),
        },
        heapBytes: jvm.wasmHeap?.top || 0,
        userAgent: navigator.userAgent,
      };
    }, {source, className, iterations, rounds, warmups, variant});
    if (pageErrors.length) result.pageErrors = pageErrors;
    return result;
  } finally {
    await page.close();
  }
}

(async () => {
  const bundle = path.join(root, 'dist', 'jvm-debug.js');
  if (!fs.existsSync(bundle)) {
    throw new Error('dist/jvm-debug.js is missing; run npm run build:bundle first');
  }
  const native = nativeResult();
  const launchOptions = {headless: true};
  if (executablePath) launchOptions.executablePath = executablePath;
  let browser;
  try {
    browser = await firefox.launch(launchOptions);
    const measured = {};
    for (const variant of variants) {
      measured[variant.name] = await runVariant(browser, variant);
      for (const shape of shapeNames) {
        const row = measured[variant.name].rows[shape];
        if (row.checksum !== native[shape].checksum) {
          throw new Error(`${variant.name}/${shape} checksum mismatch: ` +
            `${row.checksum} !== ${native[shape].checksum}`);
        }
        row.slowdownVsHotSpot = row.nanosecondsPerDispatch /
          native[shape].nanosecondsPerDispatch;
      }
    }
    process.stdout.write(`${JSON.stringify({iterations, rounds, warmups,
      native, measured}, null, 2)}\n`);
  } finally {
    if (browser) await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
