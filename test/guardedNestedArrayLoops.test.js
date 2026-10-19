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
 const method=j.findMethod(j.classes.ArrayRows,'paint','(IIIIII)I');
 const state=w.methodState({method}),originalPrepare=loops.prepare,originalEmit=loops.emit,
   originalPoll=Compiler.prototype.emitFuelCheck,planRefs=[];
 Compiler.prototype.emitFuelCheck=function(header,out){
   const index=this.addImport('test_poll_'+header,[],[],()=>{},true);
   out.push(OP.call,...uleb(index));return originalPoll.call(this,header,out);
 };
 loops.prepare=(c,s)=>{
   const plans=enabled?originalPrepare(c,s):new Map();
   for(const plan of plans.values())planRefs.push(new WeakRef(plan));
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
 return {j,w,state,method,array,run,planRefs};
}

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
 t.equal(result.bases,4,'both base snapshots happen only during the first row');
 t.equal(result.lengths,2,'metadata length getters are not repeated or moved');
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
