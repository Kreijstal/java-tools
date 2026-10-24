"use strict";
const Frame = require('../core/frame');
const {T, OP, uleb, sleb, assembleModule, descToWasm} = require('./wasmShared');

// A direct Wasm invocation allocates no JavaScript frame on a normal return.
// The callee carries its own invocation id through every canonical spill.
// Returned owner references identify the exact module even if a callback
// republishes that method while an older invocation is still running.
class DirectFrameContext {
  constructor(jvm, method, className, box) {
    this.jvm = jvm;
    this.method = method;
    this.className = className;
    this.box = box;
    this.frames = new Map();
    this.createdFrames = 0;
    this.exitCount = 0;
    this.directExitCount = 0;
    this.throwCount = 0;
    this.lastExitStatus = null;
  }
  frame(id) {
    if (!id) return this.box.frame;
    let frame = this.frames.get(id);
    if (!frame) {
      frame = new Frame(this.method);
      frame.className = this.className;
      this.frames.set(id, frame);
      this.createdFrames++;
    }
    return frame;
  }
  exit(id, status) {
    this.exitCount++;
    this.lastExitStatus = status;
    if (!id) return;
    this.directExitCount++;
    const frame = this.frame(id);
    if (status !== -3) frame.pc = status;
    frame.wasmDirectPendingFrames = this.box.pendingFrames;
    this.box.pendingFrames = null;
    if (status === -3) {
      frame.wasmDirectException = this.box.pendingException;
      frame.wasmDirectThrowPc = this.box.throwPc;
      this.box.pendingException = null;
    }
  }
  take(id) {
    const frame = this.frames.get(id);
    if (!frame) throw Error('direct Wasm exit without a canonical spill');
    this.frames.delete(id);
    return frame;
  }
}

class CanonicalDirectLinks {
  constructor() {
    this.table = new WebAssembly.Table({element:'anyfunc', initial:0});
    this.bindings = new Map();
    this.bySlot = new Map();
    this.freeSlots = [];
    this.identity=Symbol('canonical direct links');
    this.pendingExit=null;
    this.finalizer = new FinalizationRegistry(slots=>this.release(slots));
  }
  publishExit(owner,id,status) {
    // Native callers consume this synchronously before any other guest call.
    // A weak owner keeps legacy/unconsumed exits from pinning retired modules.
    this.pendingExit={owner:new WeakRef(owner),id,status};
  }
  takeExit(status) {
    const transfer=this.pendingExit;this.pendingExit=null;
    const owner=transfer?.owner.deref();
    if(!owner || transfer.status!==status)throw Error('compact Wasm exit without its exact owner');
    return {owner,id:transfer.id};
  }
  static eligible(st) {
    const meta = st?.meta;
    return st?.status === 'ready' && !st.synchronized && !st.linkVetoed &&
      meta?.canonicalRun && meta.normalFlowFullyCompiled &&
      // A native JS-tag wrapper records the exact throwable even when it
      // comes through another Wasm export. Handler-free callers therefore
      // do not need a JavaScript bridge just because they contain calls.
      // Without that wrapper retain the narrower leaf/recorded-import proof.
      (meta.usedEh || meta.canonicalNonThrowingNormalFlow || meta.canonicalRecordedNormalFlow ||
        meta.nativeJsExceptionTags) &&
      !meta.boxedCount && !(meta.specSites?.length) && !meta.speculations &&
      (!meta.frameEntryOnly || meta.booleanStaticSpillProof);
  }
  allocate(key, params, results, fallback, parameterArrayABI = [], compact = false, objectInputs = [], arrayResult = null, parameterObjectABI = [], closedNative = false) {
    if(closedNative&&(!compact||parameterArrayABI.length||objectInputs.length||arrayResult))
      throw TypeError('closed native link requires compact typed object inputs');
    // The existing bridge is the fallback until a proved callee publishes.
    // -6 requests the old deopt-flag check; normal raw exports return -1.
    const imports = closedNative?[]:[{name:'fallback',params,results}];
    const body = [];
    if(closedNative){
      // No JavaScript bridge or guest code can run on a refused contract.
      // The caller retries its original invoke with its exact operand stack.
      body.push(OP.i32_const,...sleb(-7));
      for(const type of results)body.push(...(type===T.i64?[OP.i64_const,0]:
        type===T.f32?[OP.f32_const,0,0,0,0]:type===T.f64?[OP.f64_const,0,0,0,0,0,0,0,0]:
        type===T.ref?[OP.ref_null,T.ref]:[OP.i32_const,0]));
    }else{
    // A withdrawn/unready target enters its established JavaScript bridge.
    // It must release unpublished native metadata before any callback runs.
    for(let i=0;i<objectInputs.length;i++)body.push(OP.ref_null,T.ref,OP.global_set,...uleb(i));
    for(let i=0;i<params.length;i++)body.push(OP.local_get,...uleb(i));
    body.push(OP.call,0);
    // Nested calls inside a JavaScript bridge cannot publish a payload for
    // the bridge's final result. The returned Java reference stays on stack.
    if(arrayResult)body.push(OP.i32_const,...sleb(-2),OP.global_set,...uleb(objectInputs.length),
      OP.i32_const,0,OP.global_set,...uleb(objectInputs.length+1),
      ...(arrayResult.owned?[OP.i32_const,0,OP.global_set,...uleb(objectInputs.length+2)]:[]));
    if(results.length)body.push(OP.local_set,...uleb(params.length));
    body.push(OP.i32_const,...sleb(-6));
    if(!compact)body.push(OP.i32_const,0,OP.ref_null,T.ref);
    if(results.length)body.push(OP.local_get,...uleb(params.length));
    }
    body.push(OP.end);
    const bytes = assembleModule({importDecls:imports,mainParams:params,
      mainResults:[T.i32,...(compact?[]:[T.i32,T.ref]),...results],declared:results,body,
      gcTypes:params.some(Array.isArray)?require('../core/nativeObjectStorage').nativeObjectStorageTypes():[],
      globalImportDecls:[...objectInputs.map((_,index)=>({name:'object_input_'+index,type:T.ref,mutable:true})),
        ...(arrayResult?[{name:'array_result_base',type:T.i32,mutable:true},{name:'array_result_length',type:T.i32,mutable:true},...(arrayResult.owned?[{name:'array_result_owned',type:T.i32,mutable:true}]:[])]:[])]});
    const weakFallback=closedNative?null:new WeakRef(fallback);
    const invokeFallback=closedNative?null:(...args)=>{
      const fn=weakFallback.deref();
      if(!fn)throw Error('retired canonical call stub');
      return fn(...args);
    };
    const stub = new WebAssembly.Instance(new WebAssembly.Module(bytes),
      {env:{...(closedNative?{}:{fallback:invokeFallback}),...Object.fromEntries(objectInputs.map((value,index)=>['object_input_'+index,value])),
        ...(arrayResult?{array_result_base:arrayResult.base,array_result_length:arrayResult.length,...(arrayResult.owned?{array_result_owned:arrayResult.owned}:{})}:{})}}).exports.run;
    const slot = this.freeSlots.length?this.freeSlots.pop():this.table.length;
    if(slot===this.table.length)this.table.grow(1);
    this.table.set(slot,stub);
    const binding = {slot,stub,key,params,results:results.slice(),compact,closedNative,parameterArrayABI:parameterArrayABI.slice(),parameterObjectABI:parameterObjectABI.slice()};
    this.bySlot.set(slot,binding);
    let list=this.bindings.get(key);
    if(!list)this.bindings.set(key,list=[]);
    list.push(binding);
    return slot;
  }
  allocateClosed(key,params,results,parameterObjectABI){
    return this.allocate(key,params,results,null,[],true,[],null,parameterObjectABI,true);
  }
  enableEmptyCopy(slot,heap,st) {
    const binding=this.bySlot.get(slot),meta=st?.meta;
    if(!binding || !CanonicalDirectLinks.eligible(st) || !meta.primitiveCopyZeroProof ||
        !meta.hostOwnedCanonicalFuel || meta.hostOwnedCanonicalFuel!==meta.canonicalFuel ||
        !Number.isInteger(meta.canonicalOwnerReadyAddress))return null;
    if(binding.emptyCopy)return binding.emptyCopy;
    const address=heap.allocObject(8);
    if(address<0)return null;
    // Only the independent host global survives replacement. Importing a
    // module-defined global here would retain the entire retired module.
    const guard={heap,address,fuel:meta.hostOwnedCanonicalFuel,readyAddress:meta.canonicalOwnerReadyAddress,fuelBound:meta.primitiveCopyZeroFuel};
    binding.emptyCopy=guard;
    return guard;
  }
  release(slots) {
    for(const slot of slots||[]){
      const binding=this.bySlot.get(slot);if(!binding)continue;
      const list=this.bindings.get(binding.key);
      list.splice(list.indexOf(binding),1);
      if(!list.length)this.bindings.delete(binding.key);
      if(binding.emptyCopy){
        const {heap,address}=binding.emptyCopy;
        heap.i32[address>>2]=0;heap.free(address,8);
      }
      this.bySlot.delete(slot);this.table.set(slot,null);this.freeSlots.push(slot);
    }
  }
  retain(meta) {
    if(meta.canonicalSlots?.length)this.finalizer.register(meta,meta.canonicalSlots);
  }
  publish(st) {
    if(!st.key)return;
    const eligible=CanonicalDirectLinks.eligible(st);
    for(const binding of this.bindings.get(st.key)||[]){
      const arrays=binding.parameterArrayABI;
      const objects=binding.parameterObjectABI;
      const compatible=eligible && (!binding.compact || st.meta.canonicalCompactOwnerTag===this.identity);
      const contract=st.meta?.closedNativeBody;
      const closedCompatible=!binding.closedNative||contract?.version===1&&Array.isArray(contract.objectParameters)&&
        contract.key===binding.key&&contract.run===st.meta.canonicalClosedStorageRun&&
        contract.objectParameters.length===objects.length&&contract.objectParameters.every((index,i)=>index===objects[i]);
      const fn=compatible&&closedCompatible ? binding.closedNative?st.meta.canonicalClosedStorageRun:binding.compact
        ? objects.length ? st.meta.canonicalCompactStorageRun : arrays.length ? st.meta.canonicalCompactHeapRun : st.meta.canonicalCompactRun
        : arrays.length ? st.meta.canonicalHeapRun : st.meta.canonicalRun : null;
      const javaCount=binding.params.length-2*arrays.length-objects.length;
      let slot=0;
      // Publication must validate both halves of the Wasm signature. In
      // particular an externref result cannot inhabit an older numeric slot.
      const expectedResults=st.meta?.retChar==='V'?[]:[descToWasm(st.meta?.retChar)];
      const resultIdentity=st.meta?.retChar===undefined ||
        expectedResults.length===binding.results.length &&
        expectedResults.every((type,i)=>type===binding.results[i]);
      const identity=fn && resultIdentity && st.meta.paramSlots.length===javaCount &&
        (!arrays.length || arrays.length===st.meta.parameterArrayABI?.length &&
          arrays.every((index,i)=>index===st.meta.parameterArrayABI[i]) &&
          binding.params.slice(javaCount,javaCount+2*arrays.length).every(type=>type===T.i32)) &&
        (!objects.length || objects.length===st.meta.parameterObjectABI?.length &&
          objects.every((index,i)=>index===st.meta.parameterObjectABI[i]) &&
          arrays.length===(st.meta.parameterArrayABI?.length||0) &&
          binding.params.slice(javaCount+2*arrays.length).every(type=>Array.isArray(type)&&type.length===2&&type[0]===0x63&&type[1]===1)) &&
        st.meta.paramSlots.every((p,i)=>{
          const at=slot;slot+=(binding.params[i]===T.i64||binding.params[i]===T.f64)?2:1;
          return p.slot===at&&p.t===binding.params[i];
        });
      this.table.set(binding.slot,identity?fn:binding.stub);
      const guard=binding.emptyCopy;
      if(guard)guard.heap.i32[guard.address>>2]=identity && !!st.meta.primitiveCopyZeroProof &&
        st.meta.hostOwnedCanonicalFuel===guard.fuel && st.meta.canonicalFuel===guard.fuel &&
        st.meta.canonicalOwnerReadyAddress===guard.readyAddress && st.meta.primitiveCopyZeroFuel===guard.fuelBound ? 1 : 0;
    }
  }
  withdraw(key) {
    for(const binding of this.bindings.get(key)||[]){
      if(binding.emptyCopy)binding.emptyCopy.heap.i32[binding.emptyCopy.address>>2]=0;
      this.table.set(binding.slot,binding.stub);
    }
  }
}
// Shared by structured callers and dispatcher resumptions. A non-normal
// canonical return owns its precise callee frame, including nested pending
// frames and the original exception PC; never replay the call to recover it.
function consumeCanonicalExit(jvm,wasmJit,box,status,id,owner) {
  if(status===-6){const flag=box.deoptFlag;box.deoptFlag=0;return flag;}
  if(status===-4||status===-7)return 1;
  if(status===-5)throw owner.box.lastThrown;
  const frame=owner.take(id);
  wasmJit.canonicalResumeFrames.add(frame);
  if(status===-3){
    const exn=frame.wasmDirectException;
    frame.wasmDirectException=null;
    if(!jvm.dispatchExceptionInFrame(frame,exn,frame.wasmDirectThrowPc))throw exn;
  }
  const deeper=frame.wasmDirectPendingFrames;
  frame.wasmDirectPendingFrames=null;
  box.pendingFrames=deeper?[...deeper,frame]:[frame];
  box.canonicalFrameHandoff=true;
  return 2;
}
module.exports={DirectFrameContext,CanonicalDirectLinks,consumeCanonicalExit};
