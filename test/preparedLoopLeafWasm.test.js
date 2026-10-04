'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
test('prepared leaf-loop Wasm selection requires a full ready call-free module',t=>{
 const j=new JVM({jit:{compileWorker:false,preparedLoopLeafWasm:true}}),h=j.jit;
 const leaf={attributes:[{type:'code',code:{codeItems:[{instruction:'iconst_0',labelDef:'L0:'},{instruction:'pop'},{instruction:{op:'goto',arg:'L0'}}]}}]};
 const caller={attributes:[{type:'code',code:{codeItems:[{instruction:{op:'invokestatic',arg:['Method','F',['run','()V']]},labelDef:'L0:'},{instruction:{op:'goto',arg:'L0'}}]}}]};
 const straight={attributes:[{type:'code',code:{codeItems:[{instruction:'return'}]}}]};
 h.hasReadyFullWasmModule=()=>true;h.hasWasmExitStorm=()=>false;
 t.equal(h.hasPreparedLoopLeafWasmUpgrade(leaf),false,'unprepared method is excluded');
 for(const m of [leaf,caller,straight])h.preparedCodegenMethods.add(m);
 t.equal(h.hasPreparedLoopLeafWasmUpgrade(leaf),true,'ready full leaf loop admitted');
 t.equal(h.hasPreparedLoopLeafWasmUpgrade(caller),false,'calls retain existing policy');
 t.equal(h.hasPreparedLoopLeafWasmUpgrade(straight),false,'loop-free method retains existing policy');
 h.hasReadyFullWasmModule=()=>false;
 t.equal(h.hasPreparedLoopLeafWasmUpgrade(leaf),false,'missing/partial module excluded');
 h.hasReadyFullWasmModule=()=>true;h.hasWasmExitStorm=()=>true;
 t.equal(h.hasPreparedLoopLeafWasmUpgrade(leaf),false,'exit storm retains fallback');
 h.hasWasmExitStorm=()=>false;h.preparedCompleteWasm=true;
 const state=h.wasmJit.methodState({method:caller});
 state.meta={normalFlowFullyCompiled:true,fullyCompiled:false};
 t.equal(h.hasPreparedLoopLeafWasmUpgrade(caller),false,'normal-flow-only caller remains excluded');
 state.meta.fullyCompiled=true;
 t.equal(h.hasPreparedLoopLeafWasmUpgrade(caller),true,'complete prepared caller can use existing module');
 h.hasReadyFullWasmModule=()=>false;
 t.equal(h.hasPreparedLoopLeafWasmUpgrade(caller),false,'complete metadata is insufficient without ready executable module');
 h.hasReadyFullWasmModule=()=>true;h.hasWasmExitStorm=()=>true;
 t.equal(h.hasPreparedLoopLeafWasmUpgrade(caller),false,'complete caller retains exit-storm fallback');
 t.end();
});

const Frame=require('../src/core/frame');
const Stack=require('../src/core/stack');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const fixture=makeJavaFixtureCompiler('prepared-loop-leaf-');

test('upgrades-only preparation supplies a leaf loop and real callers use its primary entry',async t=>{
 const classpath=fixture(t,'LeafPreparation',`public class LeafPreparation {
   static void kernel(int[] values) { for(int i=0;i<values.length;i++) values[i] += 3; }
   static void callerLoop(int[] values) { for(int i=0;i<2;i++) kernel(values); }
   public static void call(int[] values) { kernel(values); }
 }`);
 const j=new JVM({classpath,wasmHeap:true,wasmHeapMb:1,prepareBeforeMain:false,jit:{
   compileWorker:false,preferWholeMethodJs:true,wasmStructured:true,structuredSsa:true,
   rendererPipeline:true,compiledCallChains:true,preparedLoopLeafWasm:true}});
 await j.preloadClasspathClasses();j.classInitializationState.set('LeafPreparation','INITIALIZED');
 const h=j.jit,w=h.wasmJit;w.enabled=true;
 const kernel=await j.findMethodInHierarchy('LeafPreparation','kernel','([I)V');
 const callerLoop=await j.findMethodInHierarchy('LeafPreparation','callerLoop','([I)V');
 const caller=await j.findMethodInHierarchy('LeafPreparation','call','([I)V');
 const state=w.methodState({method:kernel});
 await j.precompileInitializedClasses({effectful:true,wasm:true,fixedPoint:true,
   wasmPreparedUpgradesOnly:true,wasmFallbackOnly:true});
 t.equal(state.status,'ready','small call-free loop receives a module before main');
 t.ok(h.hasPreparedFullWasmUpgrade(kernel),'full ready module is selected');
 t.notOk(h.isPreparedLoopLeafWasmCandidate(callerLoop),'a call-bearing loop retains its policy');
 const entries=[],execute=w.execute;
 w.execute=function(frame,...args){if(frame.method===kernel)entries.push({pc:frame.pc,osr:args[4]===true});return execute.call(this,frame,...args);};
 const thread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};
 j.threads=[thread];j.currentThreadIndex=0;
 const values=j.wasmHeap.alloc('[I',4);values.set([1,2,3,4]);
 for(let run=0;run<2;run++){
   const frame=new Frame(caller);frame.className='LeafPreparation';frame.locals[0]=values;
   thread.callStack.push(frame);
   let ticks=0;while(thread.callStack.size()){await j.executeTick();if(++ticks>10000)throw Error('tick limit');}
 }
 t.deepEqual([...values],[7,8,9,10],'generated callers preserve exactly-once writes');
 t.equal(entries.length,2,'both calls enter the leaf module');
 t.ok(entries.every(e=>e.pc===0&&!e.osr),'calls use prepared primary entries');
 state.runs=64;state.exits=32;
 t.notOk(h.hasPreparedFullWasmUpgrade(kernel),'exit-storm fallback remains active');
 t.end();
});
