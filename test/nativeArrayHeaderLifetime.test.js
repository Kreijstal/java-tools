'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame');
const {newFields,makeObjectRef,writeField}=require('../src/core/objectModel');
const {getOp,takeWasmReturnValue}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('native-array-header-lifetime-');

test('positive captured-array headers outlive mutable object and callback facts',async t=>{
 const classpath=compile(t,'ArrayHeaderLifetime',`
 class HeaderState {float[] data;int[] input;int a,b,c,d;}
 public class ArrayHeaderLifetime {
  static int read(HeaderState s,int n){for(int i=0;i<n;i++){s.a++;s.b++;s.c++;s.d++;s.a+=s.input[0];}return s.a;}
  static float callbacks(HeaderState s,float[][] trigger,int n){float[] data=s.data;float sum=0;for(int i=0;i<n;i++){
   sum+=read(s,0);for(int k=0;k<2;k++)sum+=data[k];float[] value=trigger[i];for(int k=0;k<2;k++)sum+=data[k]+value[k];}return sum;}
 }`);
 const j=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:true,
  wasm:{deepInline:false,maxInlineCalleeItems:1,inlineBudget:1,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();for(const owner of ['HeaderState','ArrayHeaderLifetime'])j._markClassInitialized(owner);
 const w=j.jit.wasmJit;w.importStatsEnabled=true;
 const build=(name,descriptor)=>{const method=j.findMethod(j.classes.ArrayHeaderLifetime,name,descriptor),state=w.methodState({method});
  w.compile({method,className:'ArrayHeaderLifetime'},state,{asCallee:true});t.equal(state.status,'ready',state.lastCompileError||name+' compiles');return state;};
 const read=build('read','(LHeaderState;I)I'),callbacks=build('callbacks','(LHeaderState;[[FI)F');
 t.ok(read.meta.closedNativeBody,'helper retains the established closed contract');
 t.ok(callbacks.meta.nativeObjectRegionBlockCount>0,'mixed caller earns the established regional proof');
 t.equal(callbacks.meta.nativeClosedCallSiteCount,1,'caller actually uses the closed helper');
 t.notOk(callbacks.meta.closedNativeBody,'opaque callback prevents a whole-body certificate');
 const array=(type,values)=>{const a=j.wasmHeap.alloc(type,values.length);a.type=type;a.set(values);return a;};
 const make=()=>{const o=makeObjectRef(j,'HeaderState',newFields(j,'HeaderState'));
  writeField(o.fields,'HeaderState.data',array('[F',[1,2]));writeField(o.fields,'HeaderState.input',array('[I',[3]));return o;};
 const raw=(state,args)=>{const frame=new Frame(state.method);frame.className='ArrayHeaderLifetime';state.meta.box.frame=frame;
  try{const status=state.run(...args,0,1e8);return {status,frame,value:status===-1?takeWasmReturnValue(state.meta):undefined};}finally{state.meta.box.frame=null;}};
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 const object=make(),captured=object.fields['HeaderState.data'],trigger=Object.assign([],{type:'[[F'});let calls=0;
 for(let i=0;i<3;i++)Object.defineProperty(trigger,i,{get(){calls++;captured[0]+=10;
  writeField(object.fields,'HeaderState.data',array('[F',[100,200]));return array('[F',[4,5]);}});
 const queries=callbacks.meta.importStats.get('native_body_array_header')||0;
 const result=raw(callbacks,[object,trigger,3]);
 t.equal(result.status,-1,'native mixed caller finishes');
 t.equal(result.value,135,'original captured array survives field replacement and content mutations');
 t.equal(calls,3,'all callbacks run exactly once at their original point');
 t.equal((callbacks.meta.importStats.get('native_body_array_header')||0)-queries,3,'only newly returned arrays require ownership queries');
 t.deepEqual([...object.fields['HeaderState.data']],[100,200],'replacement field remains visible');
 const changed=make(),custom=Object.assign([],{type:'[[F'});let getters=0;
 Object.defineProperty(custom,0,{get(){Object.defineProperty(changed.fields,'HeaderState.a',{configurable:true,get(){getters++;return 7;}});return array('[F',[4,5]);}});
 const refused=raw(callbacks,[changed,custom,2]);
 t.ok(refused.status>=0,'customized object revokes its old closed-call certificate');
 t.equal(getters,0,'revalidation does not invoke a custom field getter early');
 t.equal(getOp(refused.frame.instructions[refused.status].instruction),'invokestatic','refusal stays at the next original helper call');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'callbacks and refusal trigger no Java compilation');
 t.end();
});
