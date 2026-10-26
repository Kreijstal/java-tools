'use strict';
// Isolate the changed compiler/runtime modules from unrelated working edits.
// Each sample uses a fresh VM and the same compiled Java fixture. Timings
// cover the compiled array loop only, not startup, collection or game FPS.
const {execFileSync, spawnSync} = require('node:child_process');
const {readFileSync, rmSync} = require('node:fs');
const {createHash} = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');
const root = path.join(__dirname, '..');
const changed = ['src/core/freeExtents.js', 'src/core/wasmHeap.js', 'src/core/jvm.js', 'src/core/browserMemory.js',
  'src/jit/closed/representation.js', 'src/jit/closed/ClosedCompiler.js', 'src/jit/closed/primitiveSpillArray.js'];

if (process.argv[2] === '--browser') {
  benchmarkFirefox().catch(error => {console.error(error); process.exitCode = 1;});
} else if (process.argv[2] !== '--sample') {
  const index = process.argv.indexOf('--baseline');
  const baseline = execFileSync('git', ['rev-parse', index < 0 ? 'HEAD' : process.argv[index + 1]],
    {cwd: root, encoding: 'utf8'}).trim();
  const candidateIndex = process.argv.indexOf('--candidate');
  const candidate = candidateIndex < 0 ? 'INDEX' : execFileSync('git',
    ['rev-parse', process.argv[candidateIndex + 1]], {cwd: root, encoding: 'utf8'}).trim();
  for (const variant of ['baseline', 'candidate', 'candidate', 'baseline',
    'baseline', 'candidate', 'candidate', 'baseline']) {
    const output = execFileSync(process.execPath, [__filename, '--sample', baseline, variant, candidate,
      process.argv.includes('--allocation-only') ? 'allocation' : 'loop'],
      {cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
    for (const line of output.split('\n')) if (line.startsWith('OVERFLOW_BENCH ')) console.log(line.slice(15));
  }
} else {
  const baseline = process.argv[3], variant = process.argv[4], candidate = process.argv[5];
  const names = execFileSync('git', ['ls-tree', '-r', '--name-only', baseline, 'src'],
    {cwd: root, encoding: 'utf8'}).trim().split('\n').filter(name => /\.(js|json)$/.test(name));
  const bytes = execFileSync('git', ['cat-file', '--batch'], {cwd: root,
    input: names.map(name => baseline + ':' + name).join('\n') + '\n', maxBuffer: 128 * 1024 * 1024});
  const sources = new Map(); let offset = 0;
  for (const name of names) {
    const end = bytes.indexOf(10, offset), size = Number(bytes.subarray(offset, end).toString().split(' ')[2]);
    if (!Number.isSafeInteger(size)) throw Error('Missing source: ' + name);
    offset = end + 1; sources.set(path.join(root, name), bytes.subarray(offset, offset + size).toString()); offset += size + 1;
  }
  if (variant === 'candidate') for (const name of changed) {
    const result = spawnSync('git', ['show', (candidate === 'INDEX' ? ':' : candidate + ':') + name], {cwd: root, encoding: 'utf8'});
    if (result.status === 0) sources.set(path.join(root, name), result.stdout);
    else if (sources.has(path.join(root, name))) throw Error('Candidate source missing: ' + name);
    // New dependencies may not exist in an older candidate. If its modules
    // actually require one, the pinned loader below still refuses that load.
  }
  const jreRoot = path.join(root, 'src/jre') + path.sep;
  const jreFiles = [...sources.keys()].filter(name => name.startsWith(jreRoot) && name.endsWith('.js') && !name.endsWith('/index.js')).sort();
  sources.set(path.join(jreRoot, 'index.js'), 'module.exports={' + jreFiles.map(name =>
    JSON.stringify(name.slice(jreRoot.length, -3)) + ':require(' + JSON.stringify('./' + name.slice(jreRoot.length)) + ')').join(',') + '};');
  const sourceHash = createHash('sha256');
  for (const [name, text] of [...sources].sort(([a], [b]) => a.localeCompare(b))) sourceHash.update(path.relative(root, name)).update('\0').update(text).update('\0');
  const sourceSha256 = sourceHash.digest('hex');
  for (const extension of ['.js', '.json']) {
    const original = Module._extensions[extension];
    Module._extensions[extension] = (module, file) => {
      if (!file.startsWith(path.join(root, 'src') + path.sep)) return original(module, file);
      if (!sources.has(file)) throw Error('Unpinned source: ' + file);
      if (extension === '.js') module._compile(sources.get(file), file);
      else module.exports = JSON.parse(sources.get(file));
    };
  }
  (async () => {
    if (process.argv[6] === 'allocation') {
      const {WasmHeap} = require('../src/core/wasmHeap');
      const {ClosedRuntime} = require('../src/jit/closed/representation');
      const heap = new WasmHeap(0.0625);
      const runtime = new ClosedRuntime({wasmHeap: heap, classes: {}, jre: {}, nextHashCode: 1});
      heap.allocExtent('[B', heap.limit - heap.top);
      runtime.newPrimitiveArray('[I', 1); // resolve lazy helpers before timing
      const held = [], start = performance.now();
      for (let i = 0; i < 10000; i++) held.push(runtime.newPrimitiveArray('[I', 16 + i % 64));
      const ms = performance.now() - start;
      if (runtime.spilledArrays !== 10001 || runtime.toJs(held[0])[0] !== 0) throw Error('Invalid overflow allocation result');
      console.log('OVERFLOW_BENCH ' + JSON.stringify({variant, baseline, candidate, sourceSha256,
        mode: 'allocation', count: held.length, ms, spilledArrays: runtime.spilledArrays, heapLimit: heap.limit}));
      return;
    }
    const {JVM} = require('../src/core/jvm');
    const {compileFixture} = require('../test/helpers/closedWorld');
    const directory = compileFixture('ClosedOverflowLoop');
    try {
      for (const wasmHeapMb of [0.0625, 8]) {
        const jvm = new JVM({classpath: directory, wasmHeap: true, wasmHeapMb, closedWorld: true, jit: {compileWorker: false}});
        await jvm.run('ClosedOverflowLoop');
        const world = jvm.jit.closedWorld, record = world.entries.get('ClosedOverflowLoop.sum([II)I');
        if (!record?.fn) throw Error('Loop was not compiled');
        // The microbenchmark runs one synchronous entry; scheduling is outside
        // its scope and must not suspend a raw Wasm call in the driver.
        world.sliceExpired = () => false;
        const store = world.runtime.newPrimitiveArray('[I', 65536), view = world.runtime.toJs(store);
        for (let i = 0; i < view.length; i++) view[i] = i & 255;
        const start = performance.now();
        const checksum = world.invokeEntry(record, [store, 64], null);
        const ms = performance.now() - start;
        if (checksum !== 534773760) throw Error('Wrong checksum: ' + checksum);
        console.log('OVERFLOW_BENCH ' + JSON.stringify({variant, baseline, candidate, sourceSha256,
          fixtureSha256: createHash('sha256').update(readFileSync(path.join(directory, 'ClosedOverflowLoop.class'))).digest('hex'),
          wasmHeapMb, ms, checksum, spilled: world.runtime.ops.parrBase(store) < 0,
          moduleBytes: world.moduleBytes, pureArrayImports: [...world.imports.entries()].filter(([key, value]) => key.startsWith('spill:') && value.pure).length}));
      }
    } finally {rmSync(directory, {recursive: true, force: true});}
  })().catch(error => {console.error(error); process.exitCode = 1;});
}

async function benchmarkFirefox() {
  const {firefox} = require('playwright');
  const {compileFixture} = require('../test/helpers/closedWorld');
  const directory = compileFixture('ClosedOverflowLoop');
  const bytes = Array.from(readFileSync(path.join(directory, 'ClosedOverflowLoop.class')));
  const bundles = Object.fromEntries(['baseline', 'candidate'].map((variant, index) => {
    const source = readFileSync(path.resolve(process.argv[index + 3]), 'utf8');
    return [variant, {source, sha256: createHash('sha256').update(source).digest('hex')}];
  }));
  try {
    for (const variant of ['baseline', 'candidate', 'candidate', 'baseline',
      'baseline', 'candidate', 'candidate', 'baseline']) {
      const browser = await firefox.launch({headless: true});
      try {
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.route('**/*', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Owned allocator benchmark</title>'}));
        await page.goto('http://allocator.test/');
        await page.addScriptTag({content: bundles[variant].source});
        const results = await page.evaluate(async bytes => {
          const results = [];
          for (const wasmHeapMb of [0.0625, 8]) {
            const debug = new JVMDebug.BrowserJVMDebug();
            await debug.initialize();
            debug.fileProvider.virtualFS.set('ClosedOverflowLoop.class', new Uint8Array(bytes));
            debug.debugController.options = {classpath: ['.'], wasmHeap: true, wasmHeapMb,
              closedWorld: true, rewindHistorySize: 0, jit: {compileWorker: false}};
            await debug.run('ClosedOverflowLoop');
            const world = debug.debugController.jvm.jit.closedWorld;
            const record = world.entries.get('ClosedOverflowLoop.sum([II)I');
            if (!record?.fn) throw Error('Loop was not compiled');
            world.sliceExpired = () => false;
            const store = world.runtime.newPrimitiveArray('[I', 65536), view = world.runtime.toJs(store);
            for (let i = 0; i < view.length; i++) view[i] = i & 255;
            const start = performance.now();
            const checksum = world.invokeEntry(record, [store, 64], null);
            const ms = performance.now() - start;
            if (checksum !== 534773760) throw Error('Wrong checksum: ' + checksum);
            results.push({wasmHeapMb, ms, checksum, spilled: world.runtime.ops.parrBase(store) < 0,
              moduleBytes: world.moduleBytes,
              pureArrayImports: [...world.imports.entries()].filter(([key, value]) => key.startsWith('spill:') && value.pure).length});
          }
          return results;
        }, bytes);
        if (errors.length) throw Error(errors.join('\n'));
        for (const result of results) console.log(JSON.stringify({variant, browser: 'firefox',
          version: browser.version(), bundleSha256: bundles[variant].sha256, ...result}));
      } finally {await browser.close();}
    }
  } finally {rmSync(directory, {recursive: true, force: true});}
}
