'use strict';
const test=require('tape');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame');
const Compiler=require('../src/jit/StructuredWasmCompiler');
const loops=require('../src/jit/guardedNestedArrayLoops');
const {OP,uleb}=require('../src/jit/wasmShared');
const compile=makeJavaFixtureCompiler('guarded-array-rows-');
const SOURCE=`public class ArrayRows {
 static int[] data;
 public static int paint(int index,int width,int height,int skip,int color,int weight) {
   int row=0,left=0,prior=0,value=0;
   for(row=0;row<height;row++) {
     for(left=-width;left<0;left++) {
       value=data[index];
       value=((value&16711935)*weight>>8&16711935)+((value&65280)*weight>>8&65280);
       prior=index;index++;data[prior]=color+value;
     }
     index+=skip;
   }
   return index;
 }
}`;

async function harness(t,enabled=true,source=SOURCE,options={}) {
 const classpath=compile(t,'ArrayRows',source);
 const j=new JVM({classpath,wasmHeap:true,wasmHeapMb:4,jit:{enabled:false,compileWorker:false,
   retainCompilerDiagnostics:false,wasm:{structured:true,deepInline:false,
     canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true,
     sharedFieldArrayCaches:options.shared===true}}});
 await j.loadClassByName('ArrayRows');j._markClassInitialized('ArrayRows');
 const w=j.jit.wasmJit;w.importStatsEnabled=true;
 const method=j.findMethod(j.classes.ArrayRows,'paint',options.descriptor||'(IIIIII)I');
 const state=w.methodState({method}),originalPrepare=loops.prepare,originalEmit=loops.emit,
   originalPoll=Compiler.prototype.emitFuelCheck,planRefs=[],headerTests=new Set();
 Compiler.prototype.emitFuelCheck=function(header,out){
   const index=this.addImport('test_poll_'+header,[],[],()=>{},true);
   out.push(OP.call,...uleb(index));return originalPoll.call(this,header,out);
 };
 loops.prepare=(c,s)=>{
   const plans=enabled?originalPrepare(c,s):new Map();
   for(const plan of plans.values()){
     planRefs.push(new WeakRef(plan));headerTests.add(c.fn.blocks[plan.header].term.insnOp);
   }
   return plans;
 };
 if(options.exhaustBudget)loops.emit=(c,node,header,...rest)=>{
   if(!c.guardedNestedArrayLoopPlans?.has(header))return originalEmit(c,node,header,...rest);
   const before=c.guardedNestedArrayLoopBytes;c.guardedNestedArrayLoopBytes=8192;
   try{return originalEmit(c,node,header,...rest);}
   finally{c.guardedNestedArrayLoopBytes=before;}
 };
 try{w.compile({method,className:'ArrayRows'},state,{asCallee:true});}
 finally{loops.prepare=originalPrepare;loops.emit=originalEmit;Compiler.prototype.emitFuelCheck=originalPoll;}
 t.equal(state.status,'ready',state.lastCompileError||'row method installs Wasm');
 const array=values=>{const a=j.wasmHeap.alloc('[I',values.length);a.type='[I';a.set(values);return a;};
 const run=(data,args,fuel=100000000)=>{
   j.classes.ArrayRows.staticFields.set('data:[I',data);
   const frame=new Frame(method);frame.className='ArrayRows';state.meta.box.frame=frame;
   let status,error;
   try{status=state.run(...args,0,fuel);}
   catch(e){error={type:e.type,name:e.name,message:e.message};}
   finally{state.meta.box.frame=null;}
   return {status,error,value:state.meta.box.ret,data:data&&Array.from(data),
     locals:frame.locals,stack:frame.stack.items,pc:frame.pc};
 };
 return {j,w,state,method,array,run,planRefs,headerTests};
}

const CONDITIONAL=`public class ArrayRows {
 static int[] data;
 public static int paint(int[] dest,int[] source,int src,int dst,int width,int height,int srcSkip,int dstSkip) {
   int pixel=0,prior=0,column=0;
   for(int row=-height;row<0;row++) {
     column=-width;
     while(true) {
       if(column<0) {
         pixel=source[src++];
         if(pixel!=0){prior=dst++;dest[prior]=(dest[prior]+pixel)^0x123456;column++;}
         else {dst++;column++;}
       } else break;
     }
     src+=srcSkip;dst+=dstSkip;
   }
   return src+dst+pixel+prior+column;
 }
}`;
const parameterOptions={descriptor:'([I[IIIIIII)I'};
const normalize=result=>({...result,locals:result.locals.map(v=>
  ArrayBuffer.isView(v)||Array.isArray(v)?Array.from(v):v)});

test('inverted negative-counter branch retains exact completion and continuation',async t=>{
 const source=CONDITIONAL.replace('if(column<0) {','if(column>=0)break; {').replace('} else break;','}');
 const fast=await harness(t,true,source,parameterOptions),base=await harness(t,false,source,parameterOptions);
 t.ok(fast.headerTests.has('iflt'),'actual inverted iflt header is proved');
 const run=(h,fuel)=>{
   const dest=h.array(new Array(192).fill(19)),src=h.array(Array.from({length:192},(_,i)=>i%3?i+1:0));
   return normalize(h.run(dest,[dest,src,0,0,64,3,0,0],fuel));
 };
 t.deepEqual(run(fast,1e8),run(base,1e8),'inverted branch completion matches original');
 t.deepEqual(run(fast,134),run(base,134),'inverted branch fuel boundary matches original');
 t.end();
});

test('conditional parameter loops prove every backedge and execute without repeated polls',async t=>{
 const options=parameterOptions;
 const fast=await harness(t,true,CONDITIONAL,options),base=await harness(t,false,CONDITIONAL,options);
 t.ok(fast.state.meta.guardedNestedArrayLoopCount>0,'inverted condition, multiple latches and parameter arrays are proved');
 const values=Array.from({length:192},(_,i)=>i*101111),src=values.map((v,i)=>i%3?v:0);
 const run=(h,fuel=1e8,length=192,start=0,width=64,height=3,skip=0,plain=false)=>{
   const dest=plain?Object.assign(values.slice(0,length),{type:'[I'}):h.array(values.slice(0,length));
   const source=plain?Object.assign([...src],{type:'[I'}):h.array(src);
   const r=h.run(dest,[dest,source,0,start,width,height,0,skip],fuel);
   return normalize(r);
 };
 t.deepEqual(run(fast),run(base),'all conditional effects and final integer temporaries match');
 const polls=h=>[...h.state.meta.importStats].filter(([name])=>name.startsWith('test_poll_')).reduce((sum,[,n])=>sum+n,0);
 t.equal(polls(base),199,'original polls outer and inner headers');
 t.equal(polls(fast),4,'entry metadata permits all three rows to omit inner polls');
 t.equal([...fast.state.meta.importStats].filter(([name])=>name.startsWith('guarded_loop_')).reduce((sum,[,n])=>sum+n,0),3,'all three parameter rows execute fast code');
 for(const fuel of [1,2,31,33,65,66,67,68,129,130,131,132,133,134,135,136,199,200])
   t.deepEqual(run(fast,fuel),run(base,fuel),'exact conditional partial effects and continuation at fuel '+fuel);
 for(const length of [0,31,64,65,118,128,180])
   t.deepEqual(run(fast,1e8,length),run(base,1e8,length),'destination range refusal preserves partial writes: '+length);
 for(const [start,width,height,skip]of [[-1,64,3,0],[0,31,3,0],[0,0,3,0],[0,-1,3,0],[0,64,0,0],[0,64,-1,0],[1,32,3,1]])
   t.deepEqual(run(fast,1e8,192,start,width,height,skip),run(base,1e8,192,start,width,height,skip),'conditional shape '+[start,width,height,skip]);
 t.deepEqual(run(fast,1e8,192,0,64,3,0,true),run(base,1e8,192,0,64,3,0,true),'plain arrays keep the original path');
 t.end();
});

test('conditional proof refuses an unproved backedge, early exit, internal cycle or field effect',async t=>{
 const variants=[
   CONDITIONAL.replace('else {dst++;column++;}','else {dst++;column+=2;}'),
   CONDITIONAL.replace('else {dst++;column++;}','else {dst+=2;column++;}'),
   CONDITIONAL.replace('else {dst++;column++;}','else {break;}'),
   CONDITIONAL.replace('pixel=source[src++];','pixel=source[src++];while(pixel>7){pixel>>>=1;}'),
   CONDITIONAL.replace('static int[] data;','static int[] data;static int stamp;')
     .replace('pixel=source[src++];','stamp++;pixel=source[src++];'),
 ];
 for(const source of variants) {
   const fast=await harness(t,true,source,parameterOptions),base=await harness(t,false,source,parameterOptions);
   t.equal(fast.state.meta.guardedNestedArrayLoopCount,0,'unsupported body emits no version');
   const run=h=>{
     const dest=h.array(new Array(192).fill(19)),src=h.array(Array.from({length:192},(_,i)=>i%3?i+1:0));
     return normalize(h.run(dest,[dest,src,0,0,64,3,0,0],134));
   };
   t.deepEqual(run(fast),run(base),'refusal preserves exact partial effects and spill state');
 }
 t.end();
});

test('conditional parameter guards preserve source failures, nulls, aliases and metadata captures',async t=>{
 const fast=await harness(t,true,CONDITIONAL,parameterOptions),base=await harness(t,false,CONDITIONAL,parameterOptions);
 const run=(h,length,width=64,height=3,missingDest=false)=>{
   const dest=missingDest?null:h.array(new Array(192).fill(19));
   const src=length===null?null:h.array(Array.from({length},(_,i)=>i%3?i+1:0));
   return normalize(h.run(dest,[dest,src,0,0,width,height,0,0]));
 };
 for(const length of [0,1,31,64,65,118,128,180,null])
   t.deepEqual(run(fast,length),run(base,length),'source fault preserves earlier writes for length '+length);
 t.deepEqual(run(fast,192,64,3,true),run(base,192,64,3,true),'null destination throws at its original conditional access');
 t.deepEqual(run(fast,null,0),run(base,null,0),'unused null source remains legal');
 t.deepEqual(run(fast,192,64,0,true),run(base,192,64,0,true),'unused null destination remains legal');
 const overlap=h=>{
   const backing=h.array(Array.from({length:194},(_,i)=>i%3?i+1:0));
   const dest=backing.subarray(1,193),src=backing.subarray(0,192);
   dest.type=src.type='[I';dest.wasmBase=backing.wasmBase+4;src.wasmBase=backing.wasmBase;
   return {result:normalize(h.run(dest,[dest,src,0,0,64,3,0,0])),backing:[...backing]};
 };
 t.deepEqual(overlap(fast),overlap(base),'overlapping views retain scalar read/write order');
 const captures=h=>{
   const a=h.array(Array.from({length:193},(_,i)=>i%3?i+1:0)),address=a.wasmBase;
   let bases=0,lengths=0;
   Object.defineProperty(a,'wasmBase',{get(){return address+(bases++<2?0:4);}});
   Object.defineProperty(a,'length',{get(){lengths++;return 192;}});
   return {result:normalize(h.run(a,[a,a,0,0,64,3,0,0])),bases,lengths};
 };
 const result=captures(fast);t.deepEqual(result,captures(base),'changing snapshots match original scalar execution');
 t.equal(result.bases,0,'allocator-owned bases do not consult a shadow wasmBase getter');
 t.equal(result.lengths,2,'length getters stay at entry');
 const physical=h=>{
   const dest=h.array(new Array(192).fill(19)),src=h.array(new Array(192).fill(3));
   const heap=h.j.wasmHeap,start=(heap.limit>>2)-81;heap.i32.fill(19,start);
   dest.wasmBase=start*4;
   return {result:normalize(h.run(dest,[dest,src,0,0,64,3,0,0])),tail:[...heap.i32.slice(start)]};
 };
 t.deepEqual(physical(fast),physical(base),'physical range refusal preserves second-row partial writes before a trap');
 t.end();
});

test('conditional parameter proof graphs are collectible after installation',async t=>{
 if(!global.gc){t.pass('requires --expose-gc');t.end();return;}
 const h=await harness(t,true,CONDITIONAL,parameterOptions);
 t.ok(h.planRefs.length,'conditional proof was emitted');
 const alive=()=>h.planRefs.filter(r=>r.deref()).length;
 for(let i=0;i<30;i++){
   await new Promise(resolve=>setImmediate(resolve));global.gc();if(!alive())break;
 }
 t.equal(alive(),0,'installed parameter code retains no proof graph');
 const dest=h.array(new Array(192).fill(19)),src=h.array(new Array(192).fill(3));
 const result=h.run(dest,[dest,src,0,0,64,3,0,0]);
 t.equal(result.status,-1,'installed code still completes after analysis collection');
 t.equal(result.value,578,'collected analysis does not alter the result');
 t.end();
});

test('warmed nested loops execute the guarded version without repeated polls',async t=>{
 const fast=await harness(t),base=await harness(t,false);
 t.equal(fast.state.meta.guardedNestedArrayLoopCount,1,'proof automatically emits one nested loop version');
 t.equal(base.state.meta.guardedNestedArrayLoopCount,0,'test reference retains original scalar loop');
 const values=Array.from({length:192},(_,i)=>(i*101111)|0),args=[0,64,3,0,0x123456,173];
 t.deepEqual(fast.run(fast.array(values),args),base.run(base.array(values),args),'all values and return state match');
 const polls=h=>[...h.state.meta.importStats].filter(([name])=>name.startsWith('test_poll_')).map(([,n])=>n).sort((a,b)=>a-b);
 t.deepEqual(polls(base),[4,195],'reference polls every body iteration and final test');
 t.deepEqual(polls(fast),[4,65],'guarded rows poll only during the first cold row');
 t.equal([...fast.state.meta.importStats].filter(([name])=>name.startsWith('guarded_loop_'))
   .reduce((sum,[,n])=>sum+n,0),2,'diagnostic confirms both warmed rows took the fast version');
 t.end();
});

test('code budget and shared metadata refusal preserve the original checked loop',async t=>{
 for(const options of [{exhaustBudget:true},{shared:true}]){
   const fast=await harness(t,true,SOURCE,options),base=await harness(t,false,SOURCE,options);
   t.equal(fast.state.meta.guardedNestedArrayLoopCount,0,'unavailable proof/budget emits no fast version');
   const values=Array.from({length:128},(_,i)=>i*101111),args=[0,64,3,0,0x123456,173];
   t.deepEqual(fast.run(fast.array(values),args),base.run(base.array(values),args),
     'refusal keeps original partial effects and exception');
 }
 t.end();
});

test('installed guarded loops release their temporary proof graph',async t=>{
 if(!global.gc){t.pass('requires --expose-gc');t.end();return;}
 const h=await harness(t);t.ok(h.planRefs.length,'test observed an actual successful proof');
 const alive=()=>h.planRefs.filter(r=>r.deref()).length;
 for(let i=0;i<30;i++){
   await new Promise(resolve=>setImmediate(resolve));global.gc();if(!alive())break;
 }
 t.equal(alive(),0,'live installed metadata/functions retain no proof graphs');
 const values=Array.from({length:192},(_,i)=>i*101111);
 t.equal(h.run(h.array(values),[0,64,3,0,0x123456,173]).value,192,'collected analysis does not affect execution');
 t.end();
});

test('cached metadata getters and overlapping captures retain scalar ordering',async t=>{
 const fast=await harness(t),base=await harness(t,false),values=Array.from({length:192},(_,i)=>i*101111);
 const run=h=>{
   const a=h.array(values),address=a.wasmBase;let bases=0,lengths=0;
   Object.defineProperty(a,'wasmBase',{get(){return address+(bases++<2?0:4);}});
   Object.defineProperty(a,'length',{get(){lengths++;return values.length;}});
   const result=h.run(a,[0,64,3,0,0x123456,173]);
   return {result,bases,lengths};
 };
 const result=run(fast);t.deepEqual(result,run(base),'changing captures and overlapping stores match original order');
 t.equal(result.bases,0,'owned native field headers bypass a shadow base getter');
 t.equal(result.lengths,0,'owned native field headers supply the allocation length');
 const physical=h=>{
   const a=h.array(values),heap=h.j.wasmHeap,start=(heap.limit>>2)-81;
   heap.i32.set(values.slice(0,81),start);a.wasmBase=start*4;
   return {result:h.run(a,[0,64,3,0,0x123456,173]),tail:[...heap.i32.slice(start)]};
 };
 t.deepEqual(physical(fast),physical(base),'physical refusal retains partial writes in the second row before a trap');
 t.end();
});

test('unproved induction and field effects retain the original loop',async t=>{
 const variants=[SOURCE.replace('left++)','left+=2)'),
   SOURCE.replace('static int[] data;','static int[] data; static int stamp;').replace('value=data[index];','stamp++;value=data[index];')];
 for(const source of variants){
   const fast=await harness(t,true,source),base=await harness(t,false,source);
   t.equal(fast.state.meta.guardedNestedArrayLoopCount,0,'unsupported recurrence/effect emits no guarded version');
   const values=Array.from({length:192},(_,i)=>i*101111),args=[0,64,3,0,0x123456,173];
   t.deepEqual(fast.run(fast.array(values),args,134),base.run(base.array(values),args,134),
     'unsupported shape preserves exact continuation and partial effects');
 }
 t.end();
});

test('nested range/fuel refusal retains exact partial writes and spill state',async t=>{
 const fast=await harness(t),base=await harness(t,false);
 const values=Array.from({length:192},(_,i)=>(i*101111)|0),args=[0,64,3,0,0x123456,173];
 for(const fuel of [1,2,31,33,65,66,67,68,129,130,131,132,133,134,135,136,199,200])
   t.deepEqual(fast.run(fast.array(values),args,fuel),base.run(base.array(values),args,fuel),
     'exact continuation and effects at fuel '+fuel);
 for(const length of [0,31,64,65,118,128,180])
   t.deepEqual(fast.run(fast.array(values.slice(0,length)),args),base.run(base.array(values.slice(0,length)),args),
     'partial writes and bounds exception match for length '+length);
 for(const [width,height,start,skip]of [[0,3,0,0],[-1,3,0,0],[64,0,0,0],[64,-1,0,0],[32,3,1,1],[31,3,0,0],[64,3,-1,0]]){
   const a=[start,width,height,skip,0x123456,173];
   t.deepEqual(fast.run(fast.array(values),a),base.run(base.array(values),a),'shape refusal/acceptance '+[width,height,start,skip]);
 }
 for(const value of [null,Object.assign([...values],{type:'[I'})])
   t.deepEqual(fast.run(value,args),base.run(value&&Object.assign([...values],{type:'[I'}),args),'null/plain fallback matches');
 t.end();
});
