'use strict';
const test = require('node:test');
const fs = require('node:fs');
const directories = new Set();
test.after(() => {for (const directory of directories) fs.rmSync(directory, {recursive:true, force:true});});
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {compileFixture, hotspot} = require('./helpers/closedWorld');
const {digest, portableDigest} = require('../src/jit/closed/cacheDigest');
const preparationCache = require('../src/jit/closed/preparationCache');

test('denied IndexedDB access cannot prevent VM construction', () => {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
  try {
    Object.defineProperty(globalThis,'indexedDB',{configurable:true,get(){throw Error('storage denied');}});
    assert.equal(preparationCache.browserCache(),null);
  }finally {
    if(previous)Object.defineProperty(globalThis,'indexedDB',previous);else delete globalThis.indexedDB;
  }
});

test('cache hashes also work on HTTP origins without WebCrypto', async () => {
  for (const value of ['', 'abc', 'λ'.repeat(5000)]) {
    const bytes = Buffer.from(value), expected = createHash('sha256').update(bytes).digest('hex');
    assert.equal(portableDigest(bytes), expected);
    assert.equal(await digest(bytes), expected);
  }
});

test('oversized final artifacts are refused without retaining a second byte copy', async () => {
  const world={cacheKey:'fixture',preparationCache:{},cacheStatus:{},imports:new Map(),entries:new Map(),
    bindingEvents:[],globalImports:new Map(),jvm:{_classIndices:new Map()},sites:[],rejected:new Map(),counters:{}};
  assert.equal(await preparationCache.capture(world,new Uint8Array((16<<20)+1)),null);
  assert.equal(world.cacheStatus.status,'not-stored');
  assert.match(world.cacheStatus.reason,/budget/);
});

const RUNNER = `
const {JVM} = require(process.env.JVM_PATH);
const args = JSON.parse(process.env.CACHE_ARGS), records = new Map();
const backend = {
  async get(key) { return structuredClone(records.get(key)); },
  async put(value) {
    const bytes=value.metadataEncoding==='gzip'
      ? new Uint8Array(await new Response(new Blob([value.metadataBytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
      : value.metadataBytes;
    for(const site of JSON.parse(new TextDecoder().decode(bytes)).sites) {
      if(site.npe && (site.npe.items || site.npe.item || !site.npe.methodKey))throw Error('Retained diagnostic code');
    }
    records.set(value.key, structuredClone(value));
  },
  async delete(key) { records.delete(key); },
};
const write = process.stdout.write.bind(process.stdout);
async function run(index) {
  let output = '', analyses = 0, assemblies = 0, compiles = 0;
  process.stdout.write = chunk => { output += chunk; return true; };
  const jvm = new JVM({classpath: args.directory, wasmHeap: true, closedWorld: true, jit: {compileWorker:false}});
  const world = jvm.jit.closedWorld;
  world.cacheIdentity = index && args.change === 'runtime' ? 'fixture-runtime-v2' : 'fixture-runtime-v1';
  world.preparationCache = backend;
  if (index && args.change === 'stack') jvm.maxStackDepth = 512;
  if (index && args.change === 'native') {
    const original=jvm.jre['java/lang/Math'].staticMethods['sqrt(D)D'];
    jvm.jre['java/lang/Math'].staticMethods['sqrt(D)D']=(...a)=>original(...a);
  }
  const analyze = world.analyze, assemble = world.assemble, compile = WebAssembly.compile;
  world.analyze = function(...a) { analyses++; return analyze.apply(this, a); };
  world.assemble = function(...a) { assemblies++; return assemble.apply(this, a); };
  WebAssembly.compile = function(...a) { compiles++; return compile.apply(this, a); };
  const start = performance.now();
  try { await jvm.run(args.main); }
  finally { process.stdout.write = write; WebAssembly.compile = compile; }
  return {output, analyses, assemblies, compiles, ms:performance.now()-start, cache:world.stats().cache};
}
(async () => {
  const cold = await run(0);
  if (args.change === 'bytecode') {
    const fs=require('fs'),path=require('path');
    const source=fs.readFileSync(process.env.CACHE_FIXTURE,'utf8').replace('return 17;', 'return 18;');
    const file=path.join(args.directory, 'ClosedCache.java');fs.writeFileSync(file,source);
    require('child_process').execFileSync('javac',['--release','8','-d',args.directory,file]);
  }
  for (const entry of records.values()) {
    if (args.change === 'bytes') entry.bytes[9] ^= 1;
    if (args.change === 'metadata') entry.metadataBytes[0] ^= 1;
    if (args.change === 'module') entry.module = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
    if (args.change === 'bytes-only') delete entry.module;
  }
  if (args.change === 'read-error') backend.get = async () => {throw Error('storage unavailable');};
  if (args.change === 'write-error') backend.put = async () => {throw Error('quota');};
  if (args.change === 'write-error') records.clear();
  const warm = await run(1);
  write(JSON.stringify({cold, warm, records:records.size}));
})().catch(error => {console.error(error); process.exitCode = 1;});
`;

function compare(main, change) {
  const directory = compileFixture(main);
  directories.add(directory);
  const result = spawnSync(process.execPath, ['-e', RUNNER], {encoding:'utf8', maxBuffer:16<<20,
    env:{...process.env, JVM_PATH:path.resolve(__dirname, '../src/core/jvm.js'),
      CACHE_FIXTURE:path.resolve(__dirname, 'fixtures/closed/ClosedCache.java'), CACHE_ARGS:JSON.stringify({main, directory, change})}});
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout), expected = hotspot(directory, main);
  assert.equal(record.cold.output, expected);
  assert.equal(record.warm.output, expected);
  assert.equal(record.cold.cache.status, 'stored', JSON.stringify(record.cold));
  assert.ok(record.cold.analyses > 0);
  return record;
}

const fixtures=['ClosedCompute', 'ClosedExceptions', 'ClosedRepr', 'ClosedTypeTests', 'ClosedCache'];
if(typeof WebAssembly.Suspending==='function')fixtures.push('ClosedThreads','ClosedSlowCalls','ClosedRecursion','ClosedTryResources');
for (const main of fixtures) {
  test('cached module matches HotSpot with fresh state: ' + main, () => {
    const {warm} = compare(main);
    assert.equal(warm.cache.status, 'hit', JSON.stringify(warm));
    assert.equal(warm.cache.nativeModule, true);
    assert.equal(warm.analyses, 0);
    assert.equal(warm.assemblies, 0);
    assert.equal(warm.compiles, 0);
  });
}

for (const change of ['runtime', 'stack', 'native', 'bytecode', 'bytes', 'metadata', 'module', 'read-error', 'write-error']) {
  test('changed or unavailable cache rebuilds safely: ' + change, () => {
    const {warm} = compare(change === 'bytecode' ? 'ClosedCache' : 'ClosedRepr', change);
    assert.notEqual(warm.cache.status, 'hit');
    assert.ok(warm.analyses > 0);
    assert.equal(warm.assemblies, 1);
  });
}

test('byte cache still skips analysis and generation when native Module storage is unavailable', () => {
  const {warm} = compare('ClosedRepr', 'bytes-only');
  assert.equal(warm.cache.status, 'hit', JSON.stringify(warm));
  assert.equal(warm.cache.nativeModule, false);
  assert.equal(warm.analyses, 0);
  assert.equal(warm.assemblies, 0);
  assert.equal(warm.compiles, 1);
});
