'use strict';
const test=require('tape'),fs=require('fs'),os=require('os'),path=require('path');
const {execFileSync}=require('child_process');
const {JVM}=require('../src/core/jvm');
const Compiler=require('../src/jit/StructuredWasmCompiler');
const Frame=require('../src/core/frame'),CallStack=require('../src/core/callStack');
const {newFields,makeObjectRef,writeField,readField}=require('../src/core/objectModel');
const {supportsWasmTryTable}=require('../src/jit/wasmShared');
test('complete normal-flow selection retains canonical exception handling',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wasm-normal-flow-'));
 t.teardown(()=>fs.rmSync(dir,{recursive:true,force:true}));
 execFileSync('javac',['-g','-d',dir,path.resolve(__dirname,'../sources/WasmNormalFlowCalls.java')]);
 const owner='WasmNormalFlowCalls';
 const j=new JVM({classpath:dir,wasmHeap:true,jit:{compileWorker:false,
   wasmStructured:true,wasmSynchronizedInstanceLinks:true,wasmNormalFlowPreparedUpgrades:true}});
 await j.preloadClasspathClasses();
 j.classInitializationState.set(owner,'INITIALIZED');
 const m=await j.findMethodInHierarchy(owner,'mix','(LWasmNormalFlowCalls;[II)I');
 const wasm=j.jit.wasmJit;
 wasm.normalFlowPreparedUpgradesEnabled=false;
 const speculative=new Compiler(j,m,owner,wasm).translateWith(true);
 wasm.normalFlowPreparedUpgradesEnabled=true;
 const plain=new Compiler(j,m,owner,wasm).translateWith(false);
 const selected=new Compiler(j,m,owner,wasm).translateWith(true);
 t.notOk(speculative.normalFlowFullyCompiled,'the control exercises a guard-only inline exit');
 t.ok(plain.normalFlowFullyCompiled,'the non-inlined normal path is complete');
 t.ok(selected.normalFlowFullyCompiled,'speculative inline exits cannot displace complete normal flow');
 t.ok(selected.fullyCompiled,'the unprotected helper has full coverage');
 const helperState=wasm.methodState({method:m});wasm.compile({className:owner,method:m},helperState);
 const protectedMethod=await j.findMethodInHierarchy(owner,'protectedMix','(LWasmNormalFlowCalls;[II)I');
 const state=wasm.methodState({method:protectedMethod});wasm.compile({className:owner,method:protectedMethod},state,{asCallee:true});
 if(!supportsWasmTryTable()){
   // Without try_table every block a handler covers demotes, and a body that
   // is nothing but a try has no compiled block left: the exception-table
   // half of this test needs the EH tier.
   t.notEqual(state.status,'ready','an engine without try_table does not compile the protected caller');
   t.end();return;
 }
 t.equal(state.status,'ready',state.lastCompileError||'the protected caller compiles');
 if(!state.meta){t.end();return;}
 t.notOk(state.meta.fullyCompiled,'an exception table does not become full coverage');
 const object=makeObjectRef(j,owner,newFields(j,owner));writeField(object.fields,owner+'.value',7);
 for(const [samples,expected] of [[new Int32Array([1,1,1,1]),38],[null,-100]]){
   const frame=new Frame(protectedMethod);frame.className=owner;frame.locals[0]=object;frame.locals[1]=samples;frame.locals[2]=4;
   const thread={id:1,status:'runnable',callStack:new CallStack()};thread.callStack.push(frame);
   const result=wasm.execute(frame,thread,state,0);let returned=state.meta.box.ret,steps=0;
   while(!thread.callStack.isEmpty()&&++steps<100){
     const f=thread.callStack.peek(),ins=f.instructions[f.pc++].instruction;
     if((typeof ins==='string'?ins:ins?.op)==='ireturn')returned=f.stack.peek();
     if(ins)await j.executeInstruction(ins,f,thread);
   }
   if(samples)t.ok(result.returned,'normal execution stays inside the compiled body');
   t.ok(thread.callStack.isEmpty(),'the computation/handler completes');
   t.equal(returned,expected,'the result or original handler result is exact');
 }
 const loop=await j.findMethodInHierarchy(owner,'protectedLoop','(LWasmNormalFlowCalls;[II)I');
 const loopState=wasm.methodState({method:loop});wasm.compile({className:owner,method:loop},loopState);
 j.jit.preparedCodegenMethods.add(loop);wasm.enabled=true;
 t.ok(loopState.meta.normalFlowFullyCompiled,'the protected loop has complete normal flow');
 t.notOk(loopState.meta.fullyCompiled,'the protected loop retains its exception table');
 t.ok(j.jit.hasPreparedNormalFlowWasmUpgrade(loop),'prepared frame entry can select this module');
 loopState.runs=64;loopState.exits=64;
 t.notOk(j.jit.hasPreparedNormalFlowWasmUpgrade(loop),'observed call exits retire an unproductive module');
 loopState.runs=0;loopState.exits=0;
 j.jit.codegenCache.set(loop,()=>{throw Error('the prepared JS body must not win this entry');});
 wasm.refusePostMainCompiles=true;j.jit.markMainStarted();j.guestStarted=true;
 for(const [samples,expected,calls] of [[new Int32Array([1,1,1,1]),38,4],[null,-100,1]]){
   const beforeCalls=readField(object.fields,owner+'.calls');
   const frame=new Frame(loop);frame.className=owner;
   frame.locals[0]=object;frame.locals[1]=samples;frame.locals[2]=4;
   const thread={id:1,status:'runnable',callStack:new CallStack()};thread.callStack.push(frame);
   const beforeRuns=loopState.runs;const result=j.jit.tryRunFrame(frame,thread);
   t.equal(loopState.runs,beforeRuns+1,'normal tier selection reaches the prepared EH module');
   if(samples)t.ok(result.handled,'normal execution completes through the selected module');
   let returned=loopState.meta.box.ret,steps=0;
   while(!thread.callStack.isEmpty()&&++steps<100){
     const f=thread.callStack.peek(),ins=f.instructions[f.pc++].instruction;
     if((typeof ins==='string'?ins:ins?.op)==='ireturn')returned=f.stack.peek();
     if(ins)await j.executeInstruction(ins,f,thread);
   }
   t.equal(returned,expected,'selected-module return/handler value is exact');
   t.equal(readField(object.fields,owner+'.calls')-beforeCalls,calls,'a throwing call is not replayed');
 }
 t.equal(j.jit.postMainSyncCompileCount,0,'selection and exception continuation never compile');
 wasm.normalFlowPreparedUpgradesEnabled=false;
 t.notOk(j.jit.hasPreparedNormalFlowWasmUpgrade(loop),'the normal-flow selection remains opt-in');
 const filtered = new JVM({classpath:dir, jit:{compileWorker:false, wasmCompileClasses:[]}});
 await filtered.preloadClasspathClasses();
 const excluded = await filtered.findMethodInHierarchy(owner,'mix','(LWasmNormalFlowCalls;[II)I');
 const fw = filtered.jit.wasmJit;
 const excludedFrame = {className:owner,method:excluded};
 t.equal(fw.prepare(excludedFrame),null,'an excluded class is not prepared for Wasm');
 const excludedState=fw.methodState(excludedFrame);
 fw.compile(excludedFrame,excludedState,{asCallee:true});
 t.equal(excludedState.failReason,'class-filter','callee compilation respects the filter');
 t.ok(filtered.jit.getGeneratedFunction(excluded),'excluded methods retain JavaScript codegen');
 t.equal(wasm.compileClassFilter,null,'default compilation is unrestricted');
 t.throws(()=>new JVM({jit:{wasmCompileClasses:'bad'}}),/wasmCompileClasses/);
 t.end();
});
