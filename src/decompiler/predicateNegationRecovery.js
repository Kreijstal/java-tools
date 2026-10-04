'use strict';

// Boolean control conditions require a primitive result. De Morgan, equality
// complements and double negation preserve short-circuit order and unboxing.
// Keep arbitrary atoms verbatim; relational complements need type evidence
// and deliberately remain negated, including their NaN outcomes.
function simplifyPredicateNegations(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, predicatesSimplified: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children} = proof;
  const edits = [], counts = {doubleNegations: 0, equalityComplements: 0, deMorganOperators: 0, booleanLiterals: 0};
  let invalid = false, predicates = 0;
  function walk(node, visit, depth = 0) {
    if (depth > 128) { invalid = true; return; }
    visit(node); children(node, child => walk(child, visit, depth + 1));
  }
  walk(parsed, node => {
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) invalid = true;
  });
  if (invalid) return unchanged();
  function parenthesized(node, first, end) {
    return node.kind === 'ParenthesizedExpression' && tokens[first]?.text === '(' && closes.get(first) === end - 1;
  }
  function operator(node, first, end) {
    let result = null;
    for (let index = first; index < end; index++) {
      if (closes.has(index)) index = closes.get(index);
      else if (tokens[index].text === node.operator) result = index;
    }
    return result;
  }
  function replace(index, text) {
    edits.push({start: tokens[index].range.startOffset - 2, end: tokens[index].range.endOffset - 2, text});
  }
  function supported(node) {
    while (node?.kind === 'ParenthesizedExpression') node = node.expression;
    return node?.kind === 'UnaryExpression' && node.operator === '!' && node.prefix === true
      || node?.kind === 'BinaryExpression' && ['&&', '||', '==', '!='].includes(node.operator)
      || node?.kind === 'LiteralExpression' && ['true', 'false'].includes(node.raw);
  }
  function inverse(node, first, end, depth) {
    if (depth > 64 || first >= end) { invalid = true; return; }
    if (parenthesized(node, first, end)) return inverse(node.expression, first + 1, end - 1, depth + 1);
    if (node.kind === 'ParenthesizedExpression') { invalid = true; return; }
    if (node.kind === 'UnaryExpression' && node.operator === '!' && node.prefix === true) {
      if (tokens[first]?.text !== '!') { invalid = true; return; }
      replace(first, ''); counts.doubleNegations++; return;
    }
    if (node.kind === 'BinaryExpression' && ['&&', '||', '==', '!='].includes(node.operator)) {
      const index = operator(node, first, end);
      if (index === null || index <= first || index >= end - 1) { invalid = true; return; }
      replace(index, {'&&': '||', '||': '&&', '==': '!=', '!=': '=='}[node.operator]);
      if (['==', '!='].includes(node.operator)) { counts.equalityComplements++; return; }
      counts.deMorganOperators++;
      inverse(node.left, first, index, depth + 1); inverse(node.right, index + 1, end, depth + 1); return;
    }
    if (node.kind === 'LiteralExpression' && ['true', 'false'].includes(node.raw)) {
      if (end !== first + 1 || tokens[first].text !== node.raw) { invalid = true; return; }
      replace(first, node.raw === 'true' ? 'false' : 'true'); counts.booleanLiterals++; return;
    }
    // This atom may allocate, throw, read volatile state or contain arguments
    // with their own comparisons. Negate its complete value without inspecting
    // those operands or changing boxed-Boolean identity comparisons.
    edits.push({start: tokens[first].range.startOffset - 2, end: tokens[first].range.startOffset - 2, text: '!('},
      {start: tokens[end - 1].range.endOffset - 2, end: tokens[end - 1].range.endOffset - 2, text: ')'});
  }
  function visit(node, first, end, depth = 0) {
    if (depth > 64 || first >= end) { invalid = true; return; }
    if (parenthesized(node, first, end)) return visit(node.expression, first + 1, end - 1, depth + 1);
    if (node.kind === 'ParenthesizedExpression') { invalid = true; return; }
    if (node.kind === 'UnaryExpression' && node.operator === '!' && node.prefix === true && supported(node.operand)) {
      if (tokens[first]?.text !== '!') { invalid = true; return; }
      replace(first, ''); inverse(node.operand, first + 1, end, depth + 1); predicates++; return;
    }
    if (node.kind === 'BinaryExpression' && ['&&', '||'].includes(node.operator)) {
      const index = operator(node, first, end);
      if (index === null || index <= first || index >= end - 1) { invalid = true; return; }
      visit(node.left, first, index, depth + 1); visit(node.right, index + 1, end, depth + 1);
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
    visit(node.condition, begin, end);
  });
  if (invalid || !predicates || edits.length > 4096) return unchanged();
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  let output = source;
  for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return {source: output, predicatesSimplified: predicates,
    ...(retainDiagnostics ? {diagnostics: {counts, tokenEdits: edits}} : {})};
}

module.exports = {simplifyPredicateNegations};
