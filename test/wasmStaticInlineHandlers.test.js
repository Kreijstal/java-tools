'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame'),Stack=require('../src/core/stack');
const {inlineCalls}=require('../src/jit/wasmInline');
const fixture=require('./javaFixture').makeJavaFixtureCompiler('static-inline-handler-');

for(const heap of [false,true])for(const warm of [false,true])
test(`static inlining retains meaningful callee handlers (heap=${heap}, warm=${warm})`,async t=>{
 const classpath=fixture(t,'StaticCatchDrive',`public class StaticCatchDrive {
  static int entry(int[] values){return StaticCatchTarget.read(values);}
  static int caught(int[] values){try{return entry(values);}catch(NullPointerException e){return 77;}}
 }
 class StaticCatchTarget {
  static int calls;
  static int read(int[] values){try{calls++;return values[0];}catch(ArrayIndexOutOfBoundsException e){return 55;}}
 }`);
 const j=new JVM({classpath,wasmHeap:heap,wasmHeapMb:1,prepareBeforeMain:false,
  jit:{codegen:false,compileWorker:false,wasm:{structured:true,canonicalDirectCalls:true,
   canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j._markClassInitialized('StaticCatchDrive');
 if(warm)j._markClassInitialized('StaticCatchTarget');
 const w=j.jit.wasmJit;w.enabled=true;
 const prepare=(owner,name,descriptor)=>{
  const method=j.findMethod(j.classes[owner],name,descriptor),state=w.methodState({method});
  w.compile({method,className:owner},state,{asCallee:true});
  t.equal(state.status,'ready',state.lastCompileError||owner+'.'+name+' compiles');return state;
 };
 prepare('StaticCatchTarget','read','([I)I');
 const entry=prepare('StaticCatchDrive','entry','([I)I'),caught=prepare('StaticCatchDrive','caught','([I)I');
 t.equal(inlineCalls(j,entry.method.attributes.find(a=>a.type==='code')),null,'handler-bearing helper is never spliced');
 t.equal(entry.meta.inlinedCalls,0,'installed caller preserves the invocation');
 const thread={id:0,status:'runnable',callStack:new Stack()};j.threads=[thread];j.currentThreadIndex=0;
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 const array=values=>{if(!heap)return Object.assign([...values],{type:'[I'});
  const a=j.wasmHeap.alloc('[I',values.length);a.type='[I';a.set(values);return a;};
 const invoke=async(state,value)=>{
  const frame=new Frame(state.method),carrier=new Frame(state.method);frame.className='StaticCatchDrive';frame.locals[0]=value;
  thread.callStack.push(carrier);thread.callStack.push(frame);const immediate=w.runNested(frame,thread);
  if(immediate?.returned){thread.callStack.pop();return immediate.value;}
  let ticks=0;while(thread.callStack.size()>1){await j.executeTick();if(++ticks>100000)throw Error('static handler continuation limit');}
  thread.callStack.pop();return carrier.stack.pop();
 };
 t.equal(await invoke(entry,array([])),55,'bounds fault reaches the callee catch');
 t.equal(await invoke(entry,array([19])),19,'normal return remains exact');
 t.equal(await invoke(caught,null),77,'uncaught callee fault reaches the caller catch');
 t.equal(j.classes.StaticCatchTarget.staticFields.get('calls:I'),3,'each call keeps its preceding write exactly once');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'fault continuations never compile');
 t.end();
});
