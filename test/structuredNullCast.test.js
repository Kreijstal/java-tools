'use strict';
const test=require('tape');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const {JVM}=require('../src/core/jvm');
const {getOp,takeWasmReturnValue}=require('../src/jit/wasmShared');
const Frame=require('../src/core/frame');
const build=makeJavaFixtureCompiler('structured-null-cast-');
test('literal-null casts lower without enabling general cast compilation',async t=>{
 const classpath=build(t,'NullCast',`public class NullCast {
   public static Object saved;
   public static int loop(int[] a,int n){
     String text=(String)(Object)null;
     saved=text;
     for(int i=0;i<n;i++)a[i]+=3;
     return n;
   }
   public static String cast(){return (String)(Object)null;}
   public static Object call(){return cast();}
   public static String arbitrary(Object x){return (String)x;}
   public static int isNull(){return ((Object)null) instanceof String ? 1 : 0;}
 }`);
 const j=new JVM({classpath,jit:{enabled:false,compileWorker:false,wasm:{structured:true,deepInline:false,checkcast:false}}});
 await j.loadClassByName('NullCast');j.classes.NullCast.staticFieldsInitialized=true;j._markClassInitialized('NullCast');
 const w=j.jit.wasmJit;w.enabled=true;w.importStatsEnabled=true;
 for(const [name,desc]of [['cast','()Ljava/lang/String;'],['isNull','()I']]){
  const method=j.findMethod(j.classes.NullCast,name,desc),items=method.attributes.find(a=>a.type==='code').code.codeItems;
  t.ok(items.some(it=>['checkcast','instanceof'].includes(getOp(it.instruction))),'fixture actually contains a cast: '+name);
  const state=w.methodState({method});w.compile({method,className:'NullCast'},state,{asCallee:true});
  t.equal(state.status,'ready','native '+name+' installs');t.ok(state.meta.structured&&state.meta.normalFlowFullyCompiled,'no cast demotion for '+name);
  state.meta.box.frame=new Frame(method);t.equal(state.run(0,1000000),-1,'native cast returns');
  t.equal(takeWasmReturnValue(state.meta),name==='cast'?null:0,'exact null cast or zero instanceof result');
  t.notOk([...state.meta.importStats?.keys()||[]].some(k=>/^cast_|^isof_/.test(k)),'no type-check import is needed');
 }

 const loop=j.findMethod(j.classes.NullCast,'loop','([II)I'),ls=w.methodState({method:loop});
 w.compile({method:loop,className:'NullCast'},ls,{asCallee:true});
 t.ok(ls.status==='ready'&&ls.meta.structured&&ls.meta.normalFlowFullyCompiled,'cast-containing loop compiles fully');
 const values=new Int32Array([1,2,3]);ls.meta.box.frame=new Frame(loop);
 t.equal(ls.run(values,3,0,1000000),-1,'the full loop returns natively');
 t.deepEqual([...values],[4,5,6],'every original array write runs once');
 t.equal(takeWasmReturnValue(ls.meta),3,'exact loop result');
 t.equal(j.classes.NullCast.staticFields.get('saved:Ljava/lang/Object;'),null,'cast result stores the original null');
 const original=j.findMethod(j.classes.NullCast,'cast','()Ljava/lang/String;');
 const absent={...original,name:'castAbsent',attributes:structuredClone(original.attributes)};
 const instruction=absent.attributes.find(a=>a.type==='code').code.codeItems.find(it=>getOp(it.instruction)==='checkcast').instruction;
 instruction.arg='NeverLoadedTarget';
 const absentState=w.methodState({method:absent});
 w.compile({method:absent,className:'NullCast'},absentState,{asCallee:true});
 t.equal(absentState.status,'ready','literal null needs no target class resolution');
 absentState.meta.box.frame=new Frame(absent);
 t.equal(absentState.run(0,1000000),-1,'cast to an unloaded target completes');
 t.equal(takeWasmReturnValue(absentState.meta),null,'unloaded target still receives null');
 t.notOk(j.classes.NeverLoadedTarget,'target class was not loaded or initialized');

 const call=j.findMethod(j.classes.NullCast,'call','()Ljava/lang/Object;'),cs=w.methodState({method:call});
 w.compile({method:call,className:'NullCast'},cs,{asCallee:true});
 t.ok(cs.status==='ready'&&cs.meta.normalFlowFullyCompiled,'newly compiled null-returning callee remains linkable');
 cs.meta.box.frame=new Frame(call);
 t.equal(cs.run(0,1000000),-1,'real Wasm caller invokes the null-returning cast');
 t.equal(takeWasmReturnValue(cs.meta),null,'the nested call preserves null exactly');
 const method=j.findMethod(j.classes.NullCast,'arbitrary','(Ljava/lang/Object;)Ljava/lang/String;'),state=w.methodState({method});
 w.compile({method,className:'NullCast'},state,{asCallee:true});
 t.ok(state.status!=='ready'||!state.meta.normalFlowFullyCompiled,'an arbitrary reference retains the original admission guard');
 t.notOk(w.checkcastEnabled,'general checkcast remains disabled');
 t.end();
});
