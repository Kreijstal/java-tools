'use strict';
const Frame=require('../core/frame');
const {T,OP,uleb,sleb,STRUCTURED_RETURN}=require('./wasmShared');
const types={I:T.i32,J:T.i64,F:T.f32,D:T.f64,A:T.ref};

function at(c,item){return c.inlineActivations?.get(item);}
function chain(activation){
 const levels=[];for(let current=activation;current;current=current.parent)levels.unshift(current);return levels;
}
function root(activation){while(activation.parent)activation=activation.parent;return activation;}
function depth(activation){return chain(activation).length;}

// Only exceptional handoffs allocate frames. Normal flattened execution carries
// no JavaScript activation or per-iteration metadata publication. Snapshot the
// caller's operand prefix separately from the callee's current operand stack;
// the caller resumes AFTER the invoke once the real child eventually returns.
function emit(c,activation,state,stack,pc,out,key){
 if(!c.directFrames)throw new (require('./wasmShared').Unsupported)('inline activation needs direct frames');
 const levels=chain(activation),spills=[];
 for(const [slot,value]of state||[]){
  const t=types[value.kind];if(t===undefined||value.op==='undef')continue;
  if(slot<c.callerLocals)spills.push({slot,value,t,frame:0});
  else{
   const index=levels.findIndex(level=>slot>=level.base&&slot<level.base+level.localsSize);
   if(index>=0)spills.push({slot:slot-levels[index].base,value,t,frame:index+1});
  }
 }
 const under=levels.reduce((sum,level)=>sum+level.under,0);
 if(!Number.isInteger(under)||under<0||stack.length<under||stack.some(v=>types[v.kind]===undefined))
  throw new (require('./wasmShared').Unsupported)('inline activation stack unavailable');
 const slots=spills.map(({slot,frame})=>({slot,frame})),count=spills.length;
 const continuation=levels[0].call+1;
 // Keep only execution metadata in the import, never SSA/compiler objects.
 const children=levels.map(({method,className},index)=>({method,className,pc:index+1<levels.length?levels[index+1].call+1:pc}));
 const boundaries=[];let prefix=0;
 for(const level of levels){prefix+=level.under;boundaries.push(prefix);}
 const context=c.directFrames,box=c.box,resumes=c.wasmJit.canonicalResumeFrames;
 const idx=c.addImport('inline_spill_'+key,[...spills.map(s=>s.t),...stack.map(v=>types[v.kind]),T.i32],[],
  (...values)=>{
   const parent=context.frame(values.pop()),frames=[parent,...children.map(child=>{
    const frame=new Frame(child.method);frame.className=child.className;frame.pc=child.pc;return frame;
   })];
   parent.locals.fill(undefined);parent.stack.clear();parent.pc=continuation;
   for(let i=0;i<count;i++)frames[slots[i].frame].locals[slots[i].slot]=values[i];
   for(let i=count;i<values.length;i++){
    const frame=boundaries.findIndex(end=>i-count<end);
    frames[frame<0?frames.length-1:frame].stack.push(values[i]);
   }
   for(const frame of frames)resumes.add(frame);
   const pending=frames.slice(1).reverse();
   box.pendingFrames=box.pendingFrames?[...box.pendingFrames,...pending]:pending;
   box.canonicalFrameHandoff=true;
  });
 c.recordBooleanStaticSpill(state,continuation,spills.filter(s=>s.frame===0));
 for(const {value}of spills)out.push(...c.useOf(value));
 for(const value of stack)out.push(...c.useOf(value));
 out.push(OP.local_get,...uleb(c.directIdLocal),OP.call,...uleb(idx));
 c.markDirectExit(continuation,out);
 out.push(OP.i32_const,...sleb(continuation),STRUCTURED_RETURN);
}
module.exports={at,emit,root,depth};
