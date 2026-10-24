'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame'),Stack=require('../src/core/callStack');
const {makeObjectRef,newFields,readField}=require('../src/core/objectModel');
const {takeWasmReturnValue,getOp,Unsupported}=require('../src/jit/wasmShared');
const {addMultiANewArrayImport}=require('../src/jit/wasmRuntimeImports');
const compile=require('./javaFixture').makeJavaFixtureCompiler('wasm-multi-array-');

test('multidimensional allocation validates its shape before registering an import',t=>{
 const imports=[],reg={addImport(name,params,results,fn){imports.push({name,params,results,fn});return imports.length-1;}};
 for(const arg of [null,['I',1],['[[I',0],['[[I',3],['[[V',2],['[[I',1.5],['[[I','2x']])
  t.throws(()=>addMultiANewArrayImport(reg,{},arg),e=>e instanceof Unsupported,'invalid descriptor/dimension pair is rejected');
 t.equal(imports.length,0,'invalid input never publishes an import');
 addMultiANewArrayImport(reg,{},['[[Lalpha_beta/Gamma;',2]);
 addMultiANewArrayImport(reg,{},['[[Lalpha/beta_Gamma;',2]);
 t.notEqual(imports[0].name,imports[1].name,'distinct class descriptors cannot collide after name encoding');
 t.equal(imports[0].params.length,2,'one typed parameter per allocated dimension');t.end();
});

test('both Wasm backends allocate full and partial Java array dimensions',async t=>{
 const kinds={I:'int',J:'long',F:'float',D:'double',B:'byte',S:'short',C:'char',Z:'boolean'};
 const classpath=compile(t,'MultiArrayKernels',`
 public class MultiArrayKernels {
  static int order,initializations;
  ${Object.entries(kinds).map(([tag,type])=>`static Object matrix${tag}(int a,int b){return new ${type}[a][b];}`).join('\n')}
  static Object partial(int a,int b){return new int[a][b][];}
  static Object cube(int a,int b,int c){return new double[a][b][c];}
  static Object references(int a,int b){return new ArrayComponent[a][b];}
  static int mark(int digit,int value){order=order*10+digit;return value;}
  static int caught(int a,int b){int prefix=17;order=0;try{
   int[][] values=new int[mark(1,a)][mark(2,b)];return prefix+values.length;
  }catch(NegativeArraySizeException e){return prefix+order;}}
 }
 class ArrayComponent {static {MultiArrayKernels.initializations++;}}
 class MatrixConstructor {
  int[][] values;
  MatrixConstructor(int a,int b){values=new int[a][b];for(int i=0;i<a;i++)for(int k=0;k<b;k++)values[i][k]=i*100+k;}
 }`);
 for(const structured of [true,false]){
  const j=new JVM({classpath,wasmHeap:true,wasmFields:true,prepareBeforeMain:false,
   jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,wasmStructured:structured,
    wasm:{structured,compileConstructors:true,deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
  await j.preloadClasspathClasses();for(const name of ['MultiArrayKernels','MatrixConstructor'])j._markClassInitialized(name);
  j.classes.MultiArrayKernels.staticFields.set('initializations:I',0);
  j.classes.MultiArrayKernels.staticFields.set('order:I',0);
  const w=j.jit.wasmJit,label=structured?'structured':'dispatcher';
  const build=(owner,name,descriptor)=>{const method=j.findMethod(j.classes[owner],name,descriptor),state=w.methodState({method});
   w.compile({method,className:owner},state,{asCallee:true});
   t.equal(state.status,'ready',state.lastCompileError||label+' '+name+' compiles');return state;};
  const methods=Object.fromEntries(Object.keys(kinds).map(tag=>[tag,build('MultiArrayKernels','matrix'+tag,'(II)Ljava/lang/Object;')]));
  const partial=build('MultiArrayKernels','partial','(II)Ljava/lang/Object;'),references=build('MultiArrayKernels','references','(II)Ljava/lang/Object;');
  const cube=build('MultiArrayKernels','cube','(III)Ljava/lang/Object;');
  build('MultiArrayKernels','mark','(II)I');const caught=build('MultiArrayKernels','caught','(II)I');
  const ctor=build('MatrixConstructor','<init>','(II)V');
  const raw=(state,args)=>{const frame=new Frame(state.method);frame.className=state.key.split('.')[0];
   state.meta.paramSlots.forEach((p,i)=>frame.locals[p.slot]=args[i]);state.meta.box.frame=frame;
   try{const status=state.run(...args,0,100000000);return {status,value:status===-1?takeWasmReturnValue(state.meta):undefined,frame};}
   catch(error){return {error,frame};}finally{state.meta.box.frame=null;}};
  const finish=async(state,args)=>{const frame=new Frame(state.method);frame.className='MultiArrayKernels';
   state.meta.paramSlots.forEach((p,i)=>frame.locals[p.slot]=args[i]);
   const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(frame);j.threads=[thread];j.currentThreadIndex=0;
   let value=w.execute(frame,thread,state,0).value,steps=0;
   while(!thread.callStack.isEmpty()&&++steps<5000){const f=thread.callStack.peek(),ins=f.instructions[f.pc++].instruction;
    if(getOp(ins)==='ireturn')value=f.stack.peek();
    if(ins)try{await j.executeInstruction(ins,f,thread);}catch(e){j.handleException(e,f.pc-1,thread);}}
   t.ok(thread.callStack.isEmpty(),label+' exact handler continuation finishes');return value;};
  w.enabled=true;w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
  for(const [tag,state]of Object.entries(methods)){
   t.ok(state.meta.normalFlowFullyCompiled,label+' '+tag+' allocation is compiled');
   const result=raw(state,[2,3]);t.equal(result.status,-1,label+' '+tag+' allocation returns natively');
   const a=result.value;t.equal(a?.type,'[['+tag,label+' outer array has exact runtime type');
   t.deepEqual(a&&[a.length,a[0].length,a[1].length],[2,3,3],label+' dimension order is preserved');
   t.notEqual(a?.[0],a?.[1],label+' rows have independent Java identities');
   t.ok(a&&Array.from(a[0]).every(v=>v===0||v===0n||v===false),label+' fresh leaves are zeroed');
  }
  const p=raw(partial,[2,3]).value;
  t.deepEqual([p?.type,p?.[0].type,p?.length,p?.[0].length,p?.[0][0]],['[[[I','[[I',2,3,null],label+' unallocated dimensions remain null references');
  const c=raw(cube,[2,3,4]).value;
  t.deepEqual(c&&[c.length,c[0].length,c[0][0].length,c[0][0].type,c[1][2][3]],[2,3,4,'[D',0],label+' all three dimensions retain order and leaf type');
  const ref=raw(references,[2,3]).value;
  t.equal(ref?.[0].type,'[LArrayComponent;',label+' reference leaves retain their class');
  t.equal(ref?.[0][0],null,label+' reference leaf default is null');
  t.notEqual(j.classInitializationState.get('ArrayComponent'),'INITIALIZED',label+' array allocation does not initialize the component class');
  t.equal(j.classes.MultiArrayKernels.staticFields.get('initializations:I'),0,label+' component initializer never executes');
  t.equal(raw(methods.I,[0,3]).value?.length,0,label+' zero outer dimension is legal');
  t.equal(raw(methods.I,[2,0]).value?.[0].length,0,label+' zero inner dimension is legal');
  for(const args of [[-1,2],[2,-1],[0,-1]]){
   const before=j.nextHashCode,result=raw(methods.I,args);
   t.equal(result.error?.type,'java/lang/NegativeArraySizeException',label+' negative dimension throws '+args);
   t.equal(j.nextHashCode,before,label+' all dimensions are checked before creating any Java array');
   t.equal(await finish(caught,args),29,label+' both dimension effects precede the original catch');
  }
  t.equal(await finish(caught,[2,3]),19,label+' successful evaluation preserves the original prefix');
  const receiver=makeObjectRef(j,'MatrixConstructor',newFields(j,'MatrixConstructor'));
  t.ok(ctor.meta.normalFlowFullyCompiled,label+' allocation no longer demotes the constructor');
  const result=raw(ctor,[receiver,2,3]);t.equal(result.status,-1,label+' constructor finishes in Wasm');
  t.equal(readField(receiver.fields,'MatrixConstructor.values')?.[1][2],102,label+' constructor loop fills the allocated matrix');
  t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,label+' all cases use prepared code');
 }
 t.end();
});
