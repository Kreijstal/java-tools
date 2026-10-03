'use strict';
const test=require('tape');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const CallStack=require('../src/core/callStack');
const WasmLinker=require('../src/jit/WasmLinker');
const {supportsWasmTryTable}=require('../src/jit/wasmShared');
const fixture=makeJavaFixtureCompiler('wasm-static-monitors-');

test('structured static links preserve class monitors across return, contention and exceptions',async t=>{
 const owner='StaticMonitor',classpath=fixture(t,owner,`public class StaticMonitor {
  static int value;
  static synchronized int bump(int n) {System.currentTimeMillis();value+=n;return value;}
  static synchronized int recurse(int n) {System.currentTimeMillis();return n==0?value:recurse(n-1)+1;}
  static synchronized int fail(int[] data) {System.currentTimeMillis();return data[0];}
  static synchronized int caught(int[] data) {
    try {System.currentTimeMillis();return data[0];}
    catch(NullPointerException e){System.gc();return value;}
  }
  static synchronized int park(int n) {value+=n;if(n>0)System.gc();value++;return value;}
  static int drive(int n) {int total=0;for(int i=0;i<n;i++)total+=bump(1);return total;}
  static int recursive(int n) {return recurse(n);}
  static int failing(int[] data) {return fail(data);}
  static int catching(int[] data) {return caught(data);}
  static int parking(int n) {return park(n);}
 }
 class StaticMonitorCold {
   static int initialized=9;
   static synchronized int answer() {return 5;}
 }`);
 const j=new JVM({classpath,jit:{compileWorker:false,wasmStructured:true,wasmSynchronizedStaticLinks:true}});
 await j.preloadClasspathClasses();await j.loadClassByName('java/lang/System');
 j.classInitializationState.set(owner,'INITIALIZED');j.classInitializationState.set('java/lang/System','INITIALIZED');
 const wasm=j.jit.wasmJit,monitor=j.getClassObjectSync(owner),fields=j.classes[owner].staticFields;
 fields.set('value:I',0);let depth=0;
 j.clock.millis=()=>{t.ok(monitor.isLocked&&monitor.lockOwner===7,'native clock observes the class monitor');depth=Math.max(depth,monitor.lockCount);return 123;};
 const compile=async(name,descriptor)=>{
  const method=await j.findMethodInHierarchy(owner,name,descriptor),state=wasm.methodState({method});
  wasm.compile({className:owner,method},state,{asCallee:true});
  if(state.status!=='ready')t.comment(state.lastCompileError||'unknown refusal');
  t.equal(state.status,'ready',name+' compiles');return {method,state};
 };
 const invoke=(compiled,args)=>{
  const frame=new Frame(compiled.method);frame.className=owner;args.forEach((v,i)=>frame.locals[i]=v);
  const thread={id:7,status:'runnable',callStack:new CallStack()};thread.callStack.push(frame);
  const result=wasm.execute(frame,thread,compiled.state,0);
  return {frame,thread,result,value:compiled.state.meta.box.ret};
 };
 const drive=await compile('drive','(I)I');
 t.equal(drive.state.meta.normalFlowFullyCompiled,true,'caller stays compiled across synchronized static call');
 t.equal(drive.state.meta.directStaticLinks,0,'raw static link cannot bypass the class monitor');
 t.equal(invoke(drive,[4]).value,10,'repeated synchronized static returns are exact');
 t.equal(monitor.lockCount,0,'normal returns release every acquisition');
 const bump=wasm.findReadyStatic(owner,'bump','(I)I',true,false,true);
 t.ok(bump?.synchronized,'state records implied synchronization');
 t.notOk(WasmLinker.directLinkable(bump,'(I)I'),'linker cannot seal a raw synchronized entry');
 t.equal(wasm.findReadyStatic(owner,'bump','(I)I',true),null,'legacy callers without monitor protocol still refuse');
 t.equal(wasm.staticLinkClassification(owner,'bump','(I)I'),'incompatible','default classification remains conservative');
 monitor.isLocked=true;monitor.lockOwner=99;monitor.lockCount=1;
 const before=fields.get('value:I'),blocked=invoke(drive,[1]),child=blocked.thread.callStack.peek();
 t.equal(blocked.thread.status,'BLOCKED','contending thread blocks');
 t.equal(fields.get('value:I'),before,'contention has no guest effects');
 t.equal(child.method.name,'bump','contention materializes the synchronized child');
 t.equal(child.locals[0],1,'slot zero holds the static argument, not a receiver');
 t.equal(child.pc,0,'contention resumes before first instruction');
 monitor.isLocked=false;monitor.lockOwner=null;monitor.lockCount=0;blocked.thread.status='runnable';
 t.equal(wasm.execute(child,blocked.thread,wasm.state.get(child.method),0).returned,true,'blocked callee resumes');
 t.equal(fields.get('value:I'),before+1,'resumed side effect happens exactly once');
 t.equal(monitor.isLocked,false,'resumed return releases monitor');
 const recurse=await compile('recurse','(I)I');
 if(recurse.state.status!=='ready')t.comment(JSON.stringify(recurse.state.wasmCandidateCoverage));
 const recursive=await compile('recursive','(I)I');
 t.equal(invoke(recursive,[3]).value,fields.get('value:I')+3,'recursive static calls return exactly');
 t.equal(depth,4,'class monitor is acquired reentrantly');
 t.equal(monitor.lockCount,0,'all recursive acquisitions are released');
 const failing=await compile('failing','([I)I');
 t.throws(()=>invoke(failing,[null]),e=>e.type==='java/lang/NullPointerException','uncaught guest exception propagates');
 t.equal(monitor.isLocked,false,'uncaught exception releases class monitor');
 if(supportsWasmTryTable()) {
  const catching=await compile('catching','([I)I'),handled=invoke(catching,[null]);
  t.equal(handled.thread.callStack.peek().method.name,'caught','caught exception retains callee frame');
  t.equal(monitor.isLocked,true,'handler continuation retains class monitor');
  handled.thread.callStack.pop();t.equal(monitor.isLocked,false,'retiring handler releases monitor');
 }
 const parking=await compile('parking','(I)I'),prior=fields.get('value:I'),parked=invoke(parking,[3]);
 const continuation=parked.thread.callStack.peek();
 t.equal(continuation.method.name,'park','unsupported operation retains synchronized child');
 t.equal(monitor.isLocked,true,'partial continuation keeps monitor');
 let steps=0;
 while(parked.thread.callStack.peek()===continuation&&++steps<30){
  const ins=continuation.instructions[continuation.pc++].instruction;
  if(ins)await j.executeInstruction(ins,continuation,parked.thread);
 }
 t.equal(fields.get('value:I'),prior+4,'partial continuation completes effects once');
 t.equal(monitor.isLocked,false,'interpreted continuation releases monitor');
 const coldMethod=await j.findMethodInHierarchy('StaticMonitorCold','answer','()I');
 const coldState=wasm.methodState({method:coldMethod});
 wasm.compile({className:'StaticMonitorCold',method:coldMethod},coldState,{asCallee:true});
 t.equal(coldState.status,'ready','cold artifact may be prepared without executing its initializer');
 t.equal(wasm.findReadyStatic('StaticMonitorCold','answer','()I',true,false,true),null,
   'a prepared synchronized callee cannot bypass class initialization');
 j.classInitializationState.set('StaticMonitorCold','INITIALIZED');
 t.equal(wasm.findReadyStatic('StaticMonitorCold','answer','()I',true,false,true),coldState,
   'the same artifact becomes linkable after initialization');
 wasm.synchronizedStaticLinksEnabled=false;
 t.equal(wasm.findReadyStatic(owner,'bump','(I)I',true,false,true),null,'feature remains opt-in');
 const expanded=require('../src/jit/wasmInline').inlineCalls(j,
   drive.method.attributes.find(a=>a.type==='code'),{callerClassName:owner,callerIsStatic:true});
 t.notOk(expanded?.inlined,'synchronized static body is never silently inlined');
 t.end();
});
