'use strict';
const {BIN_OPS,ICONST}=require('./wasmShared');
const numericKinds=new Set('IJFD');
const unary=new Set(['ineg','lneg','fneg','dneg','iinc','i2l','l2i','i2f','i2d',
 'l2f','l2d','f2d','d2f','f2i','f2l','d2i','d2l','i2b','i2s','i2c',
 'lshl','lshr','lushr']);
function pure(value) {
 if(!numericKinds.has(value.kind)||value.effects?.mayThrow)return false;
 return Object.hasOwn(BIN_OPS,value.op)||Object.hasOwn(ICONST,value.op)||unary.has(value.op)||
  /^[lfd]const_[012]$/.test(value.op)||value.op==='bipush'||value.op==='sipush';
}
// Only arithmetic and single-use branch/return operands are stackified.
// Comparisons, calls and array guards can read an argument more than once.
function frameRoots(fn) {
 const protectedValues=new Set();
 const protectMap=map=>{for(const value of map?.values()||[])protectedValues.add(value);};
 const protectList=list=>{for(const value of list||[])protectedValues.add(value);};
 for(const block of fn.blocks){
  protectMap(block.slotDefsIn);protectMap(block.slotDefsOut);
  protectList(block.entryStack);protectList(block.exitStack);
  for(const node of [...block.body,...(block.term?[block.term]:[])]){
   protectMap(node.slotState);protectList(node.stackUnder);
  }
 }
 return protectedValues;
}
function prepare(fn) {
 const protectedValues=frameRoots(fn),values=new Set(),depths=new Map();
 for(const block of fn.blocks){
  if(!fn.reachable.has(block.id))continue;
  const positions=new Map(block.body.map((node,i)=>[node,i]));if(block.term)positions.set(block.term,block.body.length);
  const barriers=[0];for(const node of block.body)barriers.push(barriers.at(-1)+(pure(node)?0:1));
  for(const [position,value]of block.body.entries()){
   if(values.size>=512)return values;
   const consumer=value.uses?.length===1?value.uses[0]:null;
   const end=positions.get(consumer);
   if(!pure(value)||protectedValues.has(value)||!consumer||end===undefined||end<=position)continue;
   // Do not extend operand lifetimes across calls, loads or other effects.
   if(barriers[end]!==barriers[position+1])continue;
   if(!pure(consumer)&&!(consumer===block.term&&['cond','return'].includes(consumer.kind)))continue;
   const depth=1+Math.max(0,...value.args.map(arg=>depths.get(arg)||0));
   if(depth>16)continue;
   values.add(value);depths.set(value,depth);
  }
 }
 return values;
}

// Block-local numeric temporaries cannot appear in any frame/operand snapshot
// or flow to another block. Their slots can be reused only AFTER the complete
// last consuming instruction, including its cold call/exception paths.
function assignLocals(fn,stackified,localOf,allocate) {
 const protectedValues=frameRoots(fn);let reused=0,work=0;
 for(const block of fn.blocks){
  if(!fn.reachable.has(block.id))continue;
  for(const phi of block.phis)if(numericKinds.has(phi.kind)||phi.kind==='A')allocate(phi);
  const positions=new Map(block.body.map((node,i)=>[node,i]));if(block.term)positions.set(block.term,block.body.length);
  const free=new Map(),release=new Map();
  for(const [position,value]of block.body.entries()){
   for(const entry of release.get(position)||[]){
    let slots=free.get(entry.kind);if(!slots)free.set(entry.kind,slots=[]);slots.push(entry.slot);
   }
   if(stackified.has(value)||!numericKinds.has(value.kind)&&value.kind!=='A')continue;
   let end=position,temporary=numericKinds.has(value.kind)&&!protectedValues.has(value)&&value.uses?.length>0&&work<50000;
   if(temporary)for(let use of value.uses){
    while(stackified.has(use)&&++work<50000)use=use.uses[0];
    const at=positions.get(use);work++;
    if(at===undefined||at<=position||work>=50000){temporary=false;break;}
    end=Math.max(end,at);
   }
   const slots=temporary&&free.get(value.kind);
   let slot;
   if(slots?.length){slot=slots.pop();localOf.set(value,slot);reused++;}
   else slot=allocate(value);
   if(temporary){
    let entries=release.get(end+1);if(!entries)release.set(end+1,entries=[]);
    entries.push({slot,kind:value.kind});
   }
  }
 }
 return reused;
}
module.exports={prepare,assignLocals};
