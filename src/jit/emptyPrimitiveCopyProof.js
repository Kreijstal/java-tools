'use strict';

// Prove only the zero-count invocation, without requiring a particular copy
// loop layout. Unknown branches fork; reaching any observable instruction,
// unresolved arithmetic, or the work bound refuses the optimization entirely.
function proveEmptyPrimitiveCopy(code) {
 if(!code || code.length>2048)return null;
 const min=-2147483648,max=2147483647;
 const constant=n=>{
  if(!Number.isInteger(n)||n<min||n>max)throw Error('unproved constant');
  return {key:'c'+n,lo:n,hi:n};
 };
 const integer=(slot,lo=min)=>({key:'p'+slot,base:slot,offset:0,lo,hi:max});
 const reference=slot=>({key:'r'+slot,ref:true});
 const initial=[reference(0),integer(1,0),reference(2),integer(3),constant(0)];
 const pending=[{pc:0,locals:initial,stack:[],facts:new Map()}];
 const reverse=mask=>((mask&1)<<2)|(mask&2)|((mask&4)>>2);
 const add=(value,by)=>{
  if(!value || value.ref || !Number.isInteger(by))throw Error('unproved arithmetic');
  if(value.lo===value.hi)return constant((value.lo+by)|0);
  if(value.lo+by<min || value.hi+by>max)throw Error('possible overflow');
  const offset=value.offset+by;
  return {...value,key:'p'+value.base+':'+offset,offset,lo:value.lo+by,hi:value.hi+by};
 };
 const key=value=>value.base!==undefined?'p'+value.base+':'+value.offset:value.key;
 let steps=0,returns=0;
 try {
  while(pending.length){
   if(pending.length>64)return null;
   const state=pending.pop(),{locals,stack,facts}=state;
   const pop=()=>{if(!stack.length)throw Error('unproved stack');return stack.pop();};
   for(let pc=state.pc;;pc++){
    if(++steps>4096 || !code[pc])return null;
    const [op,arg,by]=code[pc];
    if(op==='aload'||op==='iload'){
     const v=locals[arg];if(!v || !!v.ref!==(op==='aload'))return null;stack.push(v);
    }else if(op==='istore'){
     const v=pop();if(v.ref)return null;locals[arg]=v;
    }else if(op==='iinc')locals[arg]=add(locals[arg],by);
    else if(/^iconst_[0-5]$/.test(op))stack.push(constant(Number(op.slice(-1))));
    else if(op==='iconst_m1')stack.push(constant(-1));
    else if(op==='bipush'||op==='sipush')stack.push(constant(arg));
    else if(op==='iadd'||op==='isub'){
     const right=pop(),left=pop();
     if(left.ref||right.ref)return null;
     if(right.lo===right.hi)stack.push(add(left,(op==='isub'?-1:1)*right.lo));
     else if(op==='iadd' && left.lo===left.hi)stack.push(add(right,left.lo));
     else return null;
    }else if(op==='goto'){
     if(!Number.isInteger(arg)||arg<0||arg>=code.length)return null;pc=arg-1;
    }else if(op.startsWith('if')){
     const comparison=op.replace(/^if_(?:i|a)cmp/,'').replace(/^if/,'');
     const masks={eq:2,ne:5,lt:1,le:3,gt:4,ge:6},mask=masks[comparison];
     if(!mask || !Number.isInteger(arg)||arg<0||arg>=code.length)return null;
     const right=op.includes('cmp')?pop():constant(0),left=pop();
     if(!!left.ref!==!!right.ref || left.ref && !['eq','ne'].includes(comparison))return null;
     const a=key(left),b=key(right),ordered=a<=b,pair=ordered?a+'|'+b:b+'|'+a;
     let possible;
     if(a===b)possible=2;
     else if(left.ref)possible=7;
     else if(left.base!==undefined && left.base===right.base)
      possible=left.offset<right.offset?1:left.offset>right.offset?4:2;
     else possible=(left.lo<right.hi?1:0)|
      (left.lo<=right.hi && right.lo<=left.hi?2:0)|(left.hi>right.lo?4:0);
     const known=facts.get(pair);
     if(known!==undefined)possible&=ordered?known:reverse(known);
     for(const [allowed,next]of [[mask,arg],[7^mask,pc+1]]){
      const narrowed=possible&allowed;if(!narrowed)continue;
      const branchFacts=new Map(facts);branchFacts.set(pair,ordered?narrowed:reverse(narrowed));
      pending.push({pc:next,locals:locals.slice(),stack:stack.slice(),facts:branchFacts});
     }
     break;
    }else if(op==='return'){
     if(stack.length)return null;returns++;break;
    }else return null;
   }
  }
 }catch(_){return null;}
 return returns?{steps}:null;
}
module.exports={proveEmptyPrimitiveCopy};
