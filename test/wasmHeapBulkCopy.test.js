'use strict';
const test = require('tape');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const {heapCopyKind} = require('../src/jit/WasmArrayCopy');
const Compiler = require('../src/jit/StructuredWasmCompiler');
const compile = makeJavaFixtureCompiler('heap-bulk-copy-');

test('heap bulk copy preserves primitive bits, overlap, bounds, and changing receivers', async t => {
  const classpath = compile(t, 'HeapBulkCopy', `public class HeapBulkCopy {
    public static void copy(Object a, int from, Object b, int to, int count) {
      for(int i=0;i<1;i++) System.arraycopy(a, from, b, to, count);
    }
    public static void alternate(Object a, Object b, int n) {
      for (int i=0;i<n;i++) {
        System.arraycopy(a, 0, b, 1, 4);
        Object old=a;a=b;b=old;
      }
    }
  }`);
  const jvm = new JVM({classpath,wasmHeap:true,jit:{compileWorker:false,wasmStructured:true,
    wasm:{heapBulkCopy:true}}});
  await jvm.preloadClasspathClasses();
  jvm.classInitializationState.set('java/lang/System','INITIALIZED');
  jvm.classInitializationState.set('HeapBulkCopy','INITIALIZED');
  const wasm = jvm.jit.wasmJit;
  const method = await jvm.findMethodInHierarchy('HeapBulkCopy','copy','(Ljava/lang/Object;ILjava/lang/Object;II)V');
  const state = wasm.methodState({method});
  wasm.compile({className:'HeapBulkCopy',method},state);
  if(state.status!=='ready')t.comment(state.lastCompileError || state.reason || JSON.stringify(state));
  t.equal(state.status,'ready','generic Object-array copy compiles');
  t.equal(state.meta?.heapCopyArrayCount,2,'both copy operands use guarded heap caches');
  if(state.status!=='ready'){t.end();return;}
  const invoke = (args,m=method,s=state) => {
    const frame=new Frame(m);frame.className='HeapBulkCopy';args.forEach((v,i)=>frame.locals[i]=v);
    const thread={status:'runnable',callStack:new Stack()};thread.callStack.push(frame);
    return wasm.execute(frame,thread,s,0);
  };
  let cases=0;
  for(const desc of ['[B','[C','[S','[I','[J','[F','[D']) {
    const src=jvm.wasmHeap.alloc(desc,12),other=jvm.wasmHeap.alloc(desc,12);
    const initial=Array.from({length:12},(_,i)=>desc==='[J'?BigInt(i-6):i-6);
    for(const same of [false,true])for(const from of [0,1,10,12,-1,2147483647])
      for(const to of [0,1,10,12,-1])for(const count of [0,1,4,12,-1,2147483647]) {
        src.set(initial);other.fill(desc==='[J'?99n:99);
        const dst=same?src:other,before=Array.from(dst),expected=before.slice();
        const valid=from>=0&&to>=0&&count>=0&&from+count<=12&&to+count<=12;
        if(valid)for(let i=0;i<count;i++)expected[to+i]=src[from+i];
        let error;try{invoke([src,from,dst,to,count]);}catch(e){error=e;}
        if((valid&&error)||(!valid&&error?.type!=='java/lang/ArrayIndexOutOfBoundsException')||
          Array.from(dst).some((v,i)=>!Object.is(v,expected[i]))) {
          t.fail(`${desc} same=${same} ${from}/${to}/${count}: ${error?.type}`);t.end();return;
        }
        cases++;
      }
  }
  t.equal(cases,2520,'primitive ranges match snapshot semantics; invalid ranges never write');
  const floats=jvm.wasmHeap.alloc('[F',3),out=jvm.wasmHeap.alloc('[F',3);
  const bits=[0x7fc01234,0x80000000,0x3f800000];
  new Uint32Array(floats.buffer,floats.byteOffset,3).set(bits);
  invoke([floats,0,out,0,3]);
  t.deepEqual([...new Uint32Array(out.buffer,out.byteOffset,3)],bits,'float NaN payload and signed zero survive');
  const a=jvm.wasmHeap.alloc('[I',5),b=jvm.wasmHeap.alloc('[I',5);a.set([1,2,3,4,5]);b.set([7,8,9,10,11]);
  let ea=[...a],eb=[...b];for(let i=0;i<7;i++){eb.splice(1,4,...ea.slice(0,4));[ea,eb]=[eb,ea];}
  // After an odd swap, local a is the original b.
  const alt=await jvm.findMethodInHierarchy('HeapBulkCopy','alternate','(Ljava/lang/Object;Ljava/lang/Object;I)V');
  const altState=wasm.methodState({method:alt});wasm.compile({className:'HeapBulkCopy',method:alt},altState);
  t.equal(altState.status,'ready','changing receiver loop compiles');
  invoke([a,b,7],alt,altState);
  t.deepEqual([...a],eb,'first receiver cache invalidates across loop assignments');
  t.deepEqual([...b],ea,'second receiver cache invalidates across loop assignments');
  t.throws(()=>invoke([null,-1,a,-1,-1]),e=>e.type==='java/lang/NullPointerException','null takes precedence over invalid bounds');
  const refs=[{},{}],target=[null,null];invoke([refs,0,target,0,2]);
  t.equal(target[0],refs[0],'reference fallback preserves identity');
  const plain=new Int32Array([4,5]);invoke([plain,0,a,0,2]);
  t.deepEqual([...a].slice(0,2),[4,5],'off-heap source uses native fallback');
  const mixed=jvm.wasmHeap.alloc('[B',2);a.set([260,-3]);invoke([a,0,mixed,0,2]);
  t.deepEqual([...mixed],[4,-3],'mixed element representations retain native conversion');
  const wrongHeap=new (require('../src/core/wasmHeap').WasmHeap)(1);
  t.equal(heapCopyKind(jvm.wasmHeap,wrongHeap.alloc('[I',2)),0,'other heap cannot select raw memory');
  const impostor=new Int32Array(jvm.wasmHeap.memory.buffer,0,2);impostor.wasmBase=8;
  t.equal(heapCopyKind(jvm.wasmHeap,impostor),0,'base must agree with actual view offset');
  const raw=new Compiler(jvm,method,'HeapBulkCopy',wasm).translate();
  let fallbackCalls=0;
  const fallback=raw.importObject.env.sys_arraycopy;
  raw.importObject.env.sys_arraycopy=(...args)=>{fallbackCalls++;return fallback(...args);};
  const rawRun=new WebAssembly.Instance(new WebAssembly.Module(raw.bytes),raw.importObject).exports.run;
  rawRun(a,0,b,0,2,0,1000000);
  t.equal(fallbackCalls,0,'valid matching heap copy does not cross the native import');
  rawRun(plain,0,b,0,2,0,1000000);
  t.equal(fallbackCalls,1,'off-heap copy reaches the instrumented fallback');
  const alias=new Int32Array(a.buffer,a.byteOffset+4,4);alias.wasmBase=alias.byteOffset;
  a.set([1,2,3,4,5]);rawRun(a,0,alias,0,4,0,1000000);
  t.deepEqual([...a],[1,1,2,3,4],'distinct overlapping heap views preserve source snapshot');
  t.equal(fallbackCalls,1,'overlapping views also copy entirely inside Wasm');
  const natives=jvm.jre['java/lang/System'].staticMethods,key='arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V',original=natives[key];
  try {
    let calls=0;natives[key]=()=>{calls++;};
    // Use the translator directly so this is a new compilation of this method.
    const meta=new Compiler(jvm,method,'HeapBulkCopy',wasm).translate();
    t.equal(meta.heapCopyArrayCount,0,'replacement native disables raw heap copying');
    new WebAssembly.Instance(new WebAssembly.Module(meta.bytes),meta.importObject).exports.run(a,0,b,0,2,0,1000000);
    t.equal(calls,1,'compiled fallback invokes the replacement native');
    natives[key]=original;
    const positional=original.jvmPositionalBody;
    try {
      original.jvmPositionalBody=()=>{calls++;};
      const replaced=new Compiler(jvm,method,'HeapBulkCopy',wasm).translate();
      t.equal(replaced.heapCopyArrayCount,0,'positional override also disables raw copying');
      new WebAssembly.Instance(new WebAssembly.Module(replaced.bytes),replaced.importObject).exports.run(a,0,b,0,2,0,1000000);
      t.equal(calls,2,'compiled fallback invokes the positional override');
    } finally {original.jvmPositionalBody=positional;}
  } finally {natives[key]=original;}
  t.end();
});
