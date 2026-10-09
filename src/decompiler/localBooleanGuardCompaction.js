'use strict';

// A primitive local's assignment value is exactly the value of the immediate
// subsequent local read. Combine that read with the preceding short circuit,
// keeping every assignment conditional and every RHS at its original site.
function compactLocalBooleanGuards(source, proof, {retainDiagnostics = false, reservedNames = []} = {}) {
  const unchanged = () => ({source, guardsCompacted: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || !Array.isArray(reservedNames) ||
      reservedNames.some(name => typeof name !== 'string') || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children} = proof;
  const parents = new Map(), declarations = new Map(), candidates = [];
  let refused = false;
  function visit(node, parent = null, depth = 0) {
    if (depth > 128) {refused = true; return;}
    parents.set(node, parent);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(node.kind || '') ||
        node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (node.kind === 'VariableDeclarator')
      declarations.set(node.name, [...(declarations.get(node.name) || []), node]);
    if (node.kind === 'IfStatement' && !node.alternate && parent?.kind === 'BlockStatement') candidates.push(node);
    children(node, child => visit(child, node, depth + 1));
  }
  visit(parsed);
  if (refused) return unchanged();
  const peel = node => {while (node?.kind === 'ParenthesizedExpression') node = node.expression; return node;};
  function localBoolean(name, node) {
    if (reservedNames.includes(name)) return false;
    const locals = declarations.get(name) || [];
    if (locals.length !== 1 || locals[0].dimensions) return false;
    const declaration = parents.get(locals[0]), scope = parents.get(declaration);
    if (declaration?.kind !== 'LocalVariableDeclarationStatement' || scope?.kind !== 'BlockStatement' ||
        declaration.variableType?.kind !== 'PrimitiveType' || declaration.variableType.name !== 'boolean' ||
        !(declaration.range.startOffset < node.range.startOffset)) return false;
    let cursor = node;
    while (cursor && cursor !== scope) cursor = parents.get(cursor);
    return cursor === scope;
  }
  function chain(node, name) {
    node = peel(node);
    if (node?.kind === 'Identifier' && node.name === name) return [];
    if (node?.kind !== 'BinaryExpression' || node.operator !== '&&') return null;
    const prefix = chain(node.left, name), assignment = peel(node.right);
    if (!prefix || assignment?.kind !== 'AssignmentExpression' || assignment.operator !== '=' ||
        assignment.left?.kind !== 'Identifier' || assignment.left.name !== name) return null;
    return [...prefix, assignment];
  }
  const range = (first, last) => ({start: tokens[first].range.startOffset - 2, end: tokens[last].range.endOffset - 2});
  for (const outer of candidates.sort((a, b) => b.range.startOffset - a.range.startOffset)) {
    const condition = peel(outer.condition), block = outer.consequent;
    if (condition?.kind !== 'Identifier' || !localBoolean(condition.name, outer) ||
        block?.kind !== 'BlockStatement' || block.statements.length !== 2) continue;
    const [statement, inner] = block.statements, assignment = statement.expression, name = condition.name;
    if (statement.kind !== 'ExpressionStatement' || assignment?.kind !== 'AssignmentExpression' ||
        assignment.operator !== '=' || assignment.left?.kind !== 'Identifier' || assignment.left.name !== name ||
        inner.kind !== 'IfStatement' || inner.alternate || inner.consequent?.kind !== 'BlockStatement') continue;
    const assignments = chain(inner.condition, name);
    if (!assignments || assignments.length > 32) continue;
    const first = starts.get(outer.range.startOffset), conditionClose = closes.get(first + 1),
      open = starts.get(block.range.startOffset), close = closes.get(open),
      write = starts.get(statement.range.startOffset), nested = starts.get(inner.range.startOffset),
      nestedClose = closes.get(nested + 1), bodyOpen = starts.get(inner.consequent.range.startOffset), bodyClose = closes.get(bodyOpen);
    const semicolon = nested - 1;
    if (tokens[first]?.text !== 'if' || tokens[first + 1]?.text !== '(' || conditionClose + 1 !== open ||
        tokens[open]?.text !== '{' || write !== open + 1 || tokens[write]?.text !== name || tokens[write + 1]?.text !== '=' ||
        tokens[semicolon]?.text !== ';' || tokens[nested]?.text !== 'if' || tokens[nested + 1]?.text !== '(' ||
        nestedClose + 1 !== bodyOpen || tokens[bodyOpen]?.text !== '{' || bodyClose + 1 !== close) continue;
    // The old inner condition is a left-associated conjunction starting with
    // exactly this local. Preserve every later assignment segment verbatim.
    let cursor = nested + 2;
    const headParens = [];
    while (tokens[cursor]?.text === '(' && closes.get(cursor) < nestedClose) {headParens.push(cursor); cursor++;}
    if (tokens[cursor]?.text !== name) continue;
    const innerRead = range(cursor, cursor), conditionRange = range(first + 1, conditionClose),
      assignmentRange = range(write, semicolon - 1), bodyRange = range(bodyOpen, bodyClose), whole = range(first, close);
    if (whole.end - whole.start > 80000) continue;
    // Recover the existing conjunction's suffix after the initial local read.
    // Peel only parentheses around the initial local, never around the whole
    // conjunction. The remaining conjunction suffix must start with &&.
    let headEnd = cursor;
    for (const openHead of headParens.reverse()) {
      if (closes.get(openHead) !== headEnd + 1) {headEnd = -1; break;}
      headEnd++;
    }
    if (assignments.length && (headEnd < 0 || tokens[headEnd + 1]?.text !== '&&')) continue;
    const segments = [{range: range(first, first)}, {text: ' ('}, {range: conditionRange},
      {text: ' && ('}, {range: assignmentRange}, {text: ')'}];
    if (assignments.length) segments.push({range: {start: tokens[headEnd].range.endOffset - 2, end: tokens[nestedClose].range.startOffset - 2}});
    segments.push({text: ') '}, {range: bodyRange});
    const replacement = segments.map(s => s.text ?? source.slice(s.range.start, s.range.end)).join('');
    return {source: source.slice(0, whole.start) + replacement + source.slice(whole.end), guardsCompacted: 1,
      ...(retainDiagnostics ? {diagnostics: {range: whole, name, conditionRange, assignmentRange,
        innerRead, bodyRange, assignmentConditions: assignments.length + 1, segments}} : {})};
  }
  return unchanged();
}

module.exports = {compactLocalBooleanGuards};
