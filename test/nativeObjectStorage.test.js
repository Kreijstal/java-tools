'use strict';
const test=require('tape');
const {getNativeObjectStorageOps,registerNativeObjectStorage,nativeObjectStorageOf}=require('../src/core/nativeObjectStorage');
const {T,OP,assembleModule}=require('../src/jit/wasmShared');

test('native object fields preserve identity across independently compiled Wasm modules',t=>{
 const ops=getNativeObjectStorageOps();if(!ops){t.pass('older engine retains existing representation');t.end();return;}
 const bytes=assembleModule({importDecls:[{name:'field',params:[T.ref,T.i32],results:[T.ref]}],
  mainParams:[T.ref,T.i32],mainResults:[T.ref],declared:[],body:[OP.local_get,0,OP.local_get,1,OP.call,0,OP.end]});
 const nativeRead=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{field:ops.reference}}).exports.run;
 const a=ops.create(128,7,2),b=ops.create(256,11,2),value={marker:true};
 t.equal(ops.base(a),128,'native primitive base is stable');t.equal(ops.classId(b),11,'native class identity is exact');
 t.equal(nativeRead(a,0),null,'reference fields start null');ops.setReference(a,0,value);
 t.equal(nativeRead(a,0),value,'native import returns original Java wrapper');ops.setReference(b,0,a);
 t.equal(nativeRead(b,0),a,'opaque storage itself keeps cross-module identity');
 const memory=new WebAssembly.Memory({initial:1}),fields={},wrapper={fields};registerNativeObjectStorage(wrapper,fields,a,memory);
 t.equal(nativeObjectStorageOf(wrapper,memory),a,'lookup retains original field ownership');
 t.equal(nativeObjectStorageOf(wrapper,new WebAssembly.Memory({initial:1})),null,'foreign memory never aliases primitive storage');
 wrapper.fields={};t.equal(nativeObjectStorageOf(wrapper,memory),null,'host field-container replacement revokes native access');
 let getters=0;Object.defineProperty(wrapper,'fields',{get(){getters++;return fields;}});
 t.equal(nativeObjectStorageOf(wrapper,memory),null,'custom field container retains fallback');t.equal(getters,0,'metadata lookup invokes no getter early');
 t.end();
});
test('wrapper/native-reference cycles collect without a permanent root table',async t=>{
 const ops=getNativeObjectStorageOps();if(!ops||!global.gc){t.pass('needs supported GC and forced collection');t.end();return;}
 const memory=new WebAssembly.Memory({initial:1});
 const make=()=>{const fields={},object={fields},store=ops.create(128,7,1);fields.store=store;ops.setReference(store,0,object);
  registerNativeObjectStorage(object,fields,store,memory);return {object:new WeakRef(object),fields:new WeakRef(fields),store:new WeakRef(store)};};
 const weak=make();for(let i=0;i<12;i++){await new Promise(setImmediate);global.gc();}
 for(const [name,reference] of Object.entries(weak))t.equal(reference.deref(),undefined,name+' in native/JS cycle is collectible');
 t.end();
});

test('closed-body object ownership rejects changed field shapes without getters',t=>{
 const ops=getNativeObjectStorageOps();if(!ops){t.pass('requires native GC storage');t.end();return;}
 const {JVM}=require('../src/core/jvm');
 const {newFields,makeObjectRef,BASE_KEY}=require('../src/core/objectModel');
 const {validatedNativeObjectStorageOf,registerNativeFieldsStorage,NATIVE_STORE}=require('../src/core/nativeObjectStorage');
 const j=new JVM({wasmHeap:true,wasmFields:true,jit:{compileWorker:false}});
 j.classes.ShapeCell={ast:{classes:[{className:'ShapeCell',superClassName:'java/lang/Object',items:[
  {type:'field',field:{name:'count',descriptor:'I',flags:[]}},
  {type:'field',field:{name:'array',descriptor:'[I',flags:[]}}
 ]}]}};
 const fields=newFields(j,'ShapeCell'),wrapper=makeObjectRef(j,'ShapeCell',fields),memory=j.wasmHeap.memory;
 const store=nativeObjectStorageOf(wrapper,memory),prototype=Object.getPrototypeOf(fields),base=fields[BASE_KEY];
 t.equal(validatedNativeObjectStorageOf(wrapper,memory),store,'canonical shape supplies its native store');
 t.equal(validatedNativeObjectStorageOf(wrapper,new WebAssembly.Memory({initial:1})),null,'foreign memory cannot earn the proof');
 fields[BASE_KEY]=base+8;t.equal(validatedNativeObjectStorageOf(wrapper,memory),null,'changed primitive base revokes ownership');fields[BASE_KEY]=base;
 let getters=0;Object.defineProperty(fields,'ShapeCell.count',{configurable:true,get(){getters++;return 31;}});
 t.equal(validatedNativeObjectStorageOf(wrapper,memory),null,'own accessor shadow refuses the closed body');
 t.equal(getters,0,'validation does not call a shadowing getter');delete fields['ShapeCell.count'];
 Object.setPrototypeOf(fields,Object.create(prototype));
 t.equal(validatedNativeObjectStorageOf(wrapper,memory),null,'a changed prototype also revokes the proof');Object.setPrototypeOf(fields,prototype);
 fields.auxiliary=true;t.equal(validatedNativeObjectStorageOf(wrapper,memory),null,'extra own fields conservatively retain the checked representation');delete fields.auxiliary;
 t.equal(validatedNativeObjectStorageOf(wrapper,memory),store,'restored canonical container is valid again');
 const malformedFields=Object.create(prototype),malformedStore=ops.create(-1,1,1);
 malformedFields[BASE_KEY]=base;Object.defineProperty(malformedFields,NATIVE_STORE,{value:malformedStore});
 registerNativeFieldsStorage(malformedFields,malformedStore,memory,base,j.classes.ShapeCell._slabLayout.storageShape);
 const malformed=makeObjectRef(j,'ShapeCell',malformedFields);
 t.equal(validatedNativeObjectStorageOf(malformed,memory),null,'mismatched or negative native bases supply no ownership certificate');
 const literal={fields:{}};registerNativeObjectStorage(literal,literal.fields,store,memory);
 t.equal(validatedNativeObjectStorageOf(literal,memory),null,'manual transport registration alone supplies no canonical shape proof');
 Object.defineProperty(wrapper,'fields',{get(){getters++;return fields;}});
 t.equal(validatedNativeObjectStorageOf(wrapper,memory),null,'custom wrapper storage refuses before its getter');
 t.equal(getters,0,'wrapper and field getters remain unevaluated');t.end();
});

test('native field graphs collect and live stores keep primitive extents alive',async t=>{
 const ops=getNativeObjectStorageOps();if(!ops||!global.gc){t.pass('needs supported GC and forced collection');t.end();return;}
 const {JVM}=require('../src/core/jvm');
 const {newFields,makeObjectRef,writeField}=require('../src/core/objectModel');
 const {NATIVE_STORE}=require('../src/core/nativeObjectStorage');
 const j=new JVM({wasmHeap:true,wasmFields:true,jit:{compileWorker:false}});
 j.classes.FieldCycle={ast:{classes:[{className:'FieldCycle',superClassName:'java/lang/Object',items:[
  {type:'field',field:{name:'next',descriptor:'LFieldCycle;',flags:[]}},
  {type:'field',field:{name:'count',descriptor:'I',flags:[]}}
 ]}]}};
 const create=()=>{const fields=newFields(j,'FieldCycle'),object=makeObjectRef(j,'FieldCycle',fields);
  writeField(fields,'FieldCycle.next',object);return {object:new WeakRef(object),store:new WeakRef(fields[NATIVE_STORE]),base:fields._wasmBase};};
 const cycle=create();for(let i=0;i<12;i++){await new Promise(setImmediate);global.gc();}
 t.equal(cycle.object.deref(),undefined,'self-linked Java wrapper is collected');
 t.equal(cycle.store.deref(),undefined,'native references in a dead field graph are collected');
 t.equal(j.wasmHeap.objectAllocations.has(cycle.base),false,'dead graph releases its primitive extent');
 const keepStore=()=>{const fields=newFields(j,'FieldCycle'),object=makeObjectRef(j,'FieldCycle',fields);
  return {object:new WeakRef(object),store:fields[NATIVE_STORE],base:fields._wasmBase};};
 const kept=keepStore();for(let i=0;i<12;i++){await new Promise(setImmediate);global.gc();}
 t.equal(kept.object.deref(),undefined,'storage need not pin an unused Java wrapper');
 t.equal(j.wasmHeap.objectAllocations.has(kept.base),true,'native storage keeps its primitive extent alive');
 kept.store=null;for(let i=0;i<12;i++){await new Promise(setImmediate);global.gc();}
 t.equal(j.wasmHeap.objectAllocations.has(kept.base),false,'retired standalone storage releases its extent');
 t.end();
});

test('tracked native field certificates revoke structurally and reuse unchanged shapes',t=>{
 const {JVM}=require('../src/core/jvm'),{newFields,makeObjectRef,writeField,BASE_KEY}=require('../src/core/objectModel');
 const {validatedNativeObjectStorageOf}=require('../src/core/nativeObjectStorage');
 if(!getNativeObjectStorageOps()){t.pass('requires native storage');t.end();return;}
 const j=new JVM({wasmHeap:true,wasmFields:true,jit:{compileWorker:false}});
 j.classes.TrackedCell={ast:{classes:[{className:'TrackedCell',superClassName:'java/lang/Object',items:[
  {type:'field',field:{name:'value',descriptor:'I',flags:[]}},
  {type:'field',field:{name:'array',descriptor:'[I',flags:[]}}
 ]}]}};
 const fields=newFields(j,'TrackedCell'),wrapper=makeObjectRef(j,'TrackedCell',fields),memory=j.wasmHeap.memory;
 const store=nativeObjectStorageOf(wrapper,memory),base=fields[BASE_KEY],proto=Object.getPrototypeOf(fields);
 const ownKeys=Reflect.ownKeys;let scans=0;
 Reflect.ownKeys=(...args)=>{scans++;return ownKeys(...args);};
 try{
  for(let i=0;i<5;i++){writeField(fields,'TrackedCell.value',i);t.equal(validatedNativeObjectStorageOf(wrapper,memory),store,'ordinary Java writes preserve the certificate');}
  t.equal(scans,0,'unchanged tracked shape requires no exhaustive entry scan');
  Reflect.set(fields,BASE_KEY,base+8);t.equal(validatedNativeObjectStorageOf(wrapper,memory),null,'ordinary base assignment revokes before lookup');
  Reflect.set(fields,BASE_KEY,base);t.equal(validatedNativeObjectStorageOf(wrapper,memory),store,'restoring base allows checked recertification');
  const afterBase=scans;t.equal(validatedNativeObjectStorageOf(wrapper,memory),store,'recertified shape is reusable');t.equal(scans,afterBase,'recertification is not repeated');
  const symbol=Symbol('host field');Object.assign(fields,{[symbol]:1});t.equal(validatedNativeObjectStorageOf(wrapper,memory),null,'symbol assignment cannot bypass tracking');
  Reflect.deleteProperty(fields,symbol);t.equal(validatedNativeObjectStorageOf(wrapper,memory),store,'symbol deletion restores the shape');
  let getters=0;Reflect.defineProperty(fields,'TrackedCell.value',{configurable:true,get(){getters++;return 99;}});
  t.equal(validatedNativeObjectStorageOf(wrapper,memory),null,'descriptor-defined shadow revokes');t.equal(getters,0,'no shadow getter executes during validation');
  delete fields['TrackedCell.value'];t.equal(validatedNativeObjectStorageOf(wrapper,memory),store,'accessor deletion recertifies');
  Reflect.setPrototypeOf(fields,Object.create(proto));t.equal(validatedNativeObjectStorageOf(wrapper,memory),null,'prototype mutation revokes');
  Reflect.setPrototypeOf(fields,proto);t.equal(validatedNativeObjectStorageOf(wrapper,memory),store,'canonical prototype can recover');
  Object.preventExtensions(fields);t.equal(validatedNativeObjectStorageOf(wrapper,memory),store,'preventing new fields preserves canonical accessors');
  t.equal(Reflect.defineProperty(fields,'extra',{value:1}),false,'failed definition retains ordinary object behavior');
  t.equal(validatedNativeObjectStorageOf(wrapper,memory),store,'failed structural edit can recertify safely');
  writeField(fields,'TrackedCell.value',73);t.equal(fields['TrackedCell.value'],73,'nonextensible field container still permits native Java setters');
 }finally{Reflect.ownKeys=ownKeys;}
 t.end();
});

test('tracked wrapper bindings avoid descriptor scans and revoke independently for shared fields',t=>{
 const {JVM}=require('../src/core/jvm'),{newFields,makeObjectRef}=require('../src/core/objectModel');
 const {validatedNativeObjectStorageOf,createNativeObjectWrapper,nativeObjectBaseOf}=require('../src/core/nativeObjectStorage');
 if(!getNativeObjectStorageOps()){t.pass('requires native storage');t.end();return;}
 const j=new JVM({wasmHeap:true,wasmFields:true,jit:{compileWorker:false}});
 j.classes.BindingCell={ast:{classes:[{className:'BindingCell',superClassName:'java/lang/Object',items:[
  {type:'field',field:{name:'value',descriptor:'I',flags:[]}}
 ]}]}};
 const fields=newFields(j,'BindingCell'),a=makeObjectRef(j,'BindingCell',fields),b=makeObjectRef(j,'BindingCell',fields),memory=j.wasmHeap.memory;
 const store=nativeObjectStorageOf(a,memory),descriptor=Reflect.getOwnPropertyDescriptor;let scans=0;
 Reflect.getOwnPropertyDescriptor=(...args)=>{scans++;return descriptor(...args);};
 try{
  for(let i=0;i<5;i++){
   t.equal(validatedNativeObjectStorageOf(a,memory),store,'unchanged wrapper supplies its certified store');
   t.equal(nativeObjectStorageOf(b,memory),store,'shared container keeps independent wrapper ownership');
  }
  t.equal(scans,0,'owned bindings need no per-entry descriptor allocation or lookup');
 }finally{Reflect.getOwnPropertyDescriptor=descriptor;}
 a.fields={};t.equal(validatedNativeObjectStorageOf(a,memory),null,'ordinary container replacement revokes the first wrapper');
 t.equal(validatedNativeObjectStorageOf(b,memory),store,'second wrapper remains valid');
 let fieldGetters=0;Object.defineProperty(fields,'BindingCell.value',{configurable:true,get(){fieldGetters++;return 9;}});
 t.equal(validatedNativeObjectStorageOf(b,memory),null,'shared field shadow revokes the remaining wrapper');
 t.equal(fieldGetters,0,'field validation invokes no shadow getter');delete fields['BindingCell.value'];
 t.equal(validatedNativeObjectStorageOf(b,memory),store,'restoring shared shape recertifies it');
 t.equal(validatedNativeObjectStorageOf(a,memory),null,'shape recertification cannot revive a different wrapper binding');
 a.fields=fields;t.equal(validatedNativeObjectStorageOf(a,memory),store,'restoring the first binding recertifies only that wrapper');
 let bindingGetters=0;Object.defineProperty(a,'fields',{configurable:true,get(){bindingGetters++;return fields;}});
 t.equal(validatedNativeObjectStorageOf(a,memory),null,'own binding accessor retains exact fallback');
 t.equal(bindingGetters,0,'binding validation invokes no custom getter');
 Object.defineProperty(a,'fields',{configurable:true,writable:true,value:fields});
 t.equal(validatedNativeObjectStorageOf(a,memory),store,'descriptor restoration recertifies a data binding');
 delete a.fields;Object.setPrototypeOf(a,{get fields(){bindingGetters++;return fields;}});
 t.equal(nativeObjectStorageOf(a,memory),null,'inherited field-container getter is never a canonical binding');
 t.equal(bindingGetters,0,'inherited getter is not called by metadata lookup');
 Object.defineProperty(a,'fields',{configurable:true,writable:true,value:fields});
 t.equal(validatedNativeObjectStorageOf(a,memory),store,'own binding can recover after deletion');
 const c=makeObjectRef(j,'BindingCell',fields);Object.defineProperty(c,'fields',{writable:false});
 t.equal(validatedNativeObjectStorageOf(c,memory),store,'read-only data binding remains authentic');
 Object.seal(c);t.equal(validatedNativeObjectStorageOf(c,memory),store,'sealing a wrapper preserves canonical field identity');
 const properties={type:'BindingCell',fields},copy=createNativeObjectWrapper(properties);properties.fields={};
 t.equal(validatedNativeObjectStorageOf(copy,memory),store,'factory never exposes an untrapped raw target through its input');
 const otherMemory=new WebAssembly.Memory({initial:1});
 t.equal(validatedNativeObjectStorageOf(copy,otherMemory),null,'binding certificate does not cross memory realms');
 t.equal(nativeObjectBaseOf(copy,otherMemory),-1,'primitive base also retains the realm boundary');
 t.end();
});
