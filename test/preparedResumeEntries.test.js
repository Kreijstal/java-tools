'use strict';
const test=require('tape'),fs=require('fs'),os=require('os'),path=require('path');
const {execFileSync}=require('child_process');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame'),CallStack=require('../src/core/callStack');
test('pre-main preparation retains verified loop entries across repeated yields',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prepared-resume-'));
 t.teardown(()=>fs.rmSync(dir,{recursive:true,force:true}));
 execFileSync('javac',['-g','-d',dir,path.resolve(__dirname,'../sources/PreparedResumeCalls.java')]);
 const j=new JVM({classpath:dir,jit:{compileWorker:false,compiledCallChains:true,
   structuredSsa:true,preferWholeMethodJs:true,positionalCallSafePointPolling:true,
   ordinaryAdaptiveFramelessPositional:true,ordinaryAdaptiveCallChainSafePointBudget:32,
   structuredLoopSafePointMaxBudget:32}});
 t.teardown(()=>j.jit.compileWorker.dispose());
 await j.preloadClasspathClasses();
 const owner='PreparedResumeCalls';j.classInitializationState.set(owner,'INITIALIZED');
 j.getClassInitializationToken(owner).initialized=true;
 const fields=j.classes[owner].staticFields;fields.set('calls:I',0);fields.set('result:I',0);
 j.jit.resumeDispatchStats=new Map();
 j.jit.effectfulPreparationActive=true;
 for(const item of j.classes[owner].ast.classes[0].items){
   if(item.type!=='method'||item.method.name==='<init>')continue;
   j.jit.getGeneratedFunction(item.method,{allowEffectfulCalls:true,compileLocally:true});
 }
 j.jit.effectfulPreparationActive=false;
 const method=await j.findMethodInHierarchy(owner,'run','(I)V'),fn=j.jit.codegenCache.get(method);
 t.ok(fn?.jvmStructuredResumePcs?.size>0,'prepared code retains structural resume entries');
 t.ok(fn?.jvmStructuredWrapperShape?.ordinaryAdaptiveCanonical,
   'complete verified coverage permits the ordinary compiled call-chain entry');
 const frame=new Frame(method);frame.className=owner;frame.locals[0]=128;
 const thread={id:1,status:'runnable',callStack:new CallStack()};thread.callStack.push(frame);
 j.threads=[thread];j.currentThreadIndex=0;j.jit.wasmJit.enabled=false;
 j.jit.markMainStarted();j.guestStarted=true;
 const generated=j.jit.getGeneratedFunction;
 j.jit.getGeneratedFunction=function(m){return this.codegenCache.get(m)||null;};
 let ticks=0;
 while(!thread.callStack.isEmpty()&&++ticks<10000){
   j._nextEventLoopYieldAt=-1;
   const scheduled={thread,callStack:thread.callStack,schedulerNow:0};
   let r=j._tryExecuteSynchronousJitTick(scheduled);
   if(r?.slow)r=j.executeTick({allowBurst:true},scheduled,r.skipJit);
   if(r&&typeof r.then==='function')await r;
 }
 j.jit.getGeneratedFunction=generated;
 // A synchronous tick may dispatch several times internally. Inspect the
 // actual compiled-entry trace, not just the frame PC between outer ticks.
 const entries=j.jit.resumeDispatchStats.get(`${owner}.run(I)V`)?.entryPc||[];
 let expected=0;
 for(let i=0;i<128;i++)for(let k=0;k<4;k++)
   expected=(expected+((i&1)?-((i-k)*31+7):((i+k)*31+7)))|0;
 t.ok(thread.callStack.isEmpty(),'forced yields still complete the invocation');
 t.ok(entries.some(pc=>fn.jvmStructuredResumePcs.has(pc)),
   'execution actually revisits verified optimized loop entries');
 t.equal(fields.get('calls:I'),512,'yield/resume does not replay or omit call side effects');
 t.equal(fields.get('result:I'),expected,'nested branch-loop result is exact');
 t.equal(j.jit.postMainSyncCompileCount,0,'resuming prepared code does not compile');
 t.end();
});

test('adaptive activation budgets do not enlarge host deadline polling intervals',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prepared-poll-'));
 t.teardown(()=>fs.rmSync(dir,{recursive:true,force:true}));
 execFileSync('javac',['-g','-d',dir,path.resolve(__dirname,'../sources/PreparedResumeCalls.java')]);
 const j=new JVM({classpath:dir,jit:{compileWorker:false,structuredSsa:true,
   preferWholeMethodJs:true,ordinaryAdaptiveFramelessPositional:true,
   adaptiveFramelessBudgetMultiplier:100000,structuredLoopSafePointMaxBudget:32,
   structuredBoundedAdaptivePolling:true}});
 t.teardown(()=>j.jit.compileWorker.dispose());
 await j.preloadClasspathClasses();
 const owner='PreparedResumeCalls';j.classInitializationState.set(owner,'INITIALIZED');
 j.getClassInitializationToken(owner).initialized=true;
 const fields=j.classes[owner].staticFields;fields.set('calls:I',0);
 const method=await j.findMethodInHierarchy(owner,'countLoops','(I)V');
 j.jit.effectfulPreparationActive=true;
 const fn=j.jit.getGeneratedFunction(method,{allowEffectfulCalls:true,compileLocally:true});
 j.jit.effectfulPreparationActive=false;
 const frame=new Frame(method);frame.className=owner;frame.locals[0]=50000;
 const thread={id:1,status:'runnable',callStack:new CallStack()};
 thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
 j._nextEventLoopYieldAt=0;
 const first=fn.jvmAdaptivePositionalBody(frame,thread,j.jit,false,true);
 t.ok(first?.deopt&&first.transient,'an expired host deadline yields the adaptive body');
 t.equal(first.cooperativeSuspension,true,'compiled scheduler exits carry an explicit suspension outcome');
 t.ok(fields.get('calls:I')<=32,'at most one configured poll interval executes before yielding');
 j._nextEventLoopYieldAt=Date.now()+60000;
 const resumed=fn(frame,thread,j.jit,false);
 t.ok(resumed?.returned,'a fresh deadline allows the same invocation to complete');
 t.equal(fields.get('calls:I'),50000,'polling and resume preserve every loop side effect');
 t.end();
});

test('nested resume traverses enclosing coarse loops without moving the saved PC',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prepared-coarse-'));
 t.teardown(()=>fs.rmSync(dir,{recursive:true,force:true}));
 execFileSync('javac',['-g','-d',dir,path.resolve(__dirname,'../sources/PreparedResumeCalls.java')]);
 const j=new JVM({classpath:dir,jit:{compileWorker:false,structuredSsa:true,
   preferWholeMethodJs:true,ordinaryAdaptiveFramelessPositional:true,
   adaptiveFramelessBudgetMultiplier:100,structuredLoopSafePointMaxBudget:32,
   structuredBoundedAdaptivePolling:true}});
 t.teardown(()=>j.jit.compileWorker.dispose());
 await j.preloadClasspathClasses();
 const owner='PreparedResumeCalls';j.classInitializationState.set(owner,'INITIALIZED');
 j.getClassInitializationToken(owner).initialized=true;
 const method=await j.findMethodInHierarchy(owner,'nestedCoarse','(I)V');
 const fn=j.jit.getGeneratedFunction(method,{allowEffectfulCalls:true,compileLocally:true});
 t.ok(fn.jvmStructuredCoarseCountedLoopCount>0,'fixture exercises coarse loop accounting');
 t.ok(fn.jvmStructuredResumePcs.size>1,'fixture has nested optimized resume entries');
 const frame=new Frame(method);frame.className=owner;frame.locals[0]=4;
 const thread={id:1,status:'runnable',callStack:new CallStack()};
 thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
 let polls=0,entries=0;
 j.jit.continueStructuredQuantum=()=>++polls%2!==0;
 while(!thread.callStack.isEmpty()&&entries++<10000)fn(frame,thread,j.jit,false);
 let expected=0;
 for(let a=0;a<64;a++)for(let b=0;b<4;b++){
   for(let c=0;c<64;c++)expected=(expected+c)|0;
   for(let d=80+(a&3)+b;(d&255)!==0;d--)expected=(Math.imul(expected,31)+d)|0;
 }
 t.ok(polls>2&&entries>1,'forced exits actually re-enter the nested computation');
 t.ok(thread.callStack.isEmpty(),'nested resumption makes forward progress');
 t.equal(j.classes[owner].staticFields.get('result:I'),expected,'all nested arithmetic remains exact');
 t.end();
});
