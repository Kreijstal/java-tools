'use strict';
const test=require('tape');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const {recognizeIntZeroClear}=require('../src/jit/intZeroClearEntry');

test('zero-fill proof survives copied indices and preserves checked fallbacks',async t=>{
 const compile=makeJavaFixtureCompiler('int-zero-clear-');
 const body=copied=>`int i=0, n=width*height-3;
   while(i<n) { ${Array.from({length:4},(_,k)=>copied?
     `int p${k}=i; i++; data[p${k}]=0;`:'data[i++]=0;').join(' ')} }
   n+=3; while(i<n) { ${copied?'int tail=i; i++; data[tail]=0;':'data[i++]=0;'} }`;
 const classpath=compile(t,'ZeroFillProof',`public class ZeroFillProof {
   static int width,height; static int[] data; static int other;
   static void compact() { ${body(false)} }
   static void copied() { int dead0=0,dead1=0,dead2=0; ${body(true)} }
   static void extraRead() { int ignored=other; ${body(true)} }
   static void carriedValue() { int value=0; ${body(true)
     .replace('data[p0]=0;', 'data[p0]=value;')
     .replace('data[p3]=0;', 'data[p3]=0; value++;')} }
   static void staleIndex() { int p0=0; ${body(true)
     .replace('int p0=i;', 'p0=i;')
     .replace('data[tail]=0;', 'data[p0]=0;')} }
   static void zeroTripValue() { int value=7; ${body(true)
     .replace('data[p3]=0;', 'data[p3]=0; value=0;')
     .replace('data[tail]=0;', 'data[tail]=value;')} }
   static void tailCarriedValue() { int value=0; ${body(true)
     .replace('data[tail]=0;', 'data[tail]=value; value++;')} }
 }`);
 const j=new JVM({classpath,wasmHeap:true,jit:{enabled:false,compileWorker:false,
   wasmStructured:true,wasm:{intZeroClearEntry:true}}});
 await j.preloadClasspathClasses();
 j.classInitializationState.set('ZeroFillProof','INITIALIZED');
 const fields=j.classes.ZeroFillProof.staticFields,w=j.jit.wasmJit;
 const states=[];
 for(const name of ['compact','copied']){
   const method=j.findMethod(j.classes.ZeroFillProof,name,'()V');
   t.equal(recognizeIntZeroClear(method)?.width,4,name+' proves consecutive zero writes');
   const st=w.methodState({method});w.compile({method,className:'ZeroFillProof'},st);
   t.equal(st.status,'ready',st.lastCompileError||name+' compiles');
   t.ok(st.meta.intZeroClearEntryBytes>0,name+' actually emits bulk entry');
   states.push({method,st});
 }
 const extra=j.findMethod(j.classes.ZeroFillProof,'extraRead','()V');
 t.equal(recognizeIntZeroClear(extra),null,'even an unused unproved field read refuses the fast path');
 for(const name of ['carriedValue','staleIndex','zeroTripValue','tailCarriedValue']){
   const method=j.findMethod(j.classes.ZeroFillProof,name,'()V');
   t.equal(recognizeIntZeroClear(method),null,name+' cannot use a first-iteration assumption as an invariant');
 }
 const original=states[1].method;
 for(const op of ['iastore','iinc','if_icmpge']){
   const copy=JSON.parse(JSON.stringify(original)),items=copy.attributes.find(a=>a.type==='code').code.codeItems;
   const item=items.find(x=>(typeof x.instruction==='string'?x.instruction:x.instruction?.op)===op);
   if(op==='iastore')item.instruction='iadd';
   else if(op==='iinc')item.instruction.incr='2';
   else item.instruction.arg='L999999';
   t.equal(recognizeIntZeroClear(copy),null,'modified '+op+' cannot authorize a bulk fill');
 }
 for(const entry of states){
   const run=(a,width,height,fuel=1000000)=>{
     fields.set('data:[I',a);fields.set('width:I',width);fields.set('height:I',height);
     const frame=new Frame(entry.method);entry.st.meta.box.frame=frame;
     try{return {status:entry.st.run(0,fuel),frame};}
     finally{entry.st.meta.box.frame=null;}
   };
   for(const n of [0,1,3,4,5,15,16,19]){
     const a=j.wasmHeap.alloc('[I',n+2);a.fill(91);
     const before=entry.st.meta.box.intZeroClearCalls||0;
     t.equal(run(a,n,1).status,-1,'bulk/tail completes for length '+n);
     t.deepEqual([...a],[...Array(n).fill(0),91,91],'fill touches exactly the proved range');
     if(n)t.equal(entry.st.meta.box.intZeroClearCalls,before+1,'guarded bulk path is used');
   }
   t.equal(run(null,0,1).status,-1,'zero-trip null array is legal');
   const plain=Object.assign([9,9,9,9,9],{type:'[I'});
   t.equal(run(plain,5,1).status,-1,'plain arrays keep the supported loop');
   t.deepEqual([...plain],[0,0,0,0,0],'plain-array fallback has exact writes');
   const short=j.wasmHeap.alloc('[I',3);short.fill(8);
   t.throws(()=>run(short,5,1),e=>e.type==='java/lang/ArrayIndexOutOfBoundsException','short arrays keep the guest bounds exception');
   t.deepEqual([...short],[0,0,0],'earlier stores survive a failing later store');
   t.throws(()=>run(null,5,1),e=>e.type==='java/lang/NullPointerException','nonempty null fill keeps its exception');
   short.fill(8);
   t.throws(()=>run(short,-2147483648,1),e=>e.type==='java/lang/ArrayIndexOutOfBoundsException',
     'overflowing negative threshold keeps the original checked loop');
   t.deepEqual([...short],[0,0,0],'overflow fallback retains partial writes');
   const limited=j.wasmHeap.alloc('[I',19);limited.fill(7);
   const result=run(limited,19,1,1);
   t.notEqual(result.status,-1,'insufficient fuel retains the resumable loop');
   t.notDeepEqual([...limited],Array(19).fill(0),'bulk fill never bypasses a required fuel exit');
 }
 t.end();
});
