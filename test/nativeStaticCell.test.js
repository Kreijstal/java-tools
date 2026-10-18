'use strict';
const test=require('tape');
const {StaticFieldStore}=require('../src/core/StaticFieldStore');
const {WasmHeap}=require('../src/core/wasmHeap');
const makeFields=entries=>new StaticFieldStore(entries,true);
const {bindNativeStaticCell}=require('../src/core/nativeStaticCell');
const {bindStaticFieldAccessors}=require('../src/jit/staticFieldAccessors');
const {T,OP,sleb,assembleModule}=require('../src/jit/wasmShared');
function nativePair(fields,key,heap){
 const access=bindStaticFieldAccessors(fields,key,T.i32),native=bindNativeStaticCell(access.cell,heap),stats={get:0,set:0};
 if(!native)return {native};const memory=heap.memory,{address}=native,at=n=>[OP.i32_const,...sleb(address+n)];
 const module=(params,results,body,fn)=>new WebAssembly.Instance(new WebAssembly.Module(assembleModule({
  importDecls:[{name:'fallback',params,results}],mainParams:params,mainResults:results,declared:[],body,
  importMemory:true})),{env:{mem:memory,fallback:fn}}).exports.run;
 const get=module([],[T.i32],[...at(0),OP.i32_load,2,0,OP.i32_const,1,OP.i32_and,OP.if,T.i32,
  ...at(4),OP.i32_load,2,0,OP.else,OP.call,0,OP.end,OP.end],()=>{stats.get++;return access.get();});
 const set=module([T.i32],[],[...at(0),OP.i32_load,2,0,OP.i32_const,2,OP.i32_and,OP.if,0x40,
  ...at(4),OP.local_get,0,OP.i32_store,2,0,...at(8),OP.i32_const,0,OP.i32_store,2,0,
  OP.else,OP.local_get,0,OP.call,0,OP.end,OP.end],v=>{stats.set++;access.set(v);});
 return {native,get,set,stats,cell:access.cell};
}
test('native cells share one value with Map, cells and descriptors',t=>{
 const fields=makeFields([['x:I',1]]),heap=new WasmHeap(1),n=nativePair(fields,'x:I',heap);
 t.ok(n.native,'ordinary declared integer cell binds');t.equal(n.get(),1,'initial read');n.set(17);
 t.equal(fields.get('x:I'),17,'Map reads native writes');t.equal(n.cell.value,17,'cell reads native writes');
 t.equal(Object.getOwnPropertyDescriptor(n.cell,'value').value,17,'descriptor reads native writes');
 t.deepEqual([...fields],[['x:I',17]],'iteration observes native storage');t.equal(Map.prototype.get.call(fields,'x:I'),undefined,'no duplicate backing-map value');
 fields.set('x:I',23);t.equal(n.get(),23,'native reads Map writes');n.cell.value=29;t.equal(n.get(),29,'native reads generated JS writes');
 t.deepEqual(n.stats,{get:0,set:0},'ordinary reads and writes never enter fallback');
 for(const value of [true,false,null,undefined,1.25,NaN,Infinity,-Infinity,-0,4294967295,9007199254740991]){
  fields.set('x:I',value);t.ok(Object.is(fields.get('x:I'),value),'Map keeps exact host value '+String(value));
  t.equal(n.get(),value|0,'native conversion matches i32 '+String(value));
  n.set(-41);t.equal(fields.get('x:I'),-41,'native write replaces host representation');
 }
 fields.delete('x:I');t.equal(n.get(),0,'deleted cell reads undefined as native zero');t.equal(fields.size,0,'delete preserves membership');
 n.set(43);t.equal(n.stats.set,1,'native write after deletion uses membership-restoring setter');t.ok(fields.has('x:I'),'write restores membership');t.equal(n.cell.value,43,'restored value is shared');
 fields.clear();n.set(47);t.deepEqual([...fields],[['x:I',47]],'write after clear restores the key');
 const cold=nativePair(fields,'cold:I',heap);t.notOk(fields.has('cold:I'),'binding is not a Java initialization');cold.set(53);t.equal(fields.get('cold:I'),53,'cold first write restores key');
 t.equal(bindNativeStaticCell(fields.cell('wide:J'),heap),null,'wide cells retain ordinary storage');
 t.equal(bindNativeStaticCell({value:1,present:true},heap),null,'custom cells retain ordinary storage');
 t.equal(bindNativeStaticCell(new StaticFieldStore([['plain:I',1]]).cell('plain:I'),heap),null,'ordinary stores keep plain cells by default');
 t.equal(bindNativeStaticCell(n.cell,new WasmHeap(1)),null,'another memory uses original accessors rather than incoherent copies');
 t.end();
});
test('native cells revoke on accessor, coercion and property-contract changes',t=>{
 const fields=makeFields([['x:I',7]]),heap=new WasmHeap(1),n=nativePair(fields,'x:I',heap);let reads=0,seen;
 n.set(11);Object.defineProperty(n.cell,'value',{configurable:true,get(){t.equal(this,n.cell,'getter keeps its receiver');reads++;return 13;},set(v){seen=[this,v];}});
 t.equal(n.get(),13,'custom getter fallback');t.equal(reads,1,'getter runs once');n.set(19);t.deepEqual(seen,[n.cell,19],'custom setter keeps receiver and argument');
 const thrown={message:'identity'};Object.defineProperty(n.cell,'value',{configurable:true,get(){throw thrown;}});
 try{n.get();t.fail('getter must throw');}catch(e){t.equal(e,thrown,'getter preserves exact throwable');}
 let coerces=0;const value={valueOf(){coerces++;return 23;}};
 Object.defineProperty(n.cell,'value',{value,writable:true,configurable:true});t.equal(coerces,0,'host assignment never coerces early');
 t.equal(n.get(),23,'object conversion remains at read');t.equal(coerces,1,'object coerces once');n.set(29);t.equal(n.cell.value,29,'fallback native write replaces invalid old object');
 for(const invalid of [1n,Symbol('bad')]){n.cell.value=invalid;t.throws(()=>n.get(),TypeError,'invalid i32 values fail at read');n.set(31);}
 n.set(37);Object.defineProperty(n.cell,'value',{writable:false});t.equal(n.cell.value,37,'readonly transition materializes current value');
 t.throws(()=>n.set(41),TypeError,'readonly writes retain original failure');t.equal(n.get(),37,'failed write preserves value');
 Object.defineProperty(n.cell,'value',{writable:true});n.set(43);t.equal(n.cell.value,43,'restoring writable descriptor restores native writes');
 const other={};t.ok(Reflect.set(n.cell,'value',47,other),'foreign receiver write succeeds');t.equal(other.value,47,'foreign receiver owns write');t.equal(n.get(),43,'foreign receiver does not change cell');
 const reentrant=new Proxy({}, {defineProperty(target,key,descriptor){n.set(71);n.set(73);
  t.equal(n.cell.value,73,'foreign callback sees its latest native write');return Reflect.defineProperty(target,key,descriptor);}});
 t.ok(Reflect.set(n.cell,'value',79,reentrant),'foreign Proxy can reenter native execution');
 t.equal(n.get(),73,'outer descriptor refresh preserves callback native writes');t.equal(reentrant.value,79,'outer write still belongs to its receiver');
 let presentReads=0;Object.defineProperty(n.cell,'present',{configurable:true,get(){presentReads++;throw thrown;}});
 try{n.set(83);t.fail('present getter must throw');}catch(e){t.equal(e,thrown,'present accessor is not bypassed by native store');}
 t.equal(presentReads,1,'present accessor runs exactly once');Object.defineProperty(n.cell,'present',{value:true,writable:true,configurable:true});
 delete n.cell.value;let inherited=0;Object.setPrototypeOf(n.cell,{get value(){inherited++;return 53;}});
 t.equal(n.get(),53,'deleted own property retains prototype getter');t.equal(inherited,1,'prototype getter runs once');
 Object.defineProperty(n.cell,'value',{value:59,writable:true,configurable:true});n.set(61);Object.freeze(n.cell);
 t.equal(n.get(),61,'frozen cell materializes latest native value');t.equal(n.cell.value,61,'frozen Proxy obeys value invariant');t.equal(Object.getOwnPropertyDescriptor(n.cell,'value').value,61,'frozen descriptor obeys invariant');
 t.throws(()=>n.set(67),TypeError,'frozen setter still refuses');t.end();
});
test('native cells refresh detached views and preserve allocation fallbacks',t=>{
 const heap=new WasmHeap(2,1),fields=makeFields([['x:I',3]]),n=nativePair(fields,'x:I',heap);
 n.set(5);t.ok(heap.growTo(2*1024*1024),'heap grows with no guest arrays');t.equal(n.cell.value,5,'host read refreshes detached view');
 n.cell.value=7;t.equal(n.get(),7,'native reads after growth');n.set(11);t.equal(fields.get('x:I'),11,'host reads native post-growth writes');
 const spent=new WasmHeap(1);spent.top=spent.limit;t.equal(bindNativeStaticCell(fields.cell('another:I'),spent),null,'spent heap keeps imports');
 t.equal(fields.get('another:I'),undefined,'refused binding changes no value');
 let allocations=0;const unsupported={memory:heap.memory,top:0x80000000,trackObject(){return true;},allocObject(){allocations++;return 8;}};
 t.equal(bindNativeStaticCell(fields.cell('high:I'),unsupported),null,'out-of-range address space keeps ordinary access');
 t.equal(allocations,0,'range refusal allocates no storage');
 if(typeof SharedArrayBuffer!=='undefined'){
  const shared=new WebAssembly.Memory({initial:1,maximum:1,shared:true});
  t.equal(bindNativeStaticCell(fields.cell('shared:I'),{...unsupported,memory:shared,top:8}),null,'shared memory keeps ordinary access');
  t.equal(allocations,0,'shared-memory refusal allocates no storage');
 }
 t.end();
});
test('native cells do not retain replaced host objects, heap wrappers or dead stores',async t=>{
 if(!global.gc){t.pass('needs forced GC');t.end();return;}
 const heap=new WasmHeap(1);
 const create=()=>{const fields=makeFields([['x:I',1]]),n=nativePair(fields,'x:I',heap);
  let value={valueOf(){return 7;}};const weak=new WeakRef(value);n.cell.value=value;n.set(11);value=null;
  return {weak,cell:new WeakRef(n.cell),fields:new WeakRef(fields),address:n.native.address};};
 const retired=create();for(let i=0;i<10;i++){await new Promise(setImmediate);global.gc();}
 t.equal(retired.weak.deref(),undefined,'native fallback replacement releases host object');t.equal(retired.cell.deref(),undefined,'dead cell collects');t.equal(retired.fields.deref(),undefined,'dead store collects');
 t.equal(heap.objectAllocations.has(retired.address),false,'dead cell storage is reclaimed');
 const keep=()=>{const temporary=new WasmHeap(1),fields=makeFields([['x:I',17]]),n=nativePair(fields,'x:I',temporary);return {n,weak:new WeakRef(temporary)};};
 const kept=keep();for(let i=0;i<10;i++){await new Promise(setImmediate);global.gc();}
 t.equal(kept.weak.deref()===undefined,true,'native bindings keep memory but not heap wrapper');kept.n.set(19);t.equal(kept.n.cell.value,19,'native writes remain visible after heap wrapper collects');
 t.end();
});

test('deduplicated imports retain their first cell or first native refusal',t=>{
 const {addFieldImport}=require('../src/jit/wasmRuntimeImports');
 for(const plain of [false,true]){
  const heap=new WasmHeap(1),a=makeFields([['x:I',7]]),b=makeFields([['x:I',11]]);
  const first=plain?{value:13,present:true}:a.cell('x:I'),second=b.cell('x:I');let resolutions=0;
  a.cell=()=>++resolutions===1?first:second;
  const reg={importDecls:[],importFns:[],importIndexByName:new Map(),nativeStaticFieldAddress:cell=>bindNativeStaticCell(cell,heap),
   addImport(name,params,results,fn){if(this.importIndexByName.has(name))return this.importIndexByName.get(name);
    const index=this.importFns.length;this.importIndexByName.set(name,index);this.importFns.push(fn);return index;}};
  const jvm={classes:{C:{staticFields:a,ast:{classes:[{items:[{type:'field',field:{name:'x',descriptor:'I',flags:['static']}}]}]}}},classInitializationState:new Map([['C','INITIALIZED']])};
  const ins={arg:['Field','C',['x','I']]},one=addFieldImport(reg,jvm,ins,true,true),two=addFieldImport(reg,jvm,ins,true,true);
  t.equal(resolutions,1,'same import binds once');t.equal(one.idx,two.idx,'import index stays stable');
  t.deepEqual(one.native,two.native,'native word or refusal stays bound to original cell');
  t.equal(reg.importFns[two.idx](),plain?13:7,'fallback reads original cell');
 }
 t.end();
});
