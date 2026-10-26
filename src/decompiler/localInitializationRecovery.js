'use strict';

// Place an inert, unambiguous local declaration on its first standalone store.
// Its written type and RHS bytes stay exact. Every remaining reference must
// follow that store in the same existing block, so no handler/join can observe
// an old value or enter the narrowed scope without executing initialization.
function localizeLocalInitializations(source, proof, {reservedNames = []} = {}) {
  const unchanged = () => ({source, declarationsMerged: 0});
  if (!proof || !Array.isArray(reservedNames)) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children} = proof;
  const primitives = new Set(['boolean','byte','short','char','int','long','float','double']);
  const reserved = new Set(reservedNames), bindings = new Map(), declarations = [], stores = new Map();
  const identifiers = new Map(), occurrences = new Map(), intervals = new Map(), blockBounds = new Map();
  const captures = new Set(['ClassDeclaration','InterfaceDeclaration','EnumDeclaration','RecordDeclaration',
    'LambdaExpression','MethodDeclaration','ConstructorDeclaration','MethodReferenceExpression']);
  let ordinal = 0, refused = false;
  const add = (map, name, value) => {if (!map.has(name)) map.set(name, []);map.get(name).push(value);};
  function walk(node, parent = null) {
    const begin = ordinal++;
    if (captures.has(node.kind) || node.kind === 'NewClassExpression' && node.body) refused = true;
    if (node.kind === 'VariableDeclarator' || node.kind?.includes('Parameter')) add(bindings, node.name, node);
    if (node.kind === 'Identifier') add(identifiers, node.name, node);
    if (node.kind === 'LocalVariableDeclarationStatement' && parent?.kind === 'BlockStatement')
      declarations.push({node, owner: parent});
    const assignment = node.kind === 'ExpressionStatement' && node.expression;
    if (parent?.kind === 'BlockStatement' && assignment?.kind === 'AssignmentExpression'
        && assignment.operator === '=' && assignment.left?.kind === 'Identifier') {
      const start = starts.get(node.range?.startOffset);
      if (tokens[start]?.text === assignment.left.name && tokens[start + 1]?.text === '=')
        stores.set(tokens[start].range.startOffset, {start, owner: parent});
    }
    children(node, child => walk(child, node));
    intervals.set(node, {begin, end: ordinal++});
  }
  walk(parsed);
  if (refused) return unchanged();
  for (const token of tokens) if (token.kind === 'identifier') add(occurrences, token.text, token);
  const scalarLiteral = node => node?.kind === 'LiteralExpression' && ['number','boolean','char'].includes(node.literalKind)
    || node?.kind === 'UnaryExpression' && node.prefix && ['+','-'].includes(node.operator)
      && node.operand?.kind === 'LiteralExpression' && node.operand.literalKind === 'number';
  function semicolon(start) {
    for (let index = start; index < tokens.length; index++) {
      if (tokens[index].text === ';') return index;
      if (closes.has(index)) index = closes.get(index);
      else if (['}',')',']'].includes(tokens[index].text)) return null;
    }
    return null;
  }
  function endBlock(node) {
    if (blockBounds.has(node)) return blockBounds.get(node);
    let open = starts.get(node.range?.startOffset);
    if (tokens[open]?.text !== '{') open = starts.get(node.statements?.[0]?.range?.startOffset) - 1;
    const close = tokens[open]?.text === '{' ? closes.get(open) : null;
    const end = close == null ? null : tokens[close].range.startOffset;
    blockBounds.set(node, end);return end;
  }
  const edits = []; let merged = 0;
  for (const {node, owner} of declarations) {
    const [variable] = node.declarators || [], type = node.variableType;
    const primitive = type?.kind === 'PrimitiveType' && primitives.has(type.name);
    const reference = ['ClassType','ArrayType','ParameterizedType'].includes(type?.kind) && type.name !== 'var';
    if (node.declarators?.length !== 1 || node.modifiers?.length || node.annotations?.length || variable.dimensions
        || !primitive && !reference || reserved.has(variable.name)) continue;
    let annotated = false;const inspectType = value => {if (value.annotations?.length) annotated = true;children(value, inspectType);};inspectType(type);
    if (annotated || variable.initializer && !(primitive ? scalarLiteral(variable.initializer)
      : variable.initializer.kind === 'LiteralExpression' && variable.initializer.literalKind === 'null')) continue;
    const name = variable.name, uses = occurrences.get(name) || [];
    if (bindings.get(name)?.length !== 1 || uses.length !== (identifiers.get(name)?.length || 0) + 1) continue;
    const declaration = starts.get(node.range?.startOffset), endDeclaration = semicolon(declaration);
    if (declaration == null || endDeclaration == null) continue;
    const declared = uses.filter(token => token.range.startOffset >= tokens[declaration].range.startOffset
      && token.range.endOffset <= tokens[endDeclaration].range.endOffset);
    if (declared.length !== 1) continue;
    const binding = declared[0], references = uses.filter(token => token !== binding);
    if (!references.length) continue;
    const store = stores.get(references[0].range.startOffset);
    if (!store || tokens[endDeclaration].range.endOffset > references[0].range.startOffset) continue;
    const outer = intervals.get(owner), inner = intervals.get(store.owner), endOwner = endBlock(store.owner);
    if (!outer || !inner || inner.begin < outer.begin || inner.end > outer.end || endOwner == null) continue;
    const endStore = semicolon(store.start);
    if (endStore == null || tokens[endStore].range.endOffset > endOwner) continue;
    // Excluding the declaration and store target, even a RHS self-reference
    // appears before this boundary. Reads in headers/handlers/sibling blocks
    // also fail these lexical bounds rather than acquiring a new binding.
    const remaining = references.slice(1);
    if (remaining.length && (remaining[0].range.startOffset < tokens[endStore].range.endOffset
      || remaining.at(-1).range.endOffset > endOwner)) continue;
    const typeText = wrapped.slice(tokens[declaration].range.startOffset, binding.range.startOffset).trim();
    if (!typeText) continue;
    let removalStart = tokens[declaration].range.startOffset, removalEnd = tokens[endDeclaration].range.endOffset;
    const lineStart = wrapped.lastIndexOf('\n', removalStart - 1) + 1, newline = wrapped.indexOf('\n', removalEnd);
    if (newline >= 0 && !wrapped.slice(lineStart, removalStart).trim() && !wrapped.slice(removalEnd, newline).trim()) {
      removalStart = lineStart;removalEnd = newline + 1;
    }
    edits.push({start: removalStart, end: removalEnd, text: ''},
      {start: references[0].range.startOffset, end: references[0].range.startOffset, text: typeText + ' '});
    merged++;
  }
  if (!merged) return unchanged();
  const fragments = []; let cursor = 0;
  for (const edit of edits.sort((a,b) => a.start - b.start)) {
    if (edit.start < cursor) return unchanged();
    fragments.push(wrapped.slice(cursor, edit.start), edit.text);cursor = edit.end;
  }
  fragments.push(wrapped.slice(cursor));
  return {source: fragments.join('').slice(2, -2), declarationsMerged: merged};
}

module.exports = {localizeLocalInitializations};
