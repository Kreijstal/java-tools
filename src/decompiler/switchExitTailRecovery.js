'use strict';

// A switch has one direct normal exit, followed by effectful work and an exit
// from a surrounding plain frame. Attach that work to its sole normal case,
// then localize the other frame exits to the switch. The final frame exit
// stays in place. Conditions, selector, fallthrough and effects are unchanged.
function foldSwitchExitTails(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, switchesRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children, labelCounts} = proof;
  if ([...labelCounts.values()].some(n => n !== 1)) return unchanged();
  const loopKinds = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  const blocks = [], parents = new Map(), targets = new Map(), nearest = new Map(), references = new Map();
  let refused = false;
  function visit(n, parent = null, labels = [], breaks = [], loops = [], depth = 0) {
    if (depth > 128) {refused = true; return;}
    parents.set(n, parent);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(n.kind || '') ||
        n.kind === 'NewClassExpression' && n.body != null) refused = true;
    if (n.kind === 'BlockStatement') blocks.push(n);
    if (['BreakStatement', 'ContinueStatement'].includes(n.kind)) {
      const target = n.label ? labels.slice().reverse().find(l => l.label === n.label)
        : n.kind === 'ContinueStatement' ? loops.at(-1) : breaks.at(-1);
      if (!target || n.kind === 'ContinueStatement' && n.label && !loopKinds.has(target.statement?.kind)) refused = true;
      else {targets.set(n, target); nearest.set(n, breaks.at(-1)); references.set(target, [...(references.get(target) || []), n]);}
    }
    children(n, c => visit(c, n, n.kind === 'LabeledStatement' ? [...labels, n] : labels,
      loopKinds.has(n.kind) || n.kind === 'SwitchStatement' ? [...breaks, n] : breaks,
      loopKinds.has(n.kind) ? [...loops, n] : loops, depth + 1));
  }
  visit(parsed);
  if (refused) return unchanged();
  const range = (first, last) => ({start: tokens[first].range.startOffset - 2, end: tokens[last].range.endOffset - 2});
  for (const block of blocks) {
    const ss = block.statements, close = closes.get(starts.get(block.range?.startOffset));
    if (ss.length < 3 || tokens[close]?.text !== '}') continue;
    const exit = ss.at(-1), frame = targets.get(exit), exitFirst = starts.get(exit.range?.startOffset);
    if (exit.kind !== 'BreakStatement' || !exit.label || frame?.kind !== 'LabeledStatement' || frame.statement?.kind !== 'BlockStatement' ||
        tokens[exitFirst]?.text !== 'break' || tokens[exitFirst + 1]?.text !== frame.label || tokens[exitFirst + 2]?.text !== ';' || exitFirst + 3 !== close) continue;
    for (let index = 0; index < ss.length - 2; index++) {
      const dispatch = ss[index], tail = ss.slice(index + 1, -1), groups = dispatch.groups;
      if (dispatch.kind !== 'SwitchStatement' || !groups?.length || groups.length > 128 || tail.length > 8 ||
          tail.some(n => n.kind !== 'ExpressionStatement') ||
          groups.flatMap(g => g.labels).filter(l => l.labelKind === 'default').length !== 1 ||
          groups.some(g => g.labels.some(l => l.separator !== ':') || g.statements.some(s => s.kind === 'LocalVariableDeclarationStatement'))) continue;
      const normal = references.get(dispatch) || [];
      if (normal.length !== 1 || normal[0].kind !== 'BreakStatement' || normal[0].label ||
          !groups.some(g => g.statements.at(-1) === normal[0])) continue;
      // No implicit normal completion may bypass the selected exit. The final
      // group is unconditionally abrupt; preceding groups may fall through.
      const last = groups.at(-1).statements.at(-1);
      if (last?.kind !== 'BreakStatement' || targets.get(last) !== frame) continue;
      const jumps = (references.get(frame) || []).filter(j => {
        let n = parents.get(j); while (n && n !== dispatch) n = parents.get(n); return n === dispatch;
      });
      if (!jumps.length || jumps.length > 64 || jumps.some(j => j.kind !== 'BreakStatement' || nearest.get(j) !== dispatch)) continue;
      const first = starts.get(dispatch.range.startOffset), selectorClose = closes.get(first + 1), open = selectorClose + 1, switchClose = closes.get(open),
        tailFirst = starts.get(tail[0].range.startOffset), normalFirst = starts.get(normal[0].range.startOffset);
      if (tokens[first]?.text !== 'switch' || tokens[first + 1]?.text !== '(' || tokens[open]?.text !== '{' ||
          tokens[switchClose]?.text !== '}' || tailFirst !== switchClose + 1 || tokens[exitFirst - 1]?.text !== ';' ||
          tokens[normalFirst]?.text !== 'break' || tokens[normalFirst + 1]?.text !== ';' ||
          tokens[exitFirst + 2].range.endOffset - tokens[first].range.startOffset > 80000) continue;
      const tailRange = range(tailFirst, exitFirst - 1), normalRange = range(normalFirst, normalFirst + 1), edits = [
        {...tailRange, text: '', kind: 'tail-remove'},
        {start: normalRange.start, end: normalRange.start, text: source.slice(tailRange.start, tailRange.end) + '\n', kind: 'tail-insert', originRange: tailRange},
      ];
      let valid = true;
      const jumpRanges = [];
      for (const j of jumps) {
        const begin = starts.get(j.range.startOffset);
        if (tokens[begin]?.text !== 'break' || tokens[begin + 1]?.text !== frame.label || tokens[begin + 2]?.text !== ';') {valid = false; break;}
        jumpRanges.push(range(begin, begin + 2));
        edits.push({start: tokens[begin].range.endOffset - 2, end: tokens[begin + 2].range.startOffset - 2, text: '', kind: 'local-exit'});
      }
      if (!valid) continue;
      edits.sort((a, b) => b.start - a.start || b.end - a.end);
      let result = source; for (const e of edits) result = result.slice(0, e.start) + e.text + result.slice(e.end);
      return {source: result, switchesRecovered: 1, breaksLocalized: jumps.length,
        ...(retainDiagnostics ? {diagnostics: {label: frame.label, switchRange: range(first, switchClose), tailRange,
          normalExit: normalRange, finalExit: range(exitFirst, exitFirst + 2), tailStatements: tail.length, jumps: jumpRanges, edits}} : {})};
    }
  }
  return unchanged();
}

module.exports = {foldSwitchExitTails};
