'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const Stack=require('../src/core/stack');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const fixture=makeJavaFixtureCompiler('native-instance-exit-');
const source=`public class NativeExitCaller {
 public static int effects, overrideEffects;
 public static int call(NativeSink receiver,boolean taken,int value){
  effects++;
  return taken ? 100+receiver.accept(value) : 7;
 }
}
class NativeSink {public int accept(int value){return value+1;}}
class GuestSink extends NativeSink {
 public int accept(int value){NativeExitCaller.overrideEffects++;return value+9;}
}`;

for(const asyncNative of [false,true]){
test('native instance exit preserves original dispatch and effects (async='+asyncNative+')',async t=>{
 const classpath=fixture(t,'NativeExitCaller',source);let calls=0,observed,argument;
 const j=new JVM({classpath,jit:{enabled:false,compileWorker:false,wasm:{structured:true,deepInline:false,nativeInstanceExits:true}}});
 const invoke=(j,obj,args)=>{calls++;argument=args[0];observed=j.classes.NativeExitCaller.staticFields.get('effects:I');return args[0]+3;};
 j.jre.NativeSink={super:'java/lang/Object',methods:{'accept(I)I':asyncNative?async(j,obj,args)=>{await Promise.resolve();return invoke(j,obj,args);}:invoke}};
 j.getClassObjectSync('NativeSink');
 await j.loadClassByName('NativeExitCaller');await j.loadClassByName('GuestSink');
 for(const c of ['NativeExitCaller','NativeSink','GuestSink']){j._markClassInitialized(c);j.classes[c].staticFieldsInitialized=true;}
 const fields=j.classes.NativeExitCaller.staticFields;fields.set('effects:I',0);fields.set('overrideEffects:I',0);
 const w=j.jit.wasmJit;w.enabled=true;
 const method=j.findMethod(j.classes.NativeExitCaller,'call','(LNativeSink;ZI)I'),state=w.methodState({method});
 w.compile({method,className:'NativeExitCaller'},state,{asCallee:true});
 t.equal(state.status,'ready','structured module installs');
 t.ok(state.meta.structured&&state.meta.normalFlowFullyCompiled,'guarded invoke has complete normal flow');
 t.ok(state.meta.deoptableCalls>0,'guarded call retains exit metadata');
 t.equal(calls,0,'compilation performs no native effects');
 const thread={id:0,status:'runnable',pendingException:null,callStack:new Stack()};j.threads=[thread];j.currentThreadIndex=0;
 const run=async(receiver,taken)=>{const caller=new Frame(method),frame=new Frame(method);frame.className='NativeExitCaller';frame.locals[0]=receiver;frame.locals[1]=taken?1:0;frame.locals[2]=17;
 thread.callStack.push(caller);thread.callStack.push(frame);const callsBefore=calls;t.ok(w.tryRunFrame(frame,thread).handled,'actual native frame entry');
 t.equal(calls,callsBefore,'guard returns before native effects');
 let ticks=0;while(thread.callStack.size()>1){await j.executeTick();if(++ticks>10000)throw Error('resume limit');}
 const result=caller.stack.pop();thread.callStack.pop();return result;};
 t.equal(await run({type:'NativeSink',fields:{}},false),7,'untaken branch returns normally');
 t.equal(calls,0,'untaken branch performs no native call');
 t.equal(await run({type:'NativeSink',fields:{}},true),120,'original native result and stack under operands survive');
 t.equal(calls,1,'native callback executes exactly once');
 t.equal(argument,17,'original invoke argument is retained');
 t.equal(observed,2,'native callback observes preceding effects exactly once');
 t.equal(await run({type:'GuestSink',fields:{}},true),126,'runtime guest override receives the original call');
 t.equal(calls,1,'guest override does not invoke native parent');
 t.equal(fields.get('overrideEffects:I'),1,'guest override executes once');
 t.equal(fields.get('effects:I'),3,'every caller side effect executes once');
 t.end();
});
}

test('native instance exits remain disabled by default',async t=>{
 const classpath=fixture(t,'NativeExitCaller',source);
 const j=new JVM({classpath,jit:{enabled:false,compileWorker:false,wasm:{structured:true,deepInline:false}}});
 j.jre.NativeSink={super:'java/lang/Object',methods:{'accept(I)I':()=>19}};j.getClassObjectSync('NativeSink');
 await j.loadClassByName('NativeExitCaller');j._markClassInitialized('NativeExitCaller');
 const w=j.jit.wasmJit,method=j.findMethod(j.classes.NativeExitCaller,'call','(LNativeSink;ZI)I'),state=w.methodState({method});w.enabled=true;w.compile({method,className:'NativeExitCaller'},state,{asCallee:true});
 t.equal(w.nativeInstanceExitsEnabled,false,'new policy is opt-in');
 t.notEqual(state.meta?.normalFlowFullyCompiled,true,'default retains original unresolved native-call coverage');
 t.end();
});

test('native handoff retains category-two arguments, references, and every return ABI',async t=>{
 const classpath=fixture(t,'NativeTypeCalls',`public class NativeTypeCalls {
 public static long longCall(NativeValues r){return r.longCall(17L);}
 public static double doubleCall(NativeValues r){return r.doubleCall(3.25);}
 public static float floatCall(NativeValues r){return r.floatCall(1.5f);}
 public static Object refCall(NativeValues r,Object value){return r.refCall(value);}
 public static int voidCall(NativeValues r){r.voidCall(19);return 7;}
 }
 class NativeValues {
 public long longCall(long value){return value;}
 public double doubleCall(double value){return value;}
 public float floatCall(float value){return value;}
 public Object refCall(Object value){return value;}
 public void voidCall(int value){}
 }`);
 const marker={type:'java/lang/Object',fields:{}},cases=[
  ['longCall','(LNativeValues;)J','(J)J',17n,-9223372036854775807n],
  ['doubleCall','(LNativeValues;)D','(D)D',3.25,-1.125],
  ['floatCall','(LNativeValues;)F','(F)F',1.5,Math.fround(-2.75)],
  ['refCall','(LNativeValues;Ljava/lang/Object;)Ljava/lang/Object;','(Ljava/lang/Object;)Ljava/lang/Object;',marker,marker],
  ['voidCall','(LNativeValues;)I','(I)V',19,7],
 ];
 let calls=0,argument;
 const j=new JVM({classpath,jit:{enabled:false,compileWorker:false,wasm:{structured:true,deepInline:false,nativeInstanceExits:true}}});
 j.jre.NativeValues={super:'java/lang/Object',methods:Object.fromEntries(cases.map(([name,d,nativeD,arg,result])=>[name+nativeD,(j,obj,args)=>{calls++;argument=args[0];return name==='voidCall'?undefined:result;}]))};
 j.getClassObjectSync('NativeValues');await j.loadClassByName('NativeTypeCalls');
 for(const c of ['NativeValues','NativeTypeCalls']){j._markClassInitialized(c);j.classes[c].staticFieldsInitialized=true;}
 const w=j.jit.wasmJit;w.enabled=true;
 const thread={id:0,status:'runnable',pendingException:null,callStack:new Stack()};j.threads=[thread];j.currentThreadIndex=0;
 for(const [name,descriptor,nativeD,arg,expected] of cases){
  const method=j.findMethod(j.classes.NativeTypeCalls,name,descriptor),state=w.methodState({method});w.compile({method,className:'NativeTypeCalls'},state,{asCallee:true});
  t.equal(state.status,'ready',name+' compiles');
  t.ok(state.meta.structured&&state.meta.normalFlowFullyCompiled,name+' has guarded complete normal flow');
  const caller=new Frame(method),frame=new Frame(method);frame.className='NativeTypeCalls';frame.locals[0]={type:'NativeValues',fields:{}};if(name==='refCall')frame.locals[1]=marker;
  const before=calls;thread.callStack.push(caller);thread.callStack.push(frame);
  t.ok(w.tryRunFrame(frame,thread).handled,name+' enters native code');
  t.equal(calls,before,name+' guard executes no callback');
  let ticks=0;while(thread.callStack.size()>1){await j.executeTick();if(++ticks>10000)throw Error('resume limit');}
  const result=caller.stack.pop();thread.callStack.pop();
  t.equal(result,expected,name+' original result preserved');
  t.equal(argument,arg,name+' original argument preserved');
  t.equal(calls,before+1,name+' callback executes exactly once');
 }
 t.end();
});
