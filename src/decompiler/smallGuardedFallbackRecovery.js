'use strict';

function simple(node, depth=0) {
  if (!node || depth>16) return false;
  if (['Identifier','ThisExpression','SuperExpression','LiteralExpression'].includes(node.kind)) return true;
  if (node.kind==='ParenthesizedExpression') return simple(node.expression,depth+1);
  if (node.kind==='FieldAccessExpression') return simple(node.target,depth+1);
  if (node.kind==='UnaryExpression' && node.prefix===true && ['+','-'].includes(node.operator)
      && node.operand?.kind==='LiteralExpression' && node.operand.literalKind==='number'
      && /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*)(?:[lL])?$/.test(node.operand.raw||'')) return true;
  // Do not clone arithmetic, casts, unboxing conversions or poly expressions
  // into another source context. The call itself may have effects or fail.
  return false;
}

// A bounded fallback call can occupy both exclusive arms instead of repeating
// an unstable condition or introducing a selector. It still executes once.
function foldSmallGuardedFallbacks(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, framesRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children, labelCounts} = proof;
  if (labelCounts.size > 256 || [...labelCounts.values()].some(n => n !== 1)) return unchanged();
  const parents = new Map(), references = new Map(), frames = [];
  let refused = false;
  function walk(node, parent = null, depth = 0) {
    if (depth > 128) {refused = true;return;}
    parents.set(node, parent);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass|Pattern/.test(node.kind || '')
        || node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (node.kind === 'LabeledStatement') frames.push(node);
    if (['BreakStatement','ContinueStatement'].includes(node.kind) && node.label) references.set(node.label,[...(references.get(node.label)||[]),node]);
    children(node, child => walk(child,node,depth+1));
  }
  walk(parsed);if(refused)return unchanged();
  const range = (a,b) => ({start:tokens[a].range.startOffset-2,end:tokens[b].range.endOffset-2});
  const bounds = node => {const open=starts.get(node?.range?.startOffset),close=closes.get(open);return node?.kind==='BlockStatement'&&tokens[open]?.text==='{'&&tokens[close]?.text==='}'?{open,close}:null;};
  for (const frame of frames) {
    const body=bounds(frame.statement),refs=references.get(frame.label),label=starts.get(frame.range?.startOffset);
    if(!body||refs?.length!==1||refs[0].kind!=='BreakStatement'||tokens[label]?.text!==frame.label||tokens[label+1]?.text!==':'||label+2!==body.open
        ||tokens[body.close].range.endOffset-tokens[label].range.startOffset>40000)continue;
    const statements=frame.statement.statements,last=statements.at(-1),branch=statements.at(-2),arm=bounds(branch?.consequent);
    if(last?.kind!=='ExpressionStatement'||last.expression?.kind!=='MethodInvocationExpression'||branch?.kind!=='IfStatement'||branch.alternate||!arm)continue;
    const call=last.expression;
    if(call.typeArguments?.length||call.target&&!simple(call.target)||!call.arguments.every(arg=>simple(arg)))continue;
    const prefix=branch.consequent.statements.slice(0,-1),guard=branch.consequent.statements.at(-1);
    if(!prefix.length||prefix.some(statement=>statement.kind==='LocalVariableDeclarationStatement')||guard?.kind!=='IfStatement'||guard.alternate)continue;
    const braced=guard.consequent?.kind==='BlockStatement',jump=braced&&guard.consequent.statements.length===1?guard.consequent.statements[0]:guard.consequent;
    if(jump!==refs[0])continue;
    const first=starts.get(branch.range?.startOffset),conditionClose=closes.get(first+1),keep=starts.get(guard.range?.startOffset),keepClose=closes.get(keep+1);
    const jumpFirst=starts.get(jump.range?.startOffset),jumpLast=jumpFirst+2,guardLast=braced?closes.get(keepClose+1):jumpLast,fall=starts.get(last.range?.startOffset);
    if(tokens[first]?.text!=='if'||tokens[first+1]?.text!=='('||conditionClose+1!==arm.open||tokens[keep]?.text!=='if'||tokens[keep+1]?.text!=='('||keepClose===undefined
        ||tokens[jumpFirst]?.text!=='break'||tokens[jumpFirst+1]?.text!==frame.label||tokens[jumpLast]?.text!==';'
        ||(braced?tokens[keepClose+1]?.text!=='{'||jumpFirst!==keepClose+2||guardLast!==jumpLast+1:jumpFirst!==keepClose+1)
        ||arm.close!==guardLast+1||fall!==arm.close+1)continue;
    let fallLast=fall;
    while(fallLast<tokens.length&&tokens[fallLast].text!==';'&&tokens[fallLast].text!=='}'){if(closes.has(fallLast))fallLast=closes.get(fallLast);fallLast++;}
    const fallbackRange=range(fall,fallLast);
    if(tokens[fallLast]?.text!==';'||fallLast+1!==body.close||fallLast-fall+1>32||fallbackRange.end-fallbackRange.start>512
        ||source.slice(fallbackRange.start,fallbackRange.end).includes('\n'))continue;
    const keepFrame=parents.get(frame)?.kind!=='BlockStatement'||statements.slice(0,-2).some(statement=>statement.kind==='LocalVariableDeclarationStatement');
    const indentAt=offset=>{const prefix=source.slice(source.lastIndexOf('\n',offset-1)+1,offset);return /^[ \t]*$/.test(prefix)?prefix:null;};
    const branchIndent=indentAt(tokens[first].range.startOffset-2),guardIndent=indentAt(tokens[keep].range.startOffset-2),labelIndent=indentAt(tokens[label].range.startOffset-2);
    const multiline=branchIndent!==null&&guardIndent!==null&&labelIndent!==null&&source.slice(tokens[label].range.startOffset-2,tokens[body.close].range.endOffset-2).includes('\n');
    const segments=[],prefixStart=keepFrame?body.open:starts.get(statements[0].range.startOffset);
    segments.push({range:{start:tokens[prefixStart].range.startOffset-2,end:tokens[first].range.startOffset-2}});
    segments.push({range:{start:tokens[first].range.startOffset-2,end:tokens[keep].range.startOffset-2}});
    segments.push({text:'if (!'},{range:range(keep+1,keepClose)},{text:') {'+(multiline?'\n'+guardIndent+'  ':'')},
      {range:fallbackRange,copy:true},{text:multiline?'\n'+guardIndent+'}\n'+branchIndent:'}'},
      {range:range(arm.close,arm.close)},{text:' else {'+(multiline?'\n'+branchIndent+'  ':'')},{range:fallbackRange});
    if(keepFrame)segments.push({text:multiline?'\n'+branchIndent+'}\n'+labelIndent:'}'},{range:range(body.close,body.close)});
    else segments.push({text:multiline?'\n'+branchIndent:''},{range:range(body.close,body.close)});
    let text=segments.map(segment=>segment.text??source.slice(segment.range.start,segment.range.end)).join(''),dedent=null;
    if(!keepFrame&&multiline&&branchIndent.startsWith(labelIndent)&&branchIndent.length>labelIndent.length){dedent={indent:branchIndent,delta:branchIndent.length-labelIndent.length};text=text.split('\n').map((line,index)=>index&&line.startsWith(branchIndent)?line.slice(dedent.delta):line).join('\n');}
    const editRange=range(label,body.close);
    return {source:source.slice(0,editRange.start)+text+source.slice(editRange.end),framesRecovered:1,fallbackCallSitesAdded:1,
      fallbackIdentifierCopiesAdded:tokens.slice(fall,fallLast+1).filter(token=>token.kind==='identifier').length,
      ...(retainDiagnostics?{diagnostics:{range:editRange,segments,dedent,label:frame.label,frameScopeRetained:keepFrame,
        branchRange:range(first,arm.close),conditionRange:range(first+1,conditionClose),guardRange:range(keep+1,keepClose),
        jumpRange:range(jumpFirst,jumpLast),fallbackRange,prefixStatements:prefix.length}}:{})};
  }
  return unchanged();
}
module.exports={foldSmallGuardedFallbacks,simpleFallbackOperand:simple};
