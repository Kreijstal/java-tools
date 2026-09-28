'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const Stack=require('../src/core/stack');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const fixture=makeJavaFixtureCompiler('prepared-wasm-methods-');

test('prepared Wasm method policy validates and isolates identities',t=>{
 for(const value of [true,'Owner.loop()V',[null],[''],['  ']])
  t.throws(()=>new JVM({jit:{compileWorker:false,preparedWasmMethods:value}}),/nonempty method identities/,'rejects malformed policy');
 const first=new JVM({jit:{compileWorker:false,preparedWasmMethods:['Owner.loop()V']}}).jit;
 const second=new JVM({jit:{compileWorker:false}}).jit;
 const method={className:'Owner',name:'loop',descriptor:'()V'};
 t.ok(first.isPreparedWasmMethodSelected(method),'exact identity selected');
 t.notOk(second.isPreparedWasmMethodSelected(method),'another JVM keeps defaults');
 t.notOk(first.isPreparedWasmMethodSelected({...method,descriptor:'(I)V'}),'overload is independent');
 const late={name:'loop',descriptor:'()V'};
 t.notOk(first.isPreparedWasmMethodSelected(late),'unregistered method has no policy identity');
 late.className='Owner';
 t.ok(first.isPreparedWasmMethodSelected(late),'late registration is not cached as a refusal');
 t.end();
});

for(const mode of ['fresh','ready','js-only']){
 const alreadyReady=mode!=='fresh';
 test(`selected prepared kernel enters primary Wasm (mode=${mode})`,async t=>{
  const classpath=fixture(t,'SelectedKernel',`public class SelectedKernel {
    static void kernel(int[] values) { for(int i=0;i<values.length;i++) values[i] += 3; }
    static void other(int[] values) { for(int i=0;i<values.length;i++) values[i] += 7; }
    public static void call(int[] values) { kernel(values); }
  }`);
  const j=new JVM({classpath,wasmHeap:true,wasmHeapMb:1,prepareBeforeMain:false,jit:{
    compileWorker:false,preferWholeMethodJs:true,wasmStructured:true,structuredSsa:true,
    rendererPipeline:true,compiledCallChains:true,preparedWasmMethods:['SelectedKernel.kernel([I)V']}});
  await j.preloadClasspathClasses();j.classInitializationState.set('SelectedKernel','INITIALIZED');
  const jit=j.jit,w=jit.wasmJit;w.enabled=true;
  const kernel=await j.findMethodInHierarchy('SelectedKernel','kernel','([I)V');
  const other=await j.findMethodInHierarchy('SelectedKernel','other','([I)V');
  const caller=await j.findMethodInHierarchy('SelectedKernel','call','([I)V');
  const state=w.methodState({method:kernel});
  if(alreadyReady)w.compile({method:kernel,className:'SelectedKernel'},state,{asCallee:true});
  t.notOk(jit.hasPreparedFullWasmUpgrade(kernel),'selection waits for preparation');
  const published=[];const publish=jit.publishWasmTargetReady.bind(jit);
  jit.publishWasmTargetReady=method=>{published.push(method);return publish(method);};
  await j.precompileInitializedClasses({effectful:true,wasm:mode!=='js-only',
    fixedPoint:mode!=='js-only',wasmPreparedUpgradesOnly:true,
    wasmFallbackOnly:mode==='fresh'});
  t.equal(state.status,'ready','selected small loop prepared despite oversized-only filter');
  t.ok(jit.hasPreparedFullWasmUpgrade(kernel),'selected complete loop can replace prepared JS');
  t.notOk(jit.hasPreparedFullWasmUpgrade(other),'unlisted loop retains ordinary selection');
  t.ok(published.includes(kernel),'preparation publishes selected ready module');
  const entries=[];const execute=w.execute;
  w.execute=function(frame,...args){if(frame.method===kernel)entries.push({pc:frame.pc,osr:args[4]===true});return execute.call(this,frame,...args);};
  const thread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};
  j.threads=[thread];j.currentThreadIndex=0;
  const out=j.wasmHeap.alloc('[I',4);out.set([1,2,3,4]);
  for(let run=0;run<2;run++){
    const frame=new Frame(caller);frame.className='SelectedKernel';frame.locals[0]=out;
    thread.callStack.push(frame);
    let ticks=0;while(thread.callStack.size()){await j.executeTick();if(++ticks>10000)throw new Error('tick limit');}
  }
  t.deepEqual([...out],[7,8,9,10],'real generated callers preserve exact once-only writes');
  t.equal(entries.length,2,'each call reaches the selected kernel');
  t.ok(entries.every(x=>x.pc===0&&!x.osr),'all calls use the primary entry rather than OSR');
  state.runs=64;state.exits=32;
  t.notOk(jit.hasPreparedFullWasmUpgrade(kernel),'exit-storm protection overrides selection');
  state.runs=0;state.exits=0;state.meta.fullyCompiled=false;
  t.notOk(jit.hasPreparedFullWasmUpgrade(kernel),'partial module is not promoted');
  t.end();
 });
}
