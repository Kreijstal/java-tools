'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame');
const Stack=require('../src/core/callStack');
const {newFields,makeObjectRef,writeField}=require('../src/core/objectModel');
const {allocMultiArray}=require('../src/instructions/object');
const {nativeObjectStorageOf,getNativeObjectStorageOps}=require('../src/core/nativeObjectStorage');
const {T,OP,uleb,takeWasmReturnValue}=require('../src/jit/wasmShared');
const {getOp}=require('../src/jit/wasmShared');
const Compiler=require('../src/jit/StructuredWasmCompiler');
const compile=require('./javaFixture').makeJavaFixtureCompiler('paired-native-storage-');

test('compiled storage pairing is revocable, receiver-bound and distinct from closed bodies',async t=>{
 if(!getNativeObjectStorageOps()||!require('../src/jit/wasmShared').supportsWasmJsTag()){
  t.pass('engine retains checked entries');t.end();return;
 }
 const bit='int b=PairBits.bytes[PairBits.cursor]>>PairBits.bit&1;PairBits.bit++;PairBits.cursor+=PairBits.bit>>3;PairBits.bit&=7;';
 const classpath=compile(t,'PairProbe',`
 final class PairBits {static byte[] bytes;static int bit,cursor;}
 final class PairBook {
  int[] tree;int[][] rows;
  final int[] vector(){int at=0;while(tree[at]>=0){${bit}at=b!=0?tree[at]:at+1;}return rows[~tree[at]];}
  final int choose(){int at=0;while(tree[at]>=0){${bit}at=b!=0?tree[at]:at+1;}return ~tree[at];}
  final int[] wrapped(){return rows[choose()];}
 }
 public class PairProbe {
  static int run(PairBook book,int n){int sum=0;for(int i=0;i<n;i++)sum+=book.vector()[0];return sum;}
  static int late(PairBook book){return book.vector()[0];}
  static int after(PairBook book){return book.vector()[0];}
  static int compact(PairBook book,int n){int sum=0;for(int i=0;i<n;i++)sum+=book.wrapped()[0];return sum;}
  static int coldProof(PairBook book,int n){int sum=0;for(int i=0;i<n;i++)sum+=book.wrapped()[0];return sum;}
  static int scalarLoop(PairBook book,int n){int sum=0;for(int i=0;i<n;i++)sum+=book.choose();return sum;}
  static int scalar(PairBook book,int[] unused){int at=0;while(book.tree[at]>=0){${bit}at=b!=0?book.tree[at]:at+1;}return ~book.tree[at];}
  static int staticRun(PairBook book,int[] extra,int n){int sum=0;for(int i=0;i<n;i++)sum+=scalar(book,extra);return sum;}
 }`);
 const j=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{enabled:false,compileWorker:false,
  retainCompilerDiagnostics:false,wasmStructured:true,wasm:{deepInline:false,maxInlineCalleeItems:1,inlineBudget:1,
   canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();for(const name of ['PairBits','PairBook','PairProbe'])j._markClassInitialized(name);
 const w=j.jit.wasmJit;w.enabled=true;w.importStatsEnabled=true;
 const build=(owner,name,descriptor)=>{const method=j.findMethod(j.classes[owner],name,descriptor),s=w.methodState({method});
  w.compile({method,className:owner},s,{asCallee:true});t.equal(s.status,'ready',s.lastCompileError||name+' compiles');return s;};
 const vector=build('PairBook','vector','()[I'),scalar=build('PairProbe','scalar','(LPairBook;[I)I');
 t.ok(vector.meta.pairedNativeStorage,'bounded stateful receiver earns entry-only proof');
 t.notOk(vector.meta.closedNativeBody,'terminal reference getter prevents a closed-body contract');
 t.deepEqual(vector.meta.pairedNativeStorage.objectParameters,[0],'proof binds exact Java reference positions');
 t.ok(Object.isFrozen(vector.meta.pairedNativeStorage),'installed proof cannot change after publication');
 const run=build('PairProbe','run','(LPairBook;I)I'),staticRun=build('PairProbe','staticRun','(LPairBook;[II)I');
 t.equal(run.meta.pairedStorageCallSiteCount,1,'instance caller selects a separately owned paired slot');
 t.equal(staticRun.meta.pairedStorageCallSiteCount,1,'static caller with array headers earns the same pairing');
 let mutation=()=>{};
 const emit=Compiler.prototype.emitCanonicalInvoke;
 try{
  Compiler.prototype.emitCanonicalInvoke=function(node,call,out){
   if(this.className==='PairProbe'&&['late','after'].includes(this.method.name)&&call.pair){
    const index=this.addImport('test_late_mutation',[],[],()=>mutation(),true);
    if(this.method.name==='after'){
     require('../src/jit/pairedNativeStorage').select(this,call,out);
     out.push(OP.call,...uleb(index),OP.call_indirect,...uleb(call.type),0);return;
    }
    out.push(OP.call,...uleb(index));
   }
   return emit.call(this,node,call,out);
  };
  build('PairProbe','late','(LPairBook;)I');build('PairProbe','after','(LPairBook;)I');
 }finally{Compiler.prototype.emitCanonicalInvoke=emit;}
 w.maxInlineCalleeItems=96;w.inlineBudget=512;
 build('PairBook','choose','()I');const wrapped=build('PairBook','wrapped','()[I');
 t.equal(wrapped.meta.inlineActivationDepth,1,'small wrapper retains its own recovered scalar loop');
 const compact=build('PairProbe','compact','(LPairBook;I)I');
 t.equal(compact.meta.inlineActivationDepth,0,'default inlining policy preserves proved small wrapper boundary');
 t.equal(compact.meta.pairedStorageCallSiteCount,1,'default policy uses real paired entry without workload flags');
 const scalarLoop=build('PairProbe','scalarLoop','(LPairBook;I)I');
 t.equal(scalarLoop.meta.inlineActivationDepth,1,'default policy preserves direct scalar-loop inlining');
 const savedProof=wrapped.meta.pairedNativeStorage;wrapped.meta.pairedNativeStorage=null;
 const coldProof=build('PairProbe','coldProof','(LPairBook;I)I');wrapped.meta.pairedNativeStorage=savedProof;
 t.equal(coldProof.meta.inlineActivationDepth,2,'missing entry proof retains supported nested reconstruction');
 t.deepEqual(coldProof.meta.deferredPairedBoundaries,['PairBook.wrapped()[I'],
  'early compilation retains only the method identity needed for preparation');
 t.ok(w.preparedPairedBoundaryReady(coldProof),'later published proof makes the preparation hint actionable');
 const settled=await j.settlePreparedWasmModules([{className:'PairProbe',method:coldProof.method,asCallee:true}]);
 t.equal(settled,1,'preparation revisits the complete early caller exactly once');
 t.equal(coldProof.meta.pairedStorageCallSiteCount,1,'settled caller uses the newly available proof');
 t.deepEqual(coldProof.meta.deferredPairedBoundaries,[],'settled body retains no stale boundary hint');
 t.notOk(w.preparedPairedBoundaryReady(coldProof),'settled caller cannot request a repeated optimization rebuild');
 t.notOk(coldProof.partialDeps,'optimization hint never turns complete code into a runtime dependency loss');
 const state=name=>w.methodState({method:j.findMethod(j.classes.PairProbe,name,'(LPairBook;)I')});
 const array=(type,values)=>{const a=j.wasmHeap.alloc(type,values.length);a.type=type;a.set(values);return a;};
 const book=value=>{const b=makeObjectRef(j,'PairBook',newFields(j,'PairBook'));
  writeField(b.fields,'PairBook.tree',array('[I',[2,-1,-2]));const rows=allocMultiArray(j,'[[I',[2,1]);
  rows[0][0]=value;rows[1][0]=value+1;writeField(b.fields,'PairBook.rows',rows);return b;};
 const bits=j.classes.PairBits.staticFields;
 const reset=()=>{bits.set('bytes:[B',array('[B',Array(32).fill(255)));bits.set('cursor:I',0);bits.set('bit:I',0);
  for(const s of [vector,scalar,run,staticRun])for(const key of s.meta.importStats.keys())s.meta.importStats.set(key,0);};
 const raw=(s,args)=>{const f=new Frame(s.method);f.className=s.key.split('.')[0];s.meta.box.frame=f;
  try{const status=s.run(...args,0,1e8);return {status,value:status===-1?takeWasmReturnValue(s.meta):undefined};}
  finally{s.meta.box.frame=null;}};
 const execute=async(s,args)=>{
  const frame=new Frame(s.method);frame.className='PairProbe';s.meta.paramSlots.forEach((p,i)=>frame.locals[p.slot]=args[i]);
  const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
  const out=w.execute(frame,thread,s,0);if(thread.callStack.isEmpty())return out.value;
  let result,steps=0;while(!thread.callStack.isEmpty()&&++steps<10000){
   const f=thread.callStack.peek(),ins=f.instructions[f.pc++].instruction;
   if(/^[ilfda]return$/.test(getOp(ins)))result=f.stack.peek();
   if(ins)try{await j.executeInstruction(ins,f,thread);}catch(error){j.handleException(error,f.pc-1,thread);}
  }
  t.ok(thread.callStack.isEmpty(),'checked continuation completes');return result;
 };
 w.freezeCompilation();const first=book(6),other=book(100),store=nativeObjectStorageOf(first,j.wasmHeap.memory);
 reset();t.deepEqual(raw(run,[first,16]),{status:-1,value:112},'native calls preserve every scalar write and array result');
 t.equal(run.meta.importStats.get('paired_object_storage'),1,'one pairing lookup per stable SSA receiver');
 t.equal(vector.meta.importStats.get('native_state_object_storage')||0,0,'paired callee entry stays in Wasm');
 t.deepEqual([bits.get('cursor:I'),bits.get('bit:I')],[2,0],'state is committed at the original instructions');
 reset();t.deepEqual(raw(staticRun,[first,array('[I',[0]),16]),{status:-1,value:16},'combined object/array ABI keeps Java positions');
 t.equal(staticRun.meta.importStats.get('paired_object_storage'),1,'static loop also pairs once');
 t.equal(scalar.meta.importStats.get('native_state_object_storage')||0,0,'static paired entry avoids host validation');
 reset();t.equal(raw(compact,[first,8]).value,56,'default paired wrapper policy preserves exact result');
 reset();t.equal(raw(scalarLoop,[first,8]).value,8,'direct scalar loop keeps exact effects');
 reset();t.equal(raw(coldProof,[first,8]).value,56,'unavailable proof retains correct nested fallback');
 reset();const forged=vector.meta.canonicalCompactStorageRun(other,store);
 t.equal(forged[0],-1,'ordinary entry with real but wrong storage completes through checked validation');
 t.equal(forged[1][0],101,'ordinary entry uses the actual receiver, never the forged payload');
 t.equal(vector.meta.importStats.get('native_state_object_storage'),1,'ordinary entry always checks receiver pairing');
 reset();t.deepEqual(run.meta.canonicalCompactStorageRun(other,2,store),[-1,202],
  'compiled caller pairs its actual receiver even when its incoming payload is forged');
 t.equal(run.meta.importStats.get('paired_object_storage'),1,'incoming metadata cannot substitute for caller provenance');
 t.equal(vector.meta.importStats.get('native_state_object_storage')||0,0,'newly proved actual pairing reaches native entry');
 // Both checks are necessary: an argument callback may run before selection,
 // or a readiness callback may run after the caller already selected its slot.
 for(const name of ['late','after']){
  const object=book(10),replacement=book(50),oldFields=object.fields,oldStore=nativeObjectStorageOf(object,j.wasmHeap.memory);
  mutation=()=>{object.fields=replacement.fields;};reset();
  t.equal(await execute(state(name),[object]),51,name+' mutation resumes using the new Java field binding');
  t.equal(getNativeObjectStorageOps().certificate(oldStore),-1,name+' mutation revokes the captured store synchronously');
  t.equal(vector.meta.importStats.get('native_state_object_storage'),1,name+' mutation retains checked entry fallback');
  t.equal(bits.get('bit:I'),1,name+' continuation executes scalar effects once');
  object.fields=oldFields;
 }
 mutation=()=>{};
 const slots=run.meta.canonicalSlots.filter(slot=>w.canonicalDirectLinks.bySlot.get(slot)?.pairedStorage);
 t.equal(slots.length,1,'paired slot participates in caller lifetime ownership');
 const link=w.canonicalDirectLinks,slot=slots[0],proof=vector.meta.pairedNativeStorage;
 t.equal(link.table.get(slot),vector.meta.canonicalPairedStorageRun,'exact proof publishes the paired export');
 vector.meta.pairedNativeStorage=null;link.publish(vector);
 t.equal(link.table.get(slot),vector.meta.canonicalCompactStorageRun,'replacement without proof publishes ordinary checked entry');
 reset();t.equal(raw(run,[first,2]).value,14,'already compiled caller remains correct after proof withdrawal');
 vector.meta.pairedNativeStorage={...proof,key:'wrong'};link.publish(vector);
 t.equal(link.table.get(slot),vector.meta.canonicalCompactStorageRun,'wrong method identity cannot publish paired entry');
 vector.meta.pairedNativeStorage=proof;link.publish(vector);link.withdraw(vector.key);
 t.equal(link.table.get(slot),link.bySlot.get(slot).stub,'withdrawal restores the original bridge');
 link.publish(vector);link.release(slots);
 t.equal(link.table.get(slot),null,'retired caller releases its paired slot');
 t.notOk(link.bySlot.has(slot),'retired slot retains no pairing metadata');
 if(global.gc){
  const compiler=new Compiler(j,run.method,'PairProbe',w);let graph,parameter;
  const translate=compiler.translateBody;
  compiler.translateBody=function(...args){const result=translate.apply(this,args);
   graph=new WeakRef(this.fn);parameter=new WeakRef(this.fn.params[0]);return result;};
  const meta=compiler.translateWith(false);
  t.equal(meta.pairedStorageCallSiteCount,1,'retention test exercises real paired imports');
  t.equal(compiler.pairedStorageCalls,undefined,'pairing discovery map is released');
  t.equal(compiler.canonicalFallbackByNode,undefined,'fallback map releases SSA call keys');
  for(let i=0;i<8;i++){await new Promise(setImmediate);global.gc();}
  t.equal(graph.deref(),undefined,'paired runtime imports do not retain the SSA graph');
  t.equal(parameter.deref(),undefined,'paired runtime imports do not retain receiver/uses graphs');
  t.ok(meta.importObject.env.paired_object_storage,'pairing helper stays live without compiler analyses');
  link.release(meta.canonicalSlots);
 }
 t.end();
});
