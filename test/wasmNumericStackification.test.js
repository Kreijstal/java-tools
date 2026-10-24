'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm'),Frame=require('../src/core/frame');
const Compiler=require('../src/jit/StructuredWasmCompiler');
const stackify=require('../src/jit/stackifyNumericValues');
const {takeWasmReturnValue}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('numeric-stackification-');
test('numeric stackification preserves operands, frame state, widths and observable producers',async t=>{
 const source=`public class NumericExpressions {
  static int sum(int a,int b,int count){int sum=0;for(int i=0;i<count;i++)sum+=((a+i)*3^(b-i))+(a-b)*5;return sum;}
  static long wide(long a,long b){return (a+b)*(a-3L)+(b<<7);}
  static double floating(double a,double b){return (a+b)*0.5-(a-b)*2.0;}
  static int caught(int[] a,int n){int snapshot=n+7,result=0;
   try{for(int i=0;i<n;i++)result+=(a[i]+3)*(n-i)+(n+2)*5;}
   catch(ArrayIndexOutOfBoundsException e){return result+snapshot+100;}return result;}
  static int order(int a,int[] values){return (a*5+2)+values[0]+(a-3)*7;}
  static int many(Object input){int[] a=(int[])input;return (a[0]+a[1])*(a[2]+a[3])+a[4]*a[5]+a[6]*a[7];}
  static int deep(int a){return a${'+1'.repeat(1000)};}
 }`;
 const classpath=compile(t,'NumericExpressions',source),j=new JVM({classpath,wasmHeap:true,wasmFields:true,
  jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,wasm:{deepInline:false,checkcast:true,
   canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();j._markClassInitialized('NumericExpressions');
 const build=(name,descriptor,enabled)=>{
  const original=stackify.prepare,assign=stackify.assignLocals;
  if(!enabled){
   stackify.prepare=()=>new Set();
   stackify.assignLocals=(fn,_values,_locals,allocate)=>{
    for(const block of fn.blocks)if(fn.reachable.has(block.id))for(const value of [...block.phis,...block.body])
     if(['I','J','F','D','A'].includes(value.kind))allocate(value);
    return 0;
   };
  }
  try{
   const method=j.findMethod(j.classes.NumericExpressions,name,descriptor),c=new Compiler(j,method,'NumericExpressions',j.jit.wasmJit);
   if(!enabled)c.arrayAccessFill=cache=>c.lazyArrayCacheFill(cache);
   const meta=c.translateWith(false),instance=new WebAssembly.Instance(new WebAssembly.Module(meta.bytes),meta.importObject);
   return {method,meta,c,run:instance.exports.run};
  }finally{stackify.prepare=original;stackify.assignLocals=assign;}
 };
 const normalize=values=>values.map(v=>ArrayBuffer.isView(v)||Array.isArray(v)?Array.from(v):v);
 const run=(artifact,args,fuel=1e8)=>{
  const frame=new Frame(artifact.method);artifact.meta.box.frame=frame;
  let status,error,value;try{status=artifact.run(...args,0,fuel);if(status===-1)value=takeWasmReturnValue(artifact.meta);}catch(e){error=e;}
  finally{artifact.meta.box.frame=null;}
  return {status,error,value,locals:normalize(frame.locals),stack:normalize(frame.stack.items)};
 };
 const fast=build('sum','(III)I',true),base=build('sum','(III)I',false);
 t.ok(fast.meta.stackifiedNumericValueCount>0,'real arithmetic intermediates are stackified');
 t.equal(base.meta.stackifiedNumericValueCount,0,'control retains separate locals');
 t.ok(fast.meta.bytes.length<base.meta.bytes.length,'native module shrinks');
 t.equal(fast.c.stackifiedNumericValues,undefined,'temporary expression graph releases');
 t.equal(fast.c.numericExpressionValue,undefined,'emission scratch releases');
 for(const fuel of [1,2,3,7,8,9,1e8])for(const args of [[17,29,8],[2147483647,-2147483648,8],[-1,7,0]])
  t.deepEqual(run(fast,args,fuel),run(base,args,fuel),'exact integer result and continuation '+args+' fuel '+fuel);
 const wide=build('wide','(JJ)J',true),wideBase=build('wide','(JJ)J',false);
 for(const args of [[9007199254740993n,17n],[9223372036854775807n,-1n],[-9223372036854775808n,55n]])
  t.deepEqual(run(wide,args),run(wideBase,args),'wide operations retain all bits and wrapping');
 const floating=build('floating','(DD)D',true),floatingBase=build('floating','(DD)D',false);
 for(const args of [[-0,0],[0,-0],[NaN,1],[Infinity,0],[-Infinity,Infinity],[1.0000000000000002,0.125]]){
  const a=run(floating,args),b=run(floatingBase,args);
  t.ok(Object.is(a.value,b.value),'floating order, NaN and signed zero remain exact');
 }
 const caught=build('caught','([II)I',true),caughtBase=build('caught','([II)I',false);
 const array=values=>{const a=j.wasmHeap.alloc('[I',values.length);a.type='[I';a.set(values);return a;};
 for(const fuel of [1,2,3,4,1e8])for(const length of [0,1,3,8])
  t.deepEqual(run(caught,[array(new Array(length).fill(3)),8],fuel),run(caughtBase,[array(new Array(length).fill(3)),8],fuel),
   'handler-only locals and partial sum, length '+length+' fuel '+fuel);
 const order=build('order','(I[I)I',true),orderBase=build('order','(I[I)I',false);
 const invoke=(artifact,throwing)=>{
  let reads=0;const failure={type:'java/lang/ArrayIndexOutOfBoundsException',identity:42};
  const values=Object.assign([0],{type:'[I'});Object.defineProperty(values,0,{get(){reads++;if(throwing)throw failure;return 19;}});
  const result=run(artifact,[11,values]);return {result,reads,sameException:result.error===failure};
 };
 for(const throwing of [false,true])t.deepEqual(invoke(order,throwing),invoke(orderBase,throwing),'unused arithmetic never changes getter/throw order');
 const many=build('many','(Ljava/lang/Object;)I',true),manyBase=build('many','(Ljava/lang/Object;)I',false);
 t.ok(many.meta.reusedNumericLocalCount>0,'sequential numeric temporaries share physical locals');
 t.ok(many.meta.omittedArrayFillCount>0,'dominating array accesses eliminate redundant metadata flag checks');
 for(const length of [0,1,2,3,7,8])t.deepEqual(run(many,[array(new Array(length).fill(3))]),
  run(manyBase,[array(new Array(length).fill(3))]),'reuse preserves ordered access/failure at length '+length);
 const host=artifact=>{
  let lengths=0,reads=0;const failure={identity:43};
  const a={type:'[I',get length(){lengths++;return 8;}};
  for(let i=0;i<8;i++)Object.defineProperty(a,i,{get(){reads++;if(i===6)throw failure;return 3;}});
  const result=run(artifact,[a]);return {result,lengths,reads,sameException:result.error===failure};
 };
 t.deepEqual(host(many),host(manyBase),'redundant-fill removal keeps fallback getters and thrown identity');
 t.deepEqual(run(many,[null]),run(manyBase,[null]),'metadata-check removal never skips the first null failure');
 const deep=build('deep','(I)I',true),deepBase=build('deep','(I)I',false);
 t.ok(deep.meta.stackifiedNumericValueCount>0&&deep.meta.stackifiedNumericValueCount<=512,'large expression obeys the allocation budget');
 t.deepEqual(run(deep,[17]),run(deepBase,[17]),'deep chains avoid compiler recursion overflow');
 t.end();
});
