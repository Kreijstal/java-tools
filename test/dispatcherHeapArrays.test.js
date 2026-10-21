'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const CallStack=require('../src/core/callStack');
const {newFields,makeObjectRef,writeField}=require('../src/core/objectModel');
const compile=require('./javaFixture').makeJavaFixtureCompiler('dispatcher-heap-');
const source=`
class HeapHolder { int[] data; }
public class HeapResumeKernels {
 static int sum(int[] a,int n){int total=0;for(int i=0;i<n;i++)total+=a[i];return total;}
 static int local(int[] a,int[] b){int total=0;for(int i=0;i<4;i++){if(i==2)a=b;total+=a[i];}return total;}
 static void replace(HeapHolder h,int[] next){h.data=next;}
 static int field(HeapHolder a,HeapHolder b,int[] next){int total=0;for(int i=0;i<4;i++){if(i==2)replace(b,next);total+=a.data[i];}return total;}
 static int byteAt(byte[] a,int index,int value){a[index]=(byte)value;return a[index];}
 static int numeric(byte[] b,short[] s,char[] c,int[] a,float[] f,double[] d,long[] l){
  int sum=0;for(int i=0;i<4;i++){b[i]=(byte)(128+i);s[i]=(short)(32768+i);c[i]=(char)(65535-i);a[i]=i*3;
   f[i]=1.5f+i;d[i]=-2.25+i;l[i]=4294967297L+i;
   sum+=b[i]+s[i]+c[i]+a[i]+(int)f[i]+(int)d[i]+(int)l[i];}return sum;
 }
}`;

test('dispatcher native arrays preserve aliases, kinds, fallbacks and exceptions',async t=>{
 const classpath=compile(t,'HeapResumeKernels',source);
 const j=new JVM({classpath,wasmHeap:true,denseInstanceFields:true,jit:{compileWorker:false,wasm:{structured:false}}});
 await j.preloadClasspathClasses();j._setClassInitializationState('HeapResumeKernels','INITIALIZED');j._setClassInitializationState('HeapHolder','INITIALIZED');
 const w=j.jit.wasmJit;w.enabled=true;
 const methods={};
 for(const [name,descriptor] of [['replace','(LHeapHolder;[I)V'],['sum','([II)I'],['local','([I[I)I'],['field','(LHeapHolder;LHeapHolder;[I)I'],['byteAt','([BII)I'],['numeric','([B[S[C[I[F[D[J)I']]){
  const method=await j.findMethodInHierarchy('HeapResumeKernels',name,descriptor);
  const state=w.methodState({method});w.compile({className:'HeapResumeKernels',method},state,{asCallee:true});
  t.equal(state.status,'ready',`${name} compiles in dispatcher backend`);methods[name]={method,state};
 }
 const invoke=(name,args)=>{const {method,state}=methods[name],frame=new Frame(method);frame.className='HeapResumeKernels';args.forEach((value,i)=>frame.locals[i]=value);const thread={status:'runnable',callStack:new CallStack()};thread.callStack.push(frame);return w.execute(frame,thread,state,0).value;};
 const array=(desc,values)=>{const a=j.wasmHeap.alloc(desc,values.length);a.type=desc;a.set(values);return a;};
 const a=array('[I',[1,2,3,4]),b=array('[I',[10,20,30,40]);
 t.ok(methods.sum.state.meta.nativeArrayCacheCount>0,'native metadata cache is emitted');
 t.equal(invoke('sum',[a,4]),10,'native array reads are exact');
 t.equal(invoke('sum',[[8,7,6,5],4]),26,'plain arrays retain imported access');
 t.equal(invoke('sum',[{elements:[8,7,6,5],length:4},4]),26,'wrapped arrays retain imported access');
 const foreign=new (require('../src/core/wasmHeap').WasmHeap)(1).alloc('[I',4);foreign.set([9,8,7,6]);
 t.equal(invoke('sum',[foreign,4]),30,'another heap never aliases this memory');
 t.equal(invoke('local',[a,b]),73,'local reassignment invalidates native metadata');
 const holder=makeObjectRef(j,'HeapHolder',newFields(j,'HeapHolder'));writeField(holder.fields,'HeapHolder.data',a);
 t.equal(invoke('field',[holder,holder,b]),73,'callee writes through an alias invalidate field metadata');
 writeField(holder.fields,'HeapHolder.data',a);
 const other=makeObjectRef(j,'HeapHolder',newFields(j,'HeapHolder'));writeField(other.fields,'HeapHolder.data',a);
 t.equal(invoke('field',[holder,other,b]),10,'non-aliasing writes do not substitute another receiver array');
 const bool=array('[Z',[0]);t.equal(invoke('byteAt',[bool,0,3]),1,'boolean store masking stays on canonical import');
 t.equal(invoke('byteAt',[array('[B',[0]),0,128]),-128,'signed byte narrowing is exact');
 const arrays=['[B','[S','[C','[I','[F','[D','[J'].map(desc=>array(desc,desc==='[J'?[0n,0n,0n,0n]:[0,0,0,0]));
 let expected=0;for(let i=0;i<4;i++)expected+=(-128+i)+(-32768+i)+(65535-i)+(i*3)+Math.trunc(1.5+i)+Math.trunc(-2.25+i)+(1+i);
 t.equal(invoke('numeric',arrays),expected,'all seven primitive heap widths load and store correctly');
 for(const [args,type] of [[[null,1],'java/lang/NullPointerException'],[[a,5],'java/lang/ArrayIndexOutOfBoundsException']]){
  let error;try{invoke('sum',args);}catch(caught){error=caught;}
  t.equal(error?.type,type,'null and bounds failures retain Java exception type');
 }
 let negative;try{invoke('byteAt',[a,-1,1]);}catch(caught){negative=caught;}
 t.equal(negative?.type,'java/lang/ArrayIndexOutOfBoundsException','negative indices remain checked');
 t.end();
});
