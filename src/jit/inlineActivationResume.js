'use strict';
const Frame=require('../core/frame');
const {T,OP,uleb,sleb,STRUCTURED_RETURN}=require('./wasmShared');
const types={I:T.i32,J:T.i64,F:T.f32,D:T.f64,A:T.ref};

function at(c,item){return c.inlineActivations?.get(item);}

// Only exceptional handoffs allocate frames. Normal flattened execution carries
// no JavaScript activation or per-iteration metadata publication. Snapshot the
// caller's operand prefix separately from the callee's current operand stack;
// the caller resumes AFTER the invoke once the real child eventually returns.
function emit(c,activation,state,stack,pc,out,key){
 if(!c.directFrames)throw new (require('./wasmShared').Unsupported)('inline activation needs direct frames');
 const spills=[];
 for(const [slot,value]of state||[]){
  const t=types[value.kind];if(t===undefined||value.op==='undef')continue;
  if(slot<c.callerLocals)spills.push({slot,value,t,parent:true});
  else if(slot>=activation.base&&slot<activation.base+activation.localsSize)
   spills.push({slot:slot-activation.base,value,t,parent:false});
 }
 if(stack.length<activation.under||stack.some(v=>types[v.kind]===undefined))
  throw new (require('./wasmShared').Unsupported)('inline activation stack unavailable');
 const slots=spills.map(({slot,parent})=>({slot,parent})),count=spills.length;
 const {method,className,call,under}=activation,continuation=call+1;
 const context=c.directFrames,box=c.box,resumes=c.wasmJit.canonicalResumeFrames;
 const idx=c.addImport('inline_spill_'+key,[...spills.map(s=>s.t),...stack.map(v=>types[v.kind]),T.i32],[],
  (...values)=>{
   const parent=context.frame(values.pop()),child=new Frame(method);child.className=className;child.pc=pc;
   parent.locals.fill(undefined);parent.stack.clear();parent.pc=continuation;
   for(let i=0;i<count;i++)(slots[i].parent?parent:child).locals[slots[i].slot]=values[i];
   for(let i=count;i<values.length;i++)(i-count<under?parent:child).stack.push(values[i]);
   resumes.add(parent);resumes.add(child);
   box.pendingFrames=box.pendingFrames?[...box.pendingFrames,child]:[child];
   box.canonicalFrameHandoff=true;
  });
 c.recordBooleanStaticSpill(state,continuation,spills.filter(s=>s.parent));
 for(const {value}of spills)out.push(...c.useOf(value));
 for(const value of stack)out.push(...c.useOf(value));
 out.push(OP.local_get,...uleb(c.directIdLocal),OP.call,...uleb(idx));
 c.markDirectExit(continuation,out);
 out.push(OP.i32_const,...sleb(continuation),STRUCTURED_RETURN);
}
module.exports={at,emit};
