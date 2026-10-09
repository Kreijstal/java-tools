'use strict';
const {independentlyAssignedLocalSequence} = require('./primitiveLocalLifetimeRecovery');

// Replace a nonlocal frame exit from one loop with a local loop exit and an
// explicit completion flag. Guard each remaining block suffix on the path to
// the frame. No old predicate or action is copied. Protected/outer-loop
// corridors refuse: finally can override a pending transfer, and a second loop
// could evaluate another condition after the old frame would already be gone.
function foldLoopFrameCompletion(source, proof, {retainDiagnostics = false, reservedNames = []} = {}) {
  const unchanged = () => ({source, exitsRecovered: 0, labelsRemoved: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed,tokens,starts,closes,children,labelCounts} = proof;
  const loops = new Set(['WhileStatement','ForStatement','EnhancedForStatement','DoWhileStatement']);
  const parents = new Map(), targets = new Map(), references = new Map(), jumps = [],
    uninitialized = new Set(), contexts = new Map();
  let refused = false;
  function visit(node, parent = null, labels = [], activeLoops = [], breaks = []) {
    parents.set(node,parent);
    contexts.set(node,[...labels.map(n=>({node:n,label:n.label})),...activeLoops.map(n=>({node:n,loop:true}))]);
    if(node.kind==='VariableDeclarator'&&!node.initializer)uninitialized.add(node.name);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass|Pattern/.test(node.kind || '') || node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (['BreakStatement','ContinueStatement'].includes(node.kind)) {
      const target = node.label ? labels.slice().reverse().find(n=>n.label===node.label)
        : node.kind==='ContinueStatement' ? activeLoops.at(-1) : breaks.at(-1);
      if (!target) refused = true;
      else {targets.set(node,target);references.set(target,[...(references.get(target)||[]),node]);}
      if (node.kind==='BreakStatement' && node.label) jumps.push(node);
    }
    children(node,child=>visit(child,node,node.kind==='LabeledStatement'?[...labels,node]:labels,
      loops.has(node.kind)?[...activeLoops,node]:activeLoops,
      loops.has(node.kind)||node.kind==='SwitchStatement'?[...breaks,node]:breaks));
  }
  visit(parsed);
  if (refused || [...labelCounts.values()].some(n=>n!==1)) return unchanged();
  const blockBounds = node => {
    const open=starts.get(node?.range?.startOffset),close=closes.get(open);
    return node?.kind==='BlockStatement' && tokens[open]?.text==='{' && tokens[close]?.text==='}' ? {open,close} : null;
  };
  const range = (first,last) => ({start:tokens[first].range.startOffset-2,end:tokens[last].range.endOffset-2});
  const indentAt = offset => {const prefix=source.slice(source.lastIndexOf('\n',offset-1)+1,offset);return /^[ \t]*$/.test(prefix)?prefix:null;};
  const names=new Set([...reservedNames,...tokens.filter(t=>t.kind==='identifier').map(t=>t.text)]);
  for (const jump of jumps.sort((a,b)=>b.range.startOffset-a.range.startOffset)) {
    const frame=targets.get(jump),frameBody=blockBounds(frame?.statement),jumpFirst=starts.get(jump.range?.startOffset);
    if (frame?.kind!=='LabeledStatement'||!frameBody||!frame.statement.statements.length
        || tokens[jumpFirst]?.text!=='break'||tokens[jumpFirst+1]?.text!==frame.label||tokens[jumpFirst+2]?.text!==';') continue;
    let cursor=parents.get(jump),loop=null,valid=true;
    while(cursor && cursor!==frame) {
      if(loops.has(cursor.kind)){loop=cursor;break;}
      if(!['BlockStatement','IfStatement','LabeledStatement'].includes(cursor.kind)
          || cursor.kind==='LabeledStatement'&&!blockBounds(cursor.statement)){valid=false;break;}
      cursor=parents.get(cursor);
    }
    if(!valid||!loop)continue;
    const suffixes=[],corridor=[];
    cursor=loop;
    while(cursor!==frame.statement) {
      const parent=parents.get(cursor);if(!parent){valid=false;break;}
      if(parent.kind==='BlockStatement') {
        const index=parent.statements.indexOf(cursor),bounds=blockBounds(parent);
        if(index<0||!bounds){valid=false;break;}
        if(index+1<parent.statements.length) {
          const first=starts.get(parent.statements[index+1].range?.startOffset);
          if(first==null){valid=false;break;}
          const remainder=parent.statements.slice(index+1);
          if([...uninitialized].some(name=>!independentlyAssignedLocalSequence(remainder,name,contexts.get(parent)))){valid=false;break;}
          suffixes.push({start:tokens[first].range.startOffset-2,end:tokens[bounds.close].range.startOffset-2,statements:parent.statements.length-index-1});
        }
      }else if(parent.kind==='IfStatement') {
        if(![parent.consequent,parent.alternate].includes(cursor)){valid=false;break;}
      }else if(parent.kind==='LabeledStatement') {
        if(parent.statement!==cursor||!blockBounds(cursor)){valid=false;break;}
      }else {valid=false;break;}
      corridor.push(parent.kind);cursor=parent;
    }
    if(!valid||!suffixes.length||suffixes.length>32)continue;
    let number=0,name;do{name='decompiledFrameCompleted'+number++;}while(names.has(name));
    const firstBody=starts.get(frame.statement.statements[0].range?.startOffset);
    const declarationOffset=tokens[firstBody].range.startOffset-2,indent=indentAt(declarationOffset),multiline=indent!==null&&source.slice(declarationOffset,tokens[frameBody.close].range.endOffset-2).includes('\n');
    const edits=[{start:declarationOffset,end:declarationOffset,text:`boolean ${name} = true;`+(multiline?'\n'+indent:''),kind:'declaration'}];
    const jumpRange=range(jumpFirst,jumpFirst+2),braced=parents.get(jump)?.kind==='BlockStatement';
    const jumpIndent=indentAt(jumpRange.start),separate=braced&&jumpIndent!==null&&multiline;
    edits.push({...jumpRange,text:(braced?'':'{ ')+`${name} = false;`+(separate?'\n'+jumpIndent:' ')+`break;`+(braced?'':' }'),kind:'jump'});
    for(const suffix of suffixes) {
      const prefix=indentAt(suffix.start),multi=prefix!==null&&source.slice(suffix.start,suffix.end).includes('\n');
      edits.push({start:suffix.start,end:suffix.start,text:`if (${name}) {`+(multi?'\n'+prefix+'  ':''),kind:'guard-open'});
      if(multi) {
        const text=source.slice(suffix.start,suffix.end);let position=text.indexOf('\n');
        while(position>=0){const next=suffix.start+position+1;if(next<suffix.end&&/^[ \t]*\S/.test(source.slice(next,suffix.end)))edits.push({start:next,end:next,text:'  ',kind:'indent'});position=text.indexOf('\n',position+1);}
      }
      const closingIndent=indentAt(suffix.end)||'';
      edits.push({start:suffix.end,end:suffix.end,text:(multi?'  ':'')+'}'+(multi?'\n'+closingIndent:''),kind:'guard-close'});
    }
    const retained=(references.get(frame)||[]).length>1;
    if(!retained){const label=starts.get(frame.range.startOffset);edits.push({start:tokens[label].range.startOffset-2,end:tokens[frameBody.open].range.startOffset-2,text:'',kind:'label'});}
    edits.sort((a,b)=>b.start-a.start||b.end-a.end);
    let result=source;
    for(const edit of edits)result=result.slice(0,edit.start)+edit.text+result.slice(edit.end);
    return {source:result,exitsRecovered:1,labelsRemoved:Number(!retained),guardsAdded:suffixes.length,
      ...(retainDiagnostics?{diagnostics:{frameRange:range(starts.get(frame.range.startOffset),frameBody.close),loopStart:loop.range.startOffset-2,jumpRange,name,suffixes,corridorKinds:corridor,labelRetained:retained,edits}}:{})};
  }
  return unchanged();
}
module.exports={foldLoopFrameCompletion};
