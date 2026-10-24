'use strict';
const constant=node=>{
 if(!node)return null;
 if(node.op==='iconst_m1')return -1;
 if(/^iconst_[0-5]$/.test(node.op))return Number(node.op.slice(-1));
 return /^(?:bipush|sipush)$/.test(node.op)?Number(node.imm):null;
};
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const con=n=>['const',n],scalar=address=>['scalar',address];
const add=(a,b)=>['iadd',a,b],and=(a,b)=>['iand',a,b],shr=(a,b)=>['ishr',a,b];
const next=block=>['goto','fall'].includes(block.term.kind)?block.term.target:null;

// Match a proved callback-free state body, not a class/method spelling. Every
// loop edge, array origin and cursor publication must fit this complete form.
// Return IDs/addresses only; consumers release the graph with ordinary analysis.
function analyzeIntTreePrefix(fn,state){
 if(!state?.stateful||state.regions||!fn||fn.blocks.length>32||fn.values.length>256)return null;
 const blockOf=new Map();for(const block of fn.blocks)for(const node of [...block.phis,...block.body])blockOf.set(node,block);
 const treeRead=node=>node?.op==='getfield'&&node.imm?.[2]?.[1]==='[I'&&state.instanceReads?.get(node.id)?.array;
 const sameTree=(a,b)=>treeRead(a)&&treeRead(b)&&a.args[0]===b.args[0]&&eq(a.imm,b.imm);
 const arrayIndex=(node,array,index)=>node?.op==='iaload'&&sameTree(node.args[0],array)&&node.args[1]===index;
 const plusOne=(node,index)=>node?.op==='iadd'&&
  (node.args[0]===index&&constant(node.args[1])===1||node.args[1]===index&&constant(node.args[0])===1);
 const singlePred=(block,id)=>block.predIds.length===1&&block.predIds[0]===id;
 for(const header of fn.blocks){
  const term=header.term,read=term.args?.[0];
  if(term.kind!=='cond'||!['iflt','ifge'].includes(term.insnOp)||read?.op!=='iaload'||!treeRead(read.args[0]))continue;
  const tree=read.args[0],index=read.args[1];if(index?.op!=='phi'||!header.phis.includes(index))continue;
  const exit=term.insnOp==='iflt'?term.taken:term.fall,bodyStart=term.insnOp==='iflt'?term.fall:term.taken;
  const merged=index.args.find(value=>value?.op==='phi'&&value.args.length===2&&
   value.args.some(v=>arrayIndex(v,tree,index))&&value.args.some(v=>plusOne(v,index)));
  const merge=blockOf.get(merged);
  if(!merge||next(merge)!==header.id||merge.body.some(n=>n.op!=='nop')||merge.phis.length!==1||merge.predIds.length!==2)continue;
  const backIndex=header.predIds.indexOf(merge.id);
  if(backIndex<0||index.args.length!==header.predIds.length||index.args.some((v,i)=>i===backIndex?v!==merged:constant(v)!==0))continue;
  const steps=merged.args.map((v,i)=>({value:v,block:fn.blocks[merge.predIds[i]]}));
  if(steps.some(step=>!step.block||next(step.block)!==merge.id||step.block.phis.length))continue;
  const pointer=steps.find(step=>arrayIndex(step.value,tree,index)),increment=steps.find(step=>plusOne(step.value,index));
  if(!pointer||!increment||pointer.block===increment.block)continue;
  const chain=[],seen=new Set([header.id,merge.id,pointer.block.id,increment.block.id]);
  let current=fn.blocks[bodyStart],previous=header.id,branch;
  while(current&&!seen.has(current.id)&&chain.length<16){
   if(!singlePred(current,previous)||current.phis.length)break;
   chain.push(current);seen.add(current.id);
   if(current.term.kind==='cond'){branch=current;break;}
   previous=current.id;current=fn.blocks[next(current)];
  }
  const bit=branch?.term.args?.[0];
  if(!branch||!['ifeq','ifne'].includes(branch.term.insnOp)||bit?.op!=='iand')continue;
  const zero=branch.term.insnOp==='ifeq'?branch.term.taken:branch.term.fall;
  const one=branch.term.insnOp==='ifne'?branch.term.taken:branch.term.fall;
  if(zero!==increment.block.id||one!==pointer.block.id||!singlePred(pointer.block,branch.id)||!singlePred(increment.block,branch.id))continue;
  const masked=constant(bit.args[1])===1?bit.args[0]:constant(bit.args[0])===1?bit.args[1]:null;
  if(masked?.op!=='ishr'||masked.args[0]?.op!=='baload')continue;
  const byte=masked.args[0],input=state.reads?.get(byte.args[0]?.id);
  const byteSite=state.scalarSites?.get(byte.args[1]?.id),bitSite=state.scalarSites?.get(masked.args[1]?.id);
  if(!input||byte.args[0].imm?.[2]?.[1]!=='[B'||!byteSite||byteSite.write||!bitSite||bitSite.write||
     byte.args[1].imm?.[2]?.[1]!=='I'||masked.args[1].imm?.[2]?.[1]!=='I')continue;
  const byteAddress=byteSite.native.address,bitAddress=bitSite.native.address;
  if(byteAddress===bitAddress)continue;
  const expressions=new Map(),cells=new Map(),writes=[];
  let valid=true;
  const expression=node=>expressions.get(node);
  for(const block of chain)for(const node of block.body){
   const value=constant(node);if(value!==null){expressions.set(node,con(value));continue;}
   if(node.op==='nop')continue;
   if(node.op==='getstatic'){
    const site=state.scalarSites.get(node.id),array=state.reads.get(node.id);
    if(site&&!site.write)expressions.set(node,cells.get(site.native.address)||scalar(site.native.address));
    else if(array&&array.native.address===input.native.address)expressions.set(node,['bytes',array.native.address]);
    else valid=false;
   }else if(node.op==='putstatic'){
    const site=state.scalarSites.get(node.id),expr=expression(node.args[0]);
    if(!site?.write||!expr){valid=false;continue;}
    writes.push({address:site.native.address,value:expr});cells.set(site.native.address,expr);
   }else if(['baload','ishr','iand','iadd'].includes(node.op)){
    if(node.op==='baload'&&node!==byte){valid=false;continue;}
    let args=node.args.map(expression);if(args.some(v=>!v)){valid=false;continue;}
    if(['iadd','iand'].includes(node.op)&&args[0][0]==='const')args=args.toReversed();
    expressions.set(node,[node.op,...args]);
   }else valid=false;
  }
  const b=scalar(bitAddress),p=scalar(byteAddress),advanced=add(b,con(1));
  if(!valid||!eq(expression(bit),and(shr(['baload',['bytes',input.native.address],p],b),con(1)))||!eq(writes,[
   {address:bitAddress,value:advanced},
   {address:byteAddress,value:add(p,shr(advanced,con(3)))},
   {address:bitAddress,value:and(advanced,con(7))}]))continue;
  // A bypassed block must not hide an additional fault or store. Other pure
  // constants/field reads in the matched blocks are safe under the input proof.
  const safeBlock=(block,allowed)=>block.body.every(node=>constant(node)!==null||node.op==='nop'||allowed(node));
  if(!safeBlock(header,node=>node===read||sameTree(node,tree))||
     !safeBlock(pointer.block,node=>sameTree(node,tree)||arrayIndex(node,tree,index))||
     !safeBlock(increment.block,node=>plusOne(node,index)))continue;
  const bitPhis=header.phis.filter(phi=>phi!==index);
  if(bitPhis.some(phi=>phi.kind!=='I'||phi.args.length!==header.predIds.length||phi.args[backIndex]!==bit))continue;
  const loop=[header,...chain,pointer.block,increment.block,merge],ids=new Set(loop.map(b=>b.id));
  if(ids.size!==loop.length||ids.has(exit))continue;
  // No side entry into a matched iteration, or hidden branch out of it.
  if(loop.some(block=>block!==header&&block.predIds.some(pred=>!ids.has(pred))))continue;
  const field=state.instanceReads.get(tree.id);
  return {header:header.id,exit,backBlock:merge.id,backIndex,indexPhi:index.id,nextIndex:merged.id,
   bitValue:bit.id,bitPhis:bitPhis.map(phi=>phi.id),treeRead:tree.id,
   receiver:field.receiver.id,field:field.slot.key,byteAddress,bitAddress,inputAddress:input.native.address,
   loopBlocks:[...ids].sort((a,b)=>a-b)};
 }
 return null;
}
module.exports={analyzeIntTreePrefix};
