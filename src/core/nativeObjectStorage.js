'use strict';
const {T,OP,uleb,sleb}=require('../jit/wasmShared');

// A small, structurally shared GC type, not a VM-global externref table. Each
// store owns only its object's reference array. The engine can therefore trace
// cycles across Java wrappers and native fields, and collect retired graphs.
// Exported Wasm helpers may be imported by compiled modules directly: their
// field operations cross no JavaScript boundary and need no GC type indices in
// those callers. The public Java object remains the original JS wrapper.
function nativeObjectStorageTypes(){return [[0x5e,T.ref,1],[0x5f,4,T.i32,0,T.i32,0,0x64,0,0,T.i32,1]];}
let cached;
function getNativeObjectStorageOps() {
  if(cached!==undefined)return cached;
  cached=null;
  if(typeof WebAssembly==='undefined')return null;
  const vector=entries=>[...uleb(entries.length),...entries.flat()];
  const section=(id,bytes)=>[id,...uleb(bytes.length),...bytes];
  const signature=(params,results)=>[0x60,...uleb(params.length),...params,...uleb(results.length),...results];
  // refs = array<mutable externref>; store = {base, classId, refs, certificate}.
  // Raw stores start uncertified. Only the private tracked field factory
  // certifies them once (0 -> 1); edits expire it permanently (-1).
  const types=[...nativeObjectStorageTypes(),
    signature([T.i32,T.i32,T.i32],[T.ref]),signature([T.ref],[T.i32]),
    signature([T.ref,T.i32],[T.ref]),signature([T.ref,T.i32,T.ref],[]),signature([T.ref],[])];
  const cast=[OP.local_get,0,0xfb,0x1a,0xfb,0x16,1];
  const bodies=[
    [OP.local_get,0,OP.local_get,1,OP.local_get,2,0xfb,7,0,OP.i32_const,0,0xfb,0,1,0xfb,0x1b],
    [...cast,0xfb,2,1,0],
    [...cast,0xfb,2,1,1],
    [...cast,0xfb,2,1,2,OP.local_get,1,0xfb,11,0],
    [...cast,0xfb,2,1,2,OP.local_get,1,OP.local_get,2,0xfb,14,0],
    [...cast,0xfb,2,1,2,OP.i32_const,0,OP.ref_null,T.ref,...cast,0xfb,2,1,2,0xfb,15,0xfb,16,0],
    [...cast,0xfb,2,1,3],
    [...cast,0xfb,2,1,3,OP.i32_eqz,OP.if,0x40,...cast,OP.i32_const,1,0xfb,5,1,3,OP.end],
    [...cast,OP.i32_const,...sleb(-1),0xfb,5,1,3],
  ].map(body=>[0,...body,OP.end]);
  const names=['create','base','classId','reference','setReference','clearReferences','certificate','certify','revoke'];
  const exports=names.map((name,index)=>[...uleb(name.length),...[...name].map(c=>c.charCodeAt(0)),0,...uleb(index)]);
  const bytes=Uint8Array.from([0,97,115,109,1,0,0,0,
    ...section(1,vector(types)),...section(3,vector([[2],[3],[3],[4],[5],[6],[3],[6],[6]])),
    ...section(7,vector(exports)),...section(10,[...uleb(bodies.length),...bodies.flatMap(b=>[...uleb(b.length),...b])])]);
  try{cached=new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;}
  catch { /* Older engines keep the existing field representation. */ }
  return cached;
}
const NATIVE_STORE=Symbol('native field storage');
const wrappers=new WeakMap(),fieldStores=new WeakMap(),wrapperTargets=new WeakMap();
function registerNativeFieldsStorage(fields,store,memory,base,shape) {fieldStores.set(fields,{fields,store,memory,base,shape});}
// A sticky native bit is shared by aliases of a field store. Revoking one
// wrapper may conservatively disable another alias's shortcut. Descriptor-based
// validation still recovers valid aliases; it never republishes this shared bit.
function revokeFields(record){
 record.shapeValid=false;if(record.store)getNativeObjectStorageOps().revoke(record.store);
}
function revokeBinding(record){
 record.bindingValid=false;if(record.store)getNativeObjectStorageOps().revoke(record.store);
}
// The raw target never escapes. Structural mutations through the public field
// container revoke its certificate before performing the operation. Ordinary
// inherited Java field setters only update the heap/GC store and retain it.
const trackedFieldMutations={
 defineProperty(target,key,descriptor){revokeFields(fieldStores.get(target));return Reflect.defineProperty(target,key,descriptor);},
 deleteProperty(target,key){revokeFields(fieldStores.get(target));return Reflect.deleteProperty(target,key);},
 setPrototypeOf(target,prototype){revokeFields(fieldStores.get(target));return Reflect.setPrototypeOf(target,prototype);},
};
function createNativeFieldsStorage(store,memory,base,shape){
 const target=Object.create(shape.prototype);target[shape.baseKey]=base;
 Object.defineProperty(target,NATIVE_STORE,{value:store});
 const fields=new Proxy(target,trackedFieldMutations);
 const valid=Number.isInteger(base)&&base>=0&&getNativeObjectStorageOps().base(store)===base;
 const record={fields,store,memory,base,shape,shapeTracked:true,shapeValid:valid};
 fieldStores.set(target,record);fieldStores.set(fields,record);if(valid)getNativeObjectStorageOps().certify(store);return fields;
}
// Track only the field-container binding. Native Java field setters mutate the
// separate fields proxy, and unrelated wrapper properties keep their behavior.
const trackedWrapperMutations={
 defineProperty(target,key,descriptor){
  if(key==='fields')revokeBinding(wrapperTargets.get(target));
  return Reflect.defineProperty(target,key,descriptor);
 },
 deleteProperty(target,key){
  if(key==='fields')revokeBinding(wrapperTargets.get(target));
  return Reflect.deleteProperty(target,key);
 },
};
function createNativeObjectWrapper(properties){
 const fields=properties.fields,shared=fieldStores.get(fields);
 if(!shared?.shapeTracked){registerNativeObjectStorage(properties,fields);return properties;}
 // Clone the temporary properties so callers cannot retain an untrapped raw
 // target. Each wrapper owns its binding certificate even for shared fields.
 const target={...properties},actual=fieldStores.get(target.fields);
 if(!actual?.shapeTracked){registerNativeObjectStorage(target,target.fields);return target;}
 const wrapper=new Proxy(target,trackedWrapperMutations),record={fields:target.fields,
  store:actual.store,memory:actual.memory,base:actual.base,shape:actual.shape,
  fieldRecord:actual,wrapperTracked:true,bindingValid:true};
 wrapperTargets.set(target,record);wrappers.set(wrapper,record);return wrapper;
}
function registerNativeObjectStorage(wrapper,fields,store,memory) {
  const record=store ? {fields,store,memory,base:getNativeObjectStorageOps().base(store)} : fieldStores.get(fields);
  if(record)wrappers.set(wrapper,record);
}
function registerNativeReferenceArrayStorage(array,store,memory) {
  wrappers.set(array,{referenceArray:true,store,memory,base:getNativeObjectStorageOps().base(store)});
}
function nativeReferenceArrayStorageOf(array,memory) {
  const record=array && wrappers.get(array);
  return record?.referenceArray && record.memory===memory?record.store:null;
}
function nativeObjectRecordOf(wrapper,memory) {
  const record=wrapper && wrappers.get(wrapper);
  if(!record || record.memory!==memory)return null;
  if(record.referenceArray||record.wrapperTracked&&record.bindingValid)return record;
  // Host replacement of a field container revokes the cached representation.
  // Reading descriptors invokes no host getter, including on a custom wrapper.
  const descriptor=Reflect.getOwnPropertyDescriptor(wrapper,'fields');
  if(!descriptor||!Object.hasOwn(descriptor,'value')||descriptor.value!==record.fields)return null;
  if(record.wrapperTracked)record.bindingValid=true;
  return record;
}
// Pair a Java reference with its own synchronously tracked storage. Unlike
// legacy transport lookup, manual registration cannot establish this fact.
// Consumers must also test the native certificate: another shared wrapper may
// have revoked it even while this binding remains otherwise canonical.
function pairedNativeObjectStorageOf(wrapper,memory){
 const record=wrapper&&wrappers.get(wrapper),fields=record?.fieldRecord;
 return record?.memory===memory&&record.wrapperTracked&&record.bindingValid&&
  fields?.shapeTracked&&fields.shapeValid===true?record.store:null;
}
function nativeObjectStorageOf(wrapper,memory) {return nativeObjectRecordOf(wrapper,memory)?.store||null;}
function nativeObjectBaseOf(wrapper,memory) {return nativeObjectRecordOf(wrapper,memory)?.base??-1;}
// A closed compiled body must not bypass a field accessor added by the host.
// Runtime field containers inherit nonconfigurable canonical accessors. Reject
// shape/base changes using descriptors, without executing getters. The shared
// layout token adds one pointer per storage record.
function validatedNativeObjectStorageOf(wrapper,memory) {
 const record=nativeObjectRecordOf(wrapper,memory),fields=record?.fieldRecord||record,shape=fields?.shape;
 if(!shape||!record.store)return null;
 if(fields.shapeValid===true)return record.store;
 if(Object.getPrototypeOf(record.fields)!==shape.prototype)return null;
 const keys=Reflect.ownKeys(record.fields);
 if(keys.length!==2||!keys.includes(shape.baseKey)||!keys.includes(NATIVE_STORE))return null;
 const base=Reflect.getOwnPropertyDescriptor(record.fields,shape.baseKey);
 const store=Reflect.getOwnPropertyDescriptor(record.fields,NATIVE_STORE);
 if(base?.value!==record.base||store?.value!==fields.store||!Number.isInteger(record.base)||record.base<0)return null;
 // This helper's non-null result is a canonical GC store with a nonnegative
 // base matching named field access. Compilers may use that contract directly.
 try{
  if(getNativeObjectStorageOps().base(record.store)!==record.base)return null;
  if(fields.shapeTracked)fields.shapeValid=true;
  return record.store;
 }
 catch{return null;}
}
module.exports={createNativeObjectWrapper,createNativeFieldsStorage,registerNativeReferenceArrayStorage,nativeReferenceArrayStorageOf,nativeObjectStorageTypes,nativeObjectBaseOf,getNativeObjectStorageOps,NATIVE_STORE,registerNativeObjectStorage,registerNativeFieldsStorage,nativeObjectStorageOf,pairedNativeObjectStorageOf,validatedNativeObjectStorageOf};
