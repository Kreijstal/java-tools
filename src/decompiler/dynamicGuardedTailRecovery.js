'use strict';

// if (c) { prefix; if (g) { tail; } } else { tail; }
// Cache the original decisions instead of repeating either predicate after
// effectful work. Keep prefix scopes, abrupt exits and enclosing protection.
function shareDynamicGuardedTails(source, proof, {
  retainDiagnostics = false, reservedNames = [], minimumSharedTokens = 24,
} = {}) {
  const unchanged = () => ({source, tailsShared: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || !Number.isInteger(minimumSharedTokens) ||
      minimumSharedTokens < 0 || minimumSharedTokens > 1024 || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children, labelCounts} = proof;
  if ([...labelCounts.values()].some(n => n !== 1)) return unchanged();
  const parents = new Map(), branches = [], uninitialized = new Set();
  let refused = false;
  function walk(node, parent = null, depth = 0) {
    if (depth > 128) {refused = true; return;}
    parents.set(node, parent);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(node.kind || '') ||
        node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (node.kind === 'VariableDeclarator' && !node.initializer) uninitialized.add(node.name);
    if (node.kind === 'IfStatement') branches.push(node);
    children(node, child => walk(child, node, depth + 1));
  }
  walk(parsed);
  if (refused) return unchanged();
  const bounds = node => {
    const open = starts.get(node?.range?.startOffset), close = closes.get(open);
    return node?.kind === 'BlockStatement' && tokens[open]?.text === '{' && tokens[close]?.text === '}'
      ? {open, close} : null;
  };
  const span = (first, last) => ({start: tokens[first].range.startOffset - 2, end: tokens[last].range.endOffset - 2});
  const identifierNames = (first, last) => new Set(tokens.slice(first, last + 1)
    .filter(t => t.kind === 'identifier').map(t => t.text));
  function declarations(node, out = new Set()) {
    if (node.kind === 'VariableDeclarator') out.add(node.name);
    children(node, child => declarations(child, out));
    return out;
  }
  function supportedTail(node) {
    if (node.kind === 'BlockStatement') return node.statements.every(supportedTail);
    if (node.kind === 'IfStatement') return supportedTail(node.consequent) && (!node.alternate || supportedTail(node.alternate));
    return ['ExpressionStatement', 'ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement', 'EmptyStatement'].includes(node.kind);
  }
  const occupied = new Set([...reservedNames, ...tokens.filter(t => t.kind === 'identifier').map(t => t.text)]);
  for (const branch of branches.sort((a, b) => b.range.startOffset - a.range.startOffset)) {
    if (parents.get(branch)?.kind !== 'BlockStatement') continue;
    const main = bounds(branch.consequent), fallback = bounds(branch.alternate);
    if (!main || !fallback || branch.consequent.statements.length < 2 || !branch.alternate.statements.length) continue;
    const guard = branch.consequent.statements.at(-1), tail = bounds(guard?.consequent);
    if (guard?.kind !== 'IfStatement' || guard.alternate || !tail || !supportedTail(guard.consequent)) continue;
    const sharedTokens = tokens.slice(fallback.open + 1, fallback.close);
    if (sharedTokens.length < minimumSharedTokens || sharedTokens.length > 2048 ||
        sharedTokens.map(t => t.text).join('\0') !== tokens.slice(tail.open + 1, tail.close).map(t => t.text).join('\0')) continue;
    const first = starts.get(branch.range.startOffset), conditionClose = closes.get(first + 1),
      guardFirst = starts.get(guard.range.startOffset), guardConditionClose = closes.get(guardFirst + 1);
    if (tokens[first]?.text !== 'if' || tokens[first + 1]?.text !== '(' || conditionClose + 1 !== main.open ||
        tokens[guardFirst]?.text !== 'if' || tokens[guardFirst + 1]?.text !== '(' || guardConditionClose + 1 !== tail.open ||
        tail.close + 1 !== main.close || tokens[main.close + 1]?.text !== 'else' || main.close + 2 !== fallback.open) continue;
    const candidateNames = identifierNames(first, fallback.close);
    // A new decision local cannot communicate Java definite-assignment
    // correlations to later code. Keep every such existing carrier intact.
    if ([...uninitialized].some(name => candidateNames.has(name))) continue;
    const prefix = branch.consequent.statements.slice(0, -1), tailNames = identifierNames(fallback.open + 1, fallback.close - 1);
    if (prefix.filter(n => n.kind === 'LocalVariableDeclarationStatement')
      .some(n => [...declarations(n)].some(name => tailNames.has(name)))) continue;
    const region = span(first, fallback.close);
    if (region.end - region.start > 80000) continue;
    let n = 0, name; do {name = 'decompiledSharedTail' + n++;} while (occupied.has(name));
    const condition = span(first + 1, conditionClose), guardCondition = span(guardFirst + 1, guardConditionClose),
      prefixRange = {start: tokens[starts.get(prefix[0].range.startOffset)].range.startOffset - 2, end: tokens[guardFirst].range.startOffset - 2},
      retainedTail = {start: tokens[fallback.open + 1].range.startOffset - 2, end: tokens[fallback.close].range.startOffset - 2},
      removedTail = span(tail.open + 1, tail.close - 1);
    const indentation = source.slice(source.lastIndexOf('\n', region.start - 1) + 1, region.start),
      multiline = /^[ \t]*$/.test(indentation) && source.slice(region.start, region.end).includes('\n'),
      newline = multiline ? '\n' + indentation : '', inner = multiline ? '\n' + indentation + '  ' : '';
    const segments = [
      {text: `boolean ${name} = !`}, {range: condition}, {text: ';' + newline + `if (!${name}) {` + inner},
      {range: prefixRange}, {text: `${name} = `}, {range: guardCondition},
      {text: ';' + newline + '}' + newline + `if (${name}) {` + inner},
      {range: retainedTail}, {text: '}'},
    ];
    const text = segments.map(s => s.text ?? source.slice(s.range.start, s.range.end)).join('');
    return {source: source.slice(0, region.start) + text + source.slice(region.end), tailsShared: 1,
      duplicateTokensRemoved: sharedTokens.length,
      ...(retainDiagnostics ? {diagnostics: {range: region, name, conditionRange: condition, guardConditionRange: guardCondition,
        prefixRange, retainedTailRange: retainedTail, removedTailRange: removedTail, segments}} : {})};
  }
  return unchanged();
}
module.exports = {shareDynamicGuardedTails};
