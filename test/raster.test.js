'use strict';
const test = require('tape');
const fs = require('fs');
const source = fs.readFileSync(require.resolve('../src/utils/raster'),'utf8');
const rasterRequire = require('module').createRequire(require.resolve('../src/utils/raster'));

function loadNative(mode) {
  const stats = {calls:0,instances:0,simd:false,externalCalls:0};
  const wasm = mode === 'absent' ? undefined : {
    validate: bytes => {
      if(mode === 'scalar' && bytes.includes(0xfd)) return false;
      if(!WebAssembly.validate(bytes)) return false;
      return mode !== 'single' || WebAssembly.Module.imports(new WebAssembly.Module(bytes)).length === 0;
    },
    Module: function(bytes) { stats.simd = bytes.includes(0xfd); return new WebAssembly.Module(bytes); },
    Instance: function(module,imports) {
      const external = !!imports?.env?.source;
      const native = new WebAssembly.Instance(module,imports).exports;stats.instances++;
      stats.memory = native.memory;
      return {exports:{memory:mode === 'spent' || (mode === 'external-spent' && external)
          ? {buffer:native.memory.buffer,grow(){throw Error('spent');}} : native.memory,
        swizzle(...args){stats.calls++;if(external)stats.externalCalls++;native.swizzle(...args);}}};
    },
  };
  const module = {exports:{}};
  new Function('require','module','exports','WebAssembly',source)(rasterRequire,module,module.exports,wasm);
  return {api:module.exports,stats};
}

function pixels(count) {
  const storage = new Int32Array(count+2);let state=0x1f123bb5;
  for (let i=0;i<storage.length;i++) {
    state^=state<<13;state^=state>>>17;state^=state<<5;storage[i]=state;
  }
  return storage.subarray(1,count+1);
}

function expected(values) {
  const out = new Uint8ClampedArray(values.length*4);
  for (let i=0;i<values.length;i++) {
    out[4*i]=values[i]>>>16&255;out[4*i+1]=values[i]>>>8&255;
    out[4*i+2]=values[i]&255;out[4*i+3]=255;
  }
  return out;
}

for (const mode of ['simd','scalar','absent','spent']) {
  test(`RGB presentation preserves colours, raster and boundaries with ${mode} backend`,t=>{
    const {api,stats}=loadNative(mode);
    for (const count of [65536,65537,65538,65539,131075]) {
      const input=pixels(count),before=input.slice();
      const storage=new Uint8ClampedArray(count*4+12).fill(73),out=storage.subarray(4,-8);
      api.copyRgbToRgba(input,out);
      t.deepEqual(out,expected(input),'all colours/alpha and tail pixels match: '+count);
      t.deepEqual(input,before,'guest raster is unchanged');
      t.deepEqual([...storage.slice(0,4),...storage.slice(-8)],new Array(12).fill(73),'destination sentinels are unchanged');
    }
    if (mode === 'simd' || mode === 'scalar') {
      t.equal(stats.calls,5,'native backend handles every large conversion');
      t.equal(stats.instances,1,'module and memory are reused');
      t.equal(stats.simd,mode === 'simd','unsupported SIMD selects the scalar module');
      t.ok(stats.memory.buffer.byteLength >= 131075*4,'staging memory grows across frame sizes');
    } else {
      t.equal(stats.calls,0,'unavailable native backend uses JavaScript');
      t.equal(stats.instances,mode === 'spent'?1:0,'failed allocation is not retried every frame');
    }
    t.end();
  });
}

test('RGB conversion automatically falls back for plain, small or unaligned views',t=>{
  const {api,stats}=loadNative('simd');
  for (const count of [0,7,65539]) {
    const input=pixels(count),want=expected(input);
    for (const offset of [1,3,7]) {
      const storage=new Uint8ClampedArray(offset+count*4+3).fill(69),out=storage.subarray(offset,-3);
      api.copyRgbToRgba(input,out);
      t.deepEqual(out,want,'unaligned output is correct');
      t.ok(storage.slice(0,offset).every(v=>v===69)&&storage.slice(-3).every(v=>v===69),'unaligned sentinels survive');
    }
    const out=new Array(count*4);api.copyRgbToRgba([...input],out);
    t.deepEqual(out,[...want],'plain source and destination are correct');
  }
  t.equal(stats.calls,0,'fallback representations need no staging');
  t.throws(()=>api.copyRgbToRgba([1],new Uint8Array(3)),RangeError,'incorrect destination length is rejected');
  const input=pixels(65539),out=new Uint32Array(65539);
  t.equal(api.trySwizzleRgbToRgba32(out,input,65540),false,'short source is refused before access');
  t.equal(api.trySwizzleRgbToRgba32(out.subarray(1),input,65539),false,'short output is refused before access');
  t.equal(api.trySwizzleRgbToRgba32(out,new Float32Array(65539),65539),false,'non-int source retains its value conversion');
  t.equal(api.trySwizzleRgbToRgba32(out,{elements:input},65539),true,'AWT element wrapper shares the native path');
  t.deepEqual(new Uint8ClampedArray(out.buffer),expected(input),'wrapped raster has exact colours');
  const padded=pixels(65542),prefix=padded.slice(0,65539),target=new Uint32Array(65542).fill(0x10203040);
  t.equal(api.trySwizzleRgbToRgba32(target,padded,65539),true,'native conversion accepts a visible prefix');
  t.deepEqual(new Uint8ClampedArray(target.buffer,0,65539*4),expected(prefix),'visible prefix has exact colours');
  t.deepEqual([...target.slice(65539)],new Array(3).fill(0x10203040),'native conversion preserves destination padding');
  t.deepEqual(padded.slice(0,65539),prefix,'prefix conversion leaves the source untouched');
  t.end();
});

for(const mode of ['simd','scalar','single','absent','external-spent']) {
  test('heap RGB input preserves colours and fallback behavior with '+mode,t=>{
    const {WasmHeap}=require('../src/core/wasmHeap'),heap=new WasmHeap(4);
    const {api,stats}=loadNative(mode);
    for(const count of [65536,65537,65538,65539,131075]) {
      const input=heap.alloc('[I',count),values=pixels(count);input.set(values);
      const out=new Uint8ClampedArray(count*4);
      api.copyRgbToRgba(input,out);
      t.deepEqual(out,expected(values),'all colours and tails match for heap offset '+input.byteOffset);
      t.deepEqual(input,values,'conversion leaves guest memory unchanged');
    }
    if(mode === 'simd' || mode === 'scalar') {
      t.equal(stats.externalCalls,5,'native converter reads the actual heap for every frame');
      t.equal(stats.instances,1,'one native instance/output memory is reused');
      t.equal(stats.simd,mode === 'simd','feature probing selects vector or scalar multi-memory');
    } else {
      t.equal(stats.externalCalls,0,'unavailable external path keeps the supported fallback');
      t.equal(stats.calls,mode === 'absent'?0:mode === 'external-spent'?4:5,
        'unsupported modules and failed allocation are not retried every frame');
    }
    t.end();
  });
}

test('heap RGB conversion omits staging input copies and preserves custom length/prefix effects',t=>{
  const {WasmHeap}=require('../src/core/wasmHeap'),heap=new WasmHeap(4);
  const {api,stats}=loadNative('simd'),count=65539,input=heap.alloc('[I',count);
  input.set(pixels(count));const want=expected(input),output=new Uint8ClampedArray(count*4);
  const original=Uint32Array.prototype.set,descriptor=Object.getOwnPropertyDescriptor(Uint32Array.prototype,'set');let inputCopies=0;
  Uint32Array.prototype.set=function(source,...args){
    if(source.buffer===heap.memory.buffer)inputCopies++;
    return Reflect.apply(original,this,[source,...args]);
  };
  try { api.copyRgbToRgba(input,output); }
  finally {
    if(descriptor)Object.defineProperty(Uint32Array.prototype,'set',descriptor);
    else delete Uint32Array.prototype.set;
  }
  t.equal(inputCopies,0,'actual native presentation performs no heap-to-staging copy');
  t.deepEqual(output,want,'output still receives the same full frame');
  let queries=0;
  Object.defineProperty(input,'length',{get(){queries++;return count;},configurable:true});
  api.copyRgbToRgba(input,output);
  t.equal(queries,5,'custom length keeps all three caller reads and both native-path reads');
  t.equal(stats.externalCalls,1,'custom length cannot use the external path');
  t.deepEqual(output,want,'custom-length fallback remains exact');
  delete input.length;
  const prefix=new Uint32Array(count+7).fill(0x10203040);
  t.ok(api.trySwizzleRgbToRgba32(prefix,input,count-3),'short visible prefix keeps ordinary staging');
  t.deepEqual(new Uint8ClampedArray(prefix.buffer,0,(count-3)*4),want.subarray(0,(count-3)*4),
    'prefix bytes are exact');
  t.equal(stats.externalCalls,1,'prefix conversion did not bypass subarray behavior');
  t.end();
});

test('external presenter caches do not retain retired guest memories',async t=>{
  if(!global.gc){t.pass('requires --expose-gc');t.end();return;}
  const {WasmHeap}=require('../src/core/wasmHeap'),api=require('../src/utils/raster');
  const retire=()=>{
    const heap=new WasmHeap(1),input=heap.alloc('[I',65539);
    input.fill(0x123456);api.copyRgbToRgba(input,new Uint8ClampedArray(input.length*4));
    return new WeakRef(heap.memory);
  };
  const refs=[retire(),retire(),retire()];
  const alive=()=>refs.filter(r=>r.deref()).length;
  for(let i=0;i<30;i++){
    await new Promise(resolve=>setImmediate(resolve));global.gc();
    if(!alive())break;
  }
  t.equal(alive(),0,'weak buffer lookup and native instance caches release all retired heaps');
  t.end();
});

test('typed-array proxies preserve their original native staging effects',t=>{
  const {WasmHeap}=require('../src/core/wasmHeap'),heap=new WasmHeap(1);
  const input=heap.alloc('[I',65539);input.fill(0x123456);
  const {api,stats}=loadNative('simd');let prototypeQueries=0;
  const proxy=new Proxy(input,{
    get(target,key){return Reflect.get(target,key,target);},
    getPrototypeOf(target){prototypeQueries++;return Reflect.getPrototypeOf(target);},
  });
  const output=new Uint8ClampedArray(input.length*4);
  api.copyRgbToRgba(proxy,output);
  t.deepEqual(output,expected(input),'proxy element reads retain exact colours');
  t.equal(prototypeQueries,1,'only the original instanceof check probes the proxy prototype');
  t.equal(stats.calls,1,'the original native staging path still runs');
  t.equal(stats.externalCalls,0,'an array proxy does not claim its target memory');
  t.end();
});
