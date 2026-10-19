"use strict";
const {T,OP,STRUCTURED_RETURN,uleb,sleb,getOp}=require('./wasmShared');
const {heapCopyKind}=require('./WasmArrayCopy');
const bufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;

// Recognize the entire forward/reverse unrolled primitive-array copy, including
// branch destinations, local numbers, and every increment. A signature or
// a count of array opcodes alone cannot establish memmove semantics.
function copyPattern(width, element='i') {
  const ops=[],labels=new Map();
  const add=(op,...args)=>ops.push([op,...args]);
  const mark=name=>labels.set(name,ops.length);
  const move=direction=>{
    add('aload',2);add('iload',3);add('iinc',3,direction);
    add('aload',0);add('iload',1);add('iinc',1,direction);
    add(element+'aload');add(element+'astore');
  };
  add('aload',0);add('aload',2);add('if_acmpne','forward');
  add('iload',1);add('iload',3);add('if_icmpne','reverseTest');add('return');
  mark('reverseTest');add('iload',3);add('iload',1);add('if_icmple','forward');
  add('iload',3);add('iload',1);add('iload',4);add('iadd');add('if_icmpge','forward');
  add('iinc',4,-1);add('iload',1);add('iload',4);add('iadd');add('istore',1);
  add('iload',3);add('iload',4);add('iadd');add('istore',3);
  add('iload',1);add('iload',4);add('isub');add('istore',4);add('iinc',4,width-1);
  mark('reverseLoop');add('iload',1);add('iload',4);add('if_icmplt','reverseTailSetup');
  for(let i=0;i<width;i++)move(-1);
  add('goto','reverseLoop');mark('reverseTailSetup');add('iinc',4,1-width);
  mark('reverseTail');add('iload',1);add('iload',4);add('if_icmplt','reverseReturn');
  move(-1);add('goto','reverseTail');mark('reverseReturn');add('return');
  mark('forward');add('iload',4);add('iload',1);add('iadd');add('istore',4);add('iinc',4,1-width);
  mark('forwardLoop');add('iload',1);add('iload',4);add('if_icmpge','forwardTailSetup');
  for(let i=0;i<width;i++)move(1);
  add('goto','forwardLoop');mark('forwardTailSetup');add('iinc',4,width-1);
  mark('forwardTail');add('iload',1);add('iload',4);add('if_icmpge','forwardReturn');
  move(1);add('goto','forwardTail');mark('forwardReturn');add('return');
  return ops.map(([op,...args])=>[op,...(op==='goto'||op.startsWith('if_')?[labels.get(args[0])]:args)]);
}
function normalizedCopyCode(method) {
  const code=method.attributes.find(a=>a.type==='code')?.code;
  if(!code || code.exceptionTable?.length)return null;
  const instructions=[],labels=new Map();
  for(const item of code.codeItems){
    if(item.labelDef)labels.set(item.labelDef.replace(/:$/,''),instructions.length);
    if(item.instruction)instructions.push(item.instruction);
  }
  const actual=instructions.map(insn=>{
    const op=getOp(insn),local=/^(aload|iload|istore)_([0-3])$/.exec(op);
    if(local)return [local[1],Number(local[2])];
    if(['aload','iload','istore'].includes(op))return [op,Number(insn.varnum??insn.arg)];
    if(op==='bipush'||op==='sipush')return [op,Number(insn.arg)];
    if(op==='iinc')return [op,Number(insn.varnum),Number(insn.incr)];
    if(op==='goto'||op.startsWith('if_'))return [op,labels.get(String(insn.arg).replace(/:$/,''))];
    return [op];
  });
  return actual;
}
function recognizePrimitiveCopy(method) {
  if(!['([II[III)V','([BI[BII)V'].includes(method.descriptor) || !method.flags?.includes('static') ||
      method.flags.includes('synchronized'))return null;
  const actual=normalizedCopyCode(method);
  if(!actual)return null;
  for(let width=2;width<=16;width++){
    const expected=copyPattern(width,method.descriptor==='([BI[BII)V'?'b':'i');
    if(actual.length===expected.length && actual.every((op,i)=>
      op.length===expected[i].length && op.every((v,k)=>v===expected[i][k])))return {width};
  }
  for(let width=2;width<=16;width++){
    if(require('./copyControlFlowProof').equivalentCopyControlFlow(actual,
      copyPattern(width,method.descriptor==='([BI[BII)V'?'b':'i'))){
      // Extra blocks must not weaken the original low-fuel continuation.
      return {width,controlFlowEquivalent:true,proofInstructions:actual.length};
    }
  }
  return null;
}

// Java byte/boolean access shares an opcode. Only genuine byte views can
// be bit-copied. Host metadata overrides, unsigned views, and shared buffers
// keep the original per-element operation and its fault/spill behavior.
function byteHeapCopyEligible(heap,array) {
  if(!ArrayBuffer.isView(array) || Object.getPrototypeOf(array)!==Int8Array.prototype)return false;
  if(Object.getOwnPropertyDescriptor(array,'type')?.value!=='[B' ||
      !Number.isInteger(Object.getOwnPropertyDescriptor(array,'wasmBase')?.value))return false;
  for(const key of ['buffer','byteOffset','byteLength','length','constructor'])
    if(Object.prototype.hasOwnProperty.call(array,key))return false;
  if(typeof SharedArrayBuffer!=='undefined' && array.buffer instanceof SharedArrayBuffer)return false;
  return heapCopyKind(heap,array)===0x11;
}

function emitPrimitiveCopyEntry(compiler,structured) {
  const byte=compiler.method.descriptor==='([BI[BII)V';
  const enabled=byte?compiler.wasmJit.primitiveByteCopyEntryEnabled:compiler.wasmJit.primitiveArrayCopyEntryEnabled;
  if(!['([II[III)V','([BI[BII)V'].includes(compiler.method.descriptor) ||
      !compiler.method.flags?.includes('static') || compiler.method.flags.includes('synchronized') || !compiler.heap ||
      compiler.demoted.size || compiler.deoptBlocks.size)return [];
  const plan=recognizePrimitiveCopy(compiler.method);
  if(compiler.fn.params.length!==5)return [];
  const empty=plan || require('./emptyPrimitiveCopyProof').proveEmptyPrimitiveCopy(normalizedCopyCode(compiler.method));
  if(!empty)return [];
  // Each original instruction can enter at most all structured loop headers.
  // Overestimate rather than bypass an existing low-fuel continuation.
  const fuelScale=plan?.controlFlowEquivalent
    ? plan.proofInstructions*Math.max(1,structured.loopHeaders.size) : 1;
  const fuelBound=plan?2*fuelScale:Math.max(2,empty.steps*Math.max(1,structured.loopHeaders.size));
  const source=compiler.arrayCacheFor(compiler.fn.params[0]);
  const target=compiler.arrayCacheFor(compiler.fn.params[2]);
  if(!source.parameter||!target.parameter)return [];
  const get=local=>[OP.local_get,...uleb(local)];
  const use=index=>compiler.useOf(compiler.fn.params[index]);
  // For nonnegative source positions, zero count reaches neither loop body
  // and its signed end-index arithmetic cannot wrap. Avoid all array metadata
  // lookups, including for null parameters. Preserve low-fuel loop exits.
  compiler.primitiveCopyZeroEntry=[
    ...get(compiler.blkLocal),OP.i32_eqz,
    ...use(4),OP.i32_eqz,OP.i32_and,
    ...use(1),OP.i32_const,0,OP.i32_ge_s,OP.i32_and,
    ...get(compiler.fuelLocal),OP.i32_const,...sleb(fuelBound),OP.i32_gt_s,OP.i32_and,
    OP.if,0x40,OP.i32_const,...sleb(-1),STRUCTURED_RETURN,OP.end,
  ];
  compiler.primitiveCopyZeroProof=true;
  compiler.primitiveCopyZeroFuel=fuelBound;
  if(!enabled||!plan)return [];
  // Preserve the ordering of raw scalar accesses on shared storage. The
  // intrinsic also recognizes a shared buffer from another realm.
  if(!byte)try{bufferLength.call(compiler.heap.memory.buffer);}catch(_){return [];}
  const width=[OP.i32_const,byte?0:2,OP.i32_shl];
  const address=(cache,index)=>[...get(cache.base),...use(index),...width,OP.i32_add];
  const range=(cache,index)=>[...get(cache.len),...use(index),OP.i32_ge_u,
    ...get(cache.len),...use(index),OP.i32_sub,...use(4),OP.i32_ge_u,OP.i32_and];
  const kind=byte?compiler.addImport('primitive_copy_byte_heap',[T.ref],[T.i32],
    array=>byteHeapCopyEligible(compiler.heap,array)?1:0):null;
  const wideStart=(cache,index)=>[...get(cache.base),OP.i64_extend_i32_u,
    ...use(index),OP.i64_extend_i32_u,OP.i64_const,2,OP.i64_shl,OP.i64_add];
  const wideEnd=(cache,index)=>[...wideStart(cache,index),...use(4),OP.i64_extend_i32_u,
    OP.i64_const,2,OP.i64_shl,OP.i64_add];
  // The original compiled integer loop already selects raw i32 accesses from
  // these captured caches. Prove the entire physical range too: forged host
  // metadata must retain the scalar path's wrapping addresses and partial
  // stores before a trap. i64 arithmetic cannot wrap an i32 byte address.
  const eligibility=(index,cache)=>byte?[...use(index),OP.call,...uleb(kind)]:[
    ...get(cache.base),OP.i32_const,0,OP.i32_ge_s,
    ...wideEnd(cache,index+1),OP.memory_size,0,OP.i64_extend_i32_u,
    OP.i64_const,16,OP.i64_shl,OP.i64_le_u,OP.i32_and];
  const same=[...use(0),...use(2),OP.call,...uleb(compiler.importIndexByName.get('ref_eq'))];
  const sameBase=[...get(source.base),...get(target.base),OP.i32_eq];
  const alias=byte?[
    ...same,...address(target,3),...address(source,1),...use(4),...width,OP.i32_add,OP.i32_ge_u,OP.i32_or,
    ...address(source,1),...address(target,3),...use(4),...width,OP.i32_add,OP.i32_ge_u,OP.i32_or,
  ]:[
    ...wideStart(target,3),...wideEnd(source,1),OP.i64_ge_u,
    ...wideStart(source,1),...wideEnd(target,3),OP.i64_ge_u,OP.i32_or,
    OP.if,T.i32,
      // A host getter can give two captures of the same Java reference
      // different bases. Equal Java indices then return without copying.
      ...use(1),...use(3),OP.i32_eq,...sameBase,OP.i32_eqz,OP.i32_and,
      OP.if,T.i32,...same,OP.i32_eqz,OP.else,OP.i32_const,1,OP.end,
    OP.else,...sameBase,...same,OP.i32_and,OP.end,
  ];
  const out=[
    ...get(compiler.blkLocal),OP.i32_eqz,
    ...eligibility(0,source),OP.i32_and,
    ...eligibility(2,target),OP.i32_and,
    ...range(source,1),OP.i32_and,...range(target,3),OP.i32_and,
    // Keep large copies in the fuel-polled loop; bound one bulk operation.
    OP.i32_const,...sleb(16384),...use(4),OP.i32_ge_u,OP.i32_and,
    ...get(compiler.fuelLocal),
    ...(fuelScale===1?[]:[OP.i32_const,...sleb(fuelScale),OP.i32_div_s]),
    ...use(4),OP.i32_const,2,OP.i32_add,OP.i32_gt_s,OP.i32_and,
    // Distinct Java arrays normally occupy disjoint heap ranges. Host-made
    // overlapping views must keep the original forward-copy semantics.
    ...alias,
    OP.i32_and,OP.if,0x40,
    ...address(target,3),...address(source,1),...use(4),...width,
    0xfc,0x0a,0x00,0x00,
    OP.i32_const,...sleb(-1),STRUCTURED_RETURN,OP.end,
  ];
  compiler.primitiveCopyEntryUnroll=plan.width;
  compiler.primitiveCopyEntryBytes=out.length+compiler.primitiveCopyZeroEntry.length;
  return out;
}
module.exports={recognizePrimitiveCopy,emitPrimitiveCopyEntry,byteHeapCopyEligible};
