'use strict';
const {JavaParser} = require('../java-frontend/parser');
const {tokenizeJava} = require('../java-frontend/lexer');
const parser = new JavaParser();

// Erase an allocator-owned exception carrier only when its entire lifetime is
// catch-entry stores followed by bare copies into existing reference locals.
// Keep the destination local and its type: substituting a narrower catch
// parameter into an overloaded call would not have this guarantee.
function removeCaughtExceptionCopies(source, declarations, proof, carrierNames) {
  const unchanged = () => ({source, declarations, removed: []});
  if (!proof || !Array.isArray(declarations) || source.length > 400000
      || [source, ...declarations].some(s => /\\u+[0-9a-fA-F]{4}/.test(s))) return unchanged();
  const names = new Set(carrierNames || []), locals = new Map(), declarationTokens = new Map();
  for (const declaration of declarations) {
    try {
      const node = parser.parseStatement(declaration, {requireComplete: true});
      const variable = node.declarators?.[0];
      if (node.kind !== 'LocalVariableDeclarationStatement' || node.declarators.length !== 1
          || node.modifiers?.length || node.annotations?.length || variable.dimensions
          || node.variableType?.kind !== 'ClassType' || node.variableType.name === 'var') continue;
      locals.set(variable.name, [...locals.get(variable.name) || [], {declaration, variable}]);
    } catch (_) { /* Unsupported declarations cannot supply a local binding. */ }
    declarationTokens.set(declaration, tokenizeJava(declaration).tokens);
  }
  const {parsed, tokens, starts, children} = proof;
  const parents = new Map(), catches = [], catchOwner = new Map(), bindings = new Map(), writes = new Set();
  let refused = false;
  function walk(node, parent = null, owner = null, depth = 0) {
    if (depth > 128) {refused = true; return;}
    parents.set(node, parent); catchOwner.set(node, owner);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(node.kind || '')
        || node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (['VariableDeclarator','FormalParameter'].includes(node.kind)) bindings.set(node.name, (bindings.get(node.name) || 0) + 1);
    if (node.kind === 'AssignmentExpression' && node.left?.kind === 'Identifier') writes.add(node.left.name);
    if (node.kind === 'UnaryExpression' && ['++','--'].includes(node.operator)) {
      const value = node.operand || node.expression;
      if (value?.kind === 'Identifier') writes.add(value.name);
    }
    if (node.kind === 'CatchClause') {
      // Shared carriers can be overwritten by a nested handler. Do not turn
      // a later read of that overwritten value into a read of the outer one.
      if (owner) {refused = true; return;}
      catches.push(node); owner = node;
    }
    children(node, child => walk(child, node, owner, depth + 1));
  }
  walk(parsed);
  if (refused) return unchanged();
  const uniqueLocal = name => (locals.get(name) || []).length === 1 && !bindings.has(name);
  const assignment = node => {
    if (node?.kind !== 'ExpressionStatement' || parents.get(node)?.kind !== 'BlockStatement'
        || node.expression?.kind !== 'AssignmentExpression' || node.expression.operator !== '='
        || node.expression.left.kind !== 'Identifier' || node.expression.right.kind !== 'Identifier') return null;
    const i = starts.get(node.range?.startOffset), left = node.expression.left.name, right = node.expression.right.name;
    return tokens[i]?.text === left && tokens[i + 1]?.text === '=' && tokens[i + 2]?.text === right && tokens[i + 3]?.text === ';'
      ? {left, right, i} : null;
  };
  const candidates = new Map();
  for (const name of names) {
    if (!uniqueLocal(name)) continue;
    const info = locals.get(name)[0];
    if (info.variable.initializer?.kind !== 'LiteralExpression' || info.variable.initializer.literalKind !== 'null') continue;
    const stores = new Map(), allowed = new Set(), edits = [];
    for (const clause of catches) {
      const first = clause.body?.statements?.[0], store = assignment(first), parameter = clause.parameter?.name;
      if (!store || store.left !== name || store.right !== parameter || bindings.get(parameter) !== 1
          || locals.has(parameter) || writes.has(parameter)) continue;
      stores.set(clause, parameter); allowed.add(store.i);
      edits.push({start: tokens[store.i].range.startOffset, end: tokens[store.i + 3].range.endOffset, text: ''});
    }
    if (!stores.size) continue;
    for (const [node, owner] of catchOwner) {
      const parameter = stores.get(owner);
      // The emitter can still have a scoped declaration here; its later
      // declaration-sinking pass resolves lifted duplicates. Keep this exact
      // declaration/type and change only its initializer's reference read.
      if (parameter && node.kind === 'LocalVariableDeclarationStatement' && parents.get(node)?.kind === 'BlockStatement'
          && node.declarators?.length === 1 && !node.modifiers?.length && !node.annotations?.length
          && node.variableType?.kind === 'ClassType' && node.variableType.name !== 'var') {
        const variable = node.declarators[0], i = starts.get(node.range?.startOffset);
        if (!variable.dimensions && variable.name !== name && variable.initializer?.kind === 'Identifier' && variable.initializer.name === name) {
          let end = i;
          while (end < tokens.length && tokens[end].text !== ';') end++;
          if (tokens[end - 3]?.text === variable.name && tokens[end - 2]?.text === '=' && tokens[end - 1]?.text === name) {
            allowed.add(end - 1);
            edits.push({start: tokens[end - 1].range.startOffset, end: tokens[end - 1].range.endOffset, text: parameter});
          }
        }
      }
      const copy = assignment(node);
      if (!copy || copy.right !== name || copy.left === name || !parameter || !uniqueLocal(copy.left)) continue;
      allowed.add(copy.i + 2);
      edits.push({start: tokens[copy.i + 2].range.startOffset, end: tokens[copy.i + 2].range.endOffset, text: parameter});
    }
    if (tokens.some((t, i) => t.kind === 'identifier' && t.text === name && !allowed.has(i))) continue;
    if (declarations.some(d => d !== info.declaration && (declarationTokens.get(d) || tokenizeJava(d).tokens).some(t => t.kind === 'identifier' && t.text === name))) continue;
    candidates.set(name, {declaration: info.declaration, edits});
  }
  const edits = [...candidates.values()].flatMap(c => c.edits).sort((a,b) => a.start - b.start);
  for (const edit of edits) if (!edit.text) {
    const start = proof.wrapped.lastIndexOf('\n', edit.start - 1) + 1, end = proof.wrapped.indexOf('\n', edit.end);
    if (end >= 0 && !proof.wrapped.slice(start, edit.start).trim() && !proof.wrapped.slice(edit.end, end).trim()) {edit.start = start; edit.end = end + 1;}
  }
  edits.sort((a,b) => a.start - b.start);
  if (edits.some((e,i) => i && edits[i-1].end > e.start)) return unchanged();
  let output = proof.wrapped;
  for (const edit of edits.reverse()) output = output.slice(0,edit.start) + edit.text + output.slice(edit.end);
  const removed = [...candidates.keys()];
  return {source: output.slice(2,-2), declarations: declarations.filter(d => ![...candidates.values()].some(c => c.declaration === d)), removed};
}
module.exports = {removeCaughtExceptionCopies};
