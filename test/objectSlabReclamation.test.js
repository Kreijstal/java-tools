'use strict';
const test=require('tape');
const {WasmHeap}=require('../src/core/wasmHeap');
const {newFields,slabLayoutFor,BASE_KEY}=require('../src/core/objectModel');
const {T,OP,assembleModule}=require('../src/jit/wasmShared');
function fixture(heap=new WasmHeap(1)){
 return {wasmHeap:heap,wasmFields:true,classEpoch:1,jre:{'java/lang/Object':{}},classes:{Holder:{ast:{classes:[{superClassName:'java/lang/Object',items:[
  ...[['number','I'],['wide','J'],['reference','Ljava/lang/Object;']].map(([name,descriptor])=>({type:'field',field:{name,descriptor,flags:[]}}))
 ]}]}}}};
}
async function collectUntil(predicate){
 if(!global.gc)return false;
 for(let i=0;i<32;i++){await new Promise(setImmediate);global.gc();await new Promise(setImmediate);if(predicate())return true;}
 return false;
}
test('slab reclamation follows the storage container and clears recycled fields',async t=>{
 if(!global.gc){t.pass('requires --expose-gc');t.end();return;}
 const j=fixture(),heap=j.wasmHeap;let owner={fields:newFields(j,'Holder')},fields=owner.fields;
 const base=fields[BASE_KEY],wrapper=new WeakRef(owner),storage=new WeakRef(fields);
 fields['Holder.number']=73;fields['Holder.wide']=9007199254740993n;
 t.equal(heap.objectAllocations.size,1,'normal newFields registers its allocation');
 owner=null;t.ok(await collectUntil(()=>wrapper.deref()===undefined),'Java wrapper can collect while its fields are held');
 t.equal(fields['Holder.number'],73,'retained storage stays readable');t.equal(heap.stats.freed,0,'live field storage is not freed');
 fields=null;t.ok(await collectUntil(()=>heap.objectAllocations.size===0),'unreachable field storage is reclaimed');
 t.equal(storage.deref(),undefined,'registry holdings do not retain their target');t.equal(heap.stats.freed,1,'object free bin receives the slab');
 const fresh=newFields(j,'Holder');t.equal(fresh[BASE_KEY],base,'same-size object reuses the extent');
 t.equal(fresh['Holder.number'],0,'recycled integer is zero');t.equal(fresh['Holder.wide'],0n,'recycled long is zero');t.equal(fresh['Holder.reference'],null,'reference fields keep their default');
 t.equal(heap.stats.reused,1,'reuse is accounted');t.end();
});
test('explicit free and stale finalizers cannot release a replacement allocation',t=>{
 const j=fixture(),heap=j.wasmHeap,fields=newFields(j,'Holder'),base=fields[BASE_KEY],size=slabLayoutFor(j,'Holder').size;
 const record=heap.objectAllocations.get(base);t.ok(record,'tracked record exists');
 t.notOk(heap.trackObject(fields,base,size),'duplicate tracking is refused');
 t.notOk(heap.free(base,size+8),'wrong-sized free cannot unregister a live allocation');
 t.equal(heap.objectAllocations.get(base),record,'wrong-sized free preserves its registration');
 t.ok(heap.free(base,size),'explicit free unregisters the target');t.equal(heap.objectAllocations.size,0,'explicit free releases bookkeeping');
 const replacement=newFields(j,'Holder');t.equal(replacement[BASE_KEY],base,'replacement occupies recycled address');replacement['Holder.number']=91;
 t.notOk(heap.reclaimObject(record),'old queued callback cannot free the replacement');
 t.equal(replacement['Holder.number'],91,'replacement contents remain intact');t.equal(heap.stats.freed,1,'stale callback never adds another free extent');
 t.notEqual(heap.allocObject(size),base,'live replacement never appears in a free bin');
 t.end();
});
test('native raw-base caches finish before field-container finalization runs',async t=>{
 if(!global.gc){t.pass('requires --expose-gc');t.end();return;}
 const j=fixture(),heap=j.wasmHeap;let fields=newFields(j,'Holder');const base=fields[BASE_KEY],size=slabLayoutFor(j,'Holder').size;
 fields['Holder.number']=123;const weak=new WeakRef(fields);
 const body=[OP.call,0,OP.local_get,0,OP.i32_load,2,0,OP.end];
 const x=new WebAssembly.Instance(new WebAssembly.Module(assembleModule({importDecls:[{name:'collect',params:[],results:[]}],mainParams:[T.i32],mainResults:[T.i32],declared:[],body,importMemory:true})),{env:{mem:heap.memory,collect:()=>{
  fields=null;global.gc();t.equal(weak.deref(),undefined,'GC clears the container during the native callback');
  t.equal(heap.stats.freed,0,'GC in a synchronous native callback has not run finalizers');
  t.notEqual(heap.allocObject(size),base,'nested allocation cannot reuse the currently cached base');
 }}}).exports;
 const offset=slabLayoutFor(j,'Holder').slots.find(slot=>slot.key==='Holder.number').offset;
 await new Promise(setImmediate); // end WeakRef construction's keep-alive job
 t.equal(x.run(base+offset),123,'native function still reads its original field after GC');
 t.ok(await collectUntil(()=>heap.objectAllocations.size===0),'field is reclaimed after native return and host turn');
 t.equal(weak.deref(),undefined,'native cache does not permanently retain storage');t.end();
});
test('cycles, arrays and memory growth preserve independent lifetime accounting',async t=>{
 if(!global.gc){t.pass('requires --expose-gc');t.end();return;}
 const heap=new WasmHeap(2,1),j=fixture(heap);let fields=newFields(j,'Holder');const base=fields[BASE_KEY];
 fields['Holder.number']=42;t.ok(heap.growTo(2*1024*1024),'object storage allows safe view refresh');t.equal(fields['Holder.number'],42,'live object accessor follows grown views');
 const array=heap.alloc('[I',4);array[0]=19;const live=heap.arrayViewsLive;
 fields['Holder.reference']=fields;fields=null;
 t.ok(await collectUntil(()=>heap.objectAllocations.size===0),'unreachable field cycle collects');
 t.equal(heap.arrayViewsLive,live,'object finalization never decrements array-view liveness');t.equal(array[0],19,'live array remains intact');
 const fresh=newFields(j,'Holder');t.equal(fresh[BASE_KEY],base,'grown heap reuses object bin');t.equal(fresh['Holder.number'],0,'grown recycled object is zeroed');t.end();
});
test('unsupported tracking retains the existing allocation fallback',t=>{
 const heap=new WasmHeap(1),base=heap.allocObject(16);
 for(const [address,bytes] of [[base+.5,16],[base,0],[base,-1],[base,4294967312],[heap.top+8,16]])
  t.notOk(heap.trackObject({},address,bytes),'invalid or unbinnable extent is not registered');
 heap.registry=null;const j=fixture(heap),fields=newFields(j,'Holder');fields['Holder.number']=7;
 t.equal(fields['Holder.number'],7,'field storage still works without registry');
 t.equal(heap.objectAllocations.size,0,'unavailable registry retains no tracking records');t.end();
});
test('reclaimed object storage recovers after bump-space exhaustion',async t=>{
 if(!global.gc){t.pass('requires --expose-gc');t.end();return;}
 const j=fixture(),heap=j.wasmHeap;let fields=newFields(j,'Holder');const base=fields[BASE_KEY];
 heap.allocObject(heap.limit-heap.top);
 const fallback=newFields(j,'Holder');t.equal(fallback[BASE_KEY],undefined,'spent bump space preserves plain-field fallback');
 fields=null;t.ok(await collectUntil(()=>heap.objectAllocations.size===0),'dead native allocation reaches free bin despite exhaustion');
 const recovered=newFields(j,'Holder');t.equal(recovered[BASE_KEY],base,'next field allocation recovers native storage');
 t.equal(recovered['Holder.number'],0,'recovered storage is fresh');t.end();
});
