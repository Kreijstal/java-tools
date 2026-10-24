'use strict';
const {ICONST}=require('./wasmShared');
function integer(node){
 if(Object.hasOwn(ICONST,node.op))return ICONST[node.op];
 if(node.kind!=='I')return null;
 let value=null;
 // Push immediates are textual in the class reader. Pool integer constants
 // instead use a tagged object; a textual ldc is a Java string, never a number.
 if(node.op==='bipush'||node.op==='sipush')value=Number(node.imm);
 else if(node.op==='ldc'||node.op==='ldc_w')value=typeof node.imm==='number'
  ?node.imm:node.imm?.type==='Integer'?Number(node.imm.value):null;
 if(Number.isInteger(value)&&value>=-2147483648&&value<=2147483647)return value;
 return null;
}
// Every i32 value AND a nonnegative constant lies between zero and that
// constant, including wrapping inputs. No operand evaluation is moved. The
// caller checks the captured array length once before selecting this body.
function maximum(index){
 const constant=integer(index);if(constant!==null)return constant>=0?constant:null;
 if(index.op!=='iand')return null;
 const masks=index.args.map(integer).filter(value=>value!==null&&value>=0);
 return masks.length?Math.min(...masks):null;
}
function prepare(c,loads,stores){
 const empty=()=>({caches:[],limits:new Map(),sites:new Set()});
 const descriptors=c.method.descriptor.slice(1,c.method.descriptor.indexOf(')')).match(/\[*L[^;]+;|\[*[ZBCSIJFD]/g)||[];
 const offset=c.method.flags?.includes('static')?0:1;
 // Canonical boolean arrays deliberately retain the checked representation.
 // Merely forwarding a header or reading arraylength needs no native proof.
 const capable=new Set(c.fn.params.filter((value,index)=>/^\[[BCSIJFD]$/.test(descriptors[index-offset]||'')));
 if(!capable.size)return empty();
 const caches=new Set(),limits=new Map(),sites=new Set();let work=0;
 for(const block of c.fn.blocks){
  if(!c.fn.reachable.has(block.id)||c.demoted.has(block.id))continue;
  for(const node of block.body){
   if(++work>50000)return empty();
   if(!loads[node.op]&&!stores[node.op])continue;
   const cache=c.arrayCaches.get(node.args[0].id);
   if(!cache?.parameter||!capable.has(cache.value))continue;
   caches.add(cache);const upper=maximum(node.args[1]);
   if(upper===null||upper>=2147483647)continue;
   limits.set(cache,Math.max(limits.get(cache)||0,upper+1));sites.add(node.id);
  }
 }
 return {caches:[...caches],limits,sites};
}
module.exports={prepare};
