'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Compiler = require('../src/jit/StructuredWasmCompiler');
const Frame = require('../src/core/frame');
const compile = require('./javaFixture').makeJavaFixtureCompiler('wasm-normal-callee-');

test('required callee accepts complete normal flow without relabelling exception coverage', async t => {
 const classpath=compile(t,'NormalCallee',`
public class NormalCallee {
 static int calls;
 int value() { calls++; return 7; }
 static int work(NormalCallee v, int n) {
  try { int total=0; for(int i=0;i<n;i++) total+=v.value(); return total; }
  catch(RuntimeException ex) { throw ex; }
 }
}`);
 const j=new JVM({classpath,jit:{compileWorker:false,wasmStructured:true,retainCompilerDiagnostics:false}});
 await j.preloadClasspathClasses();j._setClassInitializationState('NormalCallee','INITIALIZED');
 const w=j.jit.wasmJit,method=await j.findMethodInHierarchy('NormalCallee','work','(LNormalCallee;I)I');
 t.notOk(w.normalFlowPreparedUpgradesEnabled,'normal-flow root promotion is disabled');
 const control=new Compiler(j,method,'NormalCallee',w).translateWith(true);
 const plain=new Compiler(j,method,'NormalCallee',w).translateWith(false);
 t.ok(control.speculations>0,'ordinary entry retains speculative inlining');
 t.ok(plain.normalFlowFullyCompiled,'plain body covers normal flow');
 t.notOk(plain.fullyCompiled,'exception table prevents full coverage');
 const selected=new Compiler(j,method,'NormalCallee',w,{asCallee:true}).translateWith(true);
 t.ok(selected.normalFlowFullyCompiled,'required callee selects complete normal flow');
 t.equal(selected.speculations,0,'selected body has no unchecked inline assumptions');
 t.notOk(selected.fullyCompiled,'selection preserves exception coverage metadata');
 const state=w.methodState({method});w.compile({className:'NormalCallee',method},state,{asCallee:true});
 t.equal(w.findReadyStatic('NormalCallee','work','(LNormalCallee;I)I',true),state,'callee is discoverable');
 const meta=state.meta,receiver={type:'NormalCallee',fields:{}};
 meta.box.frame=new Frame(method);
 const args=meta.paramSlots.map(({slot})=>slot===0?receiver:slot===1?6:0);
 t.equal(state.run(...args,0,10000),-1,'native Wasm returns normally');
 t.equal(meta.box.ret,42,'native result is exact');
 t.equal(j.classes.NormalCallee.staticFields.get('calls:I'),6,'effects occur once per invocation');
 meta.box.frame=new Frame(method);
 const nullArgs=meta.paramSlots.map(({slot})=>slot===0?null:slot===1?1:0);
 t.throws(()=>state.run(...nullArgs,0,10000),e=>e.type==='java/lang/NullPointerException','null receiver still throws');
 t.equal(j.classes.NormalCallee.staticFields.get('calls:I'),6,'throw does not duplicate effects');
 t.end();
});
