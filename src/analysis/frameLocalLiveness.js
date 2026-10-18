'use strict';
const {normalizeInstruction,getStackEffect}=require('../utils/instructionUtils');
const conditional=/^if(?:eq|ne|lt|le|gt|ge|null|nonnull|_icmp(?:eq|ne|lt|le|gt|ge)|_acmp(?:eq|ne))$/;
const terminal=/^(?:[ilfda]?return|athrow)$/;
const ordinary=/^(?:nop|aconst_null|[ilfd]const_(?:m1|[0-5])|bipush|sipush|ldc(?:_w|2_w)?|[ialfdbcs]a(?:load|store)|pop2?|dup2?(?:_x[12])?|swap|[ilfd](?:add|sub|mul|div|rem|neg)|[il](?:shl|shr|ushr|and|or|xor)|[ilfd]2[ilfdbcs]|lcmp|[fd]cmp[lg]|goto(?:_w)?|tableswitch|lookupswitch|[ilfda]?return|athrow|getstatic|putstatic|getfield|putfield|invoke(?:static|special|virtual|interface|dynamic)|new|newarray|anewarray|multianewarray|arraylength|checkcast|instanceof|monitorenter|monitorexit)$/;
const trim=s=>typeof s==='string'?s.replace(/:$/,''):null;

// Conservative instruction liveness for restoring interpreter frames. Refuse
// incomplete edges/locals, legacy subroutines and excessive analysis work.
// Exception edges include every instruction in every protected region, even
// operations that cannot throw. Labels and numeric PCs both resolve explicitly.
function frameLocalLiveness(code) {
 const items=code?.codeItems,n=items?.length;
 if(!n || n>4096)return null;
 const labels=new Map(),pcs=new Map(),ops=[],uses=[],defs=[],successors=[];
 let maximumSlot=-1,edgeCount=0;
 const remember=(map,key,value)=>{
  if(map.has(key) && map.get(key)!==value)throw Error('ambiguous target');map.set(key,value);
 };
 try{
  for(let i=0;i<n;i++){
   const item=items[i];if(!item || typeof item!=='object')return null;
   if(item.labelDef!=null){const label=trim(item.labelDef);if(!label)return null;remember(labels,label,i);}
   const labelPc=/^L(\d+):?$/.exec(item.labelDef || '');
   if(item.pc!=null){if(!Number.isInteger(item.pc)||item.pc<0)return null;remember(pcs,item.pc,i);}
   if(labelPc)remember(pcs,Number(labelPc[1]),i);
  }
  const target=label=>{const name=trim(label),at=name?labels.get(name):undefined;if(at===undefined)throw Error('unknown branch');return at;};
  for(let i=0;i<n;i++){
   const ins=items[i].instruction;
   const normal=ins?normalizeInstruction(ins):null,op=normal?.op;
   ops[i]=op;uses[i]=[];defs[i]=[];
   const next=i+1<n?[i+1]:[];
   if(!ins){successors[i]=new Set(next);continue;}
   if(!op || /^(?:jsr(?:_w)?|ret|wide)$/.test(op))return null;
   const local=/^([ilfda](?:load|store))(?:_([0-3]))?$/.exec(op);
   if(/^[ilfda](?:load|store)/.test(op) && !local)return null;
   if(local || op==='iinc'){
    const slot=local?.[2]!==undefined?Number(local[2]):Number(normal.varnum??normal.index??normal.arg);
    const width=local && /^[ld]/.test(local[1])?2:1;
    if(!Number.isInteger(slot) || slot<0 || slot+width>1024)return null;
    maximumSlot=Math.max(maximumSlot,slot+width-1);
    if(op==='iinc' || local[1].endsWith('load'))for(let w=0;w<width;w++)uses[i].push(slot+w);
    if(op==='iinc' || local[1].endsWith('store'))for(let w=0;w<width;w++)defs[i].push(slot+w);
   }else if(!(ordinary.test(op)||conditional.test(op)) || !getStackEffect(op,normal))return null;
   let out;
   if(terminal.test(op))out=[];
   else if(op==='goto' || op==='goto_w')out=[target(normal.arg)];
   else if(conditional.test(op)){if(!next.length)return null;out=[target(normal.arg),...next];}
   else if(op==='tableswitch'){
    if(!Array.isArray(normal.labels) || !normal.labels.length)return null;
    out=[target(normal.defaultLbl),...normal.labels.map(target)];
   }else if(op==='lookupswitch'){
    if(!Array.isArray(normal.arg?.pairs) || normal.arg.pairs.some(p=>!Array.isArray(p)||p.length!==2))return null;
    out=[target(normal.arg.defaultLabel),...normal.arg.pairs.map(p=>target(p[1]))];
   }else {if(!next.length)return null;out=next;}
   successors[i]=new Set(out);
  }
  const point=(entry,kind)=>{
   const found=[];
   if(entry[kind+'_pc']!==undefined){
    const at=pcs.get(entry[kind+'_pc']);if(at===undefined)throw Error('unknown exception PC');found.push(at);
   }
   const names=[kind+'Lbl',kind+'Label',kind,...(kind==='handler'?['usingLbl']:[])];
   for(const name of names)if(entry[name]!==undefined)found.push(target(entry[name]));
   if(!found.length || found.some(at=>at!==found[0]))throw Error('unknown exception region');
   return found[0];
  };
  const handlers=code.exceptionTable || [];
  if(!Array.isArray(handlers) || handlers.length>128)return null;
  for(const entry of handlers){
   const start=point(entry,'start'),end=point(entry,'end'),handler=point(entry,'handler');
   if(start>=end || !items.slice(handler).some(item=>item.instruction))return null;
   for(let i=start;i<end;i++){
    successors[i].add(handler);
    if(++edgeCount>32768)return null;
   }
  }
 }catch(_){return null;}
 const words=Math.max(1,Math.ceil((maximumSlot+1)/32));
 if(n*words>65536)return null;
 const live=new Uint32Array(n*words),read=new Uint32Array(n*words),written=new Uint32Array(n*words);
 const predecessors=Array.from({length:n},()=>[]);
 for(let i=0;i<n;i++){
  for(const slot of uses[i])read[i*words+(slot>>>5)]|=1<<(slot&31);
  for(const slot of defs[i])written[i*words+(slot>>>5)]|=1<<(slot&31);
  for(const to of successors[i]){
   if(++edgeCount>32768)return null;
   predecessors[to].push(i);
  }
 }
 const queue=Array.from({length:n},(_,i)=>i),queued=new Uint8Array(n).fill(1);
 let work=0;
 while(queue.length){
  const at=queue.pop(),base=at*words;queued[at]=0;let changed=false;
  for(let w=0;w<words;w++){
   if((work+=successors[at].size+1)>4000000)return null;
   let next=0;for(const to of successors[at])next|=live[to*words+w];
   next=((next & ~written[base+w]) | read[base+w])>>>0;
   if(next!==live[base+w]){live[base+w]=next;changed=true;}
  }
  if(changed)for(const pred of predecessors[at])if(!queued[pred]){queued[pred]=1;queue.push(pred);}
 }
 return {
  has(index,slot){
   // An unmapped resume point cannot justify dropping a frame slot.
   if(!Number.isInteger(index)||index<0||index>=n)return true;
   if(!Number.isInteger(slot)||slot<0)return true;
   return slot<=maximumSlot&&!!(live[index*words+(slot>>>5)]&(1<<(slot&31)));
  },
  instructionCount:ops.filter(Boolean).length,storageBytes:live.byteLength,
 };
}
module.exports={frameLocalLiveness};
