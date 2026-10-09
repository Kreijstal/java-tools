'use strict';
const {independentlyAssignedLocalSequence} = require('./primitiveLocalLifetimeRecovery');

// Resolve each guarded frame exit locally, then guard all remaining block
// suffixes on its lexical path. Conditions/actions retain one occurrence.
// Loops, switches and protected corridors cannot become normal fallthrough.
function foldGuardedFrameCompletion(source, proof, {retainDiagnostics = false, reservedNames = []} = {}) {
  const unchanged = () => ({source, framesRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || !Array.isArray(reservedNames) || reservedNames.some(n=>typeof n!=='string') || source.length>400000) return unchanged();
  const {parsed,tokens,starts,closes,children,labelCounts}=proof;
  if([...labelCounts.values()].some(n=>n!==1))return unchanged();
  const loopKinds=new Set(['WhileStatement','ForStatement','EnhancedForStatement','DoWhileStatement']),parents=new Map(),refs=new Map(),frames=[],uninitialized=new Set(),declarations=new Map(),contexts=new Map();let refused=false;
  function visit(n,parent=null,labels=[],loops=[],breaks=[],depth=0){
    if(depth>128){refused=true;return;}parents.set(n,parent);contexts.set(n,[...labels.map(node=>({node,label:node.label})),...loops.map(node=>({node,loop:true}))]);
    if(/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(n.kind||'')||n.kind==='NewClassExpression'&&n.body!=null)refused=true;
    if(n.kind==='VariableDeclarator'){
      declarations.set(n.name,[...(declarations.get(n.name)||[]),n]);
      if(!n.initializer)uninitialized.add(n.name);
    }
    if(n.kind==='LabeledStatement'&&n.statement?.kind==='BlockStatement')frames.push(n);
    if(['BreakStatement','ContinueStatement'].includes(n.kind)){const target=n.label?labels.slice().reverse().find(x=>x.label===n.label):n.kind==='ContinueStatement'?loops.at(-1):breaks.at(-1);if(!target||n.kind==='ContinueStatement'&&n.label&&!loopKinds.has(target.statement?.kind))refused=true;else refs.set(target,[...refs.get(target)||[],n]);}
    children(n,c=>visit(c,n,n.kind==='LabeledStatement'?[...labels,n]:labels,loopKinds.has(n.kind)?[...loops,n]:loops,loopKinds.has(n.kind)||n.kind==='SwitchStatement'?[...breaks,n]:breaks,depth+1));
  }visit(parsed);if(refused)return unchanged();
  const bounds=n=>{const open=starts.get(n?.range?.startOffset),close=closes.get(open);return n?.kind==='BlockStatement'&&tokens[open]?.text==='{'&&tokens[close]?.text==='}'?{open,close}:null;};
  const range=(a,b)=>({start:tokens[a].range.startOffset-2,end:tokens[b].range.endOffset-2});
  const occupied=new Set([...reservedNames,...tokens.filter(t=>t.kind==='identifier').map(t=>t.text)]);
  function prefixAssignments(block){
    const assigned=new Map();
    // Every statement in this prefix executes before any possible frame exit.
    // A throwing initializer skips the original and transformed remainder.
    // Do not derive initialization from branches, loops or protected regions.
    for(const statement of block.statements){
      if(!['LocalVariableDeclarationStatement','ExpressionStatement'].includes(statement.kind))break;
      const assignment=statement.expression;
      if(assignment?.kind!=='AssignmentExpression'||assignment.operator!=='='||assignment.left.kind!=='Identifier')continue;
      const name=assignment.left.name,locals=declarations.get(name)||[];
      if(!uninitialized.has(name)||locals.length!==1||reservedNames.includes(name))continue;
      const declaration=parents.get(locals[0]),scope=parents.get(declaration);
      if(declaration?.kind!=='LocalVariableDeclarationStatement'||scope?.kind!=='BlockStatement'||!(declaration.range.startOffset<statement.range.startOffset))continue;
      let cursor=block;while(cursor&&cursor!==scope)cursor=parents.get(cursor);
      if(cursor!==scope||!independentlyAssignedLocalSequence([statement],name,contexts.get(block)))continue;
      assigned.set(name,{name,declarationOffset:declaration.range.startOffset-2,assignmentOffset:statement.range.startOffset-2});
    }
    return assigned;
  }
  for(const frame of frames.sort((a,b)=>b.range.startOffset-a.range.startOffset)){
    const body=bounds(frame.statement),jumps=refs.get(frame)||[],guards=[],suffixes=new Map(),assigned=prefixAssignments(frame.statement),usedAssignments=new Map();let valid=true;
    if(!body||!frame.statement.statements.length||!jumps.length||jumps.length>16||tokens[body.close].range.endOffset-frame.range.startOffset>80000)continue;
    for(const jump of jumps){
      if(jump.kind!=='BreakStatement'||jump.label!==frame.label){valid=false;break;}
      let guard=parents.get(jump);if(guard?.kind==='BlockStatement'&&guard.statements.length===1)guard=parents.get(guard);
      if(guard?.kind!=='IfStatement'||guard.alternate||!(guard.consequent===jump||guard.consequent?.kind==='BlockStatement'&&guard.consequent.statements.length===1&&guard.consequent.statements[0]===jump)){valid=false;break;}
      const first=starts.get(guard.range.startOffset),cc=closes.get(first+1),jf=starts.get(jump.range.startOffset),braced=guard.consequent.kind==='BlockStatement',last=braced?closes.get(cc+1):jf+2;
      if(tokens[first]?.text!=='if'||tokens[first+1]?.text!=='('||tokens[jf]?.text!=='break'||tokens[jf+1]?.text!==frame.label||tokens[jf+2]?.text!==';'||braced&&jf!==cc+2||!braced&&jf!==cc+1){valid=false;break;}
      const info={range:range(first,last),conditionRange:range(first+1,cc),jumpRange:range(jf,jf+2),corridorKinds:[]};
      let child=guard;
      while(child!==frame.statement){const parent=parents.get(child);if(!parent){valid=false;break;}
        if(parent.kind==='BlockStatement'){const b=bounds(parent),index=parent.statements.indexOf(child);if(!b||index<0){valid=false;break;}const rest=parent.statements.slice(index+1);if(rest.length){if([...uninitialized].some(name=>{if(independentlyAssignedLocalSequence(rest,name,contexts.get(parent)))return false;const prefix=assigned.get(name);if(!prefix)return true;usedAssignments.set(name,prefix);return false;})){valid=false;break;}const sf=starts.get(rest[0].range.startOffset);if(sf===undefined){valid=false;break;}const s={start:tokens[sf].range.startOffset-2,end:tokens[b.close].range.startOffset-2,statements:rest.length};suffixes.set(s.start+':'+s.end,s);}}
        else if(parent.kind==='IfStatement'){if(![parent.consequent,parent.alternate].includes(child)){valid=false;break;}}
        else if(parent.kind==='LabeledStatement'){if(parent.statement!==child||!bounds(child)){valid=false;break;}}
        else{valid=false;break;}
        info.corridorKinds.push(parent.kind);child=parent;
      }
      if(!valid)break;guards.push(info);
    }
    if(!valid||!suffixes.size||suffixes.size>32)continue;
    const sorted=[...suffixes.values()].sort((a,b)=>a.start-b.start||b.end-a.end);
    if(sorted.some((s,i)=>sorted.slice(i+1).some(t=>s.start<t.start&&t.start<s.end&&s.end<t.end)))continue;
    let n=0,name;do{name='decompiledFrameRemainder'+n++;}while(occupied.has(name));
    const label=starts.get(frame.range.startOffset),first=starts.get(frame.statement.statements[0].range.startOffset),declarationOffset=tokens[first].range.startOffset-2,indent=source.slice(source.lastIndexOf('\n',declarationOffset-1)+1,declarationOffset),newline=/^[ \t]*$/.test(indent)&&source.slice(declarationOffset,tokens[body.close].range.startOffset-2).includes('\n')?'\n'+indent:'';
    const edits=[{start:tokens[label].range.startOffset-2,end:tokens[body.open].range.startOffset-2,text:'',kind:'label'},{start:declarationOffset,end:declarationOffset,text:`boolean ${name} = true;`+newline,kind:'declaration'}];
    for(const g of guards)edits.push({...g.range,text:`${name} = !`+source.slice(g.conditionRange.start,g.conditionRange.end)+';',kind:'decision',conditionRange:g.conditionRange});
    const indents=new Map();
    const indentAt=offset=>{const text=source.slice(source.lastIndexOf('\n',offset-1)+1,offset);return /^[ \t]*$/.test(text)?text:null;};
    for(const s of sorted){const prefix=indentAt(s.start),multi=prefix!==null&&source.slice(s.start,s.end).includes('\n');
      edits.push({start:s.start,end:s.start,text:`if (${name}) {`+(multi?'\n'+prefix+'  ':''),kind:'guard-open'});
      if(multi){for(let offset=source.indexOf('\n',s.start)+1;offset>0&&offset<s.end;offset=source.indexOf('\n',offset)+1){if(/^[ \t]*\S/.test(source.slice(offset,s.end)))indents.set(offset,(indents.get(offset)||0)+2);}}
      const closeIndent=indentAt(s.end)||'';edits.push({start:s.end,end:s.end,text:(multi?'  ':'')+'}'+(multi?'\n'+closeIndent:''),kind:'guard-close'});
    }
    // Replacement ranges use original offsets. An insertion inside a decision
    // would shift its end before replacement and leave stray original tokens.
    // Multiline conditions retain their original internal whitespace instead.
    for(const[start,count]of indents){
      if(guards.some(g=>g.range.start<start&&start<g.range.end))continue;
      edits.push({start,end:start,text:' '.repeat(count),kind:'indent'});
    }
    // At one boundary, close an inner suffix before opening a later suffix.
    edits.sort((a,b)=>b.start-a.start||b.end-a.end||(a.kind==='guard-open'?-1:b.kind==='guard-open'?1:0));let result=source;
    for(const e of edits)result=result.slice(0,e.start)+e.text+result.slice(e.end);
    return{source:result,framesRecovered:1,jumpsRemoved:guards.length,guardsAdded:sorted.length,...(retainDiagnostics?{diagnostics:{range:range(label,body.close),name,label:frame.label,declarationOffset,guards,suffixes:sorted,prefixAssignments:[...usedAssignments.values()],edits}}:{})};
  }
  return unchanged();
}
module.exports={foldGuardedFrameCompletion};
