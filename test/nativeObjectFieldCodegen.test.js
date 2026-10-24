'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame'),CallStack=require('../src/core/callStack');
const {newFields,makeObjectRef,readField,writeField,slabLayoutFor}=require('../src/core/objectModel');
const compile=require('./javaFixture').makeJavaFixtureCompiler('native-object-fields-');

test('native object references share exact fields, captures and heap ownership',async t=>{
 if(!require('../src/core/nativeObjectStorage').getNativeObjectStorageOps() || !require('../src/jit/wasmShared').supportsWasmJsTag()){t.pass('engine retains checked field and call fallbacks');t.end();return;}
 const classpath=compile(t,'NativeObjectKernels',`
class NativeFieldBase { int seed; int phase; int[] data; Object link; }
class NativeFieldChild extends NativeFieldBase { long wide; int[] other; Object peer; }
class NativeFieldLater extends NativeFieldBase { }
public class NativeObjectKernels {
 static int read(NativeFieldBase b,int i){return b.data[i]+b.seed;}
 static NativeFieldBase cast(Object o){return (NativeFieldBase)o;}
 static boolean instance(Object o){return o instanceof NativeFieldBase;}
 static Object identity(NativeFieldBase b){return b.link;}
 static void replace(NativeFieldBase b,int[] next){b.data=next;}
 static int captured(NativeFieldBase a,NativeFieldBase b,int[] next){int[] old=a.data;replace(b,next);int[] fresh=a.data;return old[0]+fresh[0];}
 static int repeated(NativeFieldBase b){b.seed+=3;b.phase+=b.seed;return b.seed+b.phase+b.seed;}
 static int arrayLoop(NativeFieldBase b,int n){int total=0;for(int i=0;i<n;i++)total+=b.data[i];return total;}
 static int switching(NativeFieldBase a,NativeFieldBase b,int n){int sum=0;
  for(int i=0;i<n;i++){NativeFieldBase current=(i&1)==0?a:b;
   current.seed++;current.phase+=current.seed;sum+=current.seed+current.phase;}return sum;}
}`);
 const j=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:true,
  wasm:{checkcast:true,deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 for(const c of ['NativeObjectKernels','NativeFieldBase','NativeFieldChild'])await j.loadClassByName(c);for(const c of ['NativeObjectKernels','NativeFieldBase','NativeFieldChild'])j._markClassInitialized(c);
 const w=j.jit.wasmJit;w.importStatsEnabled=true;
 const prepare=(name,desc)=>{const method=j.findMethod(j.classes.NativeObjectKernels,name,desc),s=w.methodState({method});
  w.compile({method,className:'NativeObjectKernels'},s,{asCallee:true});t.equal(s.status,'ready',s.lastCompileError||name+' compiles');return s;};
 const cast=prepare('cast','(Ljava/lang/Object;)LNativeFieldBase;'),instance=prepare('instance','(Ljava/lang/Object;)Z');
 prepare('replace','(LNativeFieldBase;[I)V');const read=prepare('read','(LNativeFieldBase;I)I'),identity=prepare('identity','(LNativeFieldBase;)Ljava/lang/Object;'),captured=prepare('captured','(LNativeFieldBase;LNativeFieldBase;[I)I');
 const repeated=prepare('repeated','(LNativeFieldBase;)I'),switching=prepare('switching','(LNativeFieldBase;LNativeFieldBase;I)I');
 const arrayLoop=prepare('arrayLoop','(LNativeFieldBase;I)I');
 const array=(vm,values)=>{const a=vm.wasmHeap.alloc('[I',values.length);a.type='[I';a.set(values);return a;};
 const object=(vm,owner,a)=>{const o=makeObjectRef(vm,owner,newFields(vm,owner));writeField(o.fields,'NativeFieldBase.data',a);writeField(o.fields,'NativeFieldBase.seed',7);return o;};
 const a=array(j,[1,2,3]),b=array(j,[10,20,30]),o=object(j,'NativeFieldChild',a),other=object(j,'NativeFieldBase',a);
 const run=(s,args)=>{const f=new Frame(s.method);f.className='NativeObjectKernels';args.forEach((v,i)=>f.locals[i]=v);const thread={id:0,status:'runnable',callStack:new CallStack()};thread.callStack.push(f);return w.execute(f,thread,s,0).value;};
 t.ok(slabLayoutFor(j,'NativeFieldChild').nativeOps,'test uses native GC field storage');
 t.equal(run(read,[o,1]),9,'inherited array and primitive fields use original values');
 t.equal(run(arrayLoop,[o,3]),6,'repeated native instance fields retain exact array values');
 t.ok(read.meta.nativeObjectReferenceSites>0,'reference field reads use native helpers');
 for(const name of ['gf_NativeFieldBase_data','gf_NativeFieldBase_seed','abase','alen0','obase'])t.equal(read.meta.importStats.get(name)||0,0,'native path avoids host '+name);
 t.equal(read.meta.importStats.get('object_storage'),1,'one nonthrowing storage lookup serves the invocation');
 writeField(o.fields,'NativeFieldBase.link',other);t.equal(run(identity,[o]),other,'object reference identity survives native access');
 t.equal(run(captured,[o,o,b]),11,'captured reference survives aliased replacement and refill');
 t.equal(readField(o.fields,'NativeFieldBase.data'),b,'native setter updates named host field access');
 writeField(o.fields,'NativeFieldBase.data',a);t.equal(run(captured,[o,other,b]),2,'non-aliasing field writes preserve original receiver');
 writeField(o.fields,'NativeFieldBase.data',null);let thrown;try{run(read,[o,0]);}catch(e){thrown=e;}
 t.equal(thrown?.type,'java/lang/NullPointerException','null array retains Java exception');
 writeField(o.fields,'NativeFieldBase.data',a);thrown=undefined;try{run(read,[o,3]);}catch(e){thrown=e;}
 t.equal(thrown?.type,'java/lang/ArrayIndexOutOfBoundsException','native metadata retains bounds checks');
 writeField(o.fields,'NativeFieldBase.data',[4,8]);t.equal(run(read,[o,1]),15,'plain arrays keep checked access');
 const foreign=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{compileWorker:false}});await foreign.preloadClasspathClasses();
 const foreignObject=object(foreign,'NativeFieldChild',array(foreign,[9,11]));
 t.equal(run(read,[foreignObject,1]),18,'foreign object and array memory cannot alias local storage');
 t.ok(cast.meta.nativeCastSites>0,'cast recognizes a bounded native class set');
 t.equal(run(cast,[o]),o,'native cast preserves exact object identity');
 t.equal(run(instance,[o]),1,'native instanceof recognizes subclass');
 for(const state of [cast,instance])t.notOk([...state.meta.importStats].some(([name,count])=>/^(cast|isof)_/.test(name)&&count),'matching native class uses no host cast');
 t.equal(run(cast,[null]),null,'null cast remains legal');t.equal(run(instance,[null]),0,'null instanceof remains false');
 t.equal(run(cast,[foreignObject]),foreignObject,'foreign storage uses ordinary checked cast');
 const marker=makeObjectRef(j,'NativeObjectKernels',newFields(j,'NativeObjectKernels'));let castError;
 try{run(cast,[marker]);}catch(e){castError=e;}
 t.equal(castError?.type,'java/lang/ClassCastException','nonmatching native class retains guest CCE');
 t.equal(run(instance,[marker]),0,'nonmatching native class returns false');
 await j.loadClassByName('NativeFieldLater');const late=object(j,'NativeFieldLater',a);
 t.equal(run(cast,[late]),late,'later subclass falls back with correct identity');t.equal(run(instance,[late]),1,'later subclass uses existing hierarchy resolution');
 o.fields={'NativeFieldBase.data':a,'NativeFieldBase.seed':100};t.equal(run(read,[o,1]),102,'host field-container replacement revokes native storage');
 const alias=new Int32Array(j.wasmHeap.memory.buffer,a.byteOffset,3);
 alias.type='[I';alias.wasmBase=alias.byteOffset;let aliasLengths=0;
 Object.defineProperty(alias,'length',{get(){aliasLengths++;return 3;}});
 o.fields['NativeFieldBase.data']=alias;
 t.equal(run(arrayLoop,[o,3]),6,'replaced field containers keep checked positive-base views');
 t.equal(aliasLengths,3,'instance fallback never caches away foreign length getters');
 writeField(other.fields,'NativeFieldBase.phase',2);
 t.ok(repeated.meta.omittedSlabFillCount>0,'repeated primitive fields use the proved filled base');
 t.equal(run(repeated,[other]),32,'native reads observe earlier writes to the same receiver');
 t.equal(readField(other.fields,'NativeFieldBase.seed'),10,'native writes keep named host fields coherent');
 t.equal(run(repeated,[o]),309,'replaced field containers retain checked getter/setter behavior');
 const left=object(j,'NativeFieldChild',a),right=object(j,'NativeFieldBase',a);
 writeField(left.fields,'NativeFieldBase.seed',2);writeField(right.fields,'NativeFieldBase.seed',11);
 let expected=0;const values=[{seed:2,phase:0},{seed:11,phase:0}];
 for(let i=0;i<6;i++){const value=values[i&1];value.seed++;value.phase+=value.seed;expected+=value.seed+value.phase;}
 t.equal(run(switching,[left,right,6]),expected,'loop-carried receiver changes invalidate its filled proof');
 t.equal(readField(left.fields,'NativeFieldBase.phase'),values[0].phase,'left alias retains its own field block');
 t.equal(readField(right.fields,'NativeFieldBase.phase'),values[1].phase,'right alias retains its own field block');
 t.equal(run(repeated,[foreignObject]),30,'foreign field blocks still take the checked representation fallback');
 let nullError;try{run(repeated,[null]);}catch(error){nullError=error;}
 t.equal(nullError?.type,'java/lang/NullPointerException','first field still throws on null');
 t.end();
});
