'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const reachable=require('../src/jit/normalInstructionReachability');
const fixture=makeJavaFixtureCompiler('cold-resume-handlers-');

test('normal reachability retains switch targets and shared handler tails', t=>{
 for(const instruction of [
  {op:'tableswitch',defaultLbl:'end',labels:['shared']},
  {op:'lookupswitch',arg:{defaultLabel:'end',pairs:[[100,'shared']]}},
 ]) {
  const items=[{instruction},{labelDef:'handler:',instruction:'astore_0'},
   {labelDef:'shared:',instruction:'iconst_1'}, {labelDef:'end:',instruction:'return'}];
  t.deepEqual([...reachable(items)].sort(),[0,2,3],instruction.op+' includes all normal successors');
 }
 t.equal(reachable([{instruction:{op:'goto',arg:'missing'}}]),null,'malformed target retains the full baseline');
 t.equal(reachable([{instruction:{op:'jsr',arg:'sub'}}]),null,'legacy subroutines retain the full baseline');
 t.end();
});

test('cold resume handlers preserve catch, finally, and subsequent calls',async t=>{
 const classpath=fixture(t,'ColdHandlers',`public class ColdHandlers {
  static int cleanups, result;
  static int calculate(int value) {
    try {
      switch(value) { case 0: return 10; case 1: return 100 / (value - 1); default: return 30; }
    } catch (ArithmeticException expected) {
      return "diagnostic-handler-only".length() + 40;
    } finally { cleanups++; }
  }
  public static void main(String[] args) { result = calculate(0)+calculate(1)+calculate(9); }
 }`);
 const j=new JVM({classpath,prepareBeforeMain:true,jit:{compileWorker:false,structuredSsa:true,compiledCallChains:true,profileResumeDispatch:true}});
 await j.run('ColdHandlers');
 const data=j.classes.ColdHandlers;
 t.equal(data.staticFields.get('result:I'),103,'catch result and normal switch results');
 t.equal(data.staticFields.get('cleanups:I'),3,'finally executes exactly once for every call');
 t.ok(j.jit.resumeDispatchStats.get('ColdHandlers.calculate(I)I')?.resume > 0,
  'the exceptional invocation actually enters the resume companion');
 const method=data.ast.classes[0].items.find(x=>x.method?.name==='calculate').method;
 t.ok(j.jit.codegenCache.get(method)?.jvmResumeBodyFn?.toString().includes("cold exception handler"),
  "the executed prepared method carries the compact resume body");
 const original=j.jit.compileBaselineMethod(method);
 const compact=j.jit.compileBaselineMethod(method,null,{coldHandlers:true});
 t.ok(compact.toString().includes('cold exception handler'),'handler-only entries hand off to interpretation');
 t.ok(compact.toString().length<original.toString().length,'cold handler instructions do not duplicate generated source');
 t.end();
});
