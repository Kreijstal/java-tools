'use strict';
const test=require('tape');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');

test('call-free loops test class readiness once before any guest effects',async t=>{
 const compile=makeJavaFixtureCompiler('wasm-leaf-initialization-');
 const classpath=compile(t,'LeafInitProof',`public class LeafInitProof {
   static int effects;
   static void fill(int[] a,int n) {
     for(int i=0;i<n;i++) { a[i]=LeafValues.value; effects++; }
   }
   static void optional(boolean use,int[] a) {
     if(use)a[0]=LeafValues.value;
     effects++;
   }
   static void calls(int[] a,int n) {
     for(int i=0;i<n;i++) { LeafValues.touch(); a[i]=LeafValues.value; }
   }
 }
 class LeafValues { static int value=7; static void touch() { value++; } }`);
 const j=new JVM({classpath,wasmHeap:true,jit:{enabled:false,compileWorker:false,
   wasmStructured:true,wasm:{deepInline:false}}});
 await j.preloadClasspathClasses();
 j.classInitializationState.set('LeafInitProof','INITIALIZED');
 const token=j.getClassInitializationToken('LeafValues');let checks=0;
 token.wasmReadinessGuard=()=>()=>{checks++;return token.initialized?1:0;};
 const w=j.jit.wasmJit;
 const prepare=(name,desc)=>{
   const method=j.findMethod(j.classes.LeafInitProof,name,desc),st=w.methodState({method});
   w.compile({method,className:'LeafInitProof'},st,{asCallee:true});
   t.equal(st.status,'ready',st.lastCompileError||name+' compiles');return {method,st};
 };
 const fill=prepare('fill','([II)V'),optional=prepare('optional','(Z[I)V');
 t.equal(fill.st.meta.entryInitializationGuards,1,'the loop owns one entry guard');
 const run=({st,method},...args)=>{
   const frame=new Frame(method);frame.className='LeafInitProof';
   args.forEach((v,i)=>frame.locals[i]=v);st.meta.box.frame=frame;
   try{return st.run(...st.meta.paramSlots.map(p=>args[p.slot]),0,1000000);}
   finally{st.meta.box.frame=null;}
 };
 const a=j.wasmHeap.alloc('[I',5),effects=j.classes.LeafInitProof.staticFields;
 effects.set('effects:I',0);
 t.equal(run(fill,a,5),0,'a cold dependency resumes at the original entry');
 t.deepEqual([...a],[0,0,0,0,0],'a cold exit performs no array writes');
 t.equal(effects.get('effects:I'),0,'a cold exit performs no scalar effects');
 t.notOk(token.initialized,'compilation and readiness checks never run clinit');
 j.classes.LeafValues.staticFields.set('value:I',7);
 j.classInitializationState.set('LeafValues','INITIALIZED');checks=0;
 t.equal(run(fill,a,5),-1,'a ready loop completes');
 t.deepEqual([...a],[7,7,7,7,7],'every store has the original value');
 t.equal(effects.get('effects:I'),5,'each iteration runs once');
 t.equal(checks,1,'readiness is not checked on every iteration');
 checks=0;t.equal(run(fill,null,0),-1,'zero-trip null array remains legal');
 t.equal(checks,1,'a new invocation reads live readiness');
 t.equal(run(optional,0,null),-1,'an unused null parameter remains legal');
 j.classInitializationState.delete('LeafValues');
 a.fill(9);effects.set('effects:I',0);
 t.equal(run(fill,a,5),0,'a reset token exits before using stale assumptions');
 t.deepEqual([...a],[9,9,9,9,9],'reset preserves all array elements');
 t.equal(effects.get('effects:I'),0,'reset exit preserves scalar effects');
 t.equal(run(optional,0,null),0,'an untaken cold dependency uses the original entry');
 t.notOk(token.initialized,'untaken dependencies are never initialized early');
 const caller=prepare('calls','([II)V');
 t.equal(caller.st.meta.entryInitializationGuards,0,'a call-bearing loop retains local readiness guards');
 t.end();
});
