'use strict';
const test=require('tape');
const copy=require('../src/jre/java/lang/System').staticMethods['arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V'];

test('primitive bulk copies preserve views, overlap, boundaries and Java failures',t=>{
 let cases=0;
 for(const Type of [Int8Array,Uint8Array,Int16Array,Uint16Array,Int32Array,Float32Array,Float64Array,BigInt64Array]){
  const big=Type===BigInt64Array;
  for(const mode of ['separate','same','overlapping-views'])for(const from of [0,1,7,15,16])for(const to of [0,1,7,15,16])for(const length of [0,1,3,8,16]){
   const backing=new Type(32);for(let i=0;i<backing.length;i++)backing[i]=big?BigInt(i*971-777):i*971-777;
   const src=mode==='overlapping-views'?backing.subarray(0,16):backing.subarray(8,24);
   const dst=mode==='same'?src:mode==='overlapping-views'?backing.subarray(4,20):new Type(16);
   const beforeSrc=Array.from(src),beforeDst=Array.from(dst),snapshot=Array.from(backing),expected=beforeDst.slice();
   const valid=from+length<=src.length&&to+length<=dst.length;
   if(valid)for(let i=0;i<length;i++)expected[to+i]=beforeSrc[from+i];
   let error;try{copy({},null,[src,from,dst,to,length]);}catch(e){error=e;}
   if((!valid&&error?.type!=='java/lang/ArrayIndexOutOfBoundsException')||(valid&&error)||Array.from(dst).some((v,i)=>v!==expected[i])||(!valid&&Array.from(backing).some((v,i)=>v!==snapshot[i]))){t.fail(Type.name+' '+[mode,from,to,length]);t.end();return;}
   cases++;
  }
 }
 t.equal(cases,3000,'all primitive kinds and overlap/bounds combinations agree with snapshot semantics');
 for(const [src,from,dst,to,len,type] of [[null,-1,new Int32Array(2),-1,-1,'NullPointerException'],[new Int8Array(2),0,null,0,0,'NullPointerException'],[new Int32Array(2),-1,new Int32Array(2),0,1,'ArrayIndexOutOfBoundsException'],[new Int32Array(2),0,new Int32Array(2),0,-1,'ArrayIndexOutOfBoundsException']]){
  let error;try{copy({},null,[src,from,dst,to,len]);}catch(e){error=e;}
  t.equal(error?.type,'java/lang/'+type,'null/range precedence unchanged');
 }
 // Preserve exact floating payload bits in a same-kind bulk copy.
 const bits=new Uint32Array([0x7fc01234,0x80000000,0x3f800000]),out=new Float32Array(3);
 copy({},null,[new Float32Array(bits.buffer),0,out,0,3]);
 t.deepEqual([...new Uint32Array(out.buffer)],[...bits],'NaN payload and signed zero preserved');
 const objects=[{x:1},{x:2},{x:3}];copy({},null,[objects,0,objects,1,2]);
 t.equal(objects[1],objects[0],'reference fallback retains object identity');t.equal(objects[2].x,2,'reference overlap remains correct');
 t.end();
});

test('bulk-copy Wasm bridge preserves JRE overrides and shared-buffer boundaries',t=>{
 const {addSystemImport}=require('../src/jit/wasmRuntimeImports');
 const makeImport=native=>{
  let imported;
  const j={jre:{'java/lang/System':{staticMethods:{'arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V':native}}},classInitializationState:new Map([['java/lang/System','INITIALIZED']])};
  addSystemImport({addImport(name,params,results,fn){imported=fn;return 0;}},j,{arg:['Method','java/lang/System',['arraycopy','(Ljava/lang/Object;ILjava/lang/Object;II)V']]});
  return {j,imported};
 };
 const custom=makeImport((j,receiver,args)=>{t.equal(j,custom.j,'replacement gets its JVM');t.equal(receiver,null,'static receiver remains null');t.deepEqual(args,[src,1,dst,2,3],'replacement gets original operands');});
 const src=new Int32Array([1,2,3,4]),dst=new Int32Array(8);custom.imported(src,1,dst,2,3);
 const {imported}=makeImport(copy);
 const buffer=Int32Array.from({length:20},(_,i)=>i*11),before=[...buffer],a=buffer.subarray(2,12),b=buffer.subarray(6,16);
 imported(a,1,b,2,4);const expected=before.slice();expected.splice(8,4,...before.slice(3,7));
 t.deepEqual([...buffer],expected,'shared-buffer bulk copy leaves all surrounding bytes intact');
 t.end();
});

test('reference self-copies preserve exact values for every overlap direction',t=>{
 const refs=[{},{}];let cases=0;
 for(const from of [0,1,4,7,8])for(const to of [0,1,4,7,8])for(const length of [0,1,2,4,8]) {
  const values=[refs[0],null,refs[1],undefined,-0,NaN,3,refs[0]],snapshot=values.slice(),expected=values.slice();
  const valid=from+length<=values.length&&to+length<=values.length;
  if(valid)for(let i=0;i<length;i++)expected[to+i]=snapshot[from+i];
  let error;try{copy({},null,[values,from,values,to,length]);}catch(e){error=e;}
  if(valid)t.equal(error,undefined,'valid copy completes');
  else t.equal(error?.type,'java/lang/ArrayIndexOutOfBoundsException','invalid copy fails before writes');
  t.ok(values.every((v,i)=>Object.is(v,expected[i])),'snapshot values, NaN, signed zero and identities preserved');
  cases++;
 }
 t.equal(cases,125,'all overlap and bounds cases covered');
 const source=new Int32Array([7,11,19]),target=new Int32Array([1,2,3,4,5]);
 copy({},null,[source,0,target,1,3]);
 t.deepEqual([...target],[1,7,11,19,5],'whole typed source preserves destination prefix and tail');
 t.end();
});
