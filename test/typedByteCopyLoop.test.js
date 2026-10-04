'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const Frame=require('../src/core/frame');
const Stack=require('../src/core/stack');
const {makeJavaFixtureCompiler}=require('./javaFixture');
const fixture=makeJavaFixtureCompiler('typed-byte-loop-');
const source='public class ByteLoop { public static byte[] source; public static int copy(byte[] out,int di,int si,int end,int flag) { for(int round=0;round<1;round++) { while(~end<~si) { out[di++]=source[si]; si++; if(flag!=0)break; if(flag==0)continue;break; } } return di; } public static boolean enabled; public static int copyPruned(byte[] out,int di,int si,int end) { boolean flag=enabled; for(int round=0;round<1;round++) { while(~end<~si) { out[di++]=source[si]; si++; if(flag)break; if(!flag)continue;break; } } return di; } }';
async function setup(classpath,enabled,ssa=enabled){
 const j=new JVM({classpath,wasmHeap:true,wasmHeapMb:16,jit:{enabled:false,codegen:true,
  compileWorker:false,structuredSsa:ssa,structuredTypedByteCopyLoops:enabled,structuredLoopInvariantStaticArrayViews:enabled}});
 await j.loadClassByName('ByteLoop');j._markClassInitialized('ByteLoop');j.classes.ByteLoop.staticFieldsInitialized=true;
 const method=j.findMethod(j.classes.ByteLoop,'copy','([BIIII)I');
 const before=j.jit.siteIdWatermark();
 j.classes.ByteLoop.staticFields.set('source:[B',new Int8Array(1));
 const g=j.jit.getGeneratedFunction(method,{allowEffectfulCalls:true});
 const array=(values,type='[B')=>{const a=new Int8Array(values);a.type=type;return a;};
 return {j,method,g,array,before};
}
async function run(h,args,g=h.g){
 const frame=new Frame(h.method);frame.className='ByteLoop';frame.locals=args.slice();
 const thread={id:0,status:'runnable',pendingException:null,callStack:new Stack()};
 const caller=new Frame(h.method);thread.callStack.push(caller);thread.callStack.push(frame);h.j.threads=[thread];h.j.currentThreadIndex=0;
 let error,answer;
 try{
  const result=g(frame,thread,h.j.jit,false);answer=result?.returned?result.value:undefined;
  if(!result?.returned){let ticks=0;while(thread.callStack.size()>1){
   await h.j.executeTick();if(++ticks>100000)throw Error('resume limit');
  }answer=caller.stack.pop();}
 }catch(e){error={type:e.type||String(e),pc:e.jvmGuestLocation?.pc ?? frame.pc};}
 const data=a=>a==null?a:Array.from(a.elements||a);
 return {error,result:answer,source:data(h.j.classes.ByteLoop.staticFields.get('source:[B')),destination:data(args[0]),locals:error?frame.locals.slice(1,5):undefined};
}

test('typed byte-loop shortcut preserves original values, counters and faults',async t=>{
 // Reference uses the scalar compiler to preserve canonical bounds faults.
 const cp=fixture(t,'ByteLoop',source),a=await setup(cp,true),b=await setup(cp,false),oldSsa=await setup(cp,false,true);
 t.ok(a.g.jvmStructuredTypedByteCopyLoopCount>0,'exact complemented copy loop is proved');
 t.equal(b.g.jvmStructuredTypedByteCopyLoopCount,undefined,'default loop is unchanged');
 const cases=[
 ['valid',h=>[h.array([-128,-1,0,127]),h.array([7,7,7,7]),0,0,4,0],true],
 ['slice',h=>[h.array([1,2,3,4]),h.array([7,7,7,7]),1,1,3,0],true],
 ['flag early exit',h=>[h.array([1,2,3,4]),h.array([7,7,7,7]),0,0,4,1],false],
 ['zero trip',h=>[null,null,0,4,4,0],false],
 ['negative destination',h=>[h.array([1,2]),h.array([7,7]),-1,0,1,0],false],
 ['equal MAX_VALUE',h=>[null,null,0,2147483647,2147483647,0],false],
 ['equal MIN_VALUE',h=>[null,null,0,-2147483648,-2147483648,0],false],
 ['negative index',h=>[h.array([1,2]),h.array([7,7]),0,-1,1,0],false],
 ['source partial fault',h=>[h.array([1,2]),h.array([7,7,7]),0,0,3,0],false],
 ['destination partial fault',h=>[h.array([1,2,3]),h.array([7,7]),0,0,3,0],false],
 ['null source',h=>[null,h.array([7,7]),0,0,2,0],false],
 ['null destination',h=>[h.array([1,2]),null,0,0,2,0],false],
 ['plain arrays',h=>[[1,2,3],[7,7,7],0,0,3,0],false],
 ['same array forward hazard',h=>{const x=h.array([1,2,3,4]);return [x,x,1,0,3,0];},false],
 ['same array safe forward',h=>{const x=h.array([1,2,3,4]);return [x,x,0,1,4,0];},true],
 ['shared views hazard',h=>{const x=h.array([1,2,3,4]);return [x.subarray(0,3),x.subarray(1,4),0,0,3,0];},false],
 ['large count',h=>[h.array(Array.from({length:5000},(_,i)=>(i*17)%127)),h.array(new Array(5000).fill(7)),0,0,5000,0],false]
 ];
 for(const [name,make,fast]of cases){
  // Scalar reference checks canonical bounds behavior; null exceptions
  // also retain the existing structured fallback's reported frame PC.
  const reference=name.startsWith('null')?oldSsa:b;
  const aa=make(a),bb=make(reference);
  a.j.classes.ByteLoop.staticFields.set('source:[B',aa[0]);
  reference.j.classes.ByteLoop.staticFields.set('source:[B',bb[0]);
  const before=a.j.jit.typedByteCopyLoopCount||0;
  const x=await run(a,aa.slice(1)),y=await run(reference,bb.slice(1));
  t.deepEqual(x,y,name+' preserves values, locals and exact exception PC');
  t.equal(a.j.jit.typedByteCopyLoopCount||0,before+(fast?1:0),name+' follows expected path');
 }
 for(const [name,src,dst] of [
  ['boolean source',a.array([2,3],'[Z'),a.array([7,7])],
  ['boolean destination',a.array([2,3]),a.array([7,7],'[Z')]]){
  t.equal(a.j.jit.tryTypedByteCopyLoop(dst,0,src,0,2),false,name+' fails raw guard');
  t.deepEqual(Array.from(dst),[7,7],name+' writes nothing on miss');
 }
 a.j.classes.ByteLoop.staticFields.set('enabled:Z',0);
 const prunedMethod=a.j.findMethod(a.j.classes.ByteLoop,'copyPruned','([BIII)I');
 const pruned=a.j.jit.getGeneratedFunction(prunedMethod);
 t.ok(pruned.jvmStructuredPrunedBooleanCfgBranchCount>0,'entry boolean proof prunes branches');
 t.ok(pruned.jvmStructuredTypedByteCopyLoopCount>0,'live pruned CFG still proves exact copy');
 const ph={...a,method:prunedMethod,g:pruned},prunedBefore=a.j.jit.typedByteCopyLoopCount||0;
 a.j.classes.ByteLoop.staticFields.set('source:[B',a.array([1,2,3]));
 const prunedResult=await run(ph,[a.array([7,7,7]),0,0,3]);
 t.deepEqual(prunedResult.destination,[1,2,3],'pruned copy preserves values');
 t.equal(prunedResult.result,3,'pruned copy preserves returned counter');
 t.equal(a.j.jit.typedByteCopyLoopCount,prunedBefore+1,'actual pruned body takes shortcut');
 const before=a.j.jit.typedByteCopyLoopCount||0,old=a.j.jit.needsBytecodeChecks;
 a.j.classes.ByteLoop.staticFields.set('source:[B',a.array([1,2,3]));
 a.j.jit.needsBytecodeChecks=()=>true;
 const debug=await run(a,[a.array([7,7,7]),0,0,3,0]);
 a.j.jit.needsBytecodeChecks=old;
 t.deepEqual(debug.destination,[1,2,3],'debugger entry resumes original bytecodes');
 t.equal(a.j.jit.typedByteCopyLoopCount||0,before,'debugger entry performs no bulk copy');
 const prefixed=JSON.parse(JSON.stringify(a.method));prefixed.className='ByteLoop';
 const code=prefixed.attributes.find(x=>x.type==='code').code;
 const head=code.codeItems.findIndex(x=>x.labelDef==='L9:');
 t.ok(head>=0,'fixture retains complemented loop header');
 const label=code.codeItems[head].labelDef;delete code.codeItems[head].labelDef;
 code.codeItems.splice(head,0,{labelDef:label,instruction:{op:'iinc',varnum:'1',incr:'1'}});
 const guarded=a.j.jit.structuredSsa.compile(prefixed);
 t.ok(guarded,'header with an extra destination increment compiles');
 t.equal(guarded.jvmStructuredTypedByteCopyLoopCount,0,'header effect excludes shortcut');
 a.j.classes.ByteLoop.staticFields.set('source:[B',a.array([1,2]));
 const headerResult=await run({...a,method:prefixed,g:guarded},[a.array([7,7,7,7,7,7]),0,0,2,0]);
 t.equal(headerResult.result,5,'every header increment including exit is preserved');
 t.deepEqual(headerResult.destination,[7,1,7,2,7,7],'header effects preserve exact destination indices');
 const payload=a.j.jit.serializeGeneratedResult(a.g,{siteTablesSince:a.before});
 const restored=a.j.jit.materializeGeneratedResult(payload,a.method,{checkStaleness:false});
 t.ok(restored,'packed loop restores');
 const ar=h=>[h.array([7,7,7]),0,0,3,0];
 a.j.classes.ByteLoop.staticFields.set('source:[B',a.array([1,2,3]));
 const restoredBefore=a.j.jit.typedByteCopyLoopCount||0;
 const replay=await run(a,ar(a),restored);
 t.equal(a.j.jit.typedByteCopyLoopCount,restoredBefore+1,'replayed body really uses shortcut');
 t.deepEqual(replay,await run(a,ar(a)),'restored loop is identical');
 t.end();
});
