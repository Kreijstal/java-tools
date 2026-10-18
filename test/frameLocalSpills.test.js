'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
const compile=require('./javaFixture').makeJavaFixtureCompiler('frame-local-spills-');
const SOURCE=`public class FrameLivenessProof {
 static Object garbage;static int seed;
 static int run(int[] a,int n,int[] progress){Object discarded=garbage;int unused=seed;int snapshot=seed;
  try{for(int i=0;i<n;i++)progress[0]+=a[i];}
  catch(ArrayIndexOutOfBoundsException e){return snapshot+progress[0]+100;}
  return snapshot+progress[0];}
 static int caller(int[] a,int n,int[] p){return run(a,n,p);}
 static long wide(long value,int[] a){Object discarded=garbage;long snapshot=value;
  try{return snapshot+a[0];}catch(ArrayIndexOutOfBoundsException e){return snapshot+9;}}
 static void touch(int[] p){p[0]++;}
 static int catchOnly(int[] p,int value){int captured=value+7;
  try{touch(p);}catch(RuntimeException e){return captured;}return 9;}
}`;
test('local liveness drops dead owning references and preserves fuel, handlers and wide values',async t=>{
 const classpath=compile(t,'FrameLivenessProof',SOURCE),j=new JVM({classpath,wasmHeap:true,jit:{enabled:false,compileWorker:false,
  retainCompilerDiagnostics:false,wasmStructured:true,wasm:{deepInline:false,canonicalDirectCalls:true,
   canonicalEhLinks:true,canonicalLeafCalls:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j.classInitializationState.set('FrameLivenessProof','INITIALIZED');const w=j.jit.wasmJit,fields=j.classes.FrameLivenessProof.staticFields;fields.set('seed:I',17);
 const prepare=(name,descriptor)=>{const method=j.findMethod(j.classes.FrameLivenessProof,name,descriptor),st=w.methodState({method});
  w.compile({method,className:'FrameLivenessProof'},st,{asCallee:true});t.equal(st.status,'ready',st.lastCompileError||name+' compiles');return st;};
 const run=prepare('run','([II[I)I'),caller=prepare('caller','([II[I)I');
 t.ok(run.meta.frameLivenessProved,'real javac code passes bounded liveness proof');t.ok(run.meta.frameSpillSlotsOmitted>0,'real spills omit dead slots');
 const array=xs=>{const a=j.wasmHeap.alloc('[I',xs.length);a.type='[I';a.set(xs);return a;};
 const weak=(()=>{const object={large:new Uint8Array(1024*1024)};fields.set('garbage:Ljava/lang/Object;',object);return new WeakRef(object);})();
 const a=array([2,3]),p=array([0]),frame=new Frame(run.method);frame.locals[3]=weak.deref();frame.locals[4]=999;run.meta.box.frame=frame;
 try{const status=run.run(a,2,p,0,1);t.ok(status>=0,'low fuel returns an exact resume point');
  t.equal(frame.locals[0],a,'live array identity spills');t.equal(frame.locals[1],2,'live bound spills');t.equal(frame.locals[2],p,'live progress spills');
  t.equal(frame.locals[5],17,'captured static value spills');t.equal(frame.locals[3],undefined,'reused frame releases dead reference');t.equal(frame.locals[4],undefined,'reused frame clears dead scalar');}
 finally{run.meta.box.frame=null;}
 fields.set('garbage:Ljava/lang/Object;',null);
 if(global.gc){for(let i=0;i<10;i++){await new Promise(setImmediate);global.gc();}t.equal(weak.deref(),undefined,'dead object collects while the spill frame and module remain live');}
 const execute=async(st,args)=>{const f=new Frame(st.method);f.className='FrameLivenessProof';args.forEach((x,i)=>f.locals[i]=x);
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(f);j.threads=[thread];j.currentThreadIndex=0;
  const result=w.execute(f,thread,st,0);let value=result.value,steps=0;
  while(!thread.callStack.isEmpty()&&++steps<10000){const current=thread.callStack.peek(),ins=current.instructions[current.pc++].instruction;
   if(/^[ilfda]return$/.test(typeof ins==='string'?ins:ins?.op))value=current.stack.peek();if(ins)await j.executeInstruction(ins,current,thread);}
  t.ok(thread.callStack.isEmpty(),'continuation finishes');return value;};
 for(const fuel of [1,100000000]){run.meta.canonicalFuel.value=fuel;p[0]=0;
  t.equal(await execute(caller,[a,2,p]),22,'caller result remains exact with fuel '+fuel);t.equal(p[0],5,'effects occur once with fuel '+fuel);}
 const changing=Object.assign([2,3],{type:'[I'});Object.defineProperty(changing,1,{get(){fields.set('seed:I',41);throw {type:'java/lang/ArrayIndexOutOfBoundsException'};}});
 p[0]=0;t.equal(await execute(caller,[changing,2,p]),119,'exception handler retains pre-mutation captured value');t.equal(p[0],2,'preceding effect remains exact');t.equal(fields.get('seed:I'),41,'callback replacement remains visible');
 const wide=prepare('wide','(J[I)J');t.ok(wide.meta.frameLivenessProved,'wide locals are analyzed');
 const previous=9007199254740993n,invoke=(values)=>{const f=new Frame(wide.method);wide.meta.box.frame=f;
  try{return wide.meta.runv(previous,values);}finally{wide.meta.box.frame=null;}};
 t.deepEqual(invoke(a),[-1,previous+2n],'normal wide result is exact');
 const faultFrame=new Frame(wide.method);wide.meta.box.frame=faultFrame;
 try{t.equal(wide.run(previous,array([]),0,100000000),-3,'wide access fault preserves its handler exit');t.equal(faultFrame.locals[4],previous,'wide snapshot retains its exact BigInt');}
 finally{wide.meta.box.frame=null;}
 let reads=0;Object.defineProperty(fields.cell('garbage:Ljava/lang/Object;'),'value',{configurable:true,get(){reads++;return null;}});
 p[0]=0;t.equal(await execute(caller,[a,0,p]),41,'dead local does not discard its observable producer');t.equal(reads,1,'unused static getter still runs once');
 const touch=prepare('touch','([I)V'),catchOnly=prepare('catchOnly','([II)I');
 t.equal(catchOnly.meta.structured,true,catchOnly.lastCompileError||'call at end of protected region retains structured compilation');
 t.ok(catchOnly.meta.canonicalRun,'different before/after live sets retain native canonical entry');
 p[0]=0;t.equal(await execute(catchOnly,[p,21]),9,'normal after-call path drops catch-only local');t.equal(p[0],1,'effect before normal return occurs once');
 t.equal(await execute(catchOnly,[array([]),21]),28,'throwing call retains catch-only captured local');
 t.ok(touch.meta.canonicalEntries.value>0,'call really reaches native canonical callee');
 t.end();
});
