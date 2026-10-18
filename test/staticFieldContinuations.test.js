'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
const {supportsWasmJsTag}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('static-field-continuation-');
const SOURCE=`class SnapshotDependency {static int number;static long wide;static float fraction;static double precise;static Object ref;}
public class StaticSnapshot {
 static int loop(int[] a,int n,int[] p){int snapshot=SnapshotDependency.number,total=0;
  try{for(int i=0;i<n;i++){total+=a[i];p[0]++;}}catch(ArrayIndexOutOfBoundsException e){return snapshot+total+100;}
  return snapshot+total;}
 static int repeated(int n){int total=0;for(int i=0;i<n;i++)total+=SnapshotDependency.number;return total;}
 static int duplicate(){int first=SnapshotDependency.number;SnapshotDependency.number=31;return first+SnapshotDependency.number;}
 static int entryLoop(int[] p){do{p[0]+=SnapshotDependency.number;}while(p[0]<4);return p[0];}
 static long wide(){return SnapshotDependency.wide;}
 static float fraction(){return SnapshotDependency.fraction;}
 static double precise(){return SnapshotDependency.precise;}
}`;
test('native static reads preserve captured values across fuel, handlers and host mutations',async t=>{
 if(!supportsWasmJsTag()){t.pass('engine retains existing entry paths');t.end();return;}
 const classpath=compile(t,'StaticSnapshot',SOURCE);
 const j=new JVM({classpath,wasmHeap:true,jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,
  wasmStructured:true,wasm:{deepInline:false,maxInlineCalleeItems:1,canonicalDirectCalls:true,
   canonicalEhLinks:true,canonicalLeafCalls:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j.classInitializationState.set('StaticSnapshot','INITIALIZED');const w=j.jit.wasmJit;
 const prepare=(name,descriptor)=>{const method=j.findMethod(j.classes.StaticSnapshot,name,descriptor),st=w.methodState({method});
  w.compile({method,className:'StaticSnapshot'},st,{asCallee:true});t.equal(st.status,'ready',st.lastCompileError||name+' compiles');return st;};
 const leaf=prepare('loop','([II[I)I'),fields=j.classes.SnapshotDependency.staticFields;
 const cold=leaf.meta.canonicalRun(null,0,null);t.equal(cold[0],0,'cold dependency exits at original entry');
 t.equal(cold[2].take(cold[1]).pc,0,'cold exit carries its exact PC');
 fields.set('number:I',17);j.classInitializationState.set('SnapshotDependency','INITIALIZED');
 const array=values=>{const a=j.wasmHeap.alloc('[I',values.length);a.type='[I';a.set(values);return a;};
 const execute=async(st,args)=>{
  const frame=new Frame(st.method);frame.className='StaticSnapshot';args.forEach((a,i)=>frame.locals[i]=a);
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  const result=w.execute(frame,thread,st,0);let value=result.value,steps=0;
  while(!thread.callStack.isEmpty()&&++steps<10000){const f=thread.callStack.peek(),ins=f.instructions[f.pc++].instruction;
   if((typeof ins==='string'?ins:ins?.op)==='ireturn')value=f.stack.peek();if(ins)await j.executeInstruction(ins,f,thread);}
  t.ok(thread.callStack.isEmpty(),'continuation completes');return value;
 };
 let p=array([0]);t.equal(await execute(leaf,[array([2,3,5]),3,p]),27,'normal snapshot has exact value');t.equal(p[0],3,'normal effects occur once');
 leaf.meta.canonicalFuel.value=1;p=array([0]);
 t.equal(await execute(leaf,[array([2,3,5]),3,p]),27,'fuel exit preserves original static snapshot');t.equal(p[0],3,'fuel continuation does not replay effects');
 leaf.meta.canonicalFuel.value=100000000;
 const changing=Object.assign([2,3],{type:'[I'});Object.defineProperty(changing,1,{get(){fields.set('number:I',47);throw {type:'java/lang/ArrayIndexOutOfBoundsException'};}});
 p=array([0]);t.equal(await execute(leaf,[changing,2,p]),119,'handler keeps captured value despite later static change');
 t.equal(p[0],1,'throwing read has no duplicate effect');t.equal(fields.get('number:I'),47,'callback mutation is retained');
 let reads=0;const cell=fields.cell('number:I');Object.defineProperty(cell,'value',{configurable:true,get(){reads++;return 23;}});
 p=array([0]);t.equal(await execute(leaf,[null,0,p]),23,'accessor replacement after compilation is observed');t.equal(reads,1,'single read invokes the getter once');
 Object.defineProperty(cell,'value',{configurable:true,writable:true,value:19});
 const duplicate=prepare('duplicate','()I');t.equal(await execute(duplicate,[]),50,'write invalidates repeated-read cache');
 const repeated=prepare('repeated','(I)I');t.equal(await execute(repeated,[3]),93,'loop-contained reads preserve value');
 const entryLoop=prepare('entryLoop','([I)I');t.equal(await execute(entryLoop,[array([0])]),31,'back edge to entry preserves field semantics');
 for(const [name,descriptor,key,value]of [['wide','()J','wide:J',9007199254740993n],['fraction','()F','fraction:F',1.25],['precise','()D','precise:D',1.125]]){
  fields.set(key,value);const st=prepare(name,descriptor);t.equal(st.meta.canonicalRun()[3],value,name+' result is exact');
 }
 const thrown={type:'java/lang/RuntimeException'};Object.defineProperty(cell,'value',{configurable:true,get(){throw thrown;}});
 p=array([0]);const failure=leaf.meta.canonicalRun(array([2]),1,p);t.equal(failure[0],-3,'guest getter failure uses precise EH spill');
 const failedFrame=failure[2].take(failure[1]);t.equal(failedFrame.wasmDirectException,thrown,'exact getter throwable is retained');
 t.equal(failedFrame.wasmDirectThrowPc,0,'throwing read keeps original PC');t.equal(p[0],0,'getter failure precedes array effects');
 j.classInitializationState.set('SnapshotDependency','ERRONEOUS');reads=0;
 Object.defineProperty(cell,'value',{configurable:true,get(){reads++;return 29;}});
 const reset=leaf.meta.canonicalRun(null,0,null);t.equal(reset[0],0,'live reset refuses before a read');reset[2].take(reset[1]);t.equal(reads,0,'cold class state precedes accessor');
 t.end();
});
