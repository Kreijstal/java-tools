"use strict";
const test=require('tape');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const build=makeJavaFixtureCompiler('wasm-div-wrap-');
test('structured Wasm signed division preserves Java overflow and zero behavior',async t=>{
 const classpath=build(t,'Division','public class Division { public static int ints(int a,int b){return a/b;} public static long longs(long a,long b){return a/b;} }');
 const j=new JVM({classpath,jit:{enabled:false,compileWorker:false,wasm:{structured:true,deepInline:false}}});
 await j.loadClassByName('Division');j.classes.Division.staticFieldsInitialized=true;j._markClassInitialized('Division');
 const w=j.jit.wasmJit;w.enabled=true;
 for(const [name,desc,values]of [
  ['ints','(II)I',[[-2147483648,-1,-2147483648],[-11,-1,11],[11,-1,-11],[9,3,3],[-9,2,-4],[0,-1,0]]],
  ['longs','(JJ)J',[[-9223372036854775808n,-1n,-9223372036854775808n],[-11n,-1n,11n],[11n,-1n,-11n],[9n,3n,3n],[-9n,2n,-4n],[0n,-1n,0n]]]]){
  const method=j.findMethod(j.classes.Division,name,desc),state=w.methodState({method});w.compile({method,className:'Division'},state,{asCallee:true});
  t.equal(state.status,'ready',name+' installs native Wasm');t.ok(state.meta.structured,name+' uses the structured backend');
  const run=(a,b)=>{state.meta.box.frame=new Frame(method);const status=state.run(a,b,0,100000000);t.equal(status,-1,'raw division completes');return state.meta.box.ret;};
  for(const [a,b,expected]of values){const got=run(a,b);t.equal(typeof got==='object'?got.toBigInt():got,expected,name+' exact Java result for '+a+'/'+b);}
  t.throws(()=>run(desc==='(JJ)J'?9n:9,desc==='(JJ)J'?0n:0),e=>e.type==='java/lang/ArithmeticException',name+' zero divisor keeps its guest exception');
 }
 t.end();
});
