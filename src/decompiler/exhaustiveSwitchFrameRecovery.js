'use strict';

// Every case of an exhaustive switch exits the same plain frame. The frame's
// remaining statements are therefore the original predicate's else arm.
// Retarget direct terminal case exits only; crossed protection and any other
// switch-local exit refuse. Keep predicates, selectors, stores and scopes.
function foldExhaustiveSwitchFrameExits(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, framesRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children, labelCounts} = proof;
  if ([...labelCounts.values()].some(n => n !== 1)) return unchanged();
  const loops = new Set(['WhileStatement','ForStatement','EnhancedForStatement','DoWhileStatement']);
  const targets = new Map(), references = new Map(), frames = [];
  let refused = false;
  function visit(node, labels = [], breakTargets = [], loopTargets = [], depth = 0) {
    if (depth > 128) {refused = true; return;}
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(node.kind || '') ||
        node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (node.kind === 'LabeledStatement' && node.statement?.kind === 'BlockStatement') frames.push(node);
    if (['BreakStatement','ContinueStatement'].includes(node.kind)) {
      const target = node.label ? labels.slice().reverse().find(n => n.label === node.label)
        : node.kind === 'ContinueStatement' ? loopTargets.at(-1) : breakTargets.at(-1);
      if (!target || node.kind === 'ContinueStatement' && node.label && !loops.has(target.statement?.kind)) refused = true;
      else {targets.set(node,target); references.set(target,[...(references.get(target)||[]),node]);}
    }
    children(node, child => visit(child,
      node.kind === 'LabeledStatement' ? [...labels,node] : labels,
      loops.has(node.kind) || node.kind === 'SwitchStatement' ? [...breakTargets,node] : breakTargets,
      loops.has(node.kind) ? [...loopTargets,node] : loopTargets, depth + 1));
  }
  visit(parsed);
  if (refused) return unchanged();
  const bounds = node => {
    const open = starts.get(node?.range?.startOffset), close = closes.get(open);
    return node?.kind === 'BlockStatement' && tokens[open]?.text === '{' && tokens[close]?.text === '}' ? {open,close} : null;
  };
  const range = (first,last) => ({start:tokens[first].range.startOffset-2,end:tokens[last].range.endOffset-2});
  for (const frame of frames.sort((a,b)=>b.range.startOffset-a.range.startOffset)) {
    const body = bounds(frame.statement), statements = frame.statement.statements;
    if (!body || statements.length < 2 || tokens[body.close].range.endOffset-frame.range.startOffset > 80000) continue;
    for (let index=0; index<statements.length-1; index++) {
      const guard = statements[index], arm = bounds(guard.consequent);
      if (guard.kind !== 'IfStatement' || guard.alternate || !arm || guard.consequent.statements.length !== 1) continue;
      const dispatch = guard.consequent.statements[0], groups = dispatch.groups;
      if (dispatch.kind !== 'SwitchStatement' || !groups?.length || groups.length > 128 ||
          groups.flatMap(g=>g.labels).filter(l=>l.labelKind==='default').length !== 1 ||
          groups.some(g=>!g.labels.length || g.labels.some(l=>l.separator!==':'))) continue;
      const exits = groups.map(g=>g.statements.at(-1)), frameReferences = references.get(frame) || [];
      if (exits.some(n=>n?.kind!=='BreakStatement' || n.label!==frame.label || targets.get(n)!==frame) ||
          frameReferences.length !== exits.length || frameReferences.some(n=>!exits.includes(n)) ||
          (references.get(dispatch)||[]).length) continue;
      const first = starts.get(guard.range.startOffset), conditionClose = closes.get(first+1),
        switchFirst = starts.get(dispatch.range.startOffset), selectorClose = closes.get(switchFirst+1),
        switchOpen = selectorClose+1, switchClose = closes.get(switchOpen),
        remainderFirst = starts.get(statements[index+1].range.startOffset), label = starts.get(frame.range.startOffset);
      if (tokens[first]?.text!=='if' || tokens[first+1]?.text!=='(' || conditionClose+1!==arm.open ||
          switchFirst!==arm.open+1 || tokens[switchFirst]?.text!=='switch' || tokens[switchFirst+1]?.text!=='(' ||
          tokens[switchOpen]?.text!=='{' || switchClose+1!==arm.close || remainderFirst!==arm.close+1 ||
          tokens[label]?.text!==frame.label || tokens[label+1]?.text!==':' || label+2!==body.open) continue;
      const edits = [{start:tokens[label].range.startOffset-2,end:tokens[body.open].range.startOffset-2,text:'',kind:'label'},
        {start:tokens[arm.close].range.endOffset-2,end:tokens[arm.close].range.endOffset-2,text:' else {',kind:'else-open'},
        {start:tokens[body.close].range.startOffset-2,end:tokens[body.close].range.startOffset-2,text:'}\n',kind:'else-close'}];
      const jumps = [];
      let valid = true;
      for (const exit of exits) {
        const first = starts.get(exit.range.startOffset);
        if (tokens[first]?.text!=='break' || tokens[first+1]?.text!==frame.label || tokens[first+2]?.text!==';') {valid=false; break;}
        const r=range(first,first+2);jumps.push(r);
        edits.push({start:tokens[first].range.endOffset-2,end:tokens[first+2].range.startOffset-2,text:'',kind:'unlabel'});
      }
      if (!valid) continue;
      edits.sort((a,b)=>b.start-a.start||b.end-a.end);
      let result=source;
      for (const e of edits) result=result.slice(0,e.start)+e.text+result.slice(e.end);
      return {source:result,framesRecovered:1,breaksLocalized:exits.length,
        ...(retainDiagnostics?{diagnostics:{range:range(label,body.close),bodyRange:range(body.open,body.close),label:frame.label,
          guardRange:range(first,arm.close),conditionRange:range(first+1,conditionClose),
          switchRange:range(switchFirst,switchClose),suffixRange:range(remainderFirst,body.close-1),
          suffixStatements:statements.length-index-1,jumps,edits}}:{})};
    }
  }
  return unchanged();
}

module.exports={foldExhaustiveSwitchFrameExits};
