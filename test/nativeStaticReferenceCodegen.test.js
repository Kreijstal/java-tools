'use strict';
// Tests a JS or partial-Wasm tier: the closed-world module would take its methods.
process.env.JVM_CLOSED_WORLD = '0';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const CallStack=require('../src/core/callStack');
const compile=require('./javaFixture').makeJavaFixtureCompiler('native-reference-codegen-');

test('native reference reads capture array headers at the exact field read',async t=>{
 const classpath=compile(t,'NativeReferenceKernels',`
public class NativeReferenceKernels {
 static int[] data;
 static int read(int i){return data[i];}
 static void replace(int[] next){data=next;}
 static int captured(int[] next){int[] old=data;replace(next);int[] fresh=data;return old[0]+fresh[0];}
 static int nullable(boolean use){int[] a=data;return use?a[0]:17;}
 static int repeated(int[] first,int[] second){int total=0;for(int i=0;i<4;i++){data=(i&1)==0?first:second;total+=data[i];}return total;}
 static int progress;
 static int loop(int n){int total=0;for(int i=0;i<n;i++){progress++;total+=data[i];}return total;}
}`);
 const j=new JVM({classpath,wasmHeap:true,jit:{compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:true,
  wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j._markClassInitialized('NativeReferenceKernels');
 const w=j.jit.wasmJit;w.importStatsEnabled=true;
 const prepare=(name,desc)=>{const method=j.findMethod(j.classes.NativeReferenceKernels,name,desc),s=w.methodState({method});
  w.compile({method,className:'NativeReferenceKernels'},s,{asCallee:true});t.equal(s.status,'ready',s.lastCompileError||name+' compiles');return s;};
 prepare('replace','([I)V');const read=prepare('read','(I)I'),captured=prepare('captured','([I)I'),nullable=prepare('nullable','(Z)I'),repeated=prepare('repeated','([I[I)I');
 const loop=prepare('loop','(I)I');
 const fields=j.classes.NativeReferenceKernels.staticFields;
 const array=values=>{const a=j.wasmHeap.alloc('[I',values.length);a.type='[I';a.set(values);return a;};
 const a=array([1,2,3,4]),b=array([10,20,30,40]);
 const run=(s,args)=>{const frame=new Frame(s.method);frame.className='NativeReferenceKernels';args.forEach((v,i)=>frame.locals[i]=v);
  const thread={id:0,status:'runnable',callStack:new CallStack()};thread.callStack.push(frame);return w.execute(frame,thread,s,0).value;};
 fields.set('data:[I',a);t.equal(run(read,[2]),3,'native static array returns exact element');
 t.equal(run(loop,[4]),10,'repeated native field reads preserve exact elements');
 t.ok(read.meta.nativeStaticReferenceReadSites>0,'compiler installs native reference reads');
 t.equal(read.meta.importStats.get('gs_NativeReferenceKernels_data')||0,0,'field read uses no host callback');
 t.equal(read.meta.importStats.get('abase')||0,0,'array base comes from captured native header');
 t.equal(read.meta.importStats.get('alen0')||0,0,'array length comes from captured native header');
 t.equal(run(captured,[b]),11,'old reference survives replacement and sibling refill');
 t.equal(fields.get('data:[I'),b,'compiled setter updates canonical Map value');
 t.equal(run(repeated,[a,b]),64,'successive replacements refresh headers within a loop');
 fields.set('data:[I',null);t.equal(run(nullable,[0]),17,'unused null field does not throw');
 let error;try{run(nullable,[1]);}catch(caught){error=caught;}
 t.equal(error?.type,'java/lang/NullPointerException','null throws at original array access');
 fields.set('data:[I',a);error=undefined;try{run(read,[4]);}catch(caught){error=caught;}
 t.equal(error?.type,'java/lang/ArrayIndexOutOfBoundsException','native header retains bounds checks');
 fields.set('data:[I',[9,8,7]);t.equal(run(read,[1]),8,'plain arrays retain checked access');
 const foreign=new (require('../src/core/wasmHeap').WasmHeap)(1).alloc('[I',3);foreign.set([7,9,11]);fields.set('data:[I',foreign);
 t.equal(run(read,[1]),9,'foreign arrays never alias this memory');
 let calls=0;const cell=fields.cell('data:[I');
 Object.defineProperty(cell,'value',{configurable:true,get(){calls++;return a;}});
 t.equal(calls,0,'descriptor change executes no getter early');t.equal(run(read,[3]),4,'revoked native field uses custom getter result');
 t.equal(calls,1,'custom getter executes once');
 const alias=new Int32Array(j.wasmHeap.memory.buffer,a.byteOffset,4);
 alias.type='[I';alias.wasmBase=alias.byteOffset;let lengths=0;
 Object.defineProperty(alias,'length',{configurable:true,get(){lengths++;return 4;}});
 Object.defineProperty(cell,'value',{configurable:true,get(){return alias;}});
 t.equal(run(loop,[4]),10,'customized field retains a checked positive-base view');
 t.equal(lengths,4,'unknown field headers never suppress observable length queries');
 lengths=0;fields.set('progress:I',0);
 Object.defineProperty(alias,'length',{configurable:true,get(){lengths++;return lengths<3?4:2;}});
 error=undefined;try{run(loop,[4]);}catch(caught){error=caught;}
 t.equal(error?.type,'java/lang/ArrayIndexOutOfBoundsException','changing foreign length throws at the original access');
 t.equal(lengths,3,'failing foreign access queries length exactly once');
 t.equal(fields.get('progress:I'),3,'effects before the failing access execute once');
 t.end();
});
