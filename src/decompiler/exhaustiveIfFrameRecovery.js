'use strict';

// Every arm of a linear decision ladder leaves one plain frame. Express the
// same ordered predicates as else-if arms, with explicit inner/outer fallbacks.
// Keep each original arm scope and every effect; only direct terminal exits
// disappear. No classifier snapshots, predicate inversions or new locals.
function foldExhaustiveIfFrameExits(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, framesRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children, labelCounts} = proof;
  if ([...labelCounts.values()].some(n => n !== 1)) return unchanged();
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  const frames = [], targets = new Map(), references = new Map();
  let refused = false;
  function visit(node, labels = [], breaks = [], activeLoops = [], depth = 0) {
    if (depth > 128) {refused = true; return;}
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(node.kind || '') ||
        node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (node.kind === 'LabeledStatement' && node.statement?.kind === 'BlockStatement') frames.push(node);
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      const target = node.label ? labels.slice().reverse().find(n => n.label === node.label)
        : node.kind === 'ContinueStatement' ? activeLoops.at(-1) : breaks.at(-1);
      if (!target || node.kind === 'ContinueStatement' && node.label && !loops.has(target.statement?.kind)) refused = true;
      else {targets.set(node, target); references.set(target, [...(references.get(target) || []), node]);}
    }
    children(node, child => visit(child,
      node.kind === 'LabeledStatement' ? [...labels, node] : labels,
      loops.has(node.kind) || node.kind === 'SwitchStatement' ? [...breaks, node] : breaks,
      loops.has(node.kind) ? [...activeLoops, node] : activeLoops, depth + 1));
  }
  visit(parsed);
  if (refused) return unchanged();
  const bounds = node => {
    const open = starts.get(node?.range?.startOffset), close = closes.get(open);
    return node?.kind === 'BlockStatement' && tokens[open]?.text === '{' && tokens[close]?.text === '}' ? {open, close} : null;
  };
  const range = (first, last) => ({start: tokens[first].range.startOffset - 2, end: tokens[last].range.endOffset - 2});
  const offset = index => tokens[index].range.startOffset - 2;
  for (const frame of frames.sort((a, b) => b.range.startOffset - a.range.startOffset)) {
    const body = bounds(frame.statement), statements = frame.statement.statements;
    if (!body || statements.length < 2 || tokens[body.close].range.endOffset - frame.range.startOffset > 80000) continue;
    for (let guardIndex = 0; guardIndex < statements.length - 1; guardIndex++) {
      const guard = statements[guardIndex], inner = bounds(guard.consequent);
      if (guard.kind !== 'IfStatement' || guard.alternate || !inner) continue;
      const sequence = guard.consequent.statements, arms = [];
      let index = 0;
      while (sequence[index]?.kind === 'IfStatement' && !sequence[index].alternate) {
        const branch = sequence[index], scope = bounds(branch.consequent), jump = branch.consequent?.statements?.at(-1);
        if (!scope || jump?.kind !== 'BreakStatement' || targets.get(jump) !== frame) break;
        arms.push({branch, scope, jump}); index++;
      }
      const tail = sequence.slice(index), finalExit = tail.at(-1), refs = references.get(frame) || [];
      if (arms.length < 2 || arms.length > 64 || tail.length < 2 || finalExit?.kind !== 'BreakStatement' || targets.get(finalExit) !== frame) continue;
      const exits = [...arms.map(a => a.jump), finalExit];
      if (refs.length !== exits.length || refs.some(n => !exits.includes(n))) continue;
      const first = starts.get(guard.range.startOffset), conditionClose = closes.get(first + 1),
        label = starts.get(frame.range.startOffset), suffix = starts.get(statements[guardIndex + 1].range.startOffset),
        tailFirst = starts.get(tail[0].range.startOffset), tailExit = starts.get(finalExit.range.startOffset);
      if (tokens[first]?.text !== 'if' || tokens[first + 1]?.text !== '(' || conditionClose + 1 !== inner.open ||
          tokens[label]?.text !== frame.label || tokens[label + 1]?.text !== ':' || label + 2 !== body.open ||
          suffix !== inner.close + 1 || tailExit + 3 !== inner.close || tokens[tailExit + 2]?.text !== ';') continue;
      const edits = [{start: offset(label), end: offset(body.open), text: '', kind: 'label'},
        {start: tokens[inner.close].range.endOffset - 2, end: tokens[inner.close].range.endOffset - 2, text: ' else {', kind: 'outer-else'},
        {start: offset(body.close), end: offset(body.close), text: '}\n', kind: 'outer-close'},
        {start: offset(inner.close), end: offset(inner.close), text: '}\n', kind: 'inner-close'}];
      const predicates = [], jumps = [];
      let valid = true;
      for (let i = 0; i < arms.length; i++) {
        const a = arms[i], begin = starts.get(a.branch.range.startOffset), close = closes.get(begin + 1), exit = starts.get(a.jump.range.startOffset);
        if (tokens[begin]?.text !== 'if' || tokens[begin + 1]?.text !== '(' || close + 1 !== a.scope.open ||
            exit + 3 !== a.scope.close || i === 0 && begin !== inner.open + 1 ||
            i > 0 && begin !== arms[i - 1].scope.close + 1) {valid = false; break;}
        if (i) edits.push({start: tokens[arms[i - 1].scope.close].range.endOffset - 2,
          end: offset(begin), text: ' else ', kind: 'else-if'});
        predicates.push({guard: range(begin, a.scope.close), condition: range(begin + 1, close), scope: range(a.scope.open, a.scope.close)});
      }
      if (!valid || tailFirst !== arms.at(-1).scope.close + 1) continue;
      const lastArmEnd = tokens[arms.at(-1).scope.close].range.endOffset - 2;
      edits.push({start: lastArmEnd, end: lastArmEnd, text: ' else {', kind: 'inner-else'});
      for (const jump of exits) {
        const begin = starts.get(jump.range.startOffset);
        if (tokens[begin]?.text !== 'break' || tokens[begin + 1]?.text !== frame.label || tokens[begin + 2]?.text !== ';') {valid = false; break;}
        const r = range(begin, begin + 2); jumps.push(r);
        const lineStart = source.lastIndexOf('\n', r.start - 1) + 1, newline = source.indexOf('\n', r.end);
        const lineEnd = newline < 0 ? source.length : newline;
        const entireLine = /^[ \t]*$/.test(source.slice(lineStart, r.start)) && /^[ \t\r]*$/.test(source.slice(r.end, lineEnd));
        edits.push({start: entireLine ? lineStart : r.start, end: entireLine ? lineEnd + (newline < 0 ? 0 : 1) : r.end,
          text: '', kind: 'exit'});
      }
      if (!valid) continue;
      edits.sort((a, b) => b.start - a.start || b.end - a.end);
      let result = source;
      for (const e of edits) result = result.slice(0, e.start) + e.text + result.slice(e.end);
      return {source: result, framesRecovered: 1, breaksRemoved: exits.length,
        ...(retainDiagnostics ? {diagnostics: {range: range(label, body.close), bodyRange: range(body.open, body.close), label: frame.label,
          guardIndex, guardRange: range(first, inner.close), conditionRange: range(first + 1, conditionClose),
          suffixRange: range(suffix, body.close - 1), suffixStatements: statements.length - guardIndex - 1,
          predicates, tailRange: range(tailFirst, tailExit - 1), tailStatements: tail.length - 1, jumps, edits}} : {})};
    }
  }
  return unchanged();
}

module.exports = {foldExhaustiveIfFrameExits};
