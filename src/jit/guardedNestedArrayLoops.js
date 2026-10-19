'use strict';
const {T,OP,ICONST,BIN_OPS,uleb,sleb}=require('./wasmShared');

const MIN_TRIP=32,MAX_TRIP=16384,MAX_EXTRA_BYTES=8192;
const get=n=>[OP.local_get,...uleb(n)];
const iconst=n=>[OP.i32_const,...sleb(n)];
function pureInt(node) {
  return node.kind==='I' && (Object.hasOwn(ICONST,node.op) ||
    (node.op.startsWith('i') && Object.hasOwn(BIN_OPS,node.op)) ||
    ['iinc','ineg','i2c','i2b','i2s','bipush','sipush'].includes(node.op) ||
    (node.op==='ldc' && Number.isInteger(node.imm)));
}
function unitStep(phi,header,body) {
  if(phi?.op!=='phi' || phi.kind!=='I' || phi.block!==header.id)return false;
  const next=phi.args[header.predIds.indexOf(body.id)];
  return next?.op==='iinc' && next.block===body.id && next.args[0]===phi && next.imm?.delta===1;
}
function children(node) {
  if(node.t==='seq')return node.body;
  if(node.t==='block'||node.t==='loop')return [node.body];
  if(node.t==='if')return [node.then,node.els];
  if(node.t==='switch')return [...node.cases.map(c=>c.body),node.dflt].filter(Boolean);
  return [];
}
function planFor(c,node,headerId) {
  const header=c.fn.blocks[headerId],term=header?.term;
  if(!header || header.body.length || header.predIds.length!==2 ||
      header.phis.length>32 || header.phis.some(p=>p.kind!=='I') ||
      term?.insnOp!=='ifge' || term.args.length!==1)return null;
  const body=c.fn.blocks[term.fall],counter=term.args[0];
  if(!body || term.taken===headerId || term.taken===body.id ||
      body.predIds.length!==1 || body.predIds[0]!==headerId ||
      body.term.kind!=='goto' || body.term.target!==headerId ||
      body.body.length>96 || !unitStep(counter,header,body))return null;
  const fields=new Set(),caches=new Set(),memoryNodes=new Set(),fieldNodes=new Set(),ranges=[];
  for(const value of body.body) {
    if(value.op==='getstatic' && value.kind==='A' && value.imm?.[2]?.[1]==='[I') {
      const field=[...c.fieldCaches.values()].find(f=>f.kind==='s' && f.t===T.ref && f.readerIds.has(value.id));
      if(!field)return null;
      fields.add(field);fieldNodes.add(value.id);
    } else if(value.op==='iaload'||value.op==='iastore') {
      const array=value.args[0],index=value.args[1],cache=c.arrayCaches.get(array.id);
      if(array.op!=='getstatic' || array.block!==body.id ||
          !unitStep(index,header,body) || !cache || cache.parameter || cache.sharedField)return null;
      caches.add(cache);memoryNodes.add(value.id);
      if(!ranges.some(r=>r.cache===cache&&r.index===index))ranges.push({cache,index});
    } else if(!pureInt(value))return null;
  }
  if(!memoryNodes.size || fields.size>4 || caches.size>4)return null;
  // Cloned exit code must not re-enter this loop except through its one body
  // backedge. Keep the region small and free of other loops/conditions/effects.
  const pending=[node.body];let size=0,backedges=0;
  while(pending.length) {
    const part=pending.pop();if(!part || ++size>32)return null;
    if(part.t==='loop'||part.t==='switch'||(part.t==='if'&&part.block!==headerId))return null;
    if((part.t==='continue'||part.t==='break')&&part.label===node.label)backedges++;
    if(part.t==='straight' && part.block!==headerId && part.block!==body.id) {
      const block=c.fn.blocks[part.block];
      if(!block || !block.body.every(pureInt) || !['goto','fall','return'].includes(block.term.kind))return null;
    }
    pending.push(...children(part));
  }
  if(backedges!==1)return null;
  return {header:headerId,counter,fields,caches,ranges,memoryNodes,fieldNodes};
}

function prepare(c,structured) {
  const plans=new Map();
  // Spliced callee loops use the inliner's caller-fuel protocol instead.
  if(!c.heap || structured.loopHeaders.size<2 || c.origIdx || !c.leafInitializationGuards || c.liveRanges.length ||
      c.demoted.size || c.deoptBlocks.size || c.wasmJit.fieldCacheEnabled===false)return plans;
  const pending=[[structured.tree,0]];let visited=0;
  while(pending.length && visited++<16384 && plans.size<8) {
    const [node,depth]=pending.pop();if(!node)continue;
    if(node.t==='loop' && depth>0 && /^L\d+$/.test(node.label)) {
      const header=Number(node.label.slice(1)),plan=planFor(c,node,header);
      if(plan)plans.set(header,plan);
    }
    const next=children(node);
    if(pending.length+next.length>16384)break;
    for(const child of next)pending.push([child,depth+(node.t==='loop'?1:0)]);
  }
  return plans;
}

function trip(c,plan) { return [...iconst(0),...c.useOf(plan.counter),OP.i32_sub]; }
function guard(c,plan) {
  const combine=parts=>parts.flatMap((p,i)=>i?[...p,OP.i32_and]:p);
  const ready=[...plan.fields].map(f=>get(f.filledLocal));
  ready.push(...[...plan.caches].map(cache=>get(cache.filled)));
  const checks=[];
  for(const {cache,index} of plan.ranges) {
    const end=()=>[...c.useOf(index),OP.i64_extend_i32_u,...trip(c,plan),OP.i64_extend_i32_u,OP.i64_add];
    checks.push([...get(cache.base),...iconst(0),OP.i32_ge_s]);
    checks.push([...end(),...get(cache.len),OP.i64_extend_i32_u,OP.i64_le_u]);
    checks.push([...get(cache.base),OP.i64_extend_i32_u,...end(),OP.i64_const,2,OP.i64_shl,
      OP.i64_add,OP.memory_size,0,OP.i64_extend_i32_u,OP.i64_const,16,OP.i64_shl,OP.i64_le_u]);
  }
  checks.push([...get(c.fuelLocal),...trip(c,plan),...iconst(1),OP.i32_add,OP.i32_gt_s]);
  return [
    ...c.useOf(plan.counter),...iconst(-MAX_TRIP),OP.i32_ge_s,
    ...c.useOf(plan.counter),...iconst(-MIN_TRIP),OP.i32_le_s,OP.i32_and,
    OP.if,T.i32,...combine(ready),OP.if,T.i32,...combine(checks),
    OP.else,...iconst(0),OP.end,OP.else,...iconst(0),OP.end,
  ];
}

function emit(c,node,header,out,env) {
  const plan=c.guardedNestedArrayLoopPlans?.get(header);
  if(!plan || c.loweringGuardedLoopHeaders?.has(header))return false;
  const lowering=c.loweringGuardedLoopHeaders ||= new Set();lowering.add(header);
  const previous=c.activeGuardedLoopPlan,depth=c.frames.length,fast=[],cold=[];
  try {
    c.frames.push({label:null});c.activeGuardedLoopPlan=plan;
    // A two-block counted loop polls once for every body iteration and once
    // at its final failed test. The guard proves none can exhaust fuel.
    fast.push(...get(c.fuelLocal),...trip(c,plan),...iconst(1),OP.i32_add,OP.i32_sub,
      OP.local_set,...uleb(c.fuelLocal));
    if(c.wasmJit.importStatsEnabled)fast.push(OP.call,...uleb(c.addImport(
      'guarded_loop_'+header,[],[],()=>{},true)));
    c.lowerNode(node,fast,{...env});
    c.activeGuardedLoopPlan=previous;
    c.lowerNode(node,cold,{...env});
  } finally {
    c.frames.length=depth;c.activeGuardedLoopPlan=previous;lowering.delete(header);
  }
  const when=guard(c,plan),extra=when.length+fast.length+5;
  if((c.guardedNestedArrayLoopBytes||0)+extra>MAX_EXTRA_BYTES)return false;
  out.push(...when,OP.if,0x40,...fast,OP.else,...cold,OP.end);
  c.guardedNestedArrayLoopBytes=(c.guardedNestedArrayLoopBytes||0)+extra;
  c.guardedNestedArrayLoopCount=(c.guardedNestedArrayLoopCount||0)+1;
  return true;
}

module.exports={prepare,emit};
