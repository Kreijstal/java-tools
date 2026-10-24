'use strict';
const {T,OP,uleb,sleb}=require('./wasmShared');
const get=local=>[OP.local_get,...uleb(local)];
// Nullable GC stores carry a monotonic certificate. Check null first: a
// missing/foreign/customized reference must retain its original checked path.
function valid(local){return [...get(local),OP.ref_is_null,OP.if,T.i32,OP.i32_const,0,OP.else,
 ...get(local),0xfb,2,1,3,OP.i32_const,1,OP.i32_eq,OP.end];}
function contract(c){
 const plan=c.nativeStaticArrayBody;
 if(!plan?.stateful||plan.regions||!plan.objects.size||!c.directFrames||!c.compactExitLinks)return null;
 if([...plan.receivers].some(value=>!c.fn.params.includes(value)||
  !c.parameterObjectABI.includes(c.fn.params.indexOf(value))))return null;
 return {version:1,key:c.className+'.'+c.method.name+c.method.descriptor,
  objectParameters:c.parameterObjectABI.slice()};
}
function prepare(c,node,target,params,results,arrays,objects,fallback,arrayResult){
 const meta=target&&(target.callee||target).meta,proof=meta?.pairedNativeStorage;
 const indices=objects.map(input=>input.index);
 if(!proof||proof.version!==1||proof.key!==target.key||proof.run!==meta.canonicalPairedStorageRun||
  !proof.run||!indices.length||indices.length!==proof.objectParameters.length||
  indices.some((value,i)=>value!==proof.objectParameters[i])||
  indices.some(index=>c.rematLoads?.has(node.args[index])))return null;
 const byNode=c.pairedStorageCalls ||= new Map();let pair=byNode.get(node);
 if(!pair){
  const links=c.wasmJit.canonicalDirectLinks;
  const slot=links.allocate(target.key,params,results,fallback,arrays,true,[],arrayResult,indices,false,true);
  pair={slot,selected:c.nextLocal++,captured:indices.map(()=>c.nextLocal++)};
  c.declared.push(T.i32,...indices.map(()=>[0x63,1]));byNode.set(node,pair);
  c.canonicalSlots.push(slot);(c.canonicalCompactSlots ||= new Set()).add(slot);links.publish(target);
 }
 for(const input of objects)if(input.cache.pairedStore===undefined){
  input.cache.pairedStore=c.nextLocal++;input.cache.pairedRaw=c.nextLocal++;c.declared.push([0x63,1],T.ref);
 }
 return pair;
}
function fill(c,input,out){
 const cache=input.cache;
 if(c.pairedStorageIdx===undefined){
  const memory=c.heap.memory,{pairedNativeObjectStorageOf}=require('../core/nativeObjectStorage');
  c.pairedStorageIdx=c.addImport('paired_object_storage',[T.ref],[T.ref],
   object=>pairedNativeObjectStorageOf(object,memory),true);
 }
 out.push(...valid(cache.pairedStore),OP.i32_eqz,OP.if,0x40,...input.receiver,
  OP.call,...uleb(c.pairedStorageIdx),OP.local_set,...uleb(cache.pairedRaw),
  ...c.captureTypedStore(cache.pairedRaw,cache.pairedStore),OP.end,
  ...valid(cache.pairedStore),OP.if,0x40,
  ...get(cache.pairedStore),OP.local_set,...uleb(cache.typedStore),
  ...get(cache.pairedStore),0xfb,0x1b,OP.local_set,...uleb(cache.store),
  ...c.nativeStoreField(cache,0),OP.local_set,...uleb(cache.base),
  OP.i32_const,1,OP.local_set,...uleb(cache.filled),
  OP.i32_const,1,OP.local_set,...uleb(cache.storeFilled),OP.else,
  ...c.objectStoreFill(cache,input.receiver),OP.end);
}
function select(c,call,out){
 const pair=call.pair;if(!pair)return;
 out.push(OP.local_tee,...uleb(pair.selected),OP.i32_const,...sleb(call.slot),OP.i32_eq);
 for(const [i,input]of call.objects.entries())out.push(...valid(pair.captured[i]),
  ...get(pair.captured[i]),...get(input.cache.pairedStore),0xd3,OP.i32_and,OP.i32_and);
 out.push(OP.if,T.i32,OP.i32_const,...sleb(pair.slot),OP.else,...get(pair.selected),OP.end);
}
module.exports={valid,contract,prepare,fill,select};
