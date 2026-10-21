'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const {supportsWasmJsTag}=require('../src/jit/wasmShared');
const Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
const compile=require('./javaFixture').makeJavaFixtureCompiler('canonical-instance-');

test('canonical instance calls preserve dispatch, effects and suspended frames',async t=>{
 if(!supportsWasmJsTag()){t.pass('engine retains existing bridge');t.end();return;}
 const classpath=compile(t,'InstanceFrameProof',`
class InstanceReader {
 int recurse(int n){if(n<=0)return 1;return recurse(n-1)+1;}
 int read(int[] a,int n) { int s=0; for(int i=0;i<n;i++){s+=InstanceFrameProof.step(a[i]);} return s; }
}
class LaterReader extends InstanceReader { int read(int[] a,int n){return super.read(a,n)+100;} }
public class InstanceFrameProof {
 static int effects;
 static int step(int x){effects++;return x+1;}
 static int call(InstanceReader reader,int[] a,int n){effects++;return reader.read(a,n)+5;}
}`);
 const j=new JVM({classpath,wasmHeap:true,jit:{enabled:false,compileWorker:false,
  retainCompilerDiagnostics:false,wasmStructured:true,wasm:{deepInline:false,
   noOnDemandCalleeCompile:true,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 for(const name of ['InstanceFrameProof','InstanceReader']){
  await j.loadClassByName(name);j._markClassInitialized(name);
 }
 const w=j.jit.wasmJit;w.importStatsEnabled=true;
 const prepare=(owner,name,descriptor)=>{
  const method=j.findMethod(j.classes[owner],name,descriptor),s=w.methodState({method});
  w.compile({method,className:owner},s,{asCallee:true});
  t.equal(s.status,'ready',s.lastCompileError||owner+'.'+name+' compiles');return s;
 };
 prepare('InstanceFrameProof','step','(I)I');
 const recursive=prepare('InstanceReader','recurse','(I)I');
 const leaf=prepare('InstanceReader','read','([II)I');
 const caller=prepare('InstanceFrameProof','call','(LInstanceReader;[II)I');
 t.ok(leaf.meta.canonicalRun,'instance method has a native canonical entry');
 t.deepEqual(leaf.meta.parameterArrayABI,[1],'forwarded array ABI accounts for receiver');
 t.ok(caller.meta.canonicalDirectSites>0,'caller uses canonical native instance slots');
 const array=j.wasmHeap.alloc('[I',3);array.type='[I';array.set([2,3,5]);
 const receiver={type:'InstanceReader',fields:{}};
 t.equal(recursive.meta.canonicalRun(receiver,8)[3],9,'self-recursive instance publishes after compilation');
 const fields=j.classes.InstanceFrameProof.staticFields;
 const reset=()=>fields.set('effects:I',0);
 reset();const normal=caller.meta.canonicalRun(receiver,array,3);
 t.equal(normal[0],-1,'native instance path returns normally');t.equal(normal[3],18,'exact result');
 t.equal(fields.get('effects:I'),4,'caller and helper effects occur once');
 t.equal(leaf.meta.directFrameContext.createdFrames,0,'normal instance invocation needs no frame');
 t.equal(leaf.meta.importStats.get('ret_i')||0,0,'native non-leaf return skips legacy JS result callback');
 const legacyFrame=new Frame(leaf.method);legacyFrame.className='InstanceReader';
 leaf.meta.box.frame=legacyFrame;
 try{
  t.equal(leaf.run(receiver,array,3,0,1000000),-1,'ordinary JS entry still completes');
  t.equal(leaf.meta.box.ret,13,'ordinary JS entry retains its result ABI');
 }finally{leaf.meta.box.frame=null;}
 t.equal(leaf.meta.importStats.get('ret_i'),1,'ordinary entry runs legacy callback exactly once');
 reset();const nil=caller.meta.canonicalRun(null,array,3);
 t.equal(nil[0],-5,'null receiver throws through exact canonical owner');
 t.equal(nil[2].box.lastThrown.type,'java/lang/NullPointerException','null receiver preserves guest exception');
 t.equal(fields.get('effects:I'),1,'caller effects precede null check');
 reset();const bounds=caller.meta.canonicalRun(receiver,array,4);
 t.equal(bounds[0],-5,'callee exception unwinds normally');
 t.equal(bounds[2].box.lastThrown.type,'java/lang/ArrayIndexOutOfBoundsException','callee exception identity is retained');
 t.equal(fields.get('effects:I'),4,'successful effects preceding a failure are not replayed');
 const execute=async(target=receiver)=>{
  const frame=new Frame(caller.method);frame.className='InstanceFrameProof';
  [target,array,3].forEach((v,i)=>frame.locals[i]=v);
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  let value=w.execute(frame,thread,caller,0).value,steps=0;
  while(!thread.callStack.isEmpty()&&++steps<10000){
   const current=thread.callStack.peek(),ins=current.instructions[current.pc++].instruction;
   if((typeof ins==='string'?ins:ins?.op)==='ireturn')value=current.stack.peek();
   if(ins)await j.executeInstruction(ins,current,thread);
  }
  t.ok(thread.callStack.isEmpty(),'suspended invocation finishes');return value;
 };
 leaf.meta.canonicalFuel.value=1;reset();t.equal(await execute(),18,'fuel exit restores receiver and arguments');
 t.equal(fields.get('effects:I'),4,'fuel resumption never replays effects');
 t.equal(leaf.meta.directFrameContext.frames.size,0,'transferred instance frames are released');
 leaf.meta.canonicalFuel.value=100000000;
 await j.loadClassByName('LaterReader');j._markClassInitialized('LaterReader');
 prepare('LaterReader','read','([II)I');
 reset();t.equal(await execute({type:'LaterReader',fields:{}}),118,
  'guard miss dispatches to new override including invokespecial super call');
 t.equal(fields.get('effects:I'),4,'late dispatch effects occur once');
 t.end();
});

test('native reference results preserve identity and release return scratch',async t=>{
 if(!supportsWasmJsTag()){t.pass('engine retains existing bridge');t.end();return;}
 const classpath=compile(t,'InstanceReferenceProof',`
class ReferenceReader {
 int[] read(int[] a,int n){for(int i=0;i<n;i++)InstanceReferenceProof.effects+=a[i];return a;}
}
public class InstanceReferenceProof {
 static int effects;
 static int[] call(ReferenceReader r,int[] a,int n){return r.read(a,n);}
}`);
 const j=new JVM({classpath,wasmHeap:true,jit:{enabled:false,compileWorker:false,
  retainCompilerDiagnostics:false,wasmStructured:true,wasm:{deepInline:false,
   canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();for(const c of ['ReferenceReader','InstanceReferenceProof'])j._markClassInitialized(c);
 const w=j.jit.wasmJit;
 const prepare=(owner,name,desc)=>{const method=j.findMethod(j.classes[owner],name,desc),s=w.methodState({method});
  w.compile({method,className:owner},s,{asCallee:true});t.equal(s.status,'ready',s.lastCompileError||name+' compiles');return s;};
 const leaf=prepare('ReferenceReader','read','([II)[I'),caller=prepare('InstanceReferenceProof','call','(LReferenceReader;[II)[I');
 t.ok(caller.meta.canonicalDirectSites>0,'reference caller takes canonical instance path');
 const receiver={type:'ReferenceReader',fields:{}},a=j.wasmHeap.alloc('[I',2);a.type='[I';a.set([3,7]);
 const r=caller.meta.canonicalRun(receiver,a,2);
 t.equal(r[0],-1,'reference result completes');t.equal(r[3],a,'array identity survives nested native return');
 for(const state of [caller,leaf])t.equal(state.meta.retv.value,null,'native return scratch releases array');
 t.equal(leaf.meta.canonicalCompactRun(receiver,null,0)[1],null,'null reference is a valid normal result');
 t.equal(leaf.meta.canonicalCompactHeapRun(receiver,a,2,a.wasmBase,2)[1],a,'compact expanded entry returns identical array');
 t.equal(leaf.meta.retv.value,null,'inline compact entry releases return scratch');
 const thrown=caller.meta.canonicalRun(receiver,a,3);
 t.equal(thrown[0],-5,'reference-returning callee can throw');
 t.equal(thrown[2].box.lastThrown.type,'java/lang/ArrayIndexOutOfBoundsException','throwable crosses reference ABI');
 for(const state of [caller,leaf])t.equal(state.meta.retv.value,null,'throw leaves no old reference in result scratch');
 j.classInitializationState.set('ReferenceReader','LOADED');
 const cold=leaf.meta.canonicalRun(receiver,a,2);
 t.equal(cold[0],-4,'cold owner refuses before execution');t.equal(cold[3],null,'cold refusal returns typed null');
 j._markClassInitialized('ReferenceReader');
 const fields=j.classes.InstanceReferenceProof.staticFields;fields.set('effects:I',0);leaf.meta.canonicalFuel.value=1;
 const frame=new Frame(caller.method);frame.className='InstanceReferenceProof';[receiver,a,2].forEach((v,i)=>frame.locals[i]=v);
 const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
 let value=w.execute(frame,thread,caller,0).value,steps=0;
 while(!thread.callStack.isEmpty()&&++steps<10000){const current=thread.callStack.peek(),ins=current.instructions[current.pc++].instruction;
  if((typeof ins==='string'?ins:ins?.op)==='areturn')value=current.stack.peek();if(ins)await j.executeInstruction(ins,current,thread);}
 t.ok(thread.callStack.isEmpty(),'reference continuation completes');t.equal(value,a,'fuel handoff retains array identity');
 t.equal(fields.get('effects:I'),10,'reference continuation runs effects once');
 t.equal(leaf.meta.directFrameContext.frames.size,0,'reference callee releases transferred frame');
 t.end();
});
