'use strict';
// Small allocator comparison, not a browser or presented-frame benchmark.
// Use --baseline <commit> to repeat against an immutable previous revision.
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {readFileSync} = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

if (process.argv[2] === '--sample') {
  const baseline = process.argv[3], candidate = process.argv[4] === 'candidate';
  const filename = path.join(__dirname, '../src/core/wasmHeap.js');
  const source = candidate ? readFileSync(filename, 'utf8') :
    execFileSync('git', ['show', baseline + ':src/core/wasmHeap.js'], {encoding: 'utf8'});
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  module._compile(source, filename);
  const {WasmHeap} = module.exports;
  const fast = new WasmHeap(1);
  const start = performance.now();
  for (let i = 0; i < 100000; i++) {
    const a = fast.alloc('[I', 16);
    a[0] = i;
    fast.freeArray(a);
  }
  const fastMs = performance.now() - start;
  const heap = new WasmHeap(8), arrays = [];
  while (heap.limit - heap.top >= 1024) arrays.push(heap.alloc('[B', 1024));
  heap.allocExtent('[B', heap.limit - heap.top);
  for (const a of arrays) heap.freeArray(a);
  let spills = 0, totalBytes = 0;
  const held = [];
  const pressureStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    const a = heap.alloc('[I', 257 + i % 512);
    if (a.wasmBase === undefined) spills++;
    totalBytes += a.byteLength;
    held.push(a);
  }
  console.log(JSON.stringify({variant: candidate ? 'candidate' : 'baseline',
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    fastMs, pressureMs: performance.now() - pressureStart, spills, totalBytes,
    heap: heap.usage(), retained: held.length}));
} else {
  const index = process.argv.indexOf('--baseline');
  const baseline = index < 0 ? 'HEAD' : process.argv[index + 1];
  const commit = execFileSync('git', ['rev-parse', baseline], {encoding: 'utf8'}).trim();
  for (const variant of ['baseline', 'candidate', 'candidate', 'baseline',
    'baseline', 'candidate', 'candidate', 'baseline']) {
    process.stdout.write(execFileSync(process.execPath, [__filename, '--sample', commit, variant],
      {encoding: 'utf8', cwd: path.join(__dirname, '..')}));
  }
}
