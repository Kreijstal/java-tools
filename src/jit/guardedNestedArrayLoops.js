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
function unitStep(phi,header,region,latches) {
  if(phi?.op!=='phi' || phi.kind!=='I' || phi.block!==header.id)return false;
  return latches.every(id=>{
    const next=phi.args[header.predIds.indexOf(id)];
    return next?.op==='iinc' && region.has(next.block) && next.args[0]===phi && next.imm?.delta===1;
  });
}
function successors(block) {
  const term=block.term;
  if(term.kind==='goto'||term.kind==='fall')return [term.target];
  if(term.kind==='cond' && term.args.every(a=>a.kind==='I'))return [term.taken,term.fall];
  return null;
}
// A body may fork, but every path must reach a header backedge, never an
// early exit or another cycle. This makes the exact header-poll count n+1.
function bodyRegion(c,header,entry,exit) {
  const region=new Set(),pending=[entry];let instructions=0;
  while(pending.length) {
    const id=pending.pop();if(id===header.id||region.has(id))continue;
    const block=c.fn.blocks[id];
    if(id===exit || !block || region.size>=16 ||
        (instructions+=block.body.length)>256 || block.phis.some(p=>p.kind!=='I'))return null;
    const next=successors(block);if(!next)return null;
    region.add(id);pending.push(...next);
  }
  const latches=header.predIds.filter(id=>region.has(id));
  if(!latches.length || latches.length!==header.predIds.length-1)return null;
  for(const id of region)if(c.fn.blocks[id].predIds.some(p=>!region.has(p) &&
      !(id===entry&&p===header.id)))return null;
  // Kahn's check refuses cycles even if a different branch could reach the header.
  const degree=new Map([...region].map(id=>[id,0]));
  for(const id of region)for(const next of successors(c.fn.blocks[id]))
    if(region.has(next))degree.set(next,degree.get(next)+1);
  const ready=[...region].filter(id=>!degree.get(id));let visited=0;
  while(ready.length) {
    const id=ready.pop();visited++;
    for(const next of successors(c.fn.blocks[id]))if(region.has(next)) {
      degree.set(next,degree.get(next)-1);if(!degree.get(next))ready.push(next);
    }
  }
  return visited===region.size?{region,latches}:null;
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
  if(!header || header.body.length || header.predIds.length<2 || header.predIds.length>8 ||
      header.phis.length>32 || header.phis.some(p=>p.kind!=='I') ||
      !['ifge','iflt'].includes(term?.insnOp) || term.args.length!==1)return null;
  const entry=term.insnOp==='ifge'?term.fall:term.taken;
  const exit=term.insnOp==='ifge'?term.taken:term.fall,counter=term.args[0];
  if(entry===headerId || entry===exit)return null;
  const body=bodyRegion(c,header,entry,exit);if(!body)return null;
  const {region,latches}=body;
  if(!unitStep(counter,header,region,latches))return null;
  const fields=new Set(),caches=new Set(),memoryNodes=new Set(),fieldNodes=new Set(),ranges=[];
  for(const id of region)for(const value of c.fn.blocks[id].body) {
    if(value.op==='getstatic' && value.kind==='A' && value.imm?.[2]?.[1]==='[I') {
      const field=[...c.fieldCaches.values()].find(f=>f.kind==='s' && f.t===T.ref && f.readerIds.has(value.id));
      if(!field)return null;
      fields.add(field);fieldNodes.add(value.id);
    } else if(value.op==='iaload'||value.op==='iastore') {
      const array=value.args[0],index=value.args[1],cache=c.arrayCaches.get(array.id);
      if(!cache || cache.sharedField ||
          !(cache.parameter || array.op==='getstatic' && region.has(array.block)) ||
          !unitStep(index,header,region,latches))return null;
      caches.add(cache);memoryNodes.add(value.id);
      if(!ranges.some(r=>r.cache===cache&&r.index===index))ranges.push({cache,index});
    } else if(!pureInt(value))return null;
  }
  if(!memoryNodes.size || fields.size>4 || caches.size>4)return null;
  // Internal branches are pure integer tests. Cloned exit code remains small
  // and cannot introduce another path back into this loop.
  const pending=[node.body];let size=0,backedges=0;
  while(pending.length) {
    const part=pending.pop();if(!part || ++size>64)return null;
    if(part.t==='loop'||part.t==='switch'||(part.t==='if'&&part.block!==headerId&&!region.has(part.block)))return null;
    if((part.t==='continue'||part.t==='break')&&part.label===node.label)backedges++;
    if(part.t==='straight' && part.block!==headerId && !region.has(part.block)) {
      const block=c.fn.blocks[part.block];
      if(!block || !block.body.every(pureInt) || !['goto','fall','return'].includes(block.term.kind))return null;
    }
    pending.push(...children(part));
  }
  if(backedges!==latches.length)return null;
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
  const combine=parts=>parts.length?parts.flatMap((p,i)=>i?[...p,OP.i32_and]:p):iconst(1);
  const ready=[...plan.fields].map(f=>get(f.filledLocal));
  // Parameter metadata has already been captured by the ordinary entry code.
  ready.push(...[...plan.caches].filter(cache=>!cache.parameter).map(cache=>get(cache.filled)));
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
    // A counted loop polls once for every body iteration and once
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
