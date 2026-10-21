'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const compile=require('./javaFixture').makeJavaFixtureCompiler('prepared-osr-deps-');

test('AOT settles cold helper dependencies in the OSR companion',async t=>{
 const classpath=compile(t,'PreparedResume',`
class ResumeTrace { static int order; }
class ResumeStorage { static int seed=7; static { ResumeTrace.order=ResumeTrace.order*10+1; } }
class ResumeHelper { static { ResumeTrace.order=ResumeTrace.order*10+2; } static int step(int x){return x*3+1;} }
public class PreparedResume {
 static int result, order;
 static int loop(int n){int total=ResumeStorage.seed;for(int i=0;i<n;i++)total+=ResumeHelper.step(i);return total;}
 public static void main(String[] args){result=loop(100);order=ResumeTrace.order;}
}`);
 const j=new JVM({classpath,prepareBeforeMain:false,jit:{compileWorker:false,
  structuredSsa:true,wasmStructured:true,rendererPipeline:true,compiledCallChains:true,
  preparedWasmMethods:['PreparedResume.loop(I)I'],
  preparationPolicy:{priorityMethods:['PreparedResume.loop(I)I']},
  wasm:{noOnDemandCalleeCompile:true,maxInlineCalleeItems:1,inlineBudget:1}}});
 await j.preloadClasspathClasses();const w=j.jit.wasmJit;w.enabled=true;
 const result=await j.precompileInitializedClasses({initializedOnly:false,effectful:true,wasm:true,wasmPreparedUpgradesOnly:true});
 const method=await j.findMethodInHierarchy('PreparedResume','loop','(I)I');
 const state=w.state.get(method);
 t.ok(state?.meta?.fullyCompiled,'entry module has complete coverage');
 t.ok(state?.osr,'a companion exists for the first-use initialization exit');
 t.ok(result.report.wasmSettled>0,'preparation revisits the companion after helper compilation');
 t.notOk([...state.osr.meta.demoteReasons.values()].some(reason=>/callee not ready/.test(reason)),
  'ready helper has no stale demotion in the companion');
 t.notEqual(j.classInitializationState.get('ResumeStorage'),'INITIALIZED','preparation did not initialize storage');
 t.notEqual(j.classInitializationState.get('ResumeHelper'),'INITIALIZED','preparation did not initialize helper');
 const late=[],start=j.jit.startSynchronousCompile.bind(j.jit);
 j.jit.startSynchronousCompile=(method,entry)=>{if(j.jit.mainStarted)late.push(j.jit.methodIdentity(method));return start(method,entry);};
 w.freezeCompilation();await j.run('PreparedResume',{prepare:false});
 await new Promise(resolve=>setTimeout(resolve,10));
 t.equal(j.classes.PreparedResume.staticFields.get('result:I'),14957,'resumed loop preserves all arithmetic');
 t.equal(j.classes.PreparedResume.staticFields.get('order:I'),12,'static call initializes its owner in Java order');
 t.deepEqual(late,[],'resumption needs no guest-time compilation');
 t.end();
});
