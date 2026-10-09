'use strict';

const {primitiveExpressionProof} = require('./primitiveExpressionProof');

// An exit guard is irrelevant only if both paths reach the same lexical exit
// and evaluating the guard cannot have effects or fail. Keep declarations and
// their initializers; infer types and scope, never the value of a captured flag.
function foldRedundantExitGuards(source, proof, {parameters = [], retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, guardsRemoved: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || !Array.isArray(parameters) || source.length > 400000) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  const targets = new Map(), lists = [];
  const returnTarget = {};
  let refused = false;
  function walk(node, visit, parent = null, depth = 0) {
    if (depth > 128) {refused = true; return;}
    visit(node, parent); children(node, child => walk(child, visit, node, depth + 1));
  }
  walk(parsed, node => {
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (node.kind === 'ExpressionStatement') {
      const expression = node.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(expression?.kind)
          && !(expression?.kind === 'UnaryExpression' && ['++', '--'].includes(expression.operator))) refused = true;
      let end = starts.get(node.range?.startOffset);
      if (end === undefined) refused = true;
      else {
        while (end < tokens.length && tokens[end].text !== ';' && tokens[end].text !== '}') {
          if (closes.has(end)) end = closes.get(end);
          end++;
        }
        if (tokens[end]?.text !== ';') refused = true;
      }
    }
  });
  if (refused || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  const primitiveProof = primitiveExpressionProof(proof, parameters);
  if (!primitiveProof) return unchanged();
  const {pureType} = primitiveProof;
  function inspect(node, labels = [], loopStack = [], breakStack = []) {
    if (node.kind === 'BlockStatement') lists.push(node.statements);
    if (node.kind === 'SwitchStatement') {
      if (node.groups.some(group => group.labels.some(label => label.separator !== ':'))) refused = true;
      for (let index = 0; index < node.groups.length; index++) {
        const group = node.groups[index]; let next = index + 1;
        while (next < node.groups.length && !node.groups[next].statements.length) next++;
        lists.push([...group.statements, ...(node.groups[next]?.statements.slice(0, 1) || [])]);
      }
    }
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      const frame = node.label && labels.slice().reverse().find(label => label.label === node.label);
      const target = node.label ? frame : node.kind === 'ContinueStatement' ? loopStack.at(-1) : breakStack.at(-1);
      if (!target || node.kind === 'ContinueStatement' && node.label && !loops.has(frame.statement?.kind)) refused = true;
      else targets.set(node, target);
    } else if (node.kind === 'ReturnStatement' && !node.expression) targets.set(node, returnTarget);
    const nestedLabels = node.kind === 'LabeledStatement' ? [...labels, node] : labels;
    const nestedLoops = loops.has(node.kind) ? [...loopStack, node] : loopStack;
    const nestedBreaks = loops.has(node.kind) || node.kind === 'SwitchStatement' ? [...breakStack, node] : breakStack;
    children(node, child => inspect(child, nestedLabels, nestedLoops, nestedBreaks));
  }
  inspect(parsed);
  if (refused) return unchanged();
  function jump(node) {
    if (node?.kind === 'BlockStatement') return node.statements.length === 1 ? jump(node.statements[0]) : null;
    return targets.has(node) ? node : null;
  }
  const same = (a, b) => a && b && a.kind === b.kind && (a.label || null) === (b.label || null) && targets.get(a) === targets.get(b);
  const empty = node => !node || node.kind === 'EmptyStatement' || node.kind === 'BlockStatement' && node.statements.length === 0;
  function finish(node) {
    const first = starts.get(node?.range?.startOffset);
    if (node?.kind === 'BlockStatement' && tokens[first]?.text === '{') return closes.get(first);
    if (node?.kind === 'EmptyStatement' && tokens[first]?.text === ';') return first;
    if (!targets.has(node)) return null;
    const keyword = {BreakStatement: 'break', ContinueStatement: 'continue', ReturnStatement: 'return'}[node.kind];
    if (tokens[first]?.text !== keyword) return null;
    const end = first + (node.label ? 2 : 1);
    return tokens[end]?.text === ';' ? end : null;
  }
  const selected = new Map();
  for (const list of lists) for (let index = 0; index < list.length; index++) {
    const guard = list[index];
    if (guard.kind !== 'IfStatement' || selected.has(guard)) continue;
    const first = starts.get(guard.range?.startOffset), open = first + 1, close = closes.get(open), yes = jump(guard.consequent);
    if (!yes || tokens[first]?.text !== 'if' || tokens[open]?.text !== '(' || close === undefined
        || pureType(guard.condition, tokens[first].range.startOffset) !== 'boolean') continue;
    const no = jump(guard.alternate), following = jump(list[index + 1]);
    const bothArms = Boolean(same(yes, no)), adjacent = empty(guard.alternate) && same(yes, following);
    if (!bothArms && !adjacent) continue;
    const last = finish(guard.alternate || guard.consequent), jumpFirst = starts.get(yes.range?.startOffset), jumpLast = finish(yes);
    if (last === null || jumpFirst === undefined || jumpLast === null) continue;
    let start = tokens[first].range.startOffset, end = tokens[last].range.endOffset;
    const ranges = bothArms ? [{start, end: tokens[jumpFirst].range.startOffset}, {start: tokens[jumpLast].range.endOffset, end}] : [{start, end}];
    if (adjacent) {
      const lineStart = wrapped.lastIndexOf('\n', start - 1) + 1, lineEnd = wrapped.indexOf('\n', end);
      if (lineEnd >= 0 && !wrapped.slice(lineStart, start).trim() && !wrapped.slice(end, lineEnd).trim()) {
        ranges[0] = {start: lineStart, end: lineEnd + 1};
      }
    }
    selected.set(guard, {ranges, guard: {start: start - 2, end: end - 2,
      conditionStart: tokens[open].range.endOffset - 2, conditionEnd: tokens[close].range.startOffset - 2,
      exitKind: yes.kind, exitLabel: yes.label || null, bothArms}});
  }
  if (!selected.size) return unchanged();
  const edits = [...selected.values()].flatMap(item => item.ranges).filter(range => range.start < range.end).sort((a, b) => a.start - b.start);
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + output.slice(edit.end);
  return {source: output.slice(2, -2), guardsRemoved: selected.size, ...(retainDiagnostics ? {diagnostics: {
    deletedRanges: edits.map(edit => ({start: edit.start - 2, end: edit.end - 2})),
    removedGuards: [...selected.values()].map(item => item.guard),
  }} : {})};
}

module.exports = {foldRedundantExitGuards};
