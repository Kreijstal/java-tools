'use strict';
const test=require('tape');
const {StaticFieldStore}=require('../src/core/StaticFieldStore');
const {WasmHeap}=require('../src/core/wasmHeap');
const {bindNativeStaticReferenceCell}=require('../src/core/nativeStaticReferenceCell');
const {bindStaticFieldAccessors}=require('../src/jit/staticFieldAccessors');
const {T,OP,sleb,assembleModule}=require('../src/jit/wasmShared');
function reader(fields,key,heap){
 const access=bindStaticFieldAccessors(fields,key,T.ref),native=bindNativeStaticReferenceCell(access.cell,heap);
 let imports=0;const bytes=assembleModule({importDecls:[{name:'fallback',params:[],results:[T.ref]}],
  mainParams:[],mainResults:[T.ref],declared:[],importMemory:true,
  globalImportDecls:[{name:'reference',type:T.ref,mutable:true}],
  body:[OP.i32_const,...sleb(native.address),OP.i32_load,2,0,OP.i32_const,1,OP.i32_and,OP.if,T.ref,
   OP.global_get,0,OP.else,OP.call,0,OP.end,OP.end]});
 const get=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{mem:heap.memory,reference:native.value,fallback:()=>{imports++;return access.get();}}}).exports.run;
 return {cell:access.cell,native,get,imports:()=>imports,header:()=>new Int32Array(heap.memory.buffer,native.address,4)};
}
test('native static references retain identity, membership and captured array metadata',t=>{
 const heap=new WasmHeap(1),fields=new StaticFieldStore(undefined,true),r=reader(fields,'data:[I',heap);
 t.equal(r.get(),undefined,'binding missing storage does not initialize its field');t.equal(fields.size,0,'binding changes no membership');
 const a=heap.alloc('[I',3);a.type='[I';a.set([3,5,7]);fields.set('data:[I',a);
 t.equal(r.get(),a,'Map replacement is the same native reference');t.equal(r.cell.value,a,'cell reads the canonical reference');
 t.equal(Map.prototype.get.call(fields,'data:[I'),undefined,'backing Map holds no duplicate reference');
 t.equal(r.header()[1],a.wasmBase,'native metadata has the owning array base');t.equal(r.header()[2],3,'native metadata has exact length');
 const b=heap.alloc('[I',1);b.type='[I';r.cell.value=b;
 t.equal(r.get(),b,'direct generated-JS writes update native reference');t.equal(r.header()[1],b.wasmBase,'replacement updates metadata atomically');
 t.deepEqual([...fields],[['data:[I',b]],'iteration sees native value');
 const foreign=new WasmHeap(1).alloc('[I',4);fields.set('data:[I',foreign);
 t.equal(r.get(),foreign,'foreign heap preserves original reference');t.equal(r.header()[1],-1,'foreign heap never supplies a pointer into this memory');
 const bool=heap.alloc('[Z',2);bool.type='[Z';fields.set('data:[I',bool);t.equal(r.header()[1],-1,'boolean arrays retain canonical masking path');
 let getters=0;Object.defineProperty(a,'wasmBase',{configurable:true,get(){getters++;return 8;}});fields.set('data:[I',a);
 t.equal(getters,0,'metadata publication invokes no custom array getter');t.equal(r.header()[1],require('../src/core/wasmHeap').allocationForArray(a).base,'canonical allocator record supplies metadata without host getters');
 for(const value of [null,undefined,{},[1,2],17,'host']){fields.set('data:[I',value);t.equal(r.get(),value,'native reference keeps exact host value');}
 fields.delete('data:[I');t.equal(r.get(),undefined,'delete clears native value');t.equal(fields.size,0,'delete keeps Map membership');
 fields.set('data:[I',b);fields.clear();t.equal(r.get(),undefined,'clear releases current reference');
 t.equal(r.imports(),0,'ordinary native reads use no JavaScript getter');
 t.equal(bindNativeStaticReferenceCell(r.cell,new WasmHeap(1)),null,'a second heap cannot own the same metadata');
 t.equal(bindNativeStaticReferenceCell(new StaticFieldStore().cell('plain:[I'),heap),null,'custom/legacy stores retain their original ABI');
 t.end();
});
test('reference descriptor changes preserve getters, receivers, readonly and freeze behavior',t=>{
 const heap=new WasmHeap(1),value={},fields=new StaticFieldStore([['object:[I',value]],true);
 const r=reader(fields,'object:[I',heap);let seen=0;
 Object.defineProperty(r.cell,'value',{configurable:true,get(){seen++;t.equal(this,r.cell,'getter receiver is exact');return value;}});
 t.equal(seen,0,'installing accessor does not execute it');t.equal(r.get(),value,'native getter falls back to customized descriptor');t.equal(seen,1,'accessor executes once');
 const marker={failure:true};Object.defineProperty(r.cell,'value',{configurable:true,get(){throw marker;}});
 try{r.get();t.fail('must throw');}catch(e){t.equal(e,marker,'throw identity survives fallback');}
 Object.defineProperty(r.cell,'value',{configurable:true,value,writable:true});
 const other={};t.ok(Reflect.set(r.cell,'value',other,other),'foreign receiver write succeeds');t.equal(other.value,other,'foreign receiver owns its value');t.equal(r.get(),value,'foreign receiver leaves canonical value unchanged');
 Object.defineProperty(r.cell,'value',{writable:false});t.equal(r.get(),value,'readonly transition materializes canonical value');
 t.throws(()=>{r.cell.value={};},TypeError,'readonly assignment still refuses');
 Object.defineProperty(r.cell,'value',{writable:true});r.cell.value=other;Object.freeze(r.cell);
 t.equal(r.get(),other,'frozen native cell reads exact object');t.equal(r.cell.value,other,'Proxy preserves non-configurable value invariant');
 t.equal(Object.getOwnPropertyDescriptor(r.cell,'value').value,other,'frozen descriptor is coherent');
 t.throws(()=>{r.cell.value=value;},TypeError,'frozen assignment refuses');t.end();
});
test('native reference replacement and dead cells release their GC roots',async t=>{
 if(!global.gc){t.pass('needs forced GC');t.end();return;}
 const heap=new WasmHeap(1);
 const create=()=>{const fields=new StaticFieldStore(undefined,true),r=reader(fields,'data:[I',heap);
  let old={retired:true};const weak=new WeakRef(old);fields.set('data:[I',old);fields.set('data:[I',{current:true});old=null;
  return {r,weak,fields};};
 const kept=create();for(let i=0;i<12;i++){await new Promise(setImmediate);global.gc();}
 t.equal(kept.weak.deref(),undefined,'live native cell retains no superseded reference');
 const retire=()=>{const fields=new StaticFieldStore(undefined,true),r=reader(fields,'gone:[I',heap);let value={};fields.set('gone:[I',value);
  return {cell:new WeakRef(r.cell),value:new WeakRef(value),address:r.native.address};};
 const dead=retire();for(let i=0;i<12;i++){await new Promise(setImmediate);global.gc();}
 t.equal(dead.cell.deref(),undefined,'dead cell collects');t.equal(dead.value.deref(),undefined,'dead native global retains no guest object');
 t.equal(heap.objectAllocations.has(dead.address),false,'dead metadata extent is reclaimed');t.end();
});
