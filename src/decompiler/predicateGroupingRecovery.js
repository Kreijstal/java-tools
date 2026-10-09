'use strict';

// Remove redundant groups in control conditions, without reassociating even
// associative Boolean operators. Arithmetic/comparison operands and call
// arguments remain opaque; their grouping, casts and boxing stay intact.
function simplifyPredicateGrouping(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, conditionsSimplified: 0, parenthesisPairsRemoved: 0});
  if (!proof || source.length > 400000 || typeof retainDiagnostics !== 'boolean') return unchanged();
  const {parsed, tokens, starts, closes, children} = proof;
  const deleted = new Set(), pairs = [];
  let invalid = false, conditions = 0;
  function walk(node, visit, depth = 0) {
    if (depth > 128) { invalid = true; return; }
    visit(node); children(node, child => walk(child, visit, depth + 1));
  }
  walk(parsed, node => {
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) invalid = true;
  });
  if (invalid) return unchanged();
  const powers = {'||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
    '<': 7, '<=': 7, '>': 7, '>=': 7};
  function power(node) {
    if (node?.kind === 'BinaryExpression') return powers[node.operator] ?? null;
    if (node?.kind === 'InstanceofExpression') return 7;
    if (node?.kind === 'UnaryExpression' && node.operator === '!' && node.prefix === true) return 8;
    if (['Identifier', 'LiteralExpression', 'FieldAccessExpression', 'MethodInvocationExpression',
      'ArrayAccessExpression', 'ThisExpression', 'SuperExpression'].includes(node?.kind)) return 9;
    return null;
  }
  function removable(node, context) {
    if (node.expression?.kind === 'ParenthesizedExpression' || context.kind === 'condition') return true;
    const binding = power(node.expression);
    if (binding === null) return false;
    if (context.kind === 'not') return binding >= 8;
    return binding > powers[context.operator]
      || binding === powers[context.operator] && context.side === 'left';
  }
  function operator(node, first, end) {
    let result = null;
    for (let index = first; index < end; index++) {
      if (closes.has(index)) index = closes.get(index);
      else if (tokens[index].text === node.operator) result = index;
    }
    return result;
  }
  function visit(node, first, end, context, depth = 0) {
    if (!node || depth > 64 || first >= end) { invalid = true; return; }
    if (node.kind === 'ParenthesizedExpression') {
      if (tokens[first]?.text !== '(' || closes.get(first) !== end - 1) { invalid = true; return; }
      if (removable(node, context)) {
        for (const index of [first, end - 1]) {
          if (deleted.has(index)) { invalid = true; return; }
          deleted.add(index);
        }
        pairs.push({open: tokens[first].range.startOffset - 2, close: tokens[end - 1].range.startOffset - 2});
      }
      visit(node.expression, first + 1, end - 1, context, depth + 1);
    } else if (node.kind === 'BinaryExpression' && ['&&', '||'].includes(node.operator)) {
      const split = operator(node, first, end);
      if (split === null || split <= first || split >= end - 1) { invalid = true; return; }
      visit(node.left, first, split, {kind: 'logical', operator: node.operator, side: 'left'}, depth + 1);
      visit(node.right, split + 1, end, {kind: 'logical', operator: node.operator, side: 'right'}, depth + 1);
    } else if (node.kind === 'UnaryExpression' && node.operator === '!' && node.prefix === true) {
      if (tokens[first]?.text !== '!') { invalid = true; return; }
      visit(node.operand, first + 1, end, {kind: 'not'}, depth + 1);
    }
  }
  walk(parsed, node => {
    if (!node.condition) return;
    const first = starts.get(node.range?.startOffset);
    let open;
    if (['IfStatement', 'WhileStatement', 'ForStatement'].includes(node.kind)) open = first + 1;
    else if (node.kind === 'DoWhileStatement' && node.body?.kind === 'BlockStatement') {
      const body = starts.get(node.body.range?.startOffset), close = closes.get(body);
      if (tokens[close + 1]?.text === 'while') open = close + 2;
    }
    if (open === undefined) return;
    const close = closes.get(open);
    if (tokens[open]?.text !== '(' || close === undefined) { invalid = true; return; }
    let begin = open + 1, end = close;
    if (node.kind === 'ForStatement') {
      const semicolons = [];
      for (let index = begin; index < end; index++) {
        if (closes.has(index)) index = closes.get(index);
        else if (tokens[index].text === ';') semicolons.push(index);
      }
      if (semicolons.length !== 2) { invalid = true; return; }
      begin = semicolons[0] + 1; end = semicolons[1];
    }
    const previous = pairs.length;
    visit(node.condition, begin, end, {kind: 'condition'});
    if (pairs.length > previous) conditions++;
  });
  if (invalid || !pairs.length || pairs.length > 8192) return unchanged();
  const deletedRanges = [...deleted].map(index => ({start: tokens[index].range.startOffset - 2,
    end: tokens[index].range.endOffset - 2})).sort((a, b) => a.start - b.start);
  let output = source;
  for (const edit of deletedRanges.slice().reverse()) output = output.slice(0, edit.start) + output.slice(edit.end);
  return {source: output, conditionsSimplified: conditions, parenthesisPairsRemoved: pairs.length,
    ...(retainDiagnostics ? {diagnostics: {deletedRanges, pairs: pairs.sort((a, b) => a.open - b.open)}} : {})};
}

module.exports = {simplifyPredicateGrouping};
