"use strict";
const test=require('tape');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const {recognizePrimitiveCopy}=require('../src/jit/primitiveArrayCopyEntry');
const compileFixture=makeJavaFixtureCompiler('primitive-copy-entry-');
const SOURCE=`public class BulkMove {
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
async function harness(classpath,enabled){
 const j=new JVM({classpath,wasmHeap:true,wasmHeapMb:16,jit:{enabled:false,compileWorker:false,
  wasm:{structured:true,deepInline:false,primitiveArrayCopyEntry:enabled}}});
 await j.loadClassByName('BulkMove');j.classes.BulkMove.staticFieldsInitialized=true;j._markClassInitialized('BulkMove');
 const w=j.jit.wasmJit;w.enabled=true;w.importStatsEnabled=true;
 const method=j.findMethod(j.classes.BulkMove,'copy','([II[III)V'),state=w.methodState({method});w.compile({method,className:'BulkMove'},state,{asCallee:true});
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
 t.equal(h.state.status,'ready','real javac fixture installs Wasm');
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
