'use strict';
const test=require('tape');
const {createIntTreePrefixCache}=require('../src/jit/intTreePrefixCache');
const memoryBuffer=Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype,'buffer').get;

function treeOfDepth(depth){
 const tree=[];let leaves=0;
 const add=d=>{const index=tree.length;tree.push(0);
  if(!d)tree[index]=~leaves++;
  else{add(d-1);tree[index]=tree.length;add(d-1);}return index;
 };
 add(depth);return tree;
}
function reference(tree,bytes,byte,bit){
 let index=0,consumed=0;
 while(tree[index]>=0){
  if(++consumed>32)throw Error('reference does not terminate');
  const one=(bytes[byte]>>bit)&1;bit++;byte+=bit>>3;bit&=7;
  index=one?tree[index]:index+1;
  if(index>=tree.length)throw RangeError('reference leaves tree');
 }
 return [index,consumed];
}
function fixture(tree){
 const memory=new WebAssembly.Memory({initial:2}),base=64,input=8192;
 new Int32Array(memory.buffer,base,tree.length).set(tree);
 const cache=createIntTreePrefixCache(memory);if(!cache)throw Error('required native query module is unavailable');
 const slot=cache.prepare(base,tree.length);
 return {memory,cache,base,input,slot,tree:new Int32Array(memory.buffer,base,tree.length),bytes:new Uint8Array(memory.buffer,input,8),
  query:(byte=0,bit=0,fuel=100)=>cache.query(base,tree.length,slot,input,8,byte,bit,fuel)};
}

test('native prefix query matches every eight-bit input and cursor for balanced trees',t=>{
 for(let depth=1;depth<=8;depth++){
  const f=fixture(treeOfDepth(depth)),expected=[],actual=[];
  for(let bit=0;bit<8;bit++)for(let prefix=0;prefix<256;prefix++){
   const packed=prefix<<bit;f.bytes[0]=packed&255;f.bytes[1]=packed>>>8;
   expected.push(reference(f.tree,f.bytes,0,bit));actual.push(f.query(0,bit));
  }
  t.deepEqual(actual,expected,'all prefix/cursor combinations at depth '+depth);
  t.deepEqual(f.query(0,0,depth+1),[-1,0],'insufficient original fuel refuses');
  t.deepEqual(f.query(0,0,depth+2),reference(f.tree,f.bytes,0,0),'sufficient original fuel accepts');
 }
 t.end();
});

test('mutable tree dependencies are validated without assuming global immutability',t=>{
 const f=fixture(treeOfDepth(3));f.bytes.fill(0);
 const expected=reference(f.tree,f.bytes,0,0);t.deepEqual(f.query(),expected,'original path accepted');
 const offPath=f.tree.length-1,oldOffPath=f.tree[offPath];f.tree[offPath]=-123;
 t.deepEqual(f.query(),expected,'a changed unobserved leaf does not invalidate this query');
 f.tree[offPath]=oldOffPath;
 const leaf=expected[0],oldLeaf=f.tree[leaf];f.tree[leaf]=-999;
 t.deepEqual(f.query(),[-1,0],'a changed observed value refuses before Java state changes');
 f.tree[leaf]=oldLeaf;t.deepEqual(f.query(),expected,'restored dependencies are usable again');
 f.tree[0]=-42;
 t.deepEqual(f.cache.query(f.base,f.tree.length,f.slot,-1,0,-5,-9,2),[0,0],'a current root leaf consumes no input');
 t.deepEqual(f.query(0,0,1),[-1,0],'even root-only work preserves the original fuel threshold');
 t.end();
});

test('cycles, deep paths, wrong spans and unprepared slots retain ordinary fallback',t=>{
 const f=fixture([0,-1]);f.bytes.fill(255);
 t.deepEqual(f.query(),[-1,0],'a cyclic prefix is not compiled');
 f.bytes.fill(0);t.deepEqual(f.query(),[1,1],'a terminating path in the same graph is accepted');
 const deep=fixture(treeOfDepth(9));t.deepEqual(deep.query(),[-1,0],'depth beyond the eight-bit certificate refuses');
 const bad=fixture([100000,-7]);bad.bytes.fill(1);
 t.deepEqual(bad.query(),[-1,0],'out-of-range edge refuses without native trapping');
 bad.bytes.fill(0);t.deepEqual(bad.query(),[1,1],'an unchosen bad edge is irrelevant');
 for(const [base,length,slot,input,inputLength,byte,bit,fuel]of [
  [f.base+4,2,f.slot,f.input,8,0,0,100],[f.base,1,f.slot,f.input,8,0,0,100],
  [f.base,2,-1,f.input,8,0,0,100],[f.base,2,1,f.input,8,0,0,100],
  [f.base,2,32768,f.input,8,0,0,100],[f.base,2,f.slot,f.input,1,0,0,100],
  [f.base,2,f.slot,-1,8,0,0,100],[f.base,2,f.slot,f.input,8,-1,0,100],
  [f.base,2,f.slot,f.input,8,7,0,100],[f.base,2,f.slot,f.input,8,0,-1,100],
  [f.base,2,f.slot,f.input,8,0,8,100],[f.base,2,f.slot,131071,2,0,0,100],
  [f.base,2,f.slot,f.input,8,0,0,0]])
  t.deepEqual(f.cache.query(base,length,slot,input,inputLength,byte,bit,fuel),[-1,0],'unsupported input refuses');
 t.end();
});

test('prepared tables have a fixed allocation budget and survive heap growth',t=>{
 const memory=new WebAssembly.Memory({initial:2}),cache=createIntTreePrefixCache(memory),input=102400;
 new Uint8Array(memory.buffer)[input]=1;
 for(let i=0;i<64;i++){
  const base=1024+i*16;new Int32Array(memory.buffer,base,3).set([2,-1,-2]);
  t.equal(cache.prepare(base,3),i*32768,'table receives its bounded private slot');
 }
 t.equal(cache.prepare(4096,3),-1,'exhaustion declines rather than allocating another table');
 t.equal(cache.prepare(1024,3),0,'existing table needs no new allocation');
 t.deepEqual(cache.usage(),{tables:64,bytes:2097152,capacity:64,depth:8},'two MiB total, with no Java reference retention');
 for(const [base,len]of [[-4,3],[1,3],[131068,2],[1024,0],[1024,-1]])t.equal(cache.prepare(base,len),-1,'invalid table span refuses');
 memory.grow(1);
 t.deepEqual(cache.query(1024,3,0,input,2,0,0,100),[2,1],'native memory binding remains current after growth');
 t.end();
});

test('a prepare operation uses only intrinsic memory accessors and refuses shared storage',t=>{
 const memory=new WebAssembly.Memory({initial:2});
 new Int32Array(memory.buffer,64,3).set([2,-1,-2]);let reads=0;
 Object.defineProperty(memory,'buffer',{get(){reads++;throw Error('user getter');}});
 const cache=createIntTreePrefixCache(memory);
 t.equal(cache.prepare(64,3),0,'private native accessor bypasses unrelated host getter');t.equal(reads,0,'no host callback during preparation');
 const bytes=new Uint8Array(memoryBuffer.call(memory));bytes[8192]=1;
 t.deepEqual(cache.query(64,3,0,8192,2,0,0,100),[2,1],'query executes without a JavaScript accessor');
 if(typeof SharedArrayBuffer!=='undefined')t.equal(createIntTreePrefixCache(new WebAssembly.Memory({initial:2,maximum:2,shared:true})),null,'concurrent storage cannot earn the proof');
 t.end();
});
