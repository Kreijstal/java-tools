'use strict';
const test=require('tape');
const equals=require('../src/jre/java/util/Arrays').staticMethods['equals([B[B)Z'];
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const CallStack=require('../src/core/callStack');
const fixture=require('./javaFixture').makeJavaFixtureCompiler('byte-equals-');

test('byte equality handles signed views, offsets, tails and mutations without writes',t=>{
 const make=(n,offset,kind)=>{
  const a=kind===0?new Array(n).fill(0):new (kind===1?Int8Array:Uint8Array)(new ArrayBuffer(n+offset+8),offset,n);
  for(let i=0;i<n;i++)a[i]=(i*79+151)<<24>>24;return a;
 };
 let cases=0;
 for(let n=0;n<34;n++)for(let offset=0;offset<8;offset++)for(let kind=0;kind<3;kind++){
  const a=make(n,offset,kind),b=make(n,4,1);
  if(equals({},null,[a,b])!==1)throw Error('equal '+[n,offset,kind]);
  for(let i=0;i<n;i++){
   const old=b[i];b[i]^=1;
   if(equals({},null,[a,b])!==0)throw Error('mismatch '+[n,offset,kind,i]);
   b[i]=old;cases++;
  }
  if(equals({},null,[a,b])!==1)throw Error('mutation restoration');
 }
 t.equal(cases,13464,'all offsets, storage kinds and mismatch positions checked');
 for(const [a,b,want] of [[null,null,1],[null,[],0],[[],null,0],[[],[],1],[[1],[1,2],0]])t.equal(equals({},null,[a,b]),want,'null and length semantics');
 t.end();
});

for(const structured of [false,true])for(const kind of ['byte','int'])test('compiled '+kind+' equality, initialization and result (structured='+structured+')',async t=>{
 const classpath=fixture(t,'ByteEquals',`public class ByteEquals {
  static int drive(${kind}[] a,${kind}[] b,int n) { int sum=0; for(int i=0;i<n;i++)if(java.util.Arrays.equals(a,b))sum++;return sum; }
 }`);
 const j=new JVM({classpath,wasmHeap:true,jit:{compileWorker:false,wasmStructured:structured}});
 await j.preloadClasspathClasses();j._setClassInitializationState('ByteEquals','INITIALIZED');j.classInitializationState.delete('java/util/Arrays');
 const method=await j.findMethodInHierarchy('ByteEquals','drive',kind==='byte'?'([B[BI)I':'([I[II)I'),w=j.jit.wasmJit,state=w.methodState({method});w.compile({className:'ByteEquals',method},state);
 t.equal(state.status,'ready','compiles');t.ok(state.meta?.normalFlowFullyCompiled,'native equality has full normal-flow coverage');
 const ArrayType=kind==='byte'?Int8Array:Int32Array;
 const invoke=(a,b)=>{const f=new Frame(method);f.className='ByteEquals';f.locals[0]=a;f.locals[1]=b;f.locals[2]=5;const thread={id:1,status:'runnable',callStack:new CallStack()};thread.callStack.push(f);j.threads=[thread];j.currentThreadIndex=0;return w.execute(f,thread,state,0);};
 t.notOk(invoke(new ArrayType([1]),new ArrayType([1])).returned,'cold native owner exits before invocation');
 j._setClassInitializationState('java/util/Arrays','INITIALIZED');
 for(const [a,b,value] of [[null,null,5],[null,new ArrayType(1),0],[new ArrayType([1,-1]),new ArrayType([1,-1]),5],[new ArrayType([1,-1]),new ArrayType([1,0]),0]]){
  const result=invoke(a,b);t.ok(result.returned,'returns in Wasm');t.equal(result.value,value,'boolean result controls the Java loop');
 }
 t.end();
});

test('int equality preserves full words and mutations across backing types',t=>{
 const equal=require('../src/jre/java/util/Arrays').staticMethods['equals([I[I)Z'];
 for(const Type of [Array,Int32Array,Uint32Array]){
  const make=v=>Type===Array?v.slice():Type.from(v),a=make([0,1,-1,-2147483648,2147483647,256,65536]);
  const b=Int32Array.from(a);
  t.equal(equal({},null,[a,b]),1,'equal signed/unsigned representations');
  for(let i=0;i<b.length;i++){const old=b[i];b[i]^=0x01000000;t.equal(equal({},null,[a,b]),0,'high-byte difference is observed');b[i]=old;}
  t.equal(equal({},null,[a,b]),1,'restoring contents restores equality');
 }
 t.equal(equal({},null,[null,null]),1);t.equal(equal({},null,[null,[]]),0);t.equal(equal({},null,[[],null]),0);t.equal(equal({},null,[[0],[]]),0);t.end();
});
