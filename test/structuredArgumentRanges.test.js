"use strict";
const test=require('tape');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const Stack=require('../src/core/stack');
const compile=makeJavaFixtureCompiler('argument-ranges-');
const source=`public class ArgumentRanges {
 static int effects, last;
 static void invoke(int[] a, byte mode) { last=run(a,mode); }
 static int run(int[] a, byte mode) {
   if (mode <= 38) { effects += 100; return -mode; }
   int sum=0; for (int i=0;i<a.length;i++) { sum+=a[i]; effects++; }
   return sum;
 }
 static int overwrite(int[] a, byte mode) {
   mode=0; if(mode<=38)return 91; int sum=0;for(int x:a)sum+=x;return sum;
 }
 static int unused(byte mode, int[] a) {
   if(mode>38)return 7; int sum=0;for(int x:a)sum+=x;return sum;
 }
}`;
test('guarded argument ranges prune immutable comparisons and preserve canonical fallback',async t=>{
 const classpath=compile(t,'ArgumentRanges',source);
 const j=new JVM({classpath,jit:{compileWorker:false,wasm:false,structuredSsa:true,
  ordinaryAdaptiveFramelessPositional:true,structuredExplicitFrameSpills:true,
  structuredArgumentRanges:{'ArgumentRanges.run([IB)I':{1:[39,127]},
   'ArgumentRanges.overwrite([IB)I':{1:[39,127]},'ArgumentRanges.unused(B[I)I':{0:[39,127]}}}});
 await j.loadClassByName('ArgumentRanges');j.classInitializationState.set('ArgumentRanges','INITIALIZED');j.classes.ArgumentRanges.staticFields.set('effects:I',0);
 const m=await j.findMethodInHierarchy('ArgumentRanges','run','([IB)I');
 const g=j.jit.structuredSsa.compile(m);t.ok(g,`compiled ${j.jit.structuredSsa.lastRejectionReason}`);if(!g){t.end();return;}
 t.ok(g.jvmStructuredArgumentRangeBranchCount>0,'a branch is pruned');
 t.notOk(g.jvmRestoringDirectPositionalBody,'unguarded raw restoring entry is withheld');
 const rebound=j.jit.materializeGeneratedResult(j.jit.serializeGeneratedResult(g),m);
 t.ok(rebound,'worker/code-pack transport accepts the guarded entry');
 const observe=(body,mode,array)=>{
   const frame=new Frame(m);frame.className='ArgumentRanges';frame.locals.splice(0,2,array,mode);
   const thread={status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j._nextEventLoopYieldAt=Infinity;
   j.classes.ArgumentRanges.staticFields.set('effects:I',0);
   let result,error;try{result=body(frame,thread,j.jit,false);}catch(e){error=e;}
   return {frame,thread,result,error,effects:j.classes.ArgumentRanges.staticFields.get('effects:I')};
 };
 for(const body of [g,rebound])for(const mode of [39,49,117,127]){
  const a=[3,-7,11];a.type='[I';const r=observe(body,mode,a);
  t.equal(r.result?.value,7,`exact in-range result ${mode}`);t.equal(r.effects,3,'side effects execute once');t.equal(r.thread.callStack.size(),0,'normal return retires the frame');
 }
 for(const body of [g,rebound])for(const mode of [-128,0,38]){
  const a=[3,-7,11];a.type='[I';const r=observe(body.jvmAdaptivePositionalBody,mode,a);
  t.ok(r.result?.deopt,`out-of-range ${mode} exits before guest work`);t.equal(r.effects,0,'guard executes no effects');t.equal(r.frame.pc,0,'fallback starts at the original PC');t.deepEqual(r.frame.locals.slice(0,2),[a,mode],'original arguments retained');t.equal(r.thread.callStack.size(),1,'guard retains canonical child');
 }
 j.jit.structuredSsa.argumentRanges=null;const control=j.jit.structuredSsa.compile(m);
 const expectedNull=observe(control,49,null);
 for(const body of [g,rebound]){
  const r=observe(body,49,null);t.deepEqual({error:r.error?.type,deopt:r.result?.deopt,pc:r.frame.pc,locals:r.frame.locals,stack:r.frame.stack.items},{error:expectedNull.error?.type,deopt:expectedNull.result?.deopt,pc:expectedNull.frame.pc,locals:expectedNull.frame.locals,stack:expectedNull.frame.stack.items},'pruned body preserves exact null fallback state');t.equal(r.effects,0,'null does not run the loop');
 }
 j.jit.structuredSsa.argumentRanges={'ArgumentRanges.overwrite([IB)I':{1:[39,127]}};
 const overw=await j.findMethodInHierarchy('ArgumentRanges','overwrite','([IB)I');
 const o=j.jit.structuredSsa.compile(overw);t.equal(o?.jvmStructuredArgumentRangeBranchCount,0,'a written argument is not specialized');
 j.jit.structuredSsa.argumentRanges={'ArgumentRanges.unused(B[I)I':{0:[39,127]}};
 const unused=await j.findMethodInHierarchy('ArgumentRanges','unused','(B[I)I');
 const u=j.jit.structuredSsa.compile(unused);
 t.ok(u?.jvmStructuredArgumentRangeBranchCount>0,'unused array arm is pruned');
 const uf=new Frame(unused);uf.className='ArgumentRanges';uf.locals.splice(0,2,49,null);
 const ut={status:'runnable',callStack:new Stack()};ut.callStack.push(uf);
 t.equal(u(uf,ut,j.jit,false)?.value,7,'unused null array remains legal');
 // Run the mismatching input through the real scheduler, which consumes deopt.
 j.jit.codegenCache.set(m,g);j.jit.preparedCodegenMethods.add(m);
 const invoke=await j.findMethodInHierarchy('ArgumentRanges','invoke','([IB)V');
 const parent=new Frame(invoke);parent.className='ArgumentRanges';const array=[3,-7,11];array.type='[I';parent.locals.splice(0,2,array,38);
 const thread={id:0,status:'runnable',callStack:new Stack(),pendingException:null};thread.callStack.push(parent);j.threads=[thread];j.currentThreadIndex=0;
 j.classes.ArgumentRanges.staticFields.set('effects:I',0);j.classes.ArgumentRanges.staticFields.set('last:I',0);
 let ticks=0;while(thread.callStack.size()){await j.executeTick();if(++ticks>10000)throw Error('range fallback resume limit');}
 t.equal(j.classes.ArgumentRanges.staticFields.get('last:I'),-38,'scheduler executes the original cold branch');t.equal(j.classes.ArgumentRanges.staticFields.get('effects:I'),100,'original cold branch effects execute once');
 t.end();
});
