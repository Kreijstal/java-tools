'use strict';

// Keep one terminal exit and guard its complete preceding work with the inverse
// of the earlier exit predicate. Evaluate that original predicate once. Both
// exits must be direct siblings in the same lexical/protected block corridor.
function foldSharedFrameExitGuards(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, guardsRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children, labelCounts} = proof;
  if ([...labelCounts.values()].some(n => n !== 1)) return unchanged();
  const parents = new Map(), targets = new Map(), blocks = [], loopKinds = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  let refused = false;
  function visit(n, parent = null, labels = [], breaks = [], loops = [], depth = 0) {
    if (depth > 128) {refused = true; return;}
    parents.set(n, parent);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(n.kind || '') || n.kind === 'NewClassExpression' && n.body != null) refused = true;
    if (n.kind === 'BlockStatement') blocks.push(n);
    if (['BreakStatement', 'ContinueStatement'].includes(n.kind)) {
      const target = n.label ? labels.slice().reverse().find(x => x.label === n.label) : n.kind === 'ContinueStatement' ? loops.at(-1) : breaks.at(-1);
      if (!target || n.kind === 'ContinueStatement' && n.label && !loopKinds.has(target.statement?.kind)) refused = true;
      else targets.set(n, target);
    }
    children(n, child => visit(child, n, n.kind === 'LabeledStatement' ? [...labels, n] : labels,
      loopKinds.has(n.kind) || n.kind === 'SwitchStatement' ? [...breaks, n] : breaks, loopKinds.has(n.kind) ? [...loops, n] : loops, depth + 1));
  }
  visit(parsed); if (refused) return unchanged();
  const range = (a, b) => ({start: tokens[a].range.startOffset - 2, end: tokens[b].range.endOffset - 2});
  for (const block of blocks.slice().reverse()) {
    const statements = block.statements, terminal = statements.at(-1), target = targets.get(terminal);
    if (terminal?.kind !== 'BreakStatement' || !terminal.label || target?.kind !== 'LabeledStatement' || target.statement?.kind !== 'BlockStatement') continue;
    const last = starts.get(terminal.range?.startOffset);
    if (tokens[last]?.text !== 'break' || tokens[last + 1]?.text !== terminal.label || tokens[last + 2]?.text !== ';') continue;
    for (let index = statements.length - 3; index >= 0; index--) {
      const guard = statements[index], work = statements.slice(index + 1, -1);
      if (guard.kind !== 'IfStatement' || guard.alternate || !work.length || work.length > 32 || work.some(n => n.kind === 'LocalVariableDeclarationStatement')) continue;
      const braced = guard.consequent?.kind === 'BlockStatement', jump = braced && guard.consequent.statements.length === 1 ? guard.consequent.statements[0] : guard.consequent;
      if (jump?.kind !== 'BreakStatement' || jump.label !== terminal.label || targets.get(jump) !== target) continue;
      const first = starts.get(guard.range?.startOffset), cc = closes.get(first + 1), jf = starts.get(jump.range?.startOffset), end = braced ? closes.get(cc + 1) : jf + 2, next = starts.get(work[0].range?.startOffset);
      if (tokens[first]?.text !== 'if' || tokens[first + 1]?.text !== '(' || cc === undefined || tokens[jf]?.text !== 'break' || tokens[jf + 1]?.text !== terminal.label || tokens[jf + 2]?.text !== ';'
          || braced && (tokens[cc + 1]?.text !== '{' || jf !== cc + 2 || end !== jf + 3) || !braced && jf !== cc + 1 || next !== end + 1 || last - first > 16000) continue;
      const region = {start: tokens[first].range.startOffset - 2, end: tokens[last].range.startOffset - 2};
      if (region.end - region.start > 80000) continue;
      const conditionRange = range(first + 1, cc), workRange = {start: tokens[next].range.startOffset - 2, end: region.end}, line = source.slice(source.lastIndexOf('\n', region.start - 1) + 1, region.start), multiline = /^[ \t]*$/.test(line) && source.slice(region.start, region.end).includes('\n');
      const segments = [{range: range(first, first)}, {text: ' (!'}, {range: conditionRange}, {text: ') {' + (multiline ? '\n' + line + '  ' : '')}, {range: workRange}, {text: '}' + (multiline ? '\n' + line : '')}];
      const replacement = segments.map(s => s.text ?? source.slice(s.range.start, s.range.end)).join('');
      return {source: source.slice(0, region.start) + replacement + source.slice(region.end), guardsRecovered: 1, jumpsRemoved: 1,
        ...(retainDiagnostics ? {diagnostics: {range: region, segments, label: terminal.label, guardRange: range(first, end), conditionRange, jumpRange: range(jf, jf + 2), terminalJumpRange: range(last, last + 2), workRange, workStatements: work.length}} : {})};
    }
  }
  return unchanged();
}
module.exports = {foldSharedFrameExitGuards};
