'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const Stack=require('../src/core/stack');
const {T,NestedDeopt,parseMethodDescriptor}=require('../src/jit/wasmShared');
const {MethodTranslator}=require('../src/jit/WasmJit')._test;
const fixture=require('./javaFixture').makeJavaFixtureCompiler('deferred-casts-');

test('dispatcher casts defer typed locals and operands until unknown-class deoptimization',async t=>{
 const classpath=fixture(t,'CastFrameProof',`public class CastFrameProof {
  static int effects;
  static Object identity(Object value){effects++;return (CastTarget)value;}
  static int test(Object value){effects++;return value instanceof CastTarget?1:0;}
  static long under(long prefix,Object value){long changed=prefix+4294967297L;effects++;return changed+((CastTarget)value).number;}
  static int store(int[] out,Object value){effects++;out[1]=((int[])value)[0];return out[1];}
  static int testUnder(int prefix,Object value){int changed=prefix+9;effects++;return changed+(value instanceof CastTarget?1:0);}
 }
 class CastTarget { int number; }
 class LaterChild extends CastTarget { }
 class OtherTarget { }
 `);
 const j=new JVM({classpath,wasmHeap:true,jit:{enabled:false,codegen:false,compileWorker:false,
  retainCompilerDiagnostics:false,wasm:{structured:false,checkcast:true}}});
 await j.loadClassByName('CastFrameProof');j._markClassInitialized('CastFrameProof');
 const fields=j.classes.CastFrameProof.staticFields;fields.set('effects:I',0);
 const w=j.jit.wasmJit,prepared=new Map();
 const prepare=(name,descriptor)=>{
  const method=j.findMethod(j.classes.CastFrameProof,name,descriptor);
  const meta=new MethodTranslator(j,method,'CastFrameProof',w).translate();
  const calls=[];
  for(const [key,fn] of Object.entries(meta.importObject.env)){
   if(!/^(cast|isof)_/.test(key))continue;
   meta.importObject.env[key]=(...args)=>{calls.push({key,args});return fn(...args);};
  }
  const exports=new WebAssembly.Instance(new WebAssembly.Module(meta.bytes),meta.importObject).exports,run=exports.run;
  const invoke=args=>{
   const frame=new Frame(method);frame.className='CastFrameProof';let slot=0;
   const supplied=new Set(),params=parseMethodDescriptor(descriptor).params;
   args.forEach((value,index)=>{frame.locals[slot]=value;supplied.add(slot);slot+=params[index]==='J'||params[index]==='D'?2:1;});
   meta.box.frame=frame;let error,status;
   try{status=run(...meta.paramSlots.map(p=>{
    if(supplied.has(p.slot))return frame.locals[p.slot];
    return p.t===T.i64?0n:p.t===T.ref?null:0;
   }),0,1000000);}catch(caught){error=caught;}
   const value=exports.retv?.value;meta.box.frame=null;return {frame,error,status,value};
  };
  const result={method,meta,calls,invoke};prepared.set(name,result);return result;
 };
 const identity=prepare('identity','(Ljava/lang/Object;)Ljava/lang/Object;');
 const instance=prepare('test','(Ljava/lang/Object;)I');
 const under=prepare('under','(JLjava/lang/Object;)J');
 const store=prepare('store','([ILjava/lang/Object;)I');
 const testUnder=prepare('testUnder','(ILjava/lang/Object;)I');
 t.notOk(j.classes.CastTarget,'target stays unloaded during preparation');
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 for(const value of [null,undefined]){
  const result=identity.invoke([value]);t.equal(result.error,undefined,'nullish cast never deoptimizes');
  t.equal(result.value,null,'nullish host reference normalizes to Java null');
  t.equal(instance.invoke([value]).value,0,'nullish instanceof returns false');
 }
 t.notOk(j.classes.CastTarget,'null path never resolves its target');
 const number=4294967301n;let reads=0;
 const target={get type(){reads++;return 'CastTarget';},fields:{'CastTarget.number':19}};
 const cold=under.invoke([number,target]);
 t.ok(cold.error instanceof NestedDeopt,'unknown target takes the established deoptimization protocol');
 t.equal(reads,1,'slow-path transport never re-evaluates the type getter');
 t.deepEqual(cold.frame.stack.items,[number+4294967297n,target],'wide operand under the cast is exact');
 t.ok(cold.frame.locals.includes(number+4294967297n),'changed wide local is restored on the rare path');
 t.equal(cold.frame.instructions[cold.frame.pc].instruction.op,'checkcast','resume PC points at the original cast');
 t.equal(under.calls.filter(c=>c.key.endsWith('_deopt')).length,1,'only the unknown cast transports its frame');
 t.ok(under.calls.find(c=>c.key.endsWith('_deopt')).args.length>1,'rare path carries locals and operand state');
 t.equal(under.calls.find(c=>!c.key.endsWith('_deopt')).args.length,1,'normal type import receives only the reference');
 const resume=async result=>{
  const carrier=new Frame(result.frame.method),thread={id:0,status:'runnable',callStack:new Stack()};
  thread.callStack.push(carrier);thread.callStack.push(result.frame);j.threads=[thread];j.currentThreadIndex=0;
  w.enabled=false;let ticks=0;
  while(thread.callStack.size()>1){await j.executeTick();if(++ticks>100000)throw Error('cast continuation limit');}
  return carrier.stack.pop();
 };
 const effects=fields.get('effects:I');
 t.equal(await resume(cold),number+4294967297n+19n,'interpreter finishes the original operation after fallback');
 t.equal(fields.get('effects:I'),effects,'resuming never replays earlier effects');
 await j.loadClassByName('CastTarget');
 const warm=under.invoke([number,target]);
 t.equal(warm.status,-1,'known wide cast completes natively');t.equal(warm.value,number+4294967297n+19n,'wide under-stack value survives native success');
 t.equal(under.calls.filter(c=>c.key.endsWith('_deopt')).length,1,'warm path transports no frame');
 t.ok(under.calls.filter(c=>!c.key.endsWith('_deopt')).every(c=>c.args.length===1),'every fast call has a one-reference ABI');
 const out=new Int32Array(2),data=j.wasmHeap.alloc('[I',1);data.type='[I';data[0]=37;
 const stored=store.invoke([out,data]);
 t.equal(stored.value,37,'array receiver and index under the cast are preserved');t.equal(out[1],37,'store reaches its original destination');
 const failed=identity.invoke([{type:'java/lang/Object'}]);
 t.equal(failed.error?.type,'java/lang/ClassCastException','known incompatible class still throws CCE');
 const failedStore=store.invoke([out,{type:'java/lang/Object'}]);
 t.equal(failedStore.error?.type,'java/lang/ClassCastException','CCE beneath a pending store keeps its type');
 t.equal(out[1],37,'failed cast never performs the pending array store');
 const unknown={type:'OtherTarget'},pendingStore=store.invoke([out,unknown]);
 t.ok(pendingStore.error instanceof NestedDeopt,'unknown cast beneath a store takes the rare path');
 t.deepEqual(pendingStore.frame.stack.items,[out,1,unknown],'both receiver and index beneath an unknown cast are exact');
 const thrown={hostFailure:true};let failures=0;
 const bad={get type(){failures++;throw thrown;}};
 t.equal(identity.invoke([bad]).error,thrown,'host getter throwable preserves identity');t.equal(failures,1,'throwing getter executes once');
 const child={type:'LaterChild',fields:{'CastTarget.number':23}},late=testUnder.invoke([13,child]);
 t.ok(late.error instanceof NestedDeopt,'unknown source also deoptimizes');
 t.deepEqual(late.frame.stack.items,[22,child],'integer operand beneath instanceof is reconstructed');
 const before=fields.get('effects:I');
 t.equal(await resume(late),23,'loaded subclass makes the original instanceof true');
 t.ok(j.classes.LaterChild,'interpreter really loaded the unknown source hierarchy');
 t.equal(fields.get('effects:I'),before,'instanceof resumption never replays effects');
 t.equal(testUnder.invoke([13,child]).value,23,'later known source uses the same prepared import');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'all resumptions remain compilation-free');
 t.end();
});
