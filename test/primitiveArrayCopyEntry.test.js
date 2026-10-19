"use strict";
const test=require('tape');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const {recognizePrimitiveCopy}=require('../src/jit/primitiveArrayCopyEntry');
const compileFixture=makeJavaFixtureCompiler('primitive-copy-entry-');
const forward=`n+=si;n-=7;while(si<n){${'d[di++]=s[si++];'.repeat(8)}}n+=7;while(si<n)d[di++]=s[si++];return;`;
const SOURCE=`public class BulkMove {
 public static void copyDuplicated(int[] s,int si,int[] d,int di,int n){
   if(s!=d){${forward}}
   if(si==di)return;
   if(di<=si){${forward}}
   if(di>=si+n){${forward}}
   n--;si+=n;di+=n;n=si-n;n+=7;
   while(si>=n){${'d[di--]=s[si--];'.repeat(8)}}
   n-=7;while(si>=n)d[di--]=s[si--];
 }
 public static void copy(int[] s,int si,int[] d,int di,int n){
  if(s==d){
   if(si==di)return;
   if(di>si && di<si+n){
    n--;si+=n;di+=n;n=si-n;n+=7;
    while(si>=n){
     d[di--]=s[si--];d[di--]=s[si--];d[di--]=s[si--];d[di--]=s[si--];
     d[di--]=s[si--];d[di--]=s[si--];d[di--]=s[si--];d[di--]=s[si--];
    }
    n-=7;while(si>=n)d[di--]=s[si--];return;
   }
  }
  n+=si;n-=7;
  while(si<n){
   d[di++]=s[si++];d[di++]=s[si++];d[di++]=s[si++];d[di++]=s[si++];
   d[di++]=s[si++];d[di++]=s[si++];d[di++]=s[si++];d[di++]=s[si++];
  }
  n+=7;while(si<n)d[di++]=s[si++];
 }
 public static int root(int[] s,int si,int[] d,int di,int n){try{copy(s,si,d,di,n);return d[0]+d[1];}catch(RuntimeException e){return -97;}}
}`;
async function harness(classpath,enabled,methodName='copy'){
 const j=new JVM({classpath,wasmHeap:true,wasmHeapMb:16,jit:{enabled:false,compileWorker:false,
  wasm:{structured:true,deepInline:false,primitiveArrayCopyEntry:enabled}}});
 await j.loadClassByName('BulkMove');j.classes.BulkMove.staticFieldsInitialized=true;j._markClassInitialized('BulkMove');
 const w=j.jit.wasmJit;w.enabled=true;w.importStatsEnabled=true;
 const method=j.findMethod(j.classes.BulkMove,methodName,'([II[III)V'),state=w.methodState({method});w.compile({method,className:'BulkMove'},state,{asCallee:true});
 const array=values=>{const a=j.wasmHeap.alloc('[I',values.length);a.type='[I';a.set(values);return a;};
 return {j,w,method,state,array};
}
function invoke(h,source,si,destination,di,count,fuel=100000000){
 const frame=new Frame(h.method);h.state.meta.box.frame=frame;
 let status,error;try{status=h.state.run(source,si,destination,di,count,0,fuel);}catch(e){error=e.type||e;}
 return {status,error,source:source&&Array.from(source),destination:destination&&Array.from(destination),
  locals:frame.locals.map(v=>ArrayBuffer.isView(v)?Array.from(v):v),stack:frame.stack.items};
}
test('bulk copy recognizes a complete bytecode proof and rejects mutations',async t=>{
 const classpath=compileFixture(t,'BulkMove',SOURCE),h=await harness(classpath,true);
 t.equal(h.state.status,'ready',h.state.lastCompileError||'real javac fixture installs Wasm');
 t.deepEqual(recognizePrimitiveCopy(h.method),{width:8},'complete unrolled memmove is recognized');
 t.equal(h.state.meta.primitiveCopyEntryUnroll,8,'entry fast path is actually emitted');
 const code=h.method.attributes.find(a=>a.type==='code').code;
 for(const [predicate,mutate,label]of [
  [i=>i?.op==='iinc',i=>{i.incr=String(Number(i.incr)+1);},'increment'],
  [i=>i?.op==='goto',i=>{i.arg=code.codeItems[0].labelDef.replace(':','');},'branch target'],
  [i=>i==='iaload',(_i,item)=>{item.instruction='iadd';},'element operation'],
  [i=>i==='aload_2',(_i,item)=>{item.instruction='aload_0';},'array receiver']]){
  const method=JSON.parse(JSON.stringify(h.method)),items=method.attributes.find(a=>a.type==='code').code.codeItems,item=items.find(x=>predicate(x.instruction));
  mutate(item.instruction,item);t.equal(recognizePrimitiveCopy(method),null,'changed '+label+' cannot authorize bulk copying');
 }
 for(const change of [{flags:['static','synchronized']},{flags:[]},{descriptor:'([II[III)I'}])
  t.equal(recognizePrimitiveCopy({...h.method,...change}),null,'changed method contract is rejected');
 const withHandler=JSON.parse(JSON.stringify(h.method));withHandler.attributes.find(a=>a.type==='code').code.exceptionTable=[{}];
 t.equal(recognizePrimitiveCopy(withHandler),null,'a local handler is never bypassed');
 t.end();
});
test('guarded memory copy and the original loop have identical values and exits',async t=>{
 const classpath=compileFixture(t,'BulkMove',SOURCE),fast=await harness(classpath,true),base=await harness(classpath,false);
 t.equal(base.state.meta.primitiveCopyEntryUnroll,0,'entry bulk copying remains disabled by default');
 const unused=fast.array([1,2,3]),lookups=fast.state.meta.importStats.get('abase');
 t.equal(invoke(fast,unused,0,unused,2,0).status,-1,'zero-count copy returns normally');
 t.equal(fast.state.meta.importStats.get('abase'),lookups,'proved zero-count entry skips all base queries');
 t.equal(fast.state.meta.importStats.get('alen0'),0,'proved zero-count entry skips all length queries');

 const values=Array.from({length:40},(_,i)=>i*13-7);
 const cases=[];
 for(const count of [0,1,7,8,9,15,16,23,32])for(const [si,di]of [[0,0],[0,1],[1,0],[3,5],[5,3]])cases.push({count,si,di,alias:true});
 for(const [si,di,count]of [[0,0,33],[1,3,9],[-1,0,1],[0,-1,1],[39,0,3],[0,39,3],[0,0,-1],[0,0,41]])cases.push({si,di,count,alias:false});
 cases.push({si:-2147483648,di:0,count:0,alias:true},{si:2147483647,di:-1,count:0,alias:true},
  {si:-2147483648,di:0,count:0,alias:false});
 cases.push({si:0,di:0,count:1,nullSource:true},{si:0,di:0,count:1,nullDest:true},{si:0,di:0,count:0,nullSource:true,nullDest:true});
 for(const c of cases){const run=h=>{const source=c.nullSource?null:h.array(values),dest=c.nullDest?null:c.alias?source:h.array(values.map(x=>-x));return invoke(h,source,c.si,dest,c.di,c.count);};
  t.deepEqual(run(fast),run(base),'exact arrays and guest faults: '+JSON.stringify(c));
 }
 for(const fuel of [1,2,5,15,33])for(const [si,di]of [[0,1],[1,0]]){
  const run=h=>{const a=h.array(values);return invoke(h,a,si,a,di,32,fuel);};
  t.deepEqual(run(fast),run(base),'low fuel keeps the original canonical spill: '+fuel+'/'+si+'/'+di);
 }
 for(const fuel of [1,2,3]){
  const run=h=>{const a=h.array(values);return invoke(h,a,0,a,1,0,fuel);};
  t.deepEqual(run(fast),run(base),'zero-count entry preserves low-fuel exits: '+fuel);
 }
 for(const plain of [true,false]){const run=h=>{const s=plain?Object.assign([...values],{type:'[I'}):h.array(values),d=Object.assign(values.map(x=>-x),{type:'[I'});return invoke(h,s,0,d,1,32);};
  t.deepEqual(run(fast),run(base),'nonheap arrays keep the original normalized element path');
 }
 const big=Array.from({length:16386},(_,i)=>i);
 const runBig=h=>{const a=h.array(big),b=h.array(big.map(x=>-x));return invoke(h,a,0,b,0,16385);};
 t.deepEqual(runBig(fast),runBig(base),'large copies keep the bounded, fuel-polled original loop');
 // Distinct views into shared memory have forward-copy semantics even when
 // their physical ranges overlap; Java reference equality selects direction.
 const runViews=h=>{const a=h.array(values),b=new Int32Array(a.buffer,a.byteOffset+4,39);b.type='[I';b.wasmBase=b.byteOffset;return invoke(h,a,0,b,0,32);};
 t.deepEqual(runViews(fast),runViews(base),'distinct overlapping heap views decline memmove');
 t.end();
});

test('duplicated copy tails and inverted branches retain the complete copy proof',async t=>{
 const classpath=compileFixture(t,'BulkMove',SOURCE);
 const fast=await harness(classpath,true,'copyDuplicated'),base=await harness(classpath,false,'copyDuplicated');
 const proof=recognizePrimitiveCopy(fast.method);
 t.equal(proof?.width,8,'graph proof identifies the same unrolled width');
 t.equal(proof?.controlFlowEquivalent,true,'duplicated layout actually needs graph equivalence');
 t.equal(fast.state.meta.primitiveCopyEntryUnroll,8,'proved duplicated layout installs a native bulk entry');
 const values=Array.from({length:40},(_,i)=>i*13-7);
 for(const alias of [false,true])for(const [si,di,n] of [[0,0,1],[0,1,32],[1,0,32],[3,5,9],[5,3,9],[0,0,0],[-1,0,1],[39,0,3],[0,39,3],[0,0,-1]]){
   const run=h=>{const s=h.array(values),d=alias?s:h.array(values.map(x=>-x));return invoke(h,s,si,d,di,n);};
   t.deepEqual(run(fast),run(base),'duplicated forward/reverse copy preserves effects and faults: '+[alias,si,di,n]);
 }
 for(const fuel of [-1,0,1,2,15,100,10000]){
   const run=h=>{const a=h.array(values);return invoke(h,a,0,a,1,32,fuel);};
   t.deepEqual(run(fast),run(base),'extra control-flow blocks retain exact low-fuel continuation: '+fuel);
 }
 const code=fast.method.attributes.find(a=>a.type==='code').code;
 let mutations=0;
 for(let i=0;i<code.codeItems.length;i++)if(code.codeItems[i].instruction==='iaload'){
   const method=JSON.parse(JSON.stringify(fast.method));
   method.attributes.find(a=>a.type==='code').code.codeItems[i].instruction='iadd';
   t.equal(recognizePrimitiveCopy(method),null,'changed element in duplicated tail '+(++mutations)+' is refused');
 }
 t.ok(mutations>16,'mutations cover all duplicated forward copies and reverse body');
 t.end();
});

test('copy graph matching rejects epsilon cycles, missing edges and excessive input',t=>{
 const {equivalentCopyControlFlow:equal}=require('../src/jit/copyControlFlowProof');
 t.notOk(equal([['goto',0]],[['return']]),'effect-free infinite jump cannot become a return');
 t.notOk(equal([['goto',9]],[['return']]),'missing jump target refuses the proof');
 t.notOk(equal([['return']],[['goto',undefined]]),'unresolved expected target refuses the proof');
 t.notOk(equal(Array.from({length:4097},()=>['return']),[['return']]),'proof input is bounded');
 t.notOk(equal([['iaload'],['return']],[['return']]),'an extra throwing read is never elided');
 t.end();
});

test('a proved integer copy entry needs no opt-in',async t=>{
 const classpath=compileFixture(t,'BulkMove',SOURCE),h=await harness(classpath,undefined,'copyDuplicated');
 t.equal(h.state.meta.primitiveCopyEntryUnroll,8,'default compiler emits the proved entry');
 t.end();
});

test('native copy guards preserve physical faults, wrapping and actual bulk execution',async t=>{
 const classpath=compileFixture(t,'BulkMove',SOURCE),fast=await harness(classpath,true,'copyDuplicated'),base=await harness(classpath,false,'copyDuplicated');
 const s=fast.array([2,3,5,7]),d=fast.array([0,0,0,0]);
 const before=fast.state.meta.importStats.get('ref_eq');
 t.equal(invoke(fast,s,0,d,1,3).status,-1,'disjoint nonempty copy finishes');
 t.deepEqual([...d],[0,2,3,5],'actual bulk path copies every value');
 t.equal(fast.state.meta.importStats.get('ref_eq'),before,
   'native disjoint path avoids both the alias import and original copy body');
 t.notOk(fast.state.meta.importStats.has('primitive_copy_int_heap'),'integer bulk entry has no JS eligibility import');
 const run=(h,mode)=>{
   const heap=h.j.wasmHeap,src=h.array([11,13]),dst=h.array([-7,-9]);
   const last=(heap.limit>>2)-1;heap.i32[last]=123;
   let source=src,target=dst,si=0;
   if(mode==='source')source={wasmBase:heap.limit-4,length:2};
   if(mode==='target')target={wasmBase:heap.limit-4,length:2};
   if(mode==='wrap'){
     const address=heap.allocObject(8);heap.i32[address>>2]=777;
     source={wasmBase:address,length:0x40000001};si=0x40000000;
   }
   const frame=new Frame(h.method);h.state.meta.box.frame=frame;
   let status,error;
   try{status=h.state.run(source,si,target,0,mode==='wrap'?1:2,0,100000000);}
   catch(e){error={name:e.name,message:e.message,type:e.type};}
   finally{h.state.meta.box.frame=null;}
   return {status,error,destination:[...dst],last:heap.i32[last]};
 };
 for(const mode of ['source','target','wrap']){
   t.deepEqual(run(fast,mode),run(base,mode),'physical '+mode+' preserves original partial effects and traps');
 }
 const alias=(h,equalIndices)=>{
   const data=h.array([2,3,5,7,11,13,17,19]);let queries=0;
   const a={length:8,get wasmBase(){return data.wasmBase+(queries++<2?0:equalIndices?16:8);}};
   const frame=new Frame(h.method);h.state.meta.box.frame=frame;
   let status;try{status=h.state.run(a,equalIndices?0:1,a,0,3,0,100000000);}
   finally{h.state.meta.box.frame=null;}
   return {status,data:[...data],queries};
 };
 for(const equal of [true,false])t.deepEqual(alias(fast,equal),alias(base,equal),
   'same Java reference with inconsistent host captures preserves '+(equal?'early return':'copy direction'));
 t.end();
});
