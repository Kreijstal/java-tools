'use strict';
const {T,OP,uleb,sleb,toWasmValue}=require('./wasmShared');
const types={I:T.i32,J:T.i64,F:T.f32,D:T.f64,A:T.ref};

function blocks(node,out=new Set()) {
 if(!node)return out;
 if(node.t==='straight')out.add(node.block);
 else if(node.t==='seq')for(const child of node.body)blocks(child,out);
 else if(node.t==='block'||node.t==='loop')blocks(node.body,out);
 else if(node.t==='if'){blocks(node.then,out);blocks(node.els,out);}
 else if(node.t==='switch'){
  for(const arm of node.cases)blocks(arm.body,out);blocks(node.dflt,out);
 }
 return out;
}

// An outer loop reached through only seq/block wrappers can share the normal
// body: skip its complete prefix subtrees, then enter the existing loop. No
// loop cloning, extra dispatcher or jump into a conditional arm is needed.
function candidates(node,prefix=[],out=[]) {
 if(!node)return out;
 if(node.t==='loop')out.push({header:Number(node.label.slice(1)),prefix});
 else if(node.t==='block')candidates(node.body,prefix,out);
 else if(node.t==='seq'){
  const before=[...prefix];
  for(const child of node.body){candidates(child,[...before],out);before.push(child);}
 }
 return out;
}

function prepare(c,structured) {
 // These shapes carry additional entry-only ownership/exception state. Keep
 // their established fallback until that state also has a reconstruction proof.
 if(!c.frameLocalLiveness||c.demoted.size||c.deoptBlocks.size||c.fn.handlerEntries.length||c.irreducibleSplitBlocks||
    c.fn.blocks[c.cfg.entry].phis.length||
    c.ownArrayResult||c.guardedNestedArrayLoopPlans.size)return null;
 // Normal entry drains the native object-argument globals. Resume must not
 // repeat that ownership transfer: its fresh storage locals stay null, so
 // objectStoreFill queries the restored Java receiver lazily on first use.
 // This also observes field-container replacement while an invocation yields.
 for(const candidate of candidates(structured.tree).slice(0,8)){
  const {header}=candidate,block=c.fn.blocks[header];
  if(!header||!block||block.entryStack.length)continue;
  const item=c.origIdx?c.origIdx[c.cfg.blocks[header].insns[0]]:c.cfg.blocks[header].insns[0];
  if(!Number.isInteger(item)||item<0)continue;
  const skipped=new Set();for(const node of candidate.prefix)blocks(node,skipped);
  const region=blocks(structured.tree);for(const id of skipped)region.delete(id);
  // The skipped prefix must never be a successor of resumed execution.
  if([...region].some(id=>c.cfg.succ[id].some(target=>skipped.has(target))))continue;
  const bindings=new Map();
  for(const [slot,value]of block.slotDefsIn||[]){
   if(slot>=c.callerLocals||value.op==='undef'||types[value.kind]===undefined||
      !(c.frameLocalLiveness.has(item,slot)||c.booleanStaticCaptures.some(
        capture=>capture.slot===slot&&item>capture.storeIndex))||!c.localOf.has(value))continue;
   if(!bindings.has(value))bindings.set(value,{slot,value,t:types[value.kind],local:c.localOf.get(value)});
  }
  const restore=new Map(),literals=new Set(),visited=new Set();let valid=true,work=0;
  const need=value=>{
   // The verifier's unusable slots (including the second word of a long or
   // double) have no Wasm local and are also omitted by the spill emitter.
   if(!value||types[value.kind]===undefined||visited.has(value)||!valid)return;
   visited.add(value);if(++work>16384){valid=false;return;}
   const binding=bindings.get(value);
   if(binding){restore.set(value,binding);return;}
   // A value defined in the resumed region is computed by its normal body.
   // A header phi is different: no incoming edge executes on external entry.
   if(region.has(value.block)&&value.op!=='param'){
    if(value.op==='phi'){
     if(value.block===header){valid=false;return;}
     const owner=c.fn.blocks[value.block];
     for(let i=0;i<owner.predIds.length;i++)if(region.has(owner.predIds[i]))need(value.args[i]);
    }
    return;
   }
   if(/^(?:[ilfd]const_(?:m1|[0-5])|bipush|sipush|aconst_null)$/.test(value.op)&&c.localOf.has(value)){
    literals.add(value);return;
   }
   valid=false;
  };
  // A later spill must retain every protected header value too, even if it
  // is absent from ordinary SSA consumers (captured boolean metadata).
  for(const value of bindings.keys())need(value);
  for(const id of region){
   const b=c.fn.blocks[id];
   for(const node of [...b.body,b.term]){
    for(const value of node.args||[])need(value);
    // Cold call/exception exits must still be able to materialize the frame.
    const at=c.origIdx?c.origIdx[node.itemIdx]:node.itemIdx;
    for(const [slot,value]of node.slotState||[])if(slot<c.callerLocals&&at>=0&&
      (c.frameLocalLiveness.has(at,slot)||c.frameLocalLiveness.has(at+1,slot)))need(value);
    for(const value of node.stackUnder||[])need(value);
   }
  }
  // Parameter caches are populated before the shared body. Even a cache used
  // only by the skipped prefix may not query an invented/stale parameter.
  for(const cache of c.arrayCaches.values())if(cache.parameter)need(cache.value);
  if(!valid)continue;
  const locals=new Set();
  for(const binding of restore.values()){
   if(locals.has(binding.local)){valid=false;break;}locals.add(binding.local);
  }
  if(!valid)continue;
  return {header,item,prefix:new Set(candidate.prefix),restore:[...restore.values()],literals};
 }
 return null;
}

function test(c,out,equal=true) {
 out.push(OP.local_get,...uleb(c.blkLocal),OP.i32_const,...sleb(c.loopResume.header),equal?OP.i32_eq:OP.i32_ne);
}

function emitRestore(c,out) {
 const plan=c.loopResume;if(!plan)return;
 test(c,out);out.push(OP.if,0x40);
 const box=c.box;
 // Capture scalar execution metadata only, never the SSA graph or compiler.
 for(const {slot,t,local}of plan.restore){
  const idx=c.addImport(`resume_local_${slot}_${t}`,[],[t],()=>toWasmValue(t,box.frame.locals[slot]));
  out.push(OP.call,...uleb(idx),OP.local_set,...uleb(local));
 }
 for(const value of plan.literals)c.emitNode(value,out);
 out.push(OP.end);
}

function emitYieldMarker(c,out) {
 const frames=c.wasmJit.structuredResumeFrames,context=c.directFrames,box=c.box;
 const idx=c.addImport('structured_loop_yield',context?[T.i32]:[],[],id=>{
  frames.add(context?context.frame(id):box.frame);
 });
 if(context)out.push(OP.local_get,...uleb(c.directIdLocal));
 out.push(OP.call,...uleb(idx));
}

module.exports={prepare,test,emitRestore,emitYieldMarker};
