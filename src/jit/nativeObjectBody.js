'use strict';
const {T,OP,uleb,sleb,getOp,descToWasm,entryModeCode,Unsupported}=require('./wasmShared');
const {CanonicalDirectLinks}=require('./CanonicalDirectFrames');
const {slabSlotFor,nativeReferenceSlotFor,denseLayoutFor}=require('../core/objectModel');
const {validatedNativeObjectStorageOf}=require('../core/nativeObjectStorage');
const numeric=/^(?:[ilfd]const_(?:m1|[0-5])|bipush|sipush|ldc(?:_w|2_w)?|iinc|[ilfd](?:add|sub|mul|div|rem|neg)|[il](?:shl|shr|ushr|and|or|xor)|[ilfd]2[ilfdbcs]|lcmp|[fd]cmp[lg])$/;
const element=/^[ilfdbcs]a(?:load|store)$/;
const get=n=>[OP.local_get,...uleb(n)];

// Request extra snapshots only for plausible callback-free object loops.
// Other SSA users and callers keep their existing snapshot footprint. The
// actual field/ownership proof below remains responsible for admission.
function snapshotPredicate(c,items,structured){
 if(c.origIdx)return c.hasNestedInlineScopes?op=>op==='getfield'||op==='putfield'||op==='aaload'||element.test(op)||op==='arraylength':undefined;
 if(!c.jvm.wasmFields||!c.jvm.wasmHeap||c.origIdx||items.length>8192||
    !items.some(item=>/^(getfield|putfield|invokestatic)$/.test(getOp(item.instruction))))return undefined;
 return op=>element.test(op)||op==='arraylength'||op==='getfield'||op==='putfield'||op==='getstatic'||op==='checkcast';
}

// Resolve the same field layouts used by ordinary emission, without allocating
// imports or locals. This lets the semantic proof reject unnecessary snapshots
// BEFORE those snapshots extend register/local lifetimes.
function discoverFields(c,required=false){
 const operations=new Map();let work=0;
 for(const block of c.fn.blocks){
  if(!c.fn.reachable.has(block.id))continue;
  for(const node of block.body){
  if(++work>4096){if(required)throw new Unsupported('nested inline field proof budget');return new Map();}
  if(node.op!=='getfield'&&node.op!=='putfield')continue;
  const [,owner,[name,descriptor]]=node.imm;if(denseLayoutFor(c.jvm,owner))continue;
  const slot=slabSlotFor(c.jvm,owner,name),type=slot&&(slot.kind==='i32'?T.i32:slot.kind==='f64'?T.f64:T.i64);
  if(slot&&type===descToWasm(descriptor))operations.set(node.id,{slot,receiver:node.args[0],reference:false});
  else{
   const reference=nativeReferenceSlotFor(c.jvm,owner,name);
   if(reference)operations.set(node.id,{slot:reference,receiver:node.args[0],reference:true});
  }
 }
 }
 return operations;
}
function discardUnusedSnapshots(c,structured){
 const plan=prepare(c,structured,true);
 c.inlineNativeFields=c.hasNestedInlineScopes?discoverFields(c,true):new Map();
 const referenceDerived=value=>{
  const pending=[value],seen=new Set();let work=0;
  while(pending.length){
   const next=pending.pop();if(!next||seen.has(next))continue;
   if(++work>128)return false;seen.add(next);
   if(next.op==='aaload')return true;
   if(next.op==='phi')pending.push(...next.args);
  }
  return false;
 };
 for(const value of c.fn.values){
  const field=value.op==='getfield'||value.op==='putfield',special=value.op==='getstatic'||value.op==='checkcast';
  const checkedReference=c.hasNestedInlineScopes&&(value.op==='aaload'||
   (element.test(value.op)||value.op==='arraylength')&&referenceDerived(value.args[0]));
  const keep=field?c.inlineNativeFields.has(value.id)||plan?.lazy&&(!plan.partial||plan.fields.has(value.id)):
   checkedReference||plan&&(!plan.partial||plan.arrays.has(value.id));
  if((field||special||element.test(value.op)||value.op==='aaload'||value.op==='arraylength')&&!(special?plan?.partial&&(plan.staticReads.has(value.id)||plan.casts.has(value.id)):keep))delete value.stackUnder;
 }
 return plan;
}

// A zero-object contract still proves a checked callback-free body. The callee
// keeps its own static-cell/array guards; callers never assume those globals
// are immutable. Only private object facts may survive a successful call.
// Read preparation state only: preflight must neither compile a dependency nor
// allocate a link/import before snapshot and register-lifetime selection.
function closedCallee(c,node){
 const [,owner,[name,descriptor]]=node.imm;
 const method=c.jvm.classes[owner]?.ast?.classes?.[0]?.items.find(item=>item.type==='method'&&
  item.method.name===name&&item.method.descriptor===descriptor&&item.method.flags?.includes('static'))?.method;
 const state=method&&c.wasmJit.state.get(method),meta=state?.meta,contract=meta?.closedNativeBody;
 if(!CanonicalDirectLinks.eligible(state)||contract?.version!==1||!meta.canonicalClosedStorageRun||
    contract.key!==owner+'.'+name+descriptor||contract.run!==meta.canonicalClosedStorageRun||
    meta.parameterArrayABI?.length||!Array.isArray(contract.objectParameters)||
    contract.objectParameters.length!==(meta.parameterObjectABI?.length||0)||
    contract.objectParameters.some((index,i)=>index!==meta.parameterObjectABI[i]))return null;
 return {state,key:owner+'.'+name+descriptor,indices:contract.objectParameters.slice()};
}

// A single body for callback-free stateful array loops. The established
// single-parameter form keeps its entry guard. Multiple or loop-carried
// receivers earn validated ownership at their actual field access. Captured
// array metadata follows its SSA value, including across a native loop resume.
function prepareWhole(c,structured,preflight=false,ignoreMissingSnapshots=false){
 if(!c.heap||!c.objNativeOps||!c.directFrames||!c.jsTagEh||c.nativeStaticArrayBody||
    c.origIdx||c.liveRanges.length||c.demoted?.size||c.deoptBlocks?.size||
    c.irreducibleSplitBlocks||c.guardedNestedArrayLoopPlans?.size||
    /\)[L[]/.test(c.method.descriptor))return null;
 const operations=preflight?discoverFields(c):c.nativeObjectFieldOperations,fields=new Map(),references=new Map(),arrays=new Map();
 const receivers=new Set(),calls=new Map();let count=0,primitive=0;
 for(const block of c.fn.blocks){
  if(!c.fn.reachable.has(block.id))continue;
  if(!['return','goto','fall','cond','switch'].includes(block.term.kind))return null;
  for(const node of block.body){
   if(++count>256)return null;
   if(numeric.test(node.op)&&'IJFD'.includes(node.kind)||node.op==='nop'||node.op==='aconst_null')continue;
   if(node.op==='invokestatic'){
    const callee=closedCallee(c,node);if(!callee||calls.size>=16||!Array.isArray(node.stackUnder))return null;
    if(!preflight){
     const call=c.nativeObjectCalls.get(node.id);
     if(!call?.compact||(callee.indices.length>0&&!call.objectParameters)||call.arrays?.length||call.guardIdx!==undefined||
        call.objects.length!==callee.indices.length||call.objects.some((input,i)=>input.index!==callee.indices[i]))return null;
     callee.canonical=call;
    }
    for(const index of callee.indices){const value=node.args[index];if(!value||value.kind!=='A')return null;receivers.add(value);}
    if(receivers.size>8)return null;
    calls.set(node.id,{...callee,node});continue;
   }
   if(node.op==='getfield'||node.op==='putfield'){
    const field=operations.get(node.id);if(!field||field.receiver.kind!=='A')return null;
    receivers.add(field.receiver);if(receivers.size>8)return null;
    const split=field.slot.key.lastIndexOf('.'),owner=field.slot.key.slice(0,split),name=field.slot.key.slice(split+1);
    const declaration=c.jvm.classes[owner]?.ast?.classes?.[0]?.items.find(item=>
     item.type==='field'&&item.field.name===name&&item.field.descriptor===node.imm[2][1])?.field;
    if(!declaration||declaration.flags?.includes('volatile'))return null;
    if(field.reference){
     if(node.op!=='getfield'||!/^\[[BCSIJFD]$/.test(declaration.descriptor)||!Number.isInteger(field.slot.header))return null;
     const key=field.receiver.id+'|'+field.slot.key;
     if(!references.has(key))references.set(key,{slot:field.slot,receiver:field.receiver});
    }else primitive++;
    fields.set(node.id,field);continue;
   }
   if(element.test(node.op)||node.op==='arraylength'){
    if(!ignoreMissingSnapshots&&!Array.isArray(node.stackUnder))return null;
    arrays.set(node.id,node);continue;
   }
   return null;
  }
 }
 if(!receivers.size||fields.size>32||references.size>4||
    !calls.size&&(!structured.loopHeaders.size||primitive<4||!arrays.size))return null;
 const pending=[...receivers],seen=new Set();
 while(pending.length){
  const value=pending.pop();if(seen.has(value))continue;
  if(!value||seen.size>=64)return null;seen.add(value);
  if(c.fn.params.includes(value)||value.op==='aconst_null')continue;
  if(value.op!=='phi'||value.kind!=='A')return null;pending.push(...value.args);
 }
 const receiver=[...receivers][0],lazy=!!calls.size||receivers.size>1||!c.fn.params.includes(receiver);
 const forwarder=!!calls.size&&!fields.size&&!arrays.size;
 if(lazy&&!ignoreMissingSnapshots&&[...fields.keys()].some(id=>!Array.isArray(c.fn.values.find(v=>v.id===id)?.stackUnder)))return null;
 for(const node of arrays.values()){
  const source=fields.get(node.args[0].id);if(!source?.reference)return null;
 }
 if(preflight)return {lazy,forwarder};
 return materialize(c,{receiver,lazy,forwarder,fields,references,arrays,receivers,calls,primitive});
}

// Mixed methods can enter/leave this union of callback-free blocks through
// arbitrary CFG edges. Fresh invocation/resume locals start uncertified;
// outside -> inside edges revoke mutable object and cast facts before use. No
// partial plan is ever published as a whole-method closed certificate.
function prepareRegions(c,structured,preflight,ignoreMissingSnapshots){
 if(!c.heap||!c.objNativeOps||!c.directFrames||!c.jsTagEh||c.nativeStaticArrayBody||
    c.origIdx||c.liveRanges.length||c.demoted?.size&&!(preflight&&ignoreMissingSnapshots&&
     [...c.demoted.values()].every(reason=>reason==='op checkcast'))||c.deoptBlocks?.size||
    c.irreducibleSplitBlocks||c.guardedNestedArrayLoopPlans?.size||c.fn.blocks.length>256)return null;
 const operations=preflight?discoverFields(c):c.nativeObjectFieldOperations;
 const fields=new Map(),references=new Map(),arrays=new Map(),receivers=new Set(),calls=new Map(),blocks=new Set(),sources=new Map(),staticReads=new Map(),casts=new Map();
 let work=0,primitive=0;
 const validReceiver=value=>{
  const pending=[value],seen=new Set();
  while(pending.length){
   const next=pending.pop();if(seen.has(next))continue;
   if(!next||seen.size>=64)return false;seen.add(next);
   if(c.fn.params.includes(next)||next.op==='aconst_null')continue;
   if(next.op!=='phi'||next.kind!=='A')return false;pending.push(...next.args);
  }return true;
 };
 const fieldFor=node=>{
  const field=operations.get(node.id);if(!field||!validReceiver(field.receiver))return null;
  const split=field.slot.key.lastIndexOf('.'),owner=field.slot.key.slice(0,split),name=field.slot.key.slice(split+1);
  const declaration=c.jvm.classes[owner]?.ast?.classes?.[0]?.items.find(item=>item.type==='field'&&
   item.field.name===name&&item.field.descriptor===node.imm[2][1])?.field;
  if(!declaration||declaration.flags?.includes('volatile'))return null;
  if(field.reference&&(node.op!=='getfield'||!/^\[[BCSIJFD]$/.test(declaration.descriptor)||!Number.isInteger(field.slot.header)))return null;
  return field;
 };
 for(const block of c.fn.blocks){
  if(!c.fn.reachable.has(block.id)||!['return','goto','fall','cond','switch'].includes(block.term.kind))continue;
  const fs=new Map(),as=new Map(),cs=new Map(),ss=new Map(),sr=new Map(),xs=new Map();let good=true;
  for(const node of block.body){
   if(++work>4096)return null;
   if(numeric.test(node.op)&&'IJFD'.includes(node.kind)||node.op==='nop'||node.op==='aconst_null')continue;
   if(node.op==='getstatic'){
    const [,owner,[name,descriptor]]=node.imm;
    const declaration=c.jvm.classes[owner]?.ast?.classes?.[0]?.items.find(item=>item.type==='field'&&item.field.name===name&&item.field.descriptor===descriptor)?.field;
    const field=c.nativeStaticArrayReads.get(node.id);
    if(!/^\[[BCSIJFD]$/.test(descriptor)||!declaration||declaration.flags?.includes('volatile')||
       !declaration.flags?.includes('static')||!preflight&&!field||!ignoreMissingSnapshots&&!Array.isArray(node.stackUnder)){good=false;break;}
    sr.set(node.id,field||{owner});continue;
   }
   if(node.op==='checkcast'&&/^\[[BCSIJFD]$/.test(node.imm)){
    if(!ignoreMissingSnapshots&&!Array.isArray(node.stackUnder)){good=false;break;}
    xs.set(node.id,node);continue;
   }
   if(node.op==='getfield'||node.op==='putfield'){
    const field=fieldFor(node);if(!field||!ignoreMissingSnapshots&&!Array.isArray(node.stackUnder)){good=false;break;}
    fs.set(node.id,field);continue;
   }
   if(element.test(node.op)||node.op==='arraylength'){
    if(!ignoreMissingSnapshots&&!Array.isArray(node.stackUnder)){good=false;break;}
    // The actual array value is authenticated at its first access. It may
    // have been captured by an outside cast/aaload or carried through a phi;
    // no field-origin assumption is needed for this private owned header.
    const source=node.args[0],field=source.op==='getfield'&&fieldFor(source);
    as.set(node.id,node);if(field?.reference)ss.set(source.id,field);continue;
   }
   if(node.op==='invokestatic'){
    const callee=closedCallee(c,node);if(!callee||!Array.isArray(node.stackUnder)||callee.indices.some(i=>!validReceiver(node.args[i]))){good=false;break;}
    if(!preflight){
     const call=c.nativeObjectCalls.get(node.id);
     if(!call?.compact||(callee.indices.length>0&&!call.objectParameters)||call.arrays?.length||call.guardIdx!==undefined||
        call.objects.length!==callee.indices.length||call.objects.some((input,i)=>input.index!==callee.indices[i])){good=false;break;}
     callee.canonical=call;
    }
    cs.set(node.id,{...callee,node});continue;
   }
   good=false;break;
  }
  if(!good)continue;blocks.add(block.id);
  for(const [id,field]of fs){fields.set(id,field);sources.set(id,field);receivers.add(field.receiver);if(!field.reference)primitive++;}
  for(const [id,node]of as)arrays.set(id,node);
  for(const [id,read]of sr)staticReads.set(id,read);
  for(const [id,cast]of xs)casts.set(id,cast);
  for(const [id,field]of ss)sources.set(id,field);
  for(const [id,call]of cs){calls.set(id,call);for(const index of call.indices)receivers.add(call.node.args[index]);}
 }
 if(!calls.size||!receivers.size||calls.size>64||fields.size>128||receivers.size>8||casts.size>32||staticReads.size>16)return null;
 for(const field of sources.values())if(field.reference){
  const key=field.receiver.id+'|'+field.slot.key;if(!references.has(key))references.set(key,{slot:field.slot,receiver:field.receiver});
 }
 if(references.size>16)return null;
 // Class/header certificates travel with SSA reference values, including
 // loop/join phis. Build only the bounded upstream closure needed by actual
 // casts; flags are filled at use, never by speculative argument inspection.
 const castValues=new Map(),pending=[...casts.values()].map(node=>({value:node.args[0],target:node.imm}));
 while(pending.length){
  const item=pending.pop(),key=item.value.id+'|'+item.target;if(castValues.has(key))continue;
  if(castValues.size>=256)return null;castValues.set(key,item);
  if(item.value.op==='phi')for(const value of item.value.args){if(value?.kind!=='A')return null;pending.push({value,target:item.target});}
 }
 const plan={partial:true,lazy:true,forwarder:false,blocks,fields,references,arrays,receivers,calls,primitive,sources,staticReads,casts,castValues,receiver:[...receivers][0]};
 return preflight?plan:materialize(c,plan);
}
function prepare(c,structured,preflight=false,ignoreMissingSnapshots=false){
 return prepareWhole(c,structured,preflight,ignoreMissingSnapshots)||prepareRegions(c,structured,preflight,ignoreMissingSnapshots);
}
function materialize(c,plan){
 const {receiver,lazy,forwarder,fields,references,arrays,receivers,calls,primitive,partial,blocks,sources=fields,staticReads=new Map(),casts=new Map(),castValues=new Map()}=plan;
 const local=()=>{const n=c.nextLocal++;c.declared.push(T.i32);return n;};
 if(!lazy)for(const field of references.values()){field.base=local();field.len=local();field.filled=local();}
 const arrayCaches=new Map(),sourceCaches=new Map(),objects=new Map();
 for(const value of receivers){const cache=c.objCacheFor(value);if(partial)cache.nativeRegionValid=local();objects.set(value.id,cache);}
 for(const [id,node]of arrays){
  const value=node.args[0],source=sources.get(value.id);
  if(lazy&&!sourceCaches.has(value.id))sourceCaches.set(value.id,{base:local(),len:local(),filled:local(),captured:local()});
  const reference=lazy?sourceCaches.get(value.id):references.get(source.receiver.id+'|'+source.slot.key);
  arrayCaches.set(id,reference);
 }
 const castCaches=new Map(),castSites=new Map();
 for(const [key,{value,target}]of castValues)castCaches.set(key,{source:value.id,target,base:local(),len:local(),filled:local()});
 for(const node of casts.values())castSites.set(node.id,castCaches.get(node.args[0].id+'|'+node.imm));
 const castsBySource=new Map();for(const cache of castCaches.values()){
  let list=castsBySource.get(cache.source);if(!list)castsBySource.set(cache.source,list=[]);list.push(cache);
 }
 for(const read of staticReads.values())read.guard=c.addReadinessGuard('native_object_static_owner_'+read.owner.replace(/[^\w]/g,'_'),c.jvm.getClassInitializationToken(read.owner));
 for(const call of calls.values()){
  const original=c.wasmJit.canonicalDirectLinks.bySlot.get(call.canonical.slot);
  call.slot=c.wasmJit.canonicalDirectLinks.allocateClosed(call.key,original.params,original.results,call.indices);
  c.canonicalSlots.push(call.slot);c.wasmJit.canonicalDirectLinks.publish(call.state);
 }
 return {receiver,cache:objects.get(receiver.id),objects,lazy,forwarder,fields,references,arrayCaches,sourceCaches,calls,primitive,partial,blocks,staticReads,castSites,castCaches,castsBySource};
}
function refuse(c,out,block=c.cfg.entry){
 if(c.wasmJit.importStatsEnabled)out.push(OP.call,...uleb(c.addImport('native_object_body_refused',[],[],()=>{},true)));
 c.emitSpillResume(block,out);
}
function entry(c,out){
 const plan=c.nativeObjectBody;if(!plan||plan.partial)return;
 const closed=[],ordinary=[];
 for(const [id,cache]of plan.objects)if(cache.typedIncoming){
  closed.push(...c.nativeStoreField(cache,0),OP.local_set,...uleb(cache.base),
   OP.i32_const,1,OP.local_set,...uleb(cache.filled),OP.i32_const,1,OP.local_set,...uleb(cache.storeFilled));
 }
 if(c.wasmJit.importStatsEnabled)closed.push(OP.call,...uleb(c.addImport('closed_native_body_entered',[],[],()=>{},true)));
 if(!plan.forwarder){
  if(plan.lazy){
   if(c.wasmJit.importStatsEnabled)ordinary.push(OP.call,...uleb(c.addImport('native_object_body_lazy_entered',[],[],()=>{},true)));
  }else{
   const cache=plan.cache;
   ordinary.push(...c.objectCacheFill(cache,c.useOf(plan.receiver)),
    ...get(cache.base),OP.i32_const,0,OP.i32_lt_s,...get(cache.typedStore),OP.ref_is_null,OP.i32_or,OP.if,0x40);
   refuse(c,ordinary);ordinary.push(OP.end);
   if(c.wasmJit.importStatsEnabled)ordinary.push(OP.call,...uleb(c.addImport('native_object_body_entered',[],[],()=>{},true)));
  }
 }
 out.push(entryModeCode(c.blkLocal,ordinary,closed));
}
// The proof has no callbacks or reference writes, so a positive array-header
// capture lasts until the invocation exits. Refuse at the actual access,
// preserving effects and the operand stack already computed in this block.
function access(c,node,out){
 const plan=c.nativeObjectBody,reference=plan?.arrayCaches.get(node.id);if(!reference)return;
 if(plan.lazy){
  // A resumed loop may skip the field read that originally captured this
  // array. Recover ownership from the restored ARRAY VALUE, never from the
  // receiver's current field, which may have changed while suspended.
  const memory=c.heap.memory,{allocationForArray}=require('../core/wasmHeap');
  const index=c.addImport('native_body_array_header',[T.ref],[T.i32,T.i32],value=>{
   const record=allocationForArray(value);
   return record?.memory===memory&&record.descriptor!=='[Z'?[record.base,record.length]:[-1,0];
  },true);
  out.push(...get(reference.captured),OP.i32_eqz,OP.if,0x40,...c.useOf(node.args[0]),OP.call,...uleb(index),
   OP.local_set,...uleb(reference.len),OP.local_set,...uleb(reference.base),
   OP.i32_const,1,OP.local_set,...uleb(reference.captured),OP.end);
 }
 out.push(...get(reference.filled),OP.i32_eqz,OP.if,0x40);
 if(!plan.lazy)out.push(...get(plan.cache.base),OP.i32_load,2,...uleb(reference.slot.header),OP.local_set,...uleb(reference.base));
 out.push(...get(reference.base),OP.i32_const,0,OP.i32_lt_s,OP.if,0x40);
 if(c.wasmJit.importStatsEnabled)out.push(OP.call,...uleb(c.addImport('native_object_body_refused',[],[],()=>{},true)));
 c.emitInstructionExit(node,out);out.push(OP.end);
 if(!plan.lazy)out.push(...get(plan.cache.base),OP.i32_load,2,...uleb(reference.slot.header+4),OP.local_set,...uleb(reference.len));
 out.push(OP.i32_const,1,OP.local_set,...uleb(reference.filled));
 if(c.wasmJit.importStatsEnabled)out.push(OP.call,...uleb(c.addImport('native_object_body_array_entered',[],[],()=>{},true)));
 out.push(OP.end);
}
function guardReceiver(c,node,cache,receiver,out){
  // A general caller may have crossed an untrusted fallback after capturing a
  // private argument store. Validate the current wrapper at its actual use;
  // no incoming transport value supplies this new ownership proof.
  const memory=c.heap.memory,index=c.addImport('native_body_object_storage',[T.ref],[T.ref],
   object=>validatedNativeObjectStorageOf(object,memory),true);
  out.push(...get(cache.nativeRegionValid??cache.filled),OP.i32_eqz,OP.if,0x40,
   ...c.useOf(receiver),OP.call,...uleb(index),OP.local_set,...uleb(cache.store),
   ...c.captureTypedStore(cache.store,cache.typedStore),...get(cache.typedStore),OP.ref_is_null,OP.if,0x40);
  c.emitInstructionExit(node,out);out.push(OP.end,
   ...c.nativeStoreField(cache,0),OP.local_set,...uleb(cache.base),
   OP.i32_const,1,OP.local_set,...uleb(cache.filled),
   OP.i32_const,1,OP.local_set,...uleb(cache.storeFilled),
   ...(cache.nativeRegionValid===undefined?[]:[OP.i32_const,1,OP.local_set,...uleb(cache.nativeRegionValid)]),OP.end);
}
function beforeCall(c,node,out){
 const plan=c.nativeObjectBody,call=plan?.calls.get(node.id);if(!call)return;
 const guards=plan.forwarder?[]:out;
 for(const index of call.indices){const receiver=node.args[index];guardReceiver(c,node,plan.objects.get(receiver.id),receiver,guards);}
 if(plan.forwarder)out.push(entryModeCode(c.blkLocal,[],guards));
}
function callSlot(c,node,ordinary,out){
 const plan=c.nativeObjectBody,call=plan?.calls.get(node.id);
 if(!call){out.push(OP.i32_const,...sleb(ordinary));return;}
 const closed=[OP.i32_const,...sleb(call.slot)];
 if(plan.forwarder)out.push(entryModeCode(c.blkLocal,[OP.i32_const,...sleb(ordinary)],closed,T.i32));
 else out.push(...closed);
}
function special(c,node,out){
 const plan=c.nativeObjectBody;if(!plan?.partial)return false;
 const read=plan.staticReads.get(node.id),cast=plan.castSites.get(node.id),source=plan.sourceCaches.get(node.id);
 if(read){
  out.push(...c.readinessSeq(read.guard),OP.i32_const,...sleb(read.native.address),OP.i32_load,2,0,
   OP.i32_const,1,OP.i32_and,OP.i32_and,OP.i32_eqz,OP.if,0x40);
  c.emitInstructionExit(node,out);out.push(OP.end,OP.global_get,...uleb(read.native.index),OP.local_set,...uleb(c.mustLocal(node)),...c.cacheKillsFor(node.id));
  if(source)out.push(OP.i32_const,...sleb(read.native.address+4),OP.i32_load,2,0,OP.local_set,...uleb(source.base),
   OP.i32_const,...sleb(read.native.address+8),OP.i32_load,2,0,OP.local_set,...uleb(source.len),OP.i32_const,1,OP.local_set,...uleb(source.captured));
  return true;
 }
 if(!cast)return false;
 const memory=c.heap.memory,target=cast.target,{allocationForArray}=require('../core/wasmHeap');
 const index=c.addImport('native_body_array_cast_'+target.replace(/[^\w]/g,'_'),[T.ref],[T.i32,T.i32],value=>{
  if(value===null)return [-2,0];
  const record=allocationForArray(value),type=record&&Reflect.getOwnPropertyDescriptor(value,'type');
  return record?.memory===memory&&record.descriptor===target&&type?.value===target?[record.base,record.length]:[-1,0];
 },true);
 out.push(...get(cast.filled),OP.i32_eqz,OP.if,0x40,...c.useOf(node.args[0]),OP.call,...uleb(index),
  OP.local_set,...uleb(cast.len),OP.local_set,...uleb(cast.base),...get(cast.base),OP.i32_const,...sleb(-1),OP.i32_eq,OP.if,0x40);
 c.emitInstructionExit(node,out);out.push(OP.end,OP.i32_const,1,OP.local_set,...uleb(cast.filled),OP.end,
  ...c.useOf(node.args[0]),OP.local_set,...uleb(c.mustLocal(node)),...c.cacheKillsFor(node.id));
 const produced=plan.castCaches.get(node.id+'|'+cast.target);
 if(produced)out.push(...get(cast.base),OP.local_set,...uleb(produced.base),...get(cast.len),OP.local_set,...uleb(produced.len),
  OP.i32_const,1,OP.local_set,...uleb(produced.filled));
 if(source)out.push(...get(cast.base),OP.local_set,...uleb(source.base),...get(cast.len),OP.local_set,...uleb(source.len),
  OP.i32_const,1,OP.local_set,...uleb(source.captured));
 return true;
}
function field(c,node,out){
 if(special(c,node,out))return true;
 const plan=c.nativeObjectBody,operation=plan?.fields.get(node.id);if(!operation)return false;
 const cache=plan.objects.get(operation.receiver.id);
 if(plan.lazy)guardReceiver(c,node,cache,operation.receiver,out);
 if(operation.reference){
  out.push(...c.nativeStoreField(cache,2),OP.i32_const,...sleb(operation.slot.index),0xfb,11,0);
 }else{
  const {kind,offset}=operation.slot,isGet=node.op==='getfield';
  const op=kind==='i32'?(isGet?OP.i32_load:OP.i32_store):
   kind==='f64'?(isGet?OP.f64_load:OP.f64_store):(isGet?OP.i64_load:OP.i64_store);
  out.push(...get(cache.base),...(isGet?[]:c.useOf(node.args[1])),op,kind==='i32'?2:3,...uleb(offset));
 }
 if(node.op==='getfield')out.push(OP.local_set,...uleb(c.mustLocal(node)),...c.cacheKillsFor(node.id));
 else if(plan.partial){const [name,descriptor]=node.imm[2];
  out.push(...c.killSeqWhere(entry=>entry.kind==='f'&&entry.killKey===name+':'+descriptor));
 }
 const source=plan.sourceCaches.get(node.id);
 if(source)out.push(...get(cache.base),OP.i32_load,2,...uleb(operation.slot.header),OP.local_set,...uleb(source.base),
  ...get(cache.base),OP.i32_load,2,...uleb(operation.slot.header+4),OP.local_set,...uleb(source.len),
  OP.i32_const,1,OP.local_set,...uleb(source.captured));
 return true;
}
function inlineField(c,node,out){
 const operation=c.inlineNativeFields?.get(node.id);if(!operation)return;
 const cache=c.objCacheFor(operation.receiver);
 if(cache.nativeRegionValid===undefined){cache.nativeRegionValid=c.nextLocal++;c.declared.push(T.i32);}
 cache.inlineOwnership=true;
 guardReceiver(c,node,cache,operation.receiver,out);
}
function kill(c,id,out){
 const plan=c.nativeObjectBody,ordinary=c.objCaches?.get(id),cache=plan?.objects.get(id)||(ordinary?.inlineOwnership?ordinary:null);
 if(cache?.nativeRegionValid!==undefined)out.push(OP.i32_const,0,OP.local_set,...uleb(cache.nativeRegionValid));
 for(const cast of plan?.castCaches?.values()||[])if(cast.source===id)out.push(OP.i32_const,0,OP.local_set,...uleb(cast.filled));
 const source=plan?.sourceCaches.get(id);
 if(source)out.push(OP.i32_const,0,OP.local_set,...uleb(source.filled),OP.i32_const,0,OP.local_set,...uleb(source.captured));
}
function phiInputs(c,copies,out){
 const plan=c.nativeObjectBody,targets=[];if(!plan?.partial)return targets;
 for(const {phi,arg}of copies)for(const target of plan.castsBySource.get(phi.id)||[]){
  const source=plan.castCaches.get(arg.id+'|'+target.target);
  if(source)out.push(...get(source.base),...get(source.len),...get(source.filled));
  else out.push(OP.i32_const,0,OP.i32_const,0,OP.i32_const,0);
  targets.push(target);
 }
 return targets;
}
function phiOutputs(targets,out){
 for(const target of targets.slice().reverse())out.push(OP.local_set,...uleb(target.filled),OP.local_set,...uleb(target.len),OP.local_set,...uleb(target.base));
}
function edge(c,from,target,out){
 const plan=c.nativeObjectBody;
 if(!plan?.partial||plan.blocks.has(from)||!plan.blocks.has(target))return;
 for(const cache of plan.objects.values())out.push(OP.i32_const,0,OP.local_set,...uleb(cache.nativeRegionValid));
 for(const cast of plan.castCaches.values())out.push(OP.i32_const,0,OP.local_set,...uleb(cast.filled));
 // A completed positive header check belongs to the allocator-owned ARRAY
 // VALUE, not its current field/container. Callbacks cannot move that live
 // allocation or change its length. SSA redefinitions still revoke it in
 // kill(), and a fresh invocation/resume starts with zeroed local flags.
 // Unvalidated field/cast captures do not yet establish that positive fact.
 for(const source of plan.sourceCaches.values())out.push(...get(source.filled),OP.i32_eqz,OP.if,0x40,
  OP.i32_const,0,OP.local_set,...uleb(source.captured),OP.end);
}
function needsSnapshotRetry(c,structured){
 const plan=prepare(c,structured,true,true);if(!plan)return false;
 return c.fn.values.some(value=>!Array.isArray(value.stackUnder)&&
  (plan.partial?plan.arrays.has(value.id)||plan.fields.has(value.id)||plan.staticReads.has(value.id)||plan.casts.has(value.id):
   element.test(value.op)||value.op==='arraylength'||plan.lazy&&(value.op==='getfield'||value.op==='putfield')));
}
module.exports={snapshotPredicate,discardUnusedSnapshots,prepare,entry,access,field,inlineField,kill,beforeCall,callSlot,phiInputs,phiOutputs,edge,needsSnapshotRetry};
