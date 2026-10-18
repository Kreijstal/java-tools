"use strict";
const Frame = require('../core/frame');
const {T, OP, uleb, sleb, assembleModule} = require('./wasmShared');

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
    if (!id) return;
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
      !'L['.includes(meta.retChar) &&
      (!meta.frameEntryOnly || meta.booleanStaticSpillProof);
  }
  allocate(key, params, results, fallback, parameterArrayABI = [], compact = false) {
    // The existing bridge is the fallback until a proved callee publishes.
    // -6 requests the old deopt-flag check; normal raw exports return -1.
    const imports = [{name:'fallback',params,results}];
    const body = [];
    for(let i=0;i<params.length;i++)body.push(OP.local_get,...uleb(i));
    body.push(OP.call,0);
    if(results.length)body.push(OP.local_set,...uleb(params.length));
    body.push(OP.i32_const,...sleb(-6));
    if(!compact)body.push(OP.i32_const,0,OP.ref_null,T.ref);
    if(results.length)body.push(OP.local_get,...uleb(params.length));
    body.push(OP.end);
    const bytes = assembleModule({importDecls:imports,mainParams:params,
      mainResults:[T.i32,...(compact?[]:[T.i32,T.ref]),...results],declared:results,body});
    const weakFallback=new WeakRef(fallback);
    const invokeFallback=(...args)=>{
      const fn=weakFallback.deref();
      if(!fn)throw Error('retired canonical call stub');
      return fn(...args);
    };
    const stub = new WebAssembly.Instance(new WebAssembly.Module(bytes),
      {env:{fallback:invokeFallback}}).exports.run;
    const slot = this.freeSlots.length?this.freeSlots.pop():this.table.length;
    if(slot===this.table.length)this.table.grow(1);
    this.table.set(slot,stub);
    const binding = {slot,stub,key,params,compact,parameterArrayABI:parameterArrayABI.slice()};
    this.bySlot.set(slot,binding);
    let list=this.bindings.get(key);
    if(!list)this.bindings.set(key,list=[]);
    list.push(binding);
    return slot;
  }
  release(slots) {
    for(const slot of slots||[]){
      const binding=this.bySlot.get(slot);if(!binding)continue;
      const list=this.bindings.get(binding.key);
      list.splice(list.indexOf(binding),1);
      if(!list.length)this.bindings.delete(binding.key);
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
      const compatible=eligible && (!binding.compact || st.meta.canonicalCompactOwnerTag===this.identity);
      const fn=compatible ? binding.compact
        ? arrays.length ? st.meta.canonicalCompactHeapRun : st.meta.canonicalCompactRun
        : arrays.length ? st.meta.canonicalHeapRun : st.meta.canonicalRun : null;
      const javaCount=binding.params.length-2*arrays.length;
      let slot=0;
      const identity=fn && st.meta.paramSlots.length===javaCount &&
        (!arrays.length || arrays.length===st.meta.parameterArrayABI?.length &&
          arrays.every((index,i)=>index===st.meta.parameterArrayABI[i]) &&
          binding.params.slice(javaCount).every(type=>type===T.i32)) &&
        st.meta.paramSlots.every((p,i)=>{
          const at=slot;slot+=(binding.params[i]===T.i64||binding.params[i]===T.f64)?2:1;
          return p.slot===at&&p.t===binding.params[i];
        });
      this.table.set(binding.slot,identity?fn:binding.stub);
    }
  }
  withdraw(key) {
    for(const binding of this.bindings.get(key)||[])this.table.set(binding.slot,binding.stub);
  }
}
module.exports={DirectFrameContext,CanonicalDirectLinks};
