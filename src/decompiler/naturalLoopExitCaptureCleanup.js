'use strict';

// A captured exit decision is redundant when no break can leave that loop.
// Keep the original condition in the header and its completion work in an
// intact block. Constant-expression ambiguity and all other flag uses refuse.
function simplifyNaturalLoopExitCaptures(source, proof, {parameterNames = [], retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, capturesRemoved: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || !Array.isArray(parameterNames) || parameterNames.some(n => typeof n !== 'string') || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children, labelCounts} = proof;
  if ([...labelCounts.values()].some(n => n !== 1)) return unchanged();
  const kinds = new Set(['WhileStatement','ForStatement','EnhancedForStatement','DoWhileStatement']);
  const parents = new Map(), references = new Map(), declarations = new Map(), identifiers = new Map(), scopes = new Map(), blocks = [];
  let refused = false;
  function collect(node, parent = null, labels = [], loops = [], breaks = [], depth = 0) {
    if (depth > 128) {refused = true; return;}
    parents.set(node,parent);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(node.kind || '') || node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (node.kind === 'BlockStatement') blocks.push(node);
    if (node.kind === 'VariableDeclarator') declarations.set(node.name,(declarations.get(node.name)||0)+1);
    if (node.kind === 'Identifier') identifiers.set(node.name,(identifiers.get(node.name)||0)+1);
    if (['BreakStatement','ContinueStatement'].includes(node.kind)) {
      const target = node.label ? labels.slice().reverse().find(n=>n.label===node.label) : node.kind==='ContinueStatement' ? loops.at(-1) : breaks.at(-1);
      if (!target || node.kind==='ContinueStatement' && node.label && !kinds.has(target.statement?.kind)) refused=true;
      else references.set(target,[...references.get(target)||[],node]);
    }
    children(node,child=>collect(child,node,node.kind==='LabeledStatement'?[...labels,node]:labels,kinds.has(node.kind)?[...loops,node]:loops,kinds.has(node.kind)||node.kind==='SwitchStatement'?[...breaks,node]:breaks,depth+1));
  }
  collect(parsed);
  if (refused) return unchanged();
  function remember(node,scope) {if(node?.kind==='LocalVariableDeclarationStatement')for(const d of node.declarators)scope.set(d.name,!node.modifiers?.some(m=>m.name==='final'));}
  function scopeWalk(node,scope) {
    scopes.set(node,new Map(scope));
    if(node.kind==='BlockStatement'){const next=new Map(scope);for(const s of node.statements){scopeWalk(s,next);remember(s,next);}return;}
    if(node.kind==='ForStatement'){const next=new Map(scope);remember(node.initializer,next);children(node,c=>scopeWalk(c,next));return;}
    if(node.kind==='EnhancedForStatement'||node.kind==='CatchClause'){const next=new Map(scope);if(node.parameter?.name)next.set(node.parameter.name,true);scopeWalk(node.body,next);return;}
    if(node.kind==='TryStatement'){const next=new Map(scope);for(const r of node.resources||[])remember(r,next);scopeWalk(node.block,next);for(const c of node.catches||[])scopeWalk(c,scope);if(node.finallyBlock)scopeWalk(node.finallyBlock,scope);return;}
    children(node,c=>scopeWalk(c,scope));
  }
  scopeWalk(parsed,new Map(parameterNames.map(n=>[n,true])));
  function nonconstant(node,scope) {
    if(node.kind==='Identifier')return scope.get(node.name)===true;
    if(node.kind==='LiteralExpression')return node.literalKind==='null';
    if(['MethodInvocationExpression','AssignmentExpression','ArrayAccessExpression','NewClassExpression','NewArrayExpression'].includes(node.kind))return true;
    if(node.kind==='UnaryExpression'&&['++','--'].includes(node.operator))return true;
    // A final field can be a constant even through a variable qualifier.
    if(node.kind==='FieldAccessExpression')return false;
    let found=false;children(node,c=>{if(nonconstant(c,scope))found=true;});return found;
  }
  const peel = n => {while(n?.kind==='ParenthesizedExpression')n=n.expression;return n;};
  const blockBounds = n => {const open=starts.get(n?.range?.startOffset),close=closes.get(open);return n?.kind==='BlockStatement'&&tokens[open]?.text==='{'&&tokens[close]?.text==='}'?{open,close}:null;};
  const range=(a,b)=>({start:tokens[a].range.startOffset-2,end:tokens[b].range.endOffset-2});
  for(const block of blocks.filter(blockBounds).sort((a,b)=>b.range.startOffset-a.range.startOffset)) {
    if(block.statements.length!==3)continue;
    const[decl,statement,guard]=block.statements,label=statement.kind==='LabeledStatement'?statement:null,loop=label?label.statement:statement;
    if(decl.kind!=='LocalVariableDeclarationStatement'||decl.variableType?.kind!=='PrimitiveType'||decl.variableType.name!=='boolean'||decl.declarators.length!==1||decl.modifiers?.length||decl.annotations?.length||decl.variableType.annotations?.length||loop?.kind!=='WhileStatement'||guard.kind!=='IfStatement'||guard.alternate||!blockBounds(loop.body)||!blockBounds(guard.consequent))continue;
    const variable=decl.declarators[0],initial=peel(variable.initializer),condition=peel(loop.condition),decision=peel(condition?.expression||condition?.operand),name=variable.name;
    if(initial?.kind!=='LiteralExpression'||initial.value!==false||condition?.kind!=='UnaryExpression'||condition.operator!=='!'||decision?.kind!=='AssignmentExpression'||decision.operator!=='='||peel(decision.left)?.kind!=='Identifier'||peel(decision.left).name!==name||peel(guard.condition)?.kind!=='Identifier'||peel(guard.condition).name!==name||declarations.get(name)!==1||identifiers.get(name)!==2||parameterNames.includes(name))continue;
    if([...references.get(loop)||[],...references.get(label)||[]].some(n=>n.kind==='BreakStatement')||!nonconstant(decision.right,scopes.get(loop)))continue;
    const declFirst=starts.get(decl.range.startOffset),loopFirst=starts.get(loop.range.startOffset),conditionClose=closes.get(loopFirst+1),guardFirst=starts.get(guard.range.startOffset),guardClose=closes.get(guardFirst+1),body=blockBounds(loop.body),work=blockBounds(guard.consequent);
    if(tokens[declFirst]?.text!=='boolean'||tokens[declFirst+1]?.text!==name||tokens[loopFirst]?.text!=='while'||tokens[guardFirst]?.text!=='if'||guardClose+1!==work.open)continue;
    // The parser's expression end can be an operator/identifier prefix. Use
    // the balanced parentheses around the assignment to certify its RHS.
    const assignmentOpen=loopFirst+4;
    if(tokens[loopFirst+1]?.text!=='('||tokens[loopFirst+2]?.text!=='!'||tokens[loopFirst+3]?.text!=='('||tokens[assignmentOpen]?.text!==name||tokens[assignmentOpen+1]?.text!=='=')continue;
    const rhsFirst=assignmentOpen+2, rhsLast=conditionClose-2;
    if(tokens[conditionClose-1]?.text!==')'||closes.get(loopFirst+3)!==conditionClose-1||body.open!==conditionClose+1||tokens[guardFirst+2]?.text!==name||guardClose!==guardFirst+3)continue;
    const capturedRange=range(loopFirst+1,conditionClose),rhsRange=range(rhsFirst,rhsLast),declarationRange=range(declFirst,loopFirst-1),guardRange=range(guardFirst,guardClose);
    // declarationRange must exclude an intact loop label.
    const statementFirst=starts.get(statement.range.startOffset);declarationRange.end=tokens[statementFirst].range.startOffset-2;
    const edits=[{...declarationRange,text:''},{...capturedRange,text:'(!'+source.slice(rhsRange.start,rhsRange.end)+')'},{...guardRange,text:''}];
    let output=source;for(const e of edits.slice().sort((a,b)=>b.start-a.start))output=output.slice(0,e.start)+e.text+output.slice(e.end);
    return{source:output,capturesRemoved:1,...(retainDiagnostics?{diagnostics:{name,range:range(blockBounds(block).open,blockBounds(block).close),declarationRange,capturedRange,conditionRange:rhsRange,guardRange,loopRange:range(loopFirst,body.close),workRange:range(work.open,work.close),label:label?.label||null,edits}}:{})};
  }
  return unchanged();
}
module.exports={simplifyNaturalLoopExitCaptures};
