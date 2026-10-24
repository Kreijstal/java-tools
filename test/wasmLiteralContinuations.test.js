'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const Stack=require('../src/core/stack');
const {supportsWasmJsTag}=require('../src/jit/wasmShared');
const fixture=require('./javaFixture').makeJavaFixtureCompiler('wasm-literals-');

test('literal continuations preserve phi edges, numeric bits and spill state',async t=>{
 if(!supportsWasmJsTag()){t.pass('engine retains supported fallback');t.end();return;}
 const classpath=fixture(t,'LiteralProof',`public class LiteralProof {
  static int effects;
  static int branch(boolean b){int x;if(b)x=1234567;else x=-2147483648;return x^73;}
  static long wide(boolean b){long x;if(b)x=9007199254740993L;else x=-9223372036854775808L;return x^15L;}
  static float single(boolean b){return b?-0.0f:1.234567f;}
  static double real(boolean b){return b?-0.0:1.23456789012345;}
  static double notNumber(){return Double.NaN;}
  static int loop(int n){int x=7;for(int i=0;i<n;i++){effects++;x+=1234567;}return x;}
  static int caught(int divisor){int saved=1234567;try{effects++;return saved/divisor;}
    catch(ArithmeticException e){return saved^305419896;}}
 }`);
 const j=new JVM({classpath,wasmHeap:true,jit:{codegen:false,compileWorker:false,
  wasm:{structured:true,maxInlineCalleeItems:1,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j._markClassInitialized('LiteralProof');
 const w=j.jit.wasmJit;w.enabled=true;
 const prepare=(name,desc)=>{
  const method=j.findMethod(j.classes.LiteralProof,name,desc),state=w.methodState({method});
  w.compile({method,className:'LiteralProof'},state,{asCallee:true});
  t.equal(state.status,'ready',state.lastCompileError||name+' compiles');return state;
 };
 const branch=prepare('branch','(Z)I'),wide=prepare('wide','(Z)J');
 const single=prepare('single','(Z)F'),real=prepare('real','(Z)D'),nan=prepare('notNumber','()D');
 const loop=prepare('loop','(I)I'),caught=prepare('caught','(I)I');
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 const value=(state,...args)=>{const result=state.meta.canonicalRun(...args);t.equal(result[0],-1,'native return succeeds');return result[3];};
 t.equal(value(branch,1),1234567^73,'positive constant crosses phi edge');
 t.equal(value(branch,0),-2147483648^73,'minimum integer crosses phi edge');
 t.equal(value(wide,1),9007199254740993n^15n,'long constant retains bits above double precision');
 t.equal(value(wide,0),-9223372036854775808n^15n,'minimum long retains its sign');
 t.ok(Object.is(value(single,1),-0),'float negative zero is preserved');
 t.equal(value(single,0),Math.fround(1.234567),'float is rounded exactly once');
 t.ok(Object.is(value(real,1),-0),'double negative zero is preserved');
 t.equal(value(real,0),1.23456789012345,'double payload is preserved');
 t.ok(Number.isNaN(value(nan)),'NaN remains NaN');
 const fields=j.classes.LiteralProof.staticFields;fields.set('effects:I',0);
 const invoke=async(state,argument,fuel)=>{
  const frame=new Frame(state.method),carrier=new Frame(state.method);frame.className='LiteralProof';frame.locals[0]=argument;
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(carrier);thread.callStack.push(frame);
  j.threads=[thread];j.currentThreadIndex=0;
  const original=state.run;
  if(fuel!==undefined)state.run=(...args)=>{args[args.length-1]=fuel;return original(...args);};
  try{w.execute(frame,thread,state,0);}finally{state.run=original;}
  let ticks=0;while(thread.callStack.size()>1){await j.executeTick();if(++ticks>100000)throw Error('literal spill resume limit');}
  return carrier.stack.pop();
 };
 t.equal(await invoke(loop,6,1),7+6*1234567,'fuel spill reconstructs literals and loop phis');
 t.equal(fields.get('effects:I'),6,'fuel spill never replays effects');
 t.equal(await invoke(caught,0),1234567^305419896,'handler sees the original constant local');
 t.equal(fields.get('effects:I'),7,'caught throw executes preceding effect once');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'all continuations are compilation-free');
 t.end();
});
