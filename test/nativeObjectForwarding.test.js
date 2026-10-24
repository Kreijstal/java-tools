'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame'),CallStack=require('../src/core/callStack');
const {newFields,makeObjectRef,writeField}=require('../src/core/objectModel');
const {getNativeObjectStorageOps,nativeObjectStorageOf}=require('../src/core/nativeObjectStorage');
const {T}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('native-object-forwarding-');

test('native call chains forward storage and release every publication',async t=>{
 if(!getNativeObjectStorageOps() || !require('../src/jit/wasmShared').supportsWasmJsTag()){t.pass('engine retains checked field and call fallbacks');t.end();return;}
 const classpath=compile(t,'NativeForwarding',`
class ForwardedObject {int[] data;int seed;int value(int i){return data[i]+seed;}}
class LaterForwarded extends ForwardedObject {int value(int i){return data[i]+seed+100;}}
class ColdForwarded {static int read(ForwardedObject o){return o.seed;}}
public class NativeForwarding {
 static int read(ForwardedObject o,int i){return o.value(i);}
 static int relay(ForwardedObject o,int i){return read(o,i)+1;}
 static int loop(ForwardedObject o,int n){int total=0;for(int i=0;i<n;i++)total+=relay(o,1);return total;}
 static int recursive(ForwardedObject o,int n){if(n==0)return read(o,1);return recursive(o,n-1)+1;}
 static int cold(ForwardedObject o){return ColdForwarded.read(o);}
 static long wide(long start,ForwardedObject a,double factor,ForwardedObject b){return start+(long)(a.seed*factor)+b.seed;}
 static long wideRelay(ForwardedObject a,ForwardedObject b){return wide(9007199254740993L,a,1.5,b);}
}`);
 const j=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:true,
  wasm:{deepInline:false,maxInlineCalleeItems:1,inlineBudget:1,noOnDemandCalleeCompile:true,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 for(const owner of ['NativeForwarding','ForwardedObject','ColdForwarded'])await j.loadClassByName(owner);
 for(const owner of ['NativeForwarding','ForwardedObject','ColdForwarded'])j._markClassInitialized(owner);
 const w=j.jit.wasmJit;w.importStatsEnabled=true;
 const prepare=(owner,name,desc)=>{const method=j.findMethod(j.classes[owner],name,desc),s=w.methodState({method});
  w.compile({method,className:owner},s,{asCallee:true});t.equal(s.status,'ready',s.lastCompileError||name+' compiles');return s;};
 const value=prepare('ForwardedObject','value','(I)I'),read=prepare('NativeForwarding','read','(LForwardedObject;I)I'),relay=prepare('NativeForwarding','relay','(LForwardedObject;I)I'),loop=prepare('NativeForwarding','loop','(LForwardedObject;I)I'),recursive=prepare('NativeForwarding','recursive','(LForwardedObject;I)I');
 prepare('ColdForwarded','read','(LForwardedObject;)I');const cold=prepare('NativeForwarding','cold','(LForwardedObject;)I');
 const wide=prepare('NativeForwarding','wide','(JLForwardedObject;DLForwardedObject;)J');
 const wideRelay=prepare('NativeForwarding','wideRelay','(LForwardedObject;LForwardedObject;)J');
 const array=j.wasmHeap.alloc('[I',2);array.type='[I';array.set([3,5]);
 const object=owner=>{const o=makeObjectRef(j,owner,newFields(j,owner));writeField(o.fields,'ForwardedObject.data',array);writeField(o.fields,'ForwardedObject.seed',7);return o;};
 const o=object('ForwardedObject');
 t.deepEqual(read.meta.parameterObjectABI,[0],'native storage signature describes reference arguments only');
 t.equal(read.meta.canonicalCompactStorageRun.length,3,'native entry adds one private metadata argument');
 t.equal(read.meta.canonicalCompactRun.length,2,'legacy compact entry keeps its Java signature');
 t.equal(read.meta.runv.length,2,'raw linked entry keeps its Java signature');
 const binding=w.canonicalDirectLinks.bindings.get(read.key).find(b=>b.parameterObjectABI.length);
 t.equal(w.canonicalDirectLinks.table.get(binding.slot),read.meta.canonicalCompactStorageRun,
  'native call slot publishes the parameter entry itself');
 t.deepEqual(binding.params.at(-1),[0x63,1],'private parameter is a nullable canonical GC storage reference');
 const untyped=w.canonicalDirectLinks.allocate(read.key,[T.ref,T.i32,T.ref],[T.i32],()=>0,[],true,[],null,[0]);
 w.canonicalDirectLinks.publish(read);
 t.equal(w.canonicalDirectLinks.table.get(untyped),w.canonicalDirectLinks.bySlot.get(untyped).stub,
  'matching Java positions cannot publish an untyped storage signature');
 w.canonicalDirectLinks.release([untyped]);
 const wrong=w.canonicalDirectLinks.allocate(read.key,[T.ref,T.i32,[0x63,1]],[T.i32],()=>0,[],true,[],null,[1]);
 w.canonicalDirectLinks.publish(read);
 t.equal(w.canonicalDirectLinks.table.get(wrong),w.canonicalDirectLinks.bySlot.get(wrong).stub,
  'a different reference-position identity cannot publish the native entry');
 w.canonicalDirectLinks.release([wrong]);
 const storage=nativeObjectStorageOf(o,j.wasmHeap.memory),legacy=w.objectStorageInputs(read.key,read.method.descriptor,true)[0].value;
 legacy.value=storage;
 t.deepEqual(read.meta.canonicalCompactRun(o,1),[-1,12],'legacy publication remains consumable by the original entry');
 t.equal(legacy.value,null,'legacy bridge consumes and releases its metadata');
 t.deepEqual(read.meta.runv(o,1),[-1,12],'raw linked entry reconstructs absent native metadata');
 t.deepEqual(read.meta.canonicalCompactStorageRun(o,1,storage),[-1,12],'new entry consumes the same original Java arguments');
 t.deepEqual(read.meta.canonicalCompactStorageRun(o,1,null),[-1,12],'missing typed metadata keeps original lazy capture');
 const fuel=loop.meta.canonicalFuel.value;loop.meta.canonicalFuel.value=0;
 const [status]=loop.meta.canonicalCompactStorageRun(o,2,storage);
 t.ok(status>=0,'new metadata entry can yield before guest progress');
 const transfer=w.canonicalDirectLinks.takeExit(status),spilled=transfer.owner.take(transfer.id);
 t.equal(spilled.locals[0],o,'fuel spill retains original Java receiver identity');
 t.equal(spilled.locals[1],2,'fuel spill retains scalar argument position');
 loop.meta.canonicalFuel.value=fuel;
 const run=(s,args)=>{const f=new Frame(s.method);f.className='NativeForwarding';args.forEach((v,i)=>f.locals[i]=v);const thread={id:0,status:'runnable',callStack:new CallStack()};thread.callStack.push(f);return w.execute(f,thread,s,0).value;};
 const reset=()=>{for(const s of [value,read,relay,loop,recursive])for(const key of s.meta.importStats.keys())s.meta.importStats.set(key,0);};
 const released=label=>t.ok([...w.nativeObjectInputGlobals.values()].flat().every(input=>input.value.value===null),label);
 reset();t.equal(run(loop,[o,40]),520,'static and virtual native chains keep exact result');
 t.equal(loop.meta.importStats.get('object_storage'),1,'outer call performs one storage lookup');
 for(const s of [value,read,relay])t.equal(s.meta.importStats.get('object_storage')||0,0,s.method.name+' receives native storage with no host lookup');
 t.notOk([...read.meta.importStats].some(([name,count])=>name.startsWith('canonical_guard_')&&count),
  'native class identity avoids JavaScript receiver guards');
 released('normal return releases every native input');
 const plain={type:'ForwardedObject',fields:{'ForwardedObject.data':array,'ForwardedObject.seed':9}};
 t.deepEqual(wide.meta.parameterObjectABI,[1,3],'reference positions are independent of wide Java local slots');
 t.equal(run(wideRelay,[o,o]),9007199254741010n,'two captured stores preserve exact long and double argument positions');
 t.equal(run(wideRelay,[o,plain]),9007199254741012n,'mixed captured and checked stores keep their original arguments');
 t.equal(run(read,[plain,1]),14,'uncaptured plain storage keeps the checked fallback');
 let nullError;try{run(read,[null,1]);}catch(e){nullError=e;}
 t.equal(nullError?.type,'java/lang/NullPointerException','native parameter signature preserves null dispatch failure');
 reset();t.equal(run(recursive,[o,12]),24,'recursive native calls preserve independent storage locals');released('recursion releases input globals');
 w.canonicalDirectLinks.withdraw(read.key);t.equal(run(relay,[o,1]),13,'withdrawn native target retains existing bridge');released('fallback bridge releases publication before callbacks');
 let error;try{run(loop,[o,1]);run(read,[o,3]);}catch(e){error=e;}
 t.equal(error?.type,'java/lang/ArrayIndexOutOfBoundsException','guest exception remains exact across native chain');released('throw releases input globals');
 j.classInitializationState.set('ColdForwarded','LOADED');
 const refused=cold.meta.canonicalRun(o);
 t.notEqual(refused[0],-1,'cold static owner still refuses execution');released('cold refusal releases unconsumed inputs');
 if(refused[0]>=0)refused[2].take(refused[1]);
 j._markClassInitialized('ColdForwarded');t.equal(run(cold,[o]),7,'initialized owner uses the same storage contract');
 await j.loadClassByName('LaterForwarded');j._markClassInitialized('LaterForwarded');prepare('LaterForwarded','value','(I)I');
 t.equal(run(read,[object('LaterForwarded'),1]),112,'later override retains dynamic dispatch');released('virtual guard miss leaves no native roots');
 w.importStatsEnabled=false;const native=prepare('ForwardedObject','value','(I)I');
 t.notOk(native.meta.importObject.env.native_object_reference,
  'production field access is inline Wasm GC without a helper call');
 t.equal(run(loop,[o,3]),39,'compiled callers use safely republished storage entries after replacement');
 t.end();
});
