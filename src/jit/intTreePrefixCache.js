'use strict';
const {T,OP,uleb,sleb,assembleModule}=require('./wasmShared');

// A negative leaf terminates the query. A zero input bit selects index+1;
// a one selects tree[index]. No immutability assumption is made: every value
// used by a cached path is compared with the current heap before accepting it.
const depth=8,entryWords=2+2*(depth+1),slotBytes=32768,capacity=64,pages=32;
const bufferOf=typeof WebAssembly!=='undefined'&&WebAssembly.Memory
 ?Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype,'buffer').get:null;
const byteLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
let queryModule;
const get=n=>[OP.local_get,...uleb(n)],set=n=>[OP.local_set,...uleb(n)],iconst=n=>[OP.i32_const,...sleb(n)];
const load=(index,offset=0)=>[OP.i32_load,...uleb(2|(index?64:0)),...(index?uleb(index):[]),...uleb(offset)];

function moduleForQuery(){
 if(queryModule)return queryModule;
 // Params: tree base/length, prepared slot, input base/length, byte cursor,
 // bit cursor, fuel. Results: terminal index and consumed bits; (-1,0) refuses
 // without changing Java data. Locals: root, prefix, entry, bits, mismatch,
 // validation index, pair address, physical input length.
 const root=8,prefix=9,entry=10,bits=11,mismatch=12,index=13,pair=14,size=15;
 const refuse=[...iconst(-1),...iconst(0),OP.return];
 const fail=condition=>[...condition,OP.if,0x40,...refuse,OP.end];
 const body=[
  ...fail([...get(7),...iconst(1),OP.i32_le_s]),
  ...fail([...get(2),...iconst((capacity-1)*slotBytes),OP.i32_gt_u,
   ...get(2),...iconst(slotBytes-1),OP.i32_and,OP.i32_or]),
  ...fail([...get(2),...load(1,8),OP.i32_eqz]),
  ...fail([...get(2),...load(1,0),...get(0),OP.i32_ne,
   ...get(2),...load(1,4),...get(1),OP.i32_ne,OP.i32_or]),
  ...get(0),...load(0),OP.local_set,...uleb(root),
  ...get(root),...iconst(0),OP.i32_lt_s,OP.if,0x40,...iconst(0),...iconst(0),OP.return,OP.end,
  OP.memory_size,0,...iconst(16),OP.i32_shl,...set(size),
  ...fail([...get(3),...iconst(0),OP.i32_lt_s,...get(4),...iconst(2),OP.i32_lt_s,OP.i32_or,
   ...get(5),...iconst(0),OP.i32_lt_s,OP.i32_or,
   ...get(5),...get(4),...iconst(2),OP.i32_sub,OP.i32_gt_s,OP.i32_or,
   ...get(6),...iconst(7),OP.i32_gt_u,OP.i32_or,
   ...get(3),...get(size),OP.i32_gt_u,OP.i32_or,
   ...get(4),...get(size),...get(3),OP.i32_sub,OP.i32_gt_u,OP.i32_or]),
  ...get(3),...get(5),OP.i32_add,OP.i32_load16_u,1,0,...get(6),OP.i32_shr_u,...iconst(255),OP.i32_and,...set(prefix),
  ...get(2),...iconst(16),OP.i32_add,...get(prefix),...iconst(entryWords*4),OP.i32_mul,OP.i32_add,...set(entry),
  ...get(entry),...load(1),...set(bits),
  ...fail([...get(bits),...iconst(depth),OP.i32_gt_u,
   ...get(7),...get(bits),...iconst(1),OP.i32_add,OP.i32_le_s,OP.i32_or]),
  ...get(root),...get(entry),...load(1,12),OP.i32_xor,...set(mismatch),
  ...iconst(1),...set(index),
  OP.block,0x40,OP.loop,0x40,
   ...get(index),...get(bits),OP.i32_gt_s,OP.br_if,1,
   ...get(entry),...iconst(8),OP.i32_add,...get(index),...iconst(3),OP.i32_shl,OP.i32_add,...set(pair),
   ...get(mismatch),...get(0),...get(pair),...load(1),...iconst(2),OP.i32_shl,OP.i32_add,...load(0),
   ...get(pair),...load(1,4),OP.i32_xor,OP.i32_or,...set(mismatch),
   ...get(index),...iconst(1),OP.i32_add,...set(index),OP.br,0,
  OP.end,OP.end,
  ...fail([...get(mismatch)]),
  ...get(entry),...load(1,4),...get(bits),OP.end];
 queryModule=new WebAssembly.Module(assembleModule({importDecls:[],mainParams:Array(8).fill(T.i32),mainResults:[T.i32,T.i32],
  declared:Array(8).fill(T.i32),body,importMemory:true,memoryImportDecls:[{name:'proofs',minimum:pages,maximum:pages}]}));
 return queryModule;
}

function createIntTreePrefixCache(memory){
 if(!bufferOf)return null;
 try{
  // The helper's dependency checks rely on a synchronous, unshared heap.
  byteLength.call(bufferOf.call(memory));
  const proofMemory=new WebAssembly.Memory({initial:pages,maximum:pages});
  const query=new WebAssembly.Instance(moduleForQuery(),{env:{mem:memory,proofs:proofMemory}}).exports.run;
  const words=new Int32Array(bufferOf.call(proofMemory)),slots=new Map();
  function prepare(base,length){
   const buffer=bufferOf.call(memory),limit=byteLength.call(buffer);
   if(!Number.isInteger(base)||base<0||(base&3)||!Number.isInteger(length)||length<=0||length>(limit-base)/4)return -1;
   const key=base+':'+length;
   if(slots.has(key))return slots.get(key);
   if(slots.size===capacity)return -1;
   const slot=slots.size*slotBytes,at=slot>>2,tree=new Int32Array(buffer,base,length);
   for(let prefix=0;prefix<1<<depth;prefix++){
    const entry=at+4+prefix*entryWords;words[entry]=-1;
    let node=0;
    for(let consumed=0;consumed<=depth;consumed++){
     if(node<0||node>=length)break;
     const value=tree[node],pair=entry+2+consumed*2;words[pair]=node;words[pair+1]=value;
     if(value<0){words[entry]=consumed;words[entry+1]=node;break;}
     if(consumed===depth)break;
     node=(prefix>>consumed)&1?value:node+1;
    }
   }
   words[at]=base;words[at+1]=length;words[at+2]=1;slots.set(key,slot);return slot;
  }
  return {query,prepare,usage:()=>({tables:slots.size,bytes:pages*65536,capacity,depth})};
 }catch{return null;}
}
module.exports={createIntTreePrefixCache};
