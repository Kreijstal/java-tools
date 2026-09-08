'use strict';

// Diagnostic proof for one bytecode shape, NOT a general transformation.
// Handler code is deliberately left in the canonical callee. The compact
// representation runs only when no exception, class-init or poll is possible.
function verifySpan(jit, method, generated) {
  const fail=why=>{throw Error('checked-span proof: '+why);};
  if(method.descriptor!=='(I[IIII)V'||!(method.flags||[]).includes('static')||
      (method.flags||[]).some(f=>['native','abstract','synchronized'].includes(f)))fail('signature/flags');
  const items=jit.getCodeItems(method).slice();
  // Classfile end labels are not executable instructions. Reject any interior
  // label-only item rather than silently changing the proof's branch indices.
  while(items.length && !items.at(-1).instruction)items.pop();
  if(items.some(i=>!i.instruction))fail('interior label-only item');
  const ins=items.map(i=>i.instruction);
  const op=i=>typeof i==='string'?i:i?.op;
  const forms=ins.map(i=>typeof i==='string'?i:i.op==='iinc'?`iinc ${i.varnum} ${i.incr}`:
    ['getstatic','invokestatic','ldc','goto','if_icmpge'].includes(i.op)?i.op:`${i.op} ${i.arg}`);
  const expected=('aconst_null|astore 5|iconst_0|istore 6|iconst_0|istore 7|getstatic|istore 8|iinc 4 -1|iconst_m1|iload 4|iconst_m1|ixor|if_icmpge|goto|aload_1|astore 5|aload 5|astore 10|iload_2|istore 6|iload_3|istore 7|aload 5|iload 6|iload 7|aload 5|iload 6|iaload|ldc|ishr|ldc|invokestatic|iadd|iastore|iinc 2 1|goto|bipush -30|bipush -2|iload_0|isub|bipush 40|idiv undefined|irem undefined|istore 10|goto').split('|');
  // Normalize no-operand object instructions too; their representation may
  // differ between the frontend and a classfile loaded by the JVM.
  expected[42]='idiv';expected[43]='irem';
  for(let i=0;i<expected.length;i++)if(forms[i]!==expected[i])fail('instruction '+i+': '+forms[i]);
  const labels=new Map(items.map((x,i)=>[String(x.labelDef||'').replace(/:$/,''),i]));
  for(const [from,to] of [[13,15],[14,37],[36,8],[45,items.length-1]])
    if(labels.get(ins[from].arg)!==to)fail('control-flow edge '+from);
  if(op(ins.at(-1))!=='return')fail('normal return');
  const field=ins[6].arg, call=ins[32].arg;
  if(field?.[0]!=='Field'||field?.[2]?.[1]!=='I'||!jit.canEliminateFieldRead(field))fail('field is not proven nonvolatile');
  if(call?.[0]!=='Method'||call?.[2]?.[1]!=='(II)I')fail('helper descriptor');
  const helper=jit.jvm.findMethod(jit.jvm.classes[call[1]],call[2][0],call[2][1]);
  if(!helper||!(helper.flags||[]).includes('static')||
      (helper.flags||[]).some(f=>['native','abstract','synchronized'].includes(f)))fail('helper flags');
  if(JSON.stringify(jit.getCodeItems(helper).filter(i=>i.instruction).map(i=>op(i.instruction)))!==JSON.stringify(['iload_0','iload_1','iand','ireturn']))fail('helper is not pure integer AND');
  const shift=Number(ins[29].arg), mask=Number(ins[31].arg);
  if(!Number.isInteger(shift)||shift!==(shift|0)||!Number.isInteger(mask)||mask!==(mask|0))fail('integer constants');
  const budgets=Object.values(generated.jvmStructuredLoopPollBudgets||{});
  if(generated.jvmStructuredLoopCount!==1||budgets.length!==1||!Number.isInteger(budgets[0])||budgets[0]<3)fail('single-loop poll budget');
  const budget=Math.min(budgets[0],generated.jvmStructuredRestoringDirectSafePointBudget||0);
  if(budget<3)fail('restoring entry budget');
  const maxCount=Math.min(254,budget-2); // count+1 header visits must be < budget.
  return {shift:shift&31,mask,maxCount,field,helperOwner:call[1],
    calleeOwner:jit.jvm.findClassNameForMethod(method)||method.className};
}

// Identical checked representation in both placements. Failure has NO writes.
// All cold recovery (including exceptions after partial writes) stays in the
// original call, reached before any compact-path guest effect.
function compactBody(proof) {
  return `checkedSpanBody: {
  if (tag !== (tag|0) || start !== (start|0) || color !== (color|0) || count !== (count|0) ||
      count < 0 || count > ${proof.maxCount} || (((((-2-tag)|0)/40)|0) === 0)) break checkedSpanBody;
  const data = array instanceof Int32Array ? array : array && array.elements;
  if (!(data instanceof Int32Array) || start < 0 || start > data.length ||
      count > data.length-start || start+count > 2147483647) break checkedSpanBody;
  const end = start+count;
  for (let p=start; p<end; p++) data[p] = (color + ((data[p] >> ${proof.shift}) & ${proof.mask})) | 0;
  completed = true;
}`;
}

function prepare(jit,spec) {
  if(jit.mainStarted||jit.jvm.guestStarted)throw Error('checked span requires pre-main preparation');
  if(jit.singleSiteInlineExperiment||jit.hotCallGraphRegions?.enabled||jit.caughtRuntimeCalls||jit.rawRestoringCalls)
    throw Error('checked span requires original call ABI');
  if(!['callee','inline'].includes(spec.placement))throw Error('invalid compact placement');
  const resolve=([owner,name,desc])=>jit.jvm.findMethod(jit.jvm.classes[owner],name,desc);
  const caller=resolve(spec.caller),callee=resolve(spec.callee);
  const parent=jit.codegenCache.get(caller),child=jit.codegenCache.get(callee);
  const variant='jvmRestoringDirectPositionalSource',bodyKey='jvmRestoringDirectPositionalBody';
  if(!parent?.[bodyKey]||!child?.[bodyKey])throw Error('missing prepared body');
  const proof=verifySpan(jit,callee,child);
  const site=parent.jvmStructuredRegionCallSites.filter(s=>s.op==='invokestatic'&&s.exactTarget&&
    s.resolvedMethod===callee&&!s.directBoundary)[spec.siteOrdinal||0];
  if(!site?.regionLowering?.fastCall)throw Error('missing verified call site');
  const field=Object.values(child.jvmStructuredLinkRecordCaptures||{}).find(r=>
    r?.className===proof.field[1]&&r.fieldName===proof.field[2][0]&&r.descriptor==='I');
  if(!field?.initializationToken)throw Error('missing canonical field link');
  const state={expectedBody:child[bodyKey],field,
    calleeToken:jit.jvm.getClassInitializationToken(proof.calleeOwner),
    helperToken:jit.jvm.getClassInitializationToken(proof.helperOwner)};
  const source=parent[variant],lower=site.regionLowering;
  const open='/*'+site.regionMarkers.start+'*/',close='/*'+site.regionMarkers.end+'*/';
  const start=source.indexOf(open),end=source.indexOf(close,start);
  if(start<0||end<start||source.indexOf(open,start+1)>=0)throw Error('site absent or duplicated');
  const region=source.slice(start,end),raw=region.indexOf(lower.rawCallPrefix),tail=region.indexOf(lower.rawCallSuffix,raw);
  if(raw<0||tail<0)throw Error('missing call operands');
  let scan=raw+lower.rawCallPrefix.length;const positions=[];
  for(const token of lower.operandTokens){const p=region.indexOf(token,scan);if(p<0||p>=tail)throw Error('operand token');scan=p+token.length;positions.push(scan);}
  const args=positions.map((p,i)=>region.slice(p,(i+1<positions.length?positions[i+1]-lower.operandTokens[i+1].length:tail)-2));
  if(args.length!==5)throw Error('operand count');
  const begin=region.lastIndexOf('try { '+lower.resultName+' = ',raw),catchAt=region.indexOf('} catch ('+lower.fastCall.caught+') {',tail);
  if(begin<0||catchAt<0)throw Error('original exception scaffold missing');
  const original=region.slice(begin+6,catchAt),invoke=site.identifiers.invoke;
  const body=compactBody(proof);
  const kernel=new Function('return function checkedSpanCompact(tag,array,start,color,count) {\n'+
    'let completed=false;\n'+body+'\nreturn completed;\n}')();
  const placement=spec.placement==='callee'
    ? `completed = helpers.checkedSpanKernel(${args.join(', ')});`
    : args.map((a,i)=>`const checkedSpan${site.pc}Arg${i} = ${a};`).join('\n')+
      '\n{\n'+['tag','array','start','color','count'].map((n,i)=>`const ${n} = checkedSpan${site.pc}Arg${i};`).join('\n')+'\n'+body+'\n}';
  const replacement=`try {\n{
    let completed=false;
    const state=helpers.checkedSpanState;
    if(state && ${invoke}.jvmInlineRestoringBody === state.expectedBody &&
        !helpers.profileMethods && !helpers.needsBytecodeChecks() && thread.status === 'runnable' &&
        state.calleeToken.initialized && state.helperToken.initialized &&
        state.field.initializationToken.initialized && state.field.staticTarget) {
      ${placement}
    }
    ${spec.countEntries?'if(completed) helpers.checkedSpanEntries=(helpers.checkedSpanEntries||0)+1;':''}
    if(completed) ${lower.resultName}=ssaCheckedSpanReturnVoid;
    else { ${original} }
  }\n`;
  const expanded=source.slice(0,start+begin)+replacement+source.slice(start+catchAt);
  const textBody=jit.serializeTextBody(parent[bodyKey]);
  const compiled=jit.materializeTextBody({...textBody,source:expanded,
    captures:{...textBody.captures,ssaCheckedSpanReturnVoid:{kind:'sentinel',which:'returnVoid'}}},caller);
  if(!compiled)throw Error('compact caller failed materialization');
  jit.checkedSpanState=state;jit.checkedSpanKernel=kernel;
  for(const g of new Set([parent,parent.jvmFastBody].filter(Boolean))) {
    g[bodyKey]=compiled;g[variant]=expanded;g.jvmRestoringDirectPositionalInsertion=null;
    if(g.jvmStructuredRegionFragments)delete g.jvmStructuredRegionFragments[variant];
  }
  jit.publishGeneratedTargetUpgrade(caller,parent);
  return jit.checkedSpanReport={placement:spec.placement,pc:site.pc,proof,
    compactSource:body,compactCharacters:body.length,beforeCharacters:source.length,
    afterCharacters:expanded.length,countEntries:!!spec.countEntries};
}
module.exports={verifySpan,compactBody,prepare};
