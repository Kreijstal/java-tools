'use strict';
const {T,OP,uleb,sleb,MATH_INTRINSICS}=require('./wasmShared');
const numeric=/^(?:[ilfd]const_(?:m1|[0-5])|bipush|sipush|ldc(?:_w|2_w)?|iinc|[ilfd](?:add|sub|mul|div|rem|neg)|[il](?:shl|shr|ushr|and|or|xor)|[ilfd]2[ilfdbcs]|lcmp|[fd]cmp[lg])$/;
const element=/^[ilfdbcs]a(?:load|store)$/;
const load=address=>[OP.i32_const,...sleb(address),OP.i32_load,2,0];
const get=local=>[OP.local_get,...uleb(local)];
const {nativeReferenceSlotFor,classIndexOf}=require('../core/objectModel');
const {validatedNativeObjectStorageOf}=require('../core/nativeObjectStorage');

// One representation-specialized body, not a clone beside a generic body.
// A failed side-effect-free entry guard uses the existing interpreter/OSR
// handoff. No successful body operation may call guest code or an untrusted
// host callback, change these fields, allocate, or yield and then continue.
// This is deliberately for substantial array kernels: small methods do not
// amortize guarding every static dependency and losing their OSR checkpoint.
function prepareWhole(c){
 if(!c.heap||c.liveRanges.length||c.demoted.size||c.deoptBlocks.size||
    c.irreducibleSplitBlocks||c.guardedNestedArrayLoopPlans?.size||
    !(c.method.flags||[]).includes('static')||c.fn.params.some(p=>p.kind==='A')||
    /\)[L[]/.test(c.method.descriptor))return null;
 const reads=c.nativeStaticArrayReads,fields=new Map(),roots=[];
 let count=0,sites=0;
 for(const block of c.fn.blocks){
  if(!c.fn.reachable.has(block.id))continue;
  if(!['return','goto','fall','cond','switch'].includes(block.term.kind))return null;
  for(const node of block.body){
   if(++count>4096)return null;
   if(numeric.test(node.op)&&'IJFD'.includes(node.kind)||node.op==='nop'||node.op==='aconst_null')continue;
   if(node.op==='getstatic'){
    const field=reads?.get(node.id);if(!field)return null;
    fields.set(field.native.address,field);if(fields.size>16)return null;
    continue;
   }
   if(element.test(node.op)||node.op==='arraylength'){
    roots.push(node.args[0]);sites++;continue;
   }
   // Math intrinsics are already classified as pure by static-call lowering.
   // All other invokes (including unresolved/late-bound calls) are refused.
   if(node.op==='invokestatic'&&node.imm?.[1]==='java/lang/Math'&&
      MATH_INTRINSICS.has(node.imm?.[2]?.[0]))continue;
   return null;
  }
 }
 if(count<128||sites<16||!fields.size)return null;
 const references=new Map();let work=0;
 for(const root of roots){
  const pending=[root],seen=new Set();let hasSource=false;
  while(pending.length){
   const value=pending.pop();if(seen.has(value))continue;
   if(!value||++work>50000||references.size>=128)return null;
   seen.add(value);references.set(value.id,value);
   if(value.op==='getstatic'&&reads.has(value.id)){hasSource=true;continue;}
   if(value.op!=='phi'||value.kind!=='A')return null;
   pending.push(...value.args);
  }
  if(!hasSource)return null;
 }
 for(const field of fields.values()){
  field.base=c.nextLocal++;field.len=c.nextLocal++;c.declared.push(T.i32,T.i32);
  const idx=c.addReadinessGuard('native_array_owner_'+field.owner.replace(/[^\w]/g,'_'),
   c.jvm.getClassInitializationToken(field.owner));
  c.inlinedInitializationGuards.add(idx);(c.staticInitializationGuards ||= new Set()).add(field.owner);
 }
 for(const value of references.values())c.arrayCacheFor(value);
 return {fields,reads,references,sites};
}
// One body for bounded integer state over statics and readonly instance arrays.
// Scalar stores remain visible at their exact Java instruction; only cell
// representation/readiness decisions move to a side-effect-free entry guard.
function prepareStateful(c,structured,scope=null){
 if(!c.heap||c.liveRanges.length||c.demoted.size||c.deoptBlocks.size||
    c.irreducibleSplitBlocks||c.guardedNestedArrayLoopPlans?.size)return null;
 // Flattened leaf code is safe under the same whole-body effect proof. Keep
 // only loops with an original header or an existing recovered activation;
 // this proof never invents a new fuel/resumption policy for a spliced loop.
 if(c.origIdx&&(!structured||[...structured.loopHeaders].some(header=>{
  if(scope&&!scope.blocks.has(header))return false;
  const item=c.cfg.blocks[header].insns[0];
  return c.origIdx[item]<0&&!require('./inlineActivationResume').at(c,item);
 })))return null;
 const reads=new Map(),fields=new Map(),scalars=new Map(),scalarSites=new Map(),roots=[];
 const instanceReads=new Map(),instanceArrays=new Map(),receivers=new Set(),guards=new Map(),fallbacks=new Set(),checkedReferenceLoads=new Set();let tailLoads=0;
 const input=value=>c.fn.params.includes(value)||scope?.inputs.has(value.id);
 let count=0,sites=0,writes=0;
 for(const block of c.fn.blocks){
  if(!c.fn.reachable.has(block.id)||scope&&!scope.blocks.has(block.id))continue;
  if(!['return','goto','fall','cond','switch'].includes(block.term.kind))return null;
  for(const node of block.body){
   if(++count>256)return null;
   if(numeric.test(node.op)&&'IJFD'.includes(node.kind)||node.op==='nop'||node.op==='aconst_null')continue;
   // These are synthetic dispatch guards, not guest instanceof expressions.
   // A positive class match is proved with authenticated private storage. An
   // unknown class takes the original invoke handoff below, never a host cast.
   if(node.op==='instanceof'&&c.items[node.itemIdx]?.inlineReceiverGuard&&
      input(node.args[0])&&c.objNativeOps){
    const matching=Object.keys(c.jvm.classes).filter(name=>c.jvm.isInstanceOfSync(name,node.imm)===true);
    if(!matching.length||matching.length>16)return null;
    receivers.add(node.args[0]);if(receivers.size>8)return null;
    guards.set(node.id,{receiver:node.args[0],classes:matching.map(name=>classIndexOf(c.jvm,name))});continue;
   }
   // A generated miss exits AT the original invoke. It cannot run an opaque
   // callback and then rejoin this body's cached scalar/array state.
   if(/^invoke/.test(node.op)&&c.items[node.itemIdx]?.inlineFallbackCall&&
      Number.isInteger(c.origIdx?.[node.itemIdx])&&c.origIdx[node.itemIdx]>=0){
    fallbacks.add(node.id);continue;
   }
   if(node.op==='getstatic'||node.op==='putstatic'){
    const scalar=c.nativeStaticScalarAccesses.get(node.id);
    if(scalar){
     scalarSites.set(node.id,scalar);if(scalar.write)writes++;
     let field=scalars.get(scalar.native.address);
     if(!field)scalars.set(scalar.native.address,field={...scalar,mask:0});
     field.mask|=scalar.write?2:1;continue;
    }
    const field=node.op==='getstatic'&&c.nativeStaticArrayReads.get(node.id);if(!field)return null;
    reads.set(node.id,field);fields.set(field.native.address,field);continue;
   }
   if(node.op==='getfield'){
    if(!c.objNativeOps||!input(node.args[0]))return null;
    const [,owner,[name,descriptor]]=node.imm,slot=nativeReferenceSlotFor(c.jvm,owner,name);
    const declaration=c.jvm.classes[owner]?.ast?.classes?.[0]?.items.find(item=>item.type==='field'&&
     item.field.name===name&&item.field.descriptor===descriptor)?.field;
    if(!slot||!declaration||declaration.flags?.includes('volatile')||declaration.flags?.includes('static'))return null;
    receivers.add(node.args[0]);if(receivers.size>8||instanceReads.size>=32)return null;
    const key=node.args[0].id+'|'+slot.key;let array;
    if(/^\[[BCSIJFD]$/.test(descriptor)&&Number.isInteger(slot.header)){
     array=instanceArrays.get(key);
     if(!array)instanceArrays.set(key,array={slot,receiver:node.args[0]});
    }
    instanceReads.set(node.id,{slot,receiver:node.args[0],array,block:block.id});continue;
   }
   // A final reference-array read may run a foreign getter, but cannot return
   // to the certified body. All original writes already happened before it.
   if(node.op==='aaload'&&block.body.at(-1)===node&&(
      block.term.kind==='return'&&block.term.insnOp==='areturn'&&block.term.args[0]===node||
      scope&&block.term.kind==='goto'&&c.cfg.blocks[block.term.target]?.insns[0]===scope.end)){tailLoads++;continue;}
   // Continue only through the owned reference-array branch. Foreign or
   // customized arrays hand off before their original getter executes.
   if(node.op==='aaload'&&c.objNativeOps&&node.slotState&&Array.isArray(node.stackUnder)){
    checkedReferenceLoads.add(node.id);continue;
   }
   if(element.test(node.op)||node.op==='arraylength'){roots.push(node.args[0]);sites++;continue;}
   return null;
  }
 }
 if(writes<2||!sites||!fields.size&&!instanceArrays.size||fields.size>8||scalars.size>8||instanceArrays.size>8)return null;
 const references=new Map();let work=0;
 for(const root of roots){
  const pending=[root],seen=new Set();let source=false;
  while(pending.length){
   const value=pending.pop();if(seen.has(value))continue;
   if(!value||++work>4096||references.size>=64)return null;
   seen.add(value);references.set(value.id,value);
   // Generated miss invokes terminate this specialized invocation. Their
   // apparent SSA result may meet a real array at a join, but that result
   // never reaches the join in emitted native code.
   if(fallbacks.has(value.id))continue;
   if(value.op==='getstatic'&&reads.has(value.id)||value.op==='getfield'&&instanceReads.get(value.id)?.array){source=true;continue;}
   if(value.op==='aaload'&&checkedReferenceLoads.has(value.id)){source=true;continue;}
   if(value.op!=='phi'||value.kind!=='A')return null;pending.push(...value.args);
  }
  if(!source)return null;
 }
 const objects=new Map([...receivers].map(receiver=>[receiver.id,c.objCacheFor(receiver)]));
 if(scope)for(const cache of objects.values()){
  if(cache.nativeRegionValid===undefined){cache.nativeRegionValid=c.nextLocal++;c.declared.push(T.i32);}
  cache.inlineOwnership=true;
 }
 for(const guard of guards.values()){guard.local=c.nextLocal++;c.declared.push(T.i32);}
 for(const field of [...fields.values(),...instanceArrays.values()]){field.base=c.nextLocal++;field.len=c.nextLocal++;c.declared.push(T.i32,T.i32);}
 for(const field of scalars.values())if(field.mask&1){field.value=c.nextLocal++;c.declared.push(T.i32);}
 const readinessGuards=[];
 for(const field of [...fields.values(),...scalars.values()]){
  const guard=c.addReadinessGuard('native_state_owner_'+field.owner.replace(/[^\w]/g,'_'),c.jvm.getClassInitializationToken(field.owner));
  readinessGuards.push(guard);
  if(!scope)c.inlinedInitializationGuards.add(guard);
  (c.staticInitializationGuards ||= new Set()).add(field.owner);
 }
 const dynamicReferences=new Set(checkedReferenceLoads);
 for(let changed=true;changed;){changed=false;
  for(const value of references.values())if(value.op==='phi'&&!dynamicReferences.has(value.id)&&value.args.some(arg=>dynamicReferences.has(arg.id))){
   dynamicReferences.add(value.id);changed=true;
  }
 }
 for(const value of references.values()){
  const cache=c.arrayCacheFor(value);
  if(checkedReferenceLoads.size&&cache.owned===undefined){cache.owned=c.nextLocal++;c.declared.push(T.i32);}
 }
 return {stateful:true,closed:!instanceReads.size&&!tailLoads&&!fallbacks.size&&!checkedReferenceLoads.size&&(c.method.flags||[]).includes('static')&&
  !c.fn.params.some(p=>p.kind==='A')&&!/\)[L[]/.test(c.method.descriptor),
  fields,reads,scalars,scalarSites,references,sites,instanceReads,instanceArrays,objects,receivers,tailLoads,guards,fallbacks,checkedReferenceLoads,dynamicReferences,readinessGuards,scope};
}
function refuseEntry(c,out,plan){
 if(plan?.scope){c.emitSpillResume(plan.scope.entry,out);return;}
 if(c.loopResume){
  require('./structuredLoopResume').test(c,out);out.push(OP.if,0x40);
  c.emitSpillResume(c.loopResume.header,out);out.push(OP.else);
 }
 c.emitSpillResume(c.cfg.entry,out);if(c.loopResume)out.push(OP.end);
}
function entry(c,out){
 const plan=c.nativeStaticArrayBody;if(!plan)return;
 if(plan.regions){const first=plan.entries.get(c.cfg.entry);if(first)regionEntry(c,first,out);return;}
 stateEntry(c,plan,out);
}
function stateEntry(c,plan,out){
 for(const guard of plan.scope?plan.readinessGuards:[]){
  out.push(...c.readinessSeq(guard),OP.i32_eqz,OP.if,0x40);refuseEntry(c,out,plan);out.push(OP.end);
 }
 // A skipped prefix may be the only user of an instance receiver. Its Java
 // local need not survive a yield; authenticate restored array values instead
 // of demanding a now-dead receiver or substituting its current field.
 const resumed=new Set();
 if(c.loopResume){const work=[c.loopResume.header];while(work.length){const id=work.pop();
  if(resumed.has(id))continue;resumed.add(id);work.push(...c.cfg.succ[id]);}}
 const resumeReads=(receiver,array)=>[...plan.instanceReads?.values()||[]].some(read=>
  read.receiver===receiver&&(!array||read.array===array)&&resumed.has(read.block));
 if(plan.objects?.size){
  const memory=c.heap.memory,index=c.addImport('native_state_object_storage',[T.ref],[T.ref],
   object=>validatedNativeObjectStorageOf(object,memory),true);
  for(const receiver of plan.receivers){const cache=plan.objects.get(receiver.id),freshOnly=c.loopResume&&!resumeReads(receiver);
   if(freshOnly){require('./structuredLoopResume').test(c,out,false);out.push(OP.if,0x40);}
   if(plan.scope)out.push(...get(cache.nativeRegionValid),OP.i32_eqz,OP.if,0x40);
   const checked=[...c.useOf(receiver),OP.call,...uleb(index),OP.local_set,...uleb(cache.store),
    ...c.captureTypedStore(cache.store,cache.typedStore)];
   if(c.pairedNativeStorage){
    const {entryModeCode,PAIRED_STORAGE_ENTRY}=require('./wasmShared');
    // Only a compiler-paired entry may authenticate the incoming typed store
    // in Wasm. Ordinary exports always validate against the actual Java ref.
    // Late argument callbacks can revoke a store already on the call stack.
    const paired=[...require('./pairedNativeStorage').valid(cache.typedStore),OP.if,0x40,
     ...get(cache.typedStore),0xfb,0x1b,OP.local_set,...uleb(cache.store),OP.else,...checked,OP.end];
    out.push(entryModeCode(c.blkLocal,checked,paired,0x40,PAIRED_STORAGE_ENTRY));
   }else out.push(...checked);
   out.push(...get(cache.typedStore),OP.ref_is_null,OP.if,0x40);
   refuseEntry(c,out,plan);out.push(OP.end,...c.nativeStoreField(cache,0),OP.local_set,...uleb(cache.base),
    OP.i32_const,1,OP.local_set,...uleb(cache.filled),OP.i32_const,1,OP.local_set,...uleb(cache.storeFilled));
   if(plan.scope)out.push(OP.i32_const,1,OP.local_set,...uleb(cache.nativeRegionValid),OP.end);
   if(freshOnly)out.push(OP.end);
  }
 }
 let first=true;
 for(const field of plan.scalars?.values()||[]){
  // The cell publishes numeric representation with its permissions. Java int
  // stores preserve that fact, so neither repeated tag loads nor stores remain.
  const mask=field.mask|(field.mask&2?4:0);
  out.push(...load(field.native.address),OP.i32_const,...sleb(mask),OP.i32_and,OP.i32_const,...sleb(mask),OP.i32_eq);
  if(!first)out.push(OP.i32_and);first=false;
 }
 for(const field of plan.fields.values()){
  out.push(...load(field.native.address),OP.i32_const,1,OP.i32_and,
   ...load(field.native.address+4),OP.local_tee,...uleb(field.base),
   OP.i32_const,0,OP.i32_ge_s,OP.i32_and,
   ...load(field.native.address+8),OP.local_set,...uleb(field.len));
  if(!first)out.push(OP.i32_and);first=false;
 }
 for(const field of plan.instanceArrays?.values()||[]){
  const cache=plan.objects.get(field.receiver.id),freshOnly=c.loopResume&&!resumeReads(field.receiver,field);
  if(freshOnly){require('./structuredLoopResume').test(c,out,false);out.push(OP.if,T.i32);}
  out.push(...get(cache.base),OP.i32_load,2,...uleb(field.slot.header),OP.local_tee,...uleb(field.base),
   OP.i32_const,0,OP.i32_ge_s,...get(cache.base),OP.i32_load,2,...uleb(field.slot.header+4),OP.local_set,...uleb(field.len));
  if(freshOnly)out.push(OP.else,OP.i32_const,1,OP.end);
  if(!first)out.push(OP.i32_and);first=false;
 }
 out.push(OP.i32_eqz,OP.if,0x40);
 if(c.wasmJit.importStatsEnabled)out.push(OP.call,...uleb(c.addImport('native_static_arrays_refused',[],[],()=>{},true)));
 refuseEntry(c,out,plan);out.push(OP.end);
 for(const field of plan.scalars?.values()||[])if(field.value!==undefined)out.push(...load(field.native.address+4),OP.local_set,...uleb(field.value));
 if(c.wasmJit.importStatsEnabled)out.push(OP.call,...uleb(c.addImport('native_static_arrays_entered',[],[],()=>{},true)));
 if(plan.stateful&&c.loopResume){
  require('./structuredLoopResume').test(c,out);out.push(OP.if,0x40);
  const memory=c.heap.memory,{allocationForArray}=require('../core/wasmHeap');
  const index=c.addImport('native_state_resumed_header',[T.ref],[T.i32,T.i32],value=>{
   const record=allocationForArray(value);return record?.memory===memory&&record.descriptor!=='[Z'?[record.base,record.length]:[-1,0];
  },true);
  for(const binding of c.loopResume.restore){
   if(!plan.references.has(binding.value.id))continue;
   const cache=c.arrayCaches.get(binding.value.id);
   out.push(...get(binding.local),OP.call,...uleb(index),OP.local_set,...uleb(cache.len),OP.local_tee,...uleb(cache.base),
    OP.i32_const,0,OP.i32_lt_s,OP.if,0x40);c.emitSpillResume(c.loopResume.header,out);out.push(OP.end);
  }
  out.push(OP.end);
 }
}

function planFor(c,node){const owner=c.nativeStaticArrayBody;return owner?.regions?owner.nodePlans?.get(node.id):owner;}
function instruction(c,node,out){
 const plan=planFor(c,node);
 if(plan?.fallbacks?.has(node.id)){c.emitInstructionExit(node,out);return true;}
 const guard=plan?.guards?.get(node.id);if(!guard)return false;
 const cache=plan.objects.get(guard.receiver.id);
 out.push(...c.nativeStoreField(cache,1),OP.local_set,...uleb(guard.local));
 for(const [i,index]of guard.classes.entries()){
  out.push(...get(guard.local),OP.i32_const,...sleb(index),OP.i32_eq);
  if(i)out.push(OP.i32_or);
 }
 out.push(OP.local_set,...uleb(c.mustLocal(node)),...c.cacheKillsFor(node.id));return true;
}
function access(c,node,out){
 const plan=planFor(c,node);
 if(!plan?.dynamicReferences?.has(node.args[0]?.id)||!(element.test(node.op)||node.op==='arraylength'))return;
 const cache=c.arrayCacheFor(node.args[0]),memory=c.heap.memory;
 const {allocationForArray}=require('../core/wasmHeap');
 const index=c.addImport('native_state_array_header',[T.ref],[T.i32,T.i32],value=>{
  const record=allocationForArray(value);
  return record?.memory===memory&&record.descriptor!=='[Z'?[record.base,record.length]:[-1,0];
 },true);
 out.push(...get(cache.owned),OP.i32_eqz,OP.if,0x40,...c.useOf(node.args[0]),OP.call,...uleb(index),
  OP.local_set,...uleb(cache.len),OP.local_tee,...uleb(cache.base),OP.i32_const,0,OP.i32_lt_s,OP.if,0x40);
 c.emitInstructionExit(node,out);out.push(OP.end,OP.i32_const,1,OP.local_set,...uleb(cache.owned),
  OP.i32_const,1,OP.local_set,...uleb(cache.filled),OP.end);
}
function read(c,node,out){
 const owner=c.nativeStaticArrayBody,plan=owner?.regions?owner.readPlans.get(node.id):owner;
 const scalar=plan?.scalarSites?.get(node.id);
 if(scalar){
  const address=scalar.native.address,value=plan.scalars.get(address).value;
  if(scalar.write){
   out.push(OP.i32_const,...sleb(address+4),...c.useOf(node.args[0]),
    ...(value===undefined?[]:[OP.local_tee,...uleb(value)]),OP.i32_store,2,0,
    ...c.killSeqWhere(entry=>entry.kind==='s'&&entry.killKey===scalar.killKey));
  }else out.push(...get(value),OP.local_set,...uleb(c.mustLocal(node)),...c.cacheKillsFor(node.id));
  return true;
 }
 const instance=plan?.instanceReads?.get(node.id);
 if(instance){
  const cache=plan.objects.get(instance.receiver.id);
  out.push(...c.nativeStoreField(cache,2),OP.i32_const,...sleb(instance.slot.index),0xfb,11,0,
   OP.local_set,...uleb(c.mustLocal(node)),...c.cacheKillsFor(node.id));
  const array=c.arrayCaches.get(node.id);
  if(instance.array&&array)out.push(...get(instance.array.base),OP.local_set,...uleb(array.base),
   ...get(instance.array.len),OP.local_set,...uleb(array.len),
   ...(!plan.checkedReferenceLoads?.size||array.owned===undefined?[]:[OP.i32_const,1,OP.local_set,...uleb(array.owned)]));
  return true;
 }
 const field=plan?.reads.get(node.id);if(!field)return false;
 const source=plan.fields.get(field.native.address);
 out.push(OP.global_get,...uleb(field.native.index),OP.local_set,...uleb(c.mustLocal(node)),...c.cacheKillsFor(node.id));
 const cache=owner.regions&&!plan.stateful?null:c.arrayCaches.get(node.id);
 if(cache)out.push(...get(source.base),OP.local_set,...uleb(cache.base),
  ...get(source.len),OP.local_set,...uleb(cache.len));
 if(plan.checkedReferenceLoads?.size&&cache?.owned!==undefined)out.push(OP.i32_const,1,OP.local_set,...uleb(cache.owned));
 return true;
}
function phiCopies(c,copies,out,from){
 const owner=c.nativeStaticArrayBody;if(owner?.regions){
  const transfers=[];
  for(const {phi,arg} of copies){
   const plan=owner.phiPlans.get(phi.id);if(!plan||!plan.blocks.has(from))continue;
   const source=plan.caches.get(arg.id),target=plan.caches.get(phi.id);
   out.push(...get(source.base),...get(source.len));transfers.push({source,target,owned:plan.checkedReferenceLoads?.size});
  }
  for(const {target}of transfers.slice().reverse())out.push(OP.local_set,...uleb(target.len),OP.local_set,...uleb(target.base));
  const ownership=transfers.filter(x=>x.owned);
  for(const {source}of ownership)out.push(...get(source.owned));
  return ownership.map(x=>x.target);
 }
 const refs=owner?.references;if(!refs)return;
 const transfers=copies.filter(({phi})=>refs.has(phi.id));
 const owned=owner.checkedReferenceLoads?.size;
 for(const {arg} of transfers){const cache=c.arrayCaches.get(arg.id);out.push(...get(cache.base),...get(cache.len));}
 for(const {phi} of transfers.slice().reverse()){
  const cache=c.arrayCaches.get(phi.id);out.push(OP.local_set,...uleb(cache.len),OP.local_set,...uleb(cache.base));
 }
 // Ownership sources must be captured before any phi's ordinary cache kill,
 // and installed after all those kills. This also preserves cyclic copies.
 if(owned){
  for(const {arg}of transfers)out.push(...get(c.arrayCaches.get(arg.id).owned));
  return transfers.map(({phi})=>c.arrayCaches.get(phi.id));
 }
}

// An inlined wrapper remains a proof boundary even when the outer method has
// calls, allocations or stores. The entry is a real original PC-0 activation;
// every outside edge authenticates fresh state before any wrapper effect.
function prepareInlineScopes(c,structured){
 if(!c.hasNestedInlineScopes||c.fn.blocks.length>512)return null;
 const labels=new Map(c.items.flatMap((item,i)=>item.labelDef?[[item.labelDef.replace(/:$/,''),i]]:[]));
 const candidates=c.items.flatMap((item,start)=>{
  const end=labels.get(item.inlineScopeEnd);
  return item.inlineScopeEnd&&end>start?[{start,end}]:[];
 }).sort((a,b)=>(b.end-b.start)-(a.end-a.start));
 const regions=[],occupied=new Set();let work=0;
 for(const {start,end}of candidates){
  if(regions.length>=4||work>50000)break;
  const blocks=new Set(c.cfg.blocks.filter(block=>block.insns.every(i=>i>=start&&i<end)&&c.fn.reachable.has(block.id)).map(block=>block.id));
  const entry=c.cfg.blocks.find(block=>block.insns[0]===start)?.id;
  if(entry===undefined||!blocks.has(entry)||[...blocks].some(id=>occupied.has(id)))continue;
  let valid=true;
  for(const id of blocks){
   work+=c.fn.blocks[id].predIds.length;
   if(id!==entry&&c.fn.blocks[id].predIds.some(p=>!blocks.has(p))){valid=false;break;}
  }
  if(!valid||work>50000)continue;
  const at=c.fn.blocks[entry],inputs=new Set([...at.slotDefsIn.values(),...at.entryStack].map(value=>value.id));
  const scope={entry,end,blocks,inputs},plan=prepareStateful(c,structured,scope);if(!plan)continue;
  Object.assign(plan,{entry,blocks,external:new Map(),caches:new Map([...plan.references].map(([id,value])=>[id,c.arrayCacheFor(value)]))});
  regions.push(plan);for(const id of blocks)occupied.add(id);
 }
 if(!regions.length)return null;
 // The dry run saw these splices before regions existed and collected eager
 // root guards. When ALL uses of an owner are now behind scope entries, those
 // guards belong at the original wrapper entry, after caller effects.
 const owners=new Set(regions.flatMap(plan=>[...plan.fields.values(),...plan.scalars.values()].map(field=>field.owner)));
 for(const owner of owners){
  const outside=c.fn.blocks.some(block=>c.fn.reachable.has(block.id)&&!occupied.has(block.id)&&
   (block.body.some(node=>['getstatic','putstatic','invokestatic'].includes(node.op)&&node.imm?.[1]===owner)||
    c.cfg.blocks[block.id].insns.some(i=>c.items[i].inlineStaticOwner===owner)));
  if(!outside)c.inlinedInitializationGuards.delete(c.addReadinessGuard('native_state_owner_'+owner.replace(/[^\w]/g,'_'),c.jvm.getClassInitializationToken(owner)));
 }
 const result={regions,entries:new Map(),sitePlans:new Map(),readPlans:new Map(),nodePlans:new Map(),phiPlans:new Map(),
  stateful:true,sites:0,tailLoads:0,scalarSites:new Map(),instanceReads:new Map(),checkedReferenceLoads:new Set()};
 for(const plan of regions){
  result.entries.set(plan.entry,plan);result.sites+=plan.sites;result.tailLoads+=plan.tailLoads;
  for(const [id,value]of plan.references)if(value.op==='phi'&&plan.blocks.has(value.block))result.phiPlans.set(id,plan);
  for(const id of plan.checkedReferenceLoads)result.checkedReferenceLoads.add(id);
  for(const [id,value]of plan.scalarSites)result.scalarSites.set(id,value);
  for(const [id,value]of plan.instanceReads)result.instanceReads.set(id,value);
  for(const block of plan.blocks)for(const node of c.fn.blocks[block].body){
   result.nodePlans.set(node.id,plan);
   if(plan.reads.has(node.id)||plan.scalarSites.has(node.id)||plan.instanceReads.has(node.id))result.readPlans.set(node.id,plan);
   if(element.test(node.op)||node.op==='arraylength')result.sitePlans.set(node.id,plan);
  }
 }
 return result;
}

// A region has one entry block, reached only through guarded outside edges.
// Private metadata locals avoid introducing early parameter metadata queries
// or lending a native proof to generic accesses after a region has ended.
function prepareRegions(c){
 if(!c.heap||c.origIdx||c.liveRanges.length||c.demoted.size||c.deoptBlocks.size||
    c.irreducibleSplitBlocks||c.guardedNestedArrayLoopPlans?.size||c.fn.blocks.length>256)return null;
 const fn=c.fn,cfg=c.cfg,reads=c.nativeStaticArrayReads;
 let work=0;
 const good=new Set();
 for(const block of fn.blocks){
  if(!fn.reachable.has(block.id)||!['return','goto','fall','cond','switch'].includes(block.term.kind))continue;
  if(block.body.every(node=>numeric.test(node.op)&&'IJFD'.includes(node.kind)||node.op==='nop'||node.op==='aconst_null'||
     node.op==='getstatic'&&reads.has(node.id)||element.test(node.op)||node.op==='arraylength'||
     node.op==='invokestatic'&&node.imm?.[1]==='java/lang/Math'&&MATH_INTRINSICS.has(node.imm?.[2]?.[0])))good.add(block.id);
 }
 const dominates=(from,to)=>{
  const pending=[cfg.entry],seen=new Set();
  while(pending.length){
   if(++work>50000)return false;
   const id=pending.pop();if(id===from||seen.has(id))continue;
   if(id===to)return false;seen.add(id);pending.push(...cfg.succ[id]);
  }
  return true;
 };
 const candidates=[];
 for(const start of good){
  if(candidates.length>=16||work>50000)break;
  if(start!==cfg.entry&&fn.blocks[start].predIds.every(id=>good.has(id)))continue;
  const blocks=new Set(),pending=[start];
  while(pending.length&&work++<50000){
   const id=pending.pop();if(blocks.has(id)||!good.has(id))continue;blocks.add(id);pending.push(...cfg.succ[id]);
  }
  let changed=true;
  while(changed&&work<50000){
   changed=false;
   for(const id of [...blocks])if(id!==start){
    work+=fn.blocks[id].predIds.length;
    if(fn.blocks[id].predIds.some(p=>!blocks.has(p))){blocks.delete(id);changed=true;}
   }
  }
  if(!blocks.size||blocks.size>128||work>50000)continue;
  const regionReads=new Map(),fields=new Map(),memory=new Map();let nodes=0;
  for(const id of blocks)for(const node of fn.blocks[id].body){
   nodes++;
   if(node.op==='getstatic'){const field=reads.get(node.id);regionReads.set(node.id,field);fields.set(field.native.address,field);}
   if(element.test(node.op)||node.op==='arraylength')memory.set(node.id,node);
  }
  if(nodes<128||nodes>4096||memory.size<16||fields.size>16)continue;
  const references=new Map(),external=new Map();let valid=true;
  for(const node of memory.values()){
   const queue=[node.args[0]],seen=new Set();let source=false;
   while(queue.length){
    const value=queue.pop();if(seen.has(value))continue;
    if(!value||++work>50000||references.size>=128){valid=false;break;}
    const fact=fn.referenceFacts.get(value);
    if(fact.nullness==='null'||fact.upperBounds.includes('[Z')){valid=false;break;}
    seen.add(value);references.set(value.id,value);
    const atEntry=value.op==='phi'&&value.block===start;
    if(value.op==='param'||!blocks.has(value.block)||atEntry){
     if(!atEntry&&value.op!=='param'&&(!Number.isInteger(value.block)||!dominates(value.block,start))){valid=false;break;}
     external.set(value.id,value);source=true;
     // Backedge metadata must still follow the simultaneous reference copy.
     if(atEntry)for(const [i,pred]of fn.blocks[start].predIds.entries())if(blocks.has(pred))queue.push(value.args[i]);
     continue;
    }
    if(value.op==='getstatic'&&regionReads.has(value.id)){source=true;continue;}
    if(value.op!=='phi'||value.kind!=='A'){valid=false;break;}
    queue.push(...value.args);
   }
   if(!valid||!source){valid=false;break;}
  }
  if(valid&&external.size<=16)candidates.push({entry:start,blocks,reads:regionReads,fields,memory,references,external,sites:memory.size});
 }
 const regions=[],occupied=new Set();
 for(const plan of candidates.sort((a,b)=>b.sites-a.sites)){
  if(regions.length>=4)break;
  if([...plan.blocks].some(id=>occupied.has(id)))continue;
  for(const id of plan.blocks)occupied.add(id);regions.push(plan);
 }
 if(!regions.length)return null;
 const result={regions,entries:new Map(),sitePlans:new Map(),readPlans:new Map(),phiPlans:new Map(),sites:0};
 const local=()=>{const n=c.nextLocal++;c.declared.push(T.i32);return n;};
 for(const plan of regions){
  plan.caches=new Map();plan.guards=[];
  for(const [address,original] of plan.fields){
   const field={...original,base:local(),len:local()};plan.fields.set(address,field);
   plan.guards.push(c.addReadinessGuard('native_region_owner_'+field.owner.replace(/[^\w]/g,'_'),
    c.jvm.getClassInitializationToken(field.owner)));
  }
  for(const [id,value]of plan.references){
   const read=plan.reads.get(id),field=read&&plan.fields.get(read.native.address);
   plan.caches.set(id,field||{base:local(),len:local()});
   if(value.op==='phi'&&plan.blocks.has(value.block))result.phiPlans.set(id,plan);
  }
  result.entries.set(plan.entry,plan);result.sites+=plan.sites;
  for(const id of plan.memory.keys())result.sitePlans.set(id,plan);
  for(const id of plan.reads.keys())result.readPlans.set(id,plan);
 }
 return result;
}
function regionEntry(c,plan,out){
 if(plan.scope){stateEntry(c,plan,out);return;}
 let first=true;const combine=()=>{if(!first)out.push(OP.i32_and);first=false;};
 for(const guard of plan.guards){out.push(...c.readinessSeq(guard));combine();}
 for(const field of plan.fields.values()){
  out.push(...load(field.native.address),OP.i32_const,1,OP.i32_and,
   ...load(field.native.address+4),OP.local_tee,...uleb(field.base),OP.i32_const,0,OP.i32_ge_s,OP.i32_and,
   ...load(field.native.address+8),OP.local_set,...uleb(field.len));combine();
 }
 if(plan.external.size){
  const memory=c.heap.memory,{allocationForArray}=require('../core/wasmHeap');
  const idx=c.addImport('native_region_owned_header',[T.ref],[T.i32,T.i32],value=>{
   const record=allocationForArray(value);
   return record?.memory===memory&&record.descriptor!=='[Z'?[record.base,record.length]:[-1,0];
  },true);
  for(const value of plan.external.values()){
   const cache=plan.caches.get(value.id);
   out.push(...c.useOf(value),OP.call,...uleb(idx),OP.local_set,...uleb(cache.len),OP.local_set,...uleb(cache.base),
    ...get(cache.base),OP.i32_const,0,OP.i32_ge_s);combine();
  }
 }
 if(first)return;
 out.push(OP.i32_eqz,OP.if,0x40);
 if(c.wasmJit.importStatsEnabled)out.push(OP.call,...uleb(c.addImport('native_array_region_refused_'+plan.entry,[],[],()=>{},true)));
 c.emitSpillResume(plan.entry,out);out.push(OP.end);
 if(c.wasmJit.importStatsEnabled)out.push(OP.call,...uleb(c.addImport('native_array_region_entered_'+plan.entry,[],[],()=>{},true)));
}
function edge(c,from,to,out){
 const plan=c.nativeStaticArrayBody?.entries?.get(to);
 if(plan&&!plan.blocks.has(from))regionEntry(c,plan,out);
}
function cacheFor(c,node){return c.nativeStaticArrayBody?.sitePlans?.get(node.id)?.caches.get(node.args[0].id);}
// Authentic owned arrays cannot alias readiness cells, and no successful
// operation here can run an initializer or callback. Reuse only an existing
// positive entry guard; do not initialize a cold/untaken dependency early.
function provesReadiness(c,block,guard){
 const owner=c.nativeStaticArrayBody;if(!owner)return false;
 return owner.regions?owner.regions.some(plan=>plan.blocks.has(block)&&(plan.readinessGuards||plan.guards).includes(guard)):
  c.inlinedInitializationGuards.has(guard);
}
function prepare(c,structured){return prepareStateful(c,structured)||prepareInlineScopes(c,structured)||prepareWhole(c)||prepareRegions(c);}
module.exports={prepare,entry,instruction,access,read,phiCopies,edge,cacheFor,provesReadiness};
