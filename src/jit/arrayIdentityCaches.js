'use strict';
const {T,OP,uleb}=require('./wasmShared');

// A successful checkcast keeps the same reference. Share only a positive
// native base/length proof across its aliases; an imported/host array retains
// each original metadata query. No reference or type verdict is cached here.
const MAX_GROUPS=64;
function repeatedBlocks(tree) {
 const blocks=new Set(),pending=[[tree,false]];
 while(pending.length){
  const [node,outer]=pending.pop();if(!node)continue;
  const repeated=outer || node.t==='loop';
  if(repeated && node.block!==undefined)blocks.add(node.block);
  const children=node.t==='seq'?node.body:node.t==='loop'||node.t==='block'?[node.body]:
   node.t==='if'?[node.then,node.els]:node.t==='switch'?[...node.cases.map(c=>c.body),node.dflt]:[];
  for(const child of children)pending.push([child,repeated]);
 }
 return blocks;
}
function prepare(c,structured) {
 if(!c.heap)return;
 const groups=new Map(),repeated=repeatedBlocks(structured.tree);
 for(const cache of c.arrayCaches.values()){
  if(cache.parameter || cache.sharedField)continue;
  const root=c.fn.referenceFacts.identity(cache.value);
  let group=groups.get(root.id);
  if(!group){group={root,readers:[]};groups.set(root.id,group);}
  group.readers.push(cache);
 }
 const active=new Map();
 for(const [id,group] of groups){
  if(group.readers.some(cache=>cache.value!==group.root && repeated.has(cache.value.block)))active.set(id,group);
 }
 // An unused intermediate phi still carries the reference to a later cast.
 // Propagate through that SSA slice, rather than dropping a proof merely
 // because the intermediate join itself never accesses an array.
 const queue=[...active.values()];
 for(let i=0;i<queue.length;i++){
  if(active.size>MAX_GROUPS)return;
  const root=queue[i].root;if(root.op!=='phi')continue;
  for(const arg of root.args){
   const source=c.fn.referenceFacts.identity(arg);
   if(source.op!=='phi' || active.has(source.id))continue;
   const group=groups.get(source.id)||{root:source,readers:[]};active.set(source.id,group);queue.push(group);
  }
 }
 if(!active.size || active.size>MAX_GROUPS)return;
 const local=()=>{const index=c.nextLocal++;c.declared.push(T.i32);return index;};
 c.arrayIdentityGroups=active;
 for(const group of active.values()){
  group.base=local();group.len=local();group.filled=local();
  for(const cache of group.readers)cache.identityGroup=group;
 }
}
function fill(c,cache,query) {
 const group=cache.identityGroup;if(!group)return query;
 let owned=c.importIndexByName.get('owned_array_metadata');
 if(owned===undefined){
  const memory=c.heap.memory,{hasOwnedArrayMetadata}=require('../core/nativeArrayMetadata');
  owned=c.addImport('owned_array_metadata',[T.ref],[T.i32],value=>hasOwnedArrayMetadata(memory,value)?1:0,true);
 }
 const copy=(source,target)=>[OP.local_get,...uleb(source),OP.local_set,...uleb(target)];
 return [OP.local_get,...uleb(group.filled),OP.if,0x40,
  ...copy(group.base,cache.base),...copy(group.len,cache.len),OP.else,...query,
  OP.local_get,...uleb(cache.base),OP.i32_const,0,OP.i32_ge_s,OP.if,0x40,
  ...c.useOf(cache.value),OP.call,...uleb(owned),OP.if,0x40,
  ...copy(cache.base,group.base),...copy(cache.len,group.len),
  OP.i32_const,1,OP.local_set,...uleb(group.filled),OP.end,OP.end,OP.end];
}

// Phi reference copies happen simultaneously. Capture every source's numeric
// proof before overwriting any destination proof, including swaps/cycles.
// Unknown/deferred metadata simply clears the destination: never query an
// array or run a getter on an edge that did not access it in Java.
function phiCopies(c,copies,out) {
 const transfers=[];
 for(const {phi,arg} of copies){
  const target=c.arrayIdentityGroups?.get(phi.id);if(!target)continue;
  const root=c.fn.referenceFacts.identity(arg);
  const group=c.arrayIdentityGroups.get(root.id);
  const header=c.referenceArrayElementHeaders?.get(arg.id);
  // Raw cache pointers also accept untracked host aliases. Only a group
  // ownership proof or an allocator-derived row header may cross a join.
  const source=group || header && {...header,filled:null};
  if(source){
   out.push(OP.local_get,...uleb(source.base),OP.local_get,...uleb(source.len));
   if(source.filled!==null)out.push(OP.local_get,...uleb(source.filled));
   out.push(OP.local_get,...uleb(source.base),OP.i32_const,0,OP.i32_ge_s);
   if(source.filled!==null)out.push(OP.i32_and);
  }else out.push(OP.i32_const,0,OP.i32_const,0,OP.i32_const,0);
  transfers.push(target);
 }
 for(const target of transfers.slice().reverse())out.push(
  OP.local_set,...uleb(target.filled),OP.local_set,...uleb(target.len),OP.local_set,...uleb(target.base));
 return transfers.length>0;
}
module.exports={prepare,fill,phiCopies};
