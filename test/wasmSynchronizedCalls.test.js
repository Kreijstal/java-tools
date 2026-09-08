'use strict';
const test=require('tape');
const fs=require('fs'),os=require('os'),path=require('path');
const {execFileSync}=require('child_process');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const CallStack=require('../src/core/callStack');
const {newFields,makeObjectRef}=require('../src/core/objectModel');
const {supportsWasmTryTable}=require('../src/jit/wasmShared');

test('compiled synchronized instance calls preserve monitor ownership',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wasm-sync-calls-'));
 t.teardown(()=>fs.rmSync(dir,{recursive:true,force:true}));
 execFileSync('javac',['-g','-d',dir,path.resolve(__dirname,'../sources/WasmSynchronizedCalls.java')]);
 const owner='WasmSynchronizedCalls';
 const j=new JVM({classpath:dir,wasmHeap:true,jit:{compileWorker:false,
   wasmStructured:true,wasmSynchronizedInstanceLinks:true}});
 await j.preloadClasspathClasses();
 await j.loadClassByName('java/lang/System');
 j.classInitializationState.set('java/lang/System','INITIALIZED');
 j.classInitializationState.set(owner,'INITIALIZED');
 const wasm=j.jit.wasmJit;
 const object=makeObjectRef(j,owner,newFields(j,owner));
 let value=0,maxDepth=0;
 Object.defineProperty(object.fields,owner+'.value',{configurable:true,
   get(){t.ok(object.isLocked && object.lockOwner===7,'guest field read holds its monitor');
     maxDepth=Math.max(maxDepth,object.lockCount);return value;},
   set(v){t.ok(object.isLocked && object.lockOwner===7,'guest field write holds its monitor');value=v;}});
 const compile=async(name,desc)=>{
   const method=await j.findMethodInHierarchy(owner,name,desc),state=wasm.methodState({method});
   wasm.compile({className:owner,method},state,{asCallee:true});
   t.equal(state.status,'ready',name+' compiles');
   return {method,state};
 };
 const invoke=(compiled,args)=>{
   const frame=new Frame(compiled.method);frame.className=owner;
   args.forEach((v,i)=>frame.locals[i]=v);
   const thread={id:7,status:'runnable',callStack:new CallStack()};thread.callStack.push(frame);
   const result=wasm.execute(frame,thread,compiled.state,0);
   return {frame,thread,result,value:compiled.state.meta.box.ret};
 };
 const drive=await compile('drive','(LWasmSynchronizedCalls;I)I');
 t.equal(drive.state.meta.fullyCompiled,true,'the caller no longer demotes its synchronized call');
 t.equal(drive.state.meta.directLinks,0,'the synchronized call cannot bypass the monitor via raw linking');
 const first=invoke(drive,[object,4]);
 t.equal(first.result.returned,true,'the compiled caller finishes without deoptimizing');
 t.equal(first.value,10,'all four updates and returns are exact');
 t.equal(object.isLocked,false,'normal return releases the monitor');
 t.equal(object.lockCount,0,'normal return releases every acquisition');
 t.equal(wasm.activeThread,null,'the ambient compiled thread is restored');
 const other=makeObjectRef(j,owner,newFields(j,owner));
 t.equal(invoke(drive,[other,2]).value,3,'a reused scratch frame acquires a different receiver');
 t.equal(other.isLocked,false,'the second receiver is released');
 t.equal(wasm.findReadyInstance(owner,'bump','(I)I'),null,
   'callers without the monitor protocol still cannot link synchronized methods');

 object.isLocked=true;object.lockOwner=99;object.lockCount=1;
 const before=value;
 const blocked=invoke(drive,[object,1]);
 t.notEqual(blocked.result.returned,true,'a contended call does not execute');
 t.equal(blocked.thread.status,'BLOCKED','the calling thread blocks on contention');
 t.equal(value,before,'the contended call has no guest effects');
 const child=blocked.thread.callStack.peek();
 t.equal(child.method.name,'bump','the pending callee is materialized');
 t.equal(child.locals[0],object,'the receiver survives contention');
 t.equal(child.locals[1],1,'the argument survives contention');
 t.equal(child.pc,0,'the blocked callee resumes before its first effect');
 object.isLocked=false;object.lockOwner=null;object.lockCount=0;
 blocked.thread.status='runnable';
 const childState=wasm.state.get(child.method);
 t.equal(wasm.execute(child,blocked.thread,childState,0).returned,true,
   'the same callee resumes after the owner releases the lock');
 t.equal(value,before+1,'the resumed update happens once');
 t.equal(object.isLocked,false,'the resumed return releases its lock');

 const recursive=await compile('recursive','(LWasmSynchronizedCalls;I)I');
 t.equal(invoke(recursive,[object,3]).value,value+3,'recursive synchronized calls return exactly');
 t.equal(maxDepth,4,'recursive calls acquire the same monitor reentrantly');
 t.equal(object.lockCount,0,'recursive return releases every nested acquisition');

 const failing=await compile('failing','(LWasmSynchronizedCalls;[I)I');
 let thrown;try{invoke(failing,[object,null]);}catch(e){thrown=e;}
 t.equal(thrown?.type,'java/lang/NullPointerException','an uncaught exception propagates');
 t.equal(object.isLocked,false,'an uncaught exception releases the monitor');

 // A callee whose body is one try block needs the EH tier; without try_table
 // every covered block demotes and nothing is left to compile.
 if(supportsWasmTryTable()){
   const catching=await compile('catching','(LWasmSynchronizedCalls;[I)I');
   const handled=invoke(catching,[object,null]);
   t.equal(handled.thread.callStack.peek().method.name,'caught','the handler retains the callee frame');
   t.equal(object.isLocked,true,'the monitor is retained through a caught exception');
   handled.thread.callStack.pop();
   t.equal(object.isLocked,false,'retiring the handler frame releases the monitor');
 }else{
   t.comment('engine without try_table: the caught-exception callee is skipped');
 }

 const parking=await compile('parking','(LWasmSynchronizedCalls;I)I');
 const saved=value;
 const parked=invoke(parking,[object,3]);
 t.equal(parked.thread.callStack.peek().method.name,'park','a partial exit materializes its synchronized callee');
 t.equal(object.isLocked,true,'the partial continuation retains ownership');
 t.equal(object.lockOwner,7,'the continuation retains the correct owner');
 const continuation=parked.thread.callStack.peek();
 t.ok(value===saved || value===saved+3,'the guarded block has not duplicated its effect');
 let steps=0;
 while(parked.thread.callStack.peek()===continuation && ++steps<30){
   const ins=continuation.instructions[continuation.pc++].instruction;
   if(ins)await j.executeInstruction(ins,continuation,parked.thread);
 }
 t.equal(value,saved+4,'interpreter continuation completes each effect once');
 t.equal(object.isLocked,false,'the interpreter return releases the retained monitor');
 const sum=await compile('sum','(I)I');
 wasm.enabled=true;
 j.jit.preparedCodegenMethods.add(sum.method);
 t.notOk(j.jit.isOversizedLoopMethod(sum.method),'the prepared loop is below the size threshold');
 t.ok(j.jit.hasPreparedFullWasmUpgrade(sum.method),'a complete prepared synchronized loop is reachable');
 wasm.synchronizedInstanceLinksEnabled=false;
 t.notOk(j.jit.hasPreparedFullWasmUpgrade(sum.method),'the new selection remains opt-in');
 wasm.synchronizedInstanceLinksEnabled=true;
 sum.state.meta.fullyCompiled=false;
 t.notOk(j.jit.hasPreparedFullWasmUpgrade(sum.method),'a partial synchronized loop does not take over');
 sum.state.meta.fullyCompiled=true;
 const selected=new Frame(sum.method);selected.className=owner;
 selected.locals[0]=object;selected.locals[1]=5;
 const selectedThread={id:7,status:'runnable',callStack:new CallStack()};
 selectedThread.callStack.push(selected);
 j.jit.codegenCache.set(sum.method,()=>{throw new Error('prepared JS must not beat complete synchronized Wasm');});
 const selectedResult=j.jit.tryRunFrame(selected,selectedThread);
 t.ok(selectedResult.handled,'the normal tier selector executes the prepared Wasm loop');
 t.equal(sum.state.runs,1,'selection reaches Wasm without a new compilation');
 t.equal(sum.state.meta.box.ret,value+10,'the selected loop returns the exact result');
 t.equal(object.isLocked,false,'selected frame return releases the monitor');
 t.end();
});
