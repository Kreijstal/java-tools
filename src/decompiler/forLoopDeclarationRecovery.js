'use strict';

// Narrow one primitive local's scope only when its first effective store is a
// for initializer and every reference belongs to that loop. Declarations with
// effects, conversions, captures, shadows or an externally observed value stay.
function localizeForLoopDeclarations(source, proof, {reservedNames = []} = {}) {
  const unchanged = () => ({source, declarationsMoved: 0});
  if (!proof || !Array.isArray(reservedNames)) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children} = proof;
  const primitives = new Set(['boolean','byte','short','char','int','long','float','double']);
  const reserved = new Set(reservedNames), bindings = new Map(), declarations = [], loops = new Map();
  const identifiers = new Map(), occurrences = new Map(), intervals = new Map();
  let ordinal = 0, refused = false;
  const captures = new Set(['ClassDeclaration','InterfaceDeclaration','EnumDeclaration','RecordDeclaration',
    'LambdaExpression','MethodDeclaration','ConstructorDeclaration','MethodReferenceExpression']);
  function add(map, name, value) {if (!map.has(name)) map.set(name, []);map.get(name).push(value);}
  function walk(node, parent = null) {
    const begin = ordinal++;
    if (captures.has(node.kind) || node.kind === 'NewClassExpression' && node.body) refused = true;
    if (node.kind === 'VariableDeclarator' || node.kind?.includes('Parameter')) add(bindings, node.name, node);
    if (node.kind === 'Identifier') add(identifiers, node.name, node);
    if (node.kind === 'LocalVariableDeclarationStatement' && parent?.kind === 'BlockStatement')
      declarations.push({node, owner: parent});
    if (node.kind === 'ForStatement' && node.initializer?.kind === 'AssignmentExpression'
        && node.initializer.operator === '=' && node.initializer.left?.kind === 'Identifier')
      add(loops, node.initializer.left.name, node);
    children(node, child => walk(child, node));
    intervals.set(node, {begin, end: ordinal++});
  }
  walk(parsed);
  if (refused) return unchanged();
  for (const token of tokens) if (token.kind === 'identifier') add(occurrences, token.text, token);
  const inert = node => !node || node.kind === 'LiteralExpression' && ['number','boolean','char'].includes(node.literalKind)
    || node.kind === 'UnaryExpression' && node.prefix && ['+','-'].includes(node.operator)
      && node.operand?.kind === 'LiteralExpression' && node.operand.literalKind === 'number';
  function mentions(node, name) {
    if (!node) return false;
    if (node.kind === 'Identifier' && node.name === name) return true;
    let found = false; children(node, child => {if (!found && mentions(child, name)) found = true;});return found;
  }
  const edits = []; let moved = 0;
  for (const {node, owner} of declarations) {
    const [variable] = node.declarators || [], type = node.variableType;
    if (node.declarators?.length !== 1 || node.modifiers?.length || node.annotations?.length
        || type?.kind !== 'PrimitiveType' || !primitives.has(type.name) || type.annotations?.length
        || variable.dimensions || !inert(variable.initializer) || reserved.has(variable.name)) continue;
    const name = variable.name, uses = occurrences.get(name) || [];
    if (bindings.get(name)?.length !== 1 || uses.length !== (identifiers.get(name)?.length || 0) + 1) continue;
    const declaration = starts.get(node.range?.startOffset), binding = tokens[declaration + 1];
    if (tokens[declaration]?.text !== type.name || binding?.kind !== 'identifier' || binding.text !== name) continue;
    let endDeclaration = declaration + 2;
    while (endDeclaration < tokens.length && tokens[endDeclaration].text !== ';') endDeclaration++;
    if (tokens[endDeclaration]?.text !== ';') continue;
    const references = uses.filter(token => token !== binding);
    if (!references.length) continue;
    const first = references[0].range.startOffset, last = references.at(-1).range.endOffset;
    for (const loop of loops.get(name) || []) {
      const outer = intervals.get(owner), inner = intervals.get(loop);
      if (!outer || !inner || inner.begin <= outer.begin || inner.end >= outer.end) continue;
      const start = starts.get(loop.range?.startOffset), open = start + 1, close = closes.get(open);
      const body = starts.get(loop.body?.range?.startOffset), endBody = closes.get(body);
      if (tokens[start]?.text !== 'for' || tokens[open]?.text !== '(' || close == null
          || loop.body?.kind !== 'BlockStatement' || tokens[body]?.text !== '{' || endBody == null
          || body !== close + 1 || tokens[open + 1]?.text !== name || tokens[open + 2]?.text !== '=') continue;
      if (tokens[endDeclaration].range.endOffset > tokens[start].range.startOffset
          || first < tokens[start].range.startOffset || last > tokens[endBody].range.endOffset
          || mentions(loop.initializer.right, name)) continue;
      let removalStart = tokens[declaration].range.startOffset, removalEnd = tokens[endDeclaration].range.endOffset;
      const lineStart = wrapped.lastIndexOf('\n', removalStart - 1) + 1;
      const newline = wrapped.indexOf('\n', removalEnd);
      if (newline >= 0 && !wrapped.slice(lineStart, removalStart).trim() && !wrapped.slice(removalEnd, newline).trim()) {
        removalStart = lineStart; removalEnd = newline + 1;
      }
      edits.push({start: removalStart, end: removalEnd, text: ''},
        {start: tokens[open + 1].range.startOffset, end: tokens[open + 1].range.startOffset, text: type.name + ' '});
      moved++;break;
    }
  }
  if (!moved) return unchanged();
  const fragments = []; let cursor = 0;
  for (const edit of edits.sort((a,b) => a.start - b.start)) {
    if (edit.start < cursor) return unchanged();
    fragments.push(wrapped.slice(cursor, edit.start), edit.text);cursor = edit.end;
  }
  fragments.push(wrapped.slice(cursor));
  return {source: fragments.join('').slice(2, -2), declarationsMoved: moved};
}

module.exports = {localizeForLoopDeclarations};
