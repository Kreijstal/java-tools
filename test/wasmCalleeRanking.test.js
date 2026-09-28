'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const {hasUncheckedSpeculation} = require('../src/jit/wasmShared');
const compile = require('./javaFixture').makeJavaFixtureCompiler('wasm-callee-ranking-');

test('callee selection prefers an eligible partial dispatcher over speculative primary', async t => {
  const classpath = compile(t, 'RankedCallee', `
public class RankedCallee {
  static int count;
  static native void cold();
  int value() { count++; return 7; }
  static int helper(RankedCallee receiver, int n) {
    if (n < 0) cold();
    int total = 0;
    for (int i = 0; i < n; i++) total += receiver.value();
    return total;
  }
}`);
  const j = new JVM({classpath, jit: {compileWorker: false, wasmStructured: true}});
  await j.preloadClasspathClasses();
  j._setClassInitializationState('RankedCallee', 'INITIALIZED');
  const w=j.jit.wasmJit;
  const leaf=await j.findMethodInHierarchy('RankedCallee','value','()I');
  w.compile({method:leaf,className:'RankedCallee'},w.methodState({method:leaf}),{asCallee:true});
  const method=await j.findMethodInHierarchy('RankedCallee','helper','(LRankedCallee;I)I');
  const state=w.methodState({method});
  w.compile({method,className:'RankedCallee'},state,{asCallee:true});
  t.equal(state.status,'ready',state.lastCompileError||'helper compiles');
  t.ok(hasUncheckedSpeculation(state.meta),'primary exercises a speculative inline');
  t.notOk(state.osr.meta.boxedCount,'dispatcher has unboxed slots');
  t.ok(state.osr.meta.externalEntry.has(0),'dispatcher admits canonical entry');
  t.notOk(hasUncheckedSpeculation(state.osr.meta),'dispatcher does not require entry speculation');
  t.equal(state.callee,state.osr,'callee uses eligible dispatcher');
  t.equal(w.findReadyStatic('RankedCallee','helper','(LRankedCallee;I)I',true),state,
    'static callers can discover the existing partial body');
  t.notOk(state.meta.fullyCompiled,'primary coverage is not relabelled');
  t.notOk(state.osr.meta.fullyCompiled,'unsupported cold branch remains a fallback');
  const meta=state.osr.meta,frame=new Frame(method),receiver={type:'RankedCallee',fields:{}};
  frame.className='RankedCallee';meta.box.frame=frame;
  const args=meta.paramSlots.map(({slot})=>slot===0?receiver:slot===1?6:0);
  t.equal(state.osr.run(...args,0,100000),-1,'valid dispatcher entry completes in Wasm');
  t.equal(meta.box.ret,42,'compiled calls produce the exact result');
  t.equal(j.classes.RankedCallee.staticFields.get('count:I'),6,'callee effects execute exactly once');
  meta.box.frame=new Frame(method);
  const coldArgs=meta.paramSlots.map(({slot})=>slot===0?receiver:slot===1?-1:0);
  const resume=state.osr.run(...coldArgs,0,100000);
  t.ok(resume>=0,'unsupported cold branch exits to canonical execution');
  t.equal(meta.box.frame.locals[0],receiver,'fallback retains receiver identity');
  t.equal(meta.box.frame.locals[1],-1,'fallback retains the argument');
  t.equal(j.classes.RankedCallee.staticFields.get('count:I'),6,'cold exit does not replay or run leaf effects');
  t.end();
});
