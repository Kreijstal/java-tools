'use strict';

// Infer only scoped primitive bindings and total, effect-free expressions.
// No initializer value, field value, unboxing or capture invariant is assumed.
function primitiveExpressionProof(proof, parameters = [], literalType = null) {
  if (!proof || !Array.isArray(parameters)) return null;
  const {parsed, tokens, starts, closes, children} = proof;
  const primitives = new Set(['boolean', 'byte', 'short', 'char', 'int', 'long', 'float', 'double']);
  const counts = new Map(), locals = new Map(), formals = new Map(), statementStarts = new Set();
  let refused = false;
  function walk(node, visit, parent = null, depth = 0) {
    if (depth > 128) {refused = true; return;}
    visit(node, parent); children(node, child => walk(child, visit, node, depth + 1));
  }
  walk(parsed, node => {
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')
        || node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (['VariableDeclarator', 'FormalParameter'].includes(node.kind)) counts.set(node.name, (counts.get(node.name) || 0) + 1);
    if (node.kind?.endsWith('Statement') && node.range) statementStarts.add(node.range.startOffset);
  });
  if (refused) return null;
  for (const parameter of parameters) {
    if (!parameter || typeof parameter.name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(parameter.name)
        || typeof parameter.type !== 'string' || formals.has(parameter.name)) return null;
    formals.set(parameter.name, primitives.has(parameter.type) ? parameter.type : null);
  }
  walk(parsed, (node, parent) => {
    if (node.kind !== 'LocalVariableDeclarationStatement' || parent?.kind !== 'BlockStatement'
        || node.annotations?.length || node.variableType?.annotations?.length
        || node.variableType?.kind !== 'PrimitiveType' || !primitives.has(node.variableType.name)) return;
    let open = starts.get(parent.range?.startOffset);
    if (open === undefined) {
      const first = starts.get(parent.statements?.[0]?.range?.startOffset);
      if (tokens[first - 1]?.text === '{') open = first - 1;
    }
    const close = closes.get(open), first = starts.get(node.range?.startOffset);
    if (tokens[open]?.text !== '{' || close === undefined || first === undefined) return;
    let end = null;
    for (let index = first; index < close; index++) {
      if (index !== first && statementStarts.has(tokens[index].range.startOffset)) break;
      if (tokens[index].text === ';') {end = index; break;}
      if (tokens[index].text === '}') break;
      if (closes.has(index)) index = closes.get(index);
    }
    if (end === null) return;
    for (const variable of node.declarators) if (variable.dimensions === 0) locals.set(variable.name, {
      type: node.variableType.name, declarationStart: tokens[first].range.startOffset, declarationEnd: tokens[end].range.endOffset, start: tokens[end].range.endOffset, end: tokens[close].range.startOffset,
    });
  });
  const numeric = type => primitives.has(type) && type !== 'boolean';
  const integral = type => ['byte', 'short', 'char', 'int', 'long'].includes(type);
  function pureType(node, site, depth = 0) {
    if (!node || depth > 64) return null;
    const type = child => pureType(child, site, depth + 1);
    if (node.kind === 'ParenthesizedExpression') return type(node.expression);
    if (node.kind === 'Identifier') {
      if (formals.has(node.name)) return counts.has(node.name) ? null : formals.get(node.name);
      const local = locals.get(node.name);
      return counts.get(node.name) === 1 && local && site >= local.start && site < local.end ? local.type : null;
    }
    if (node.kind === 'LiteralExpression') {
      if (['true', 'false'].includes(node.raw)) return 'boolean';
      if (node.literalKind === 'char') return 'char';
      const raw = (node.raw || '').replace(/_/g, '');
      if (node.literalKind === 'number' && /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)[lL]?$/.test(raw)) return /[lL]$/.test(raw) ? 'long' : 'int';
      return literalType ? literalType(node) : null;
    }
    if (node.kind === 'UnaryExpression') {
      const operand = type(node.operand);
      if (node.operator === '!' && node.prefix === true && operand === 'boolean') return 'boolean';
      if (['+', '-'].includes(node.operator) && numeric(operand)) return integral(operand) && operand !== 'long' ? 'int' : operand;
      if (node.operator === '~' && integral(operand)) return operand === 'long' ? 'long' : 'int';
      return null;
    }
    if (node.kind !== 'BinaryExpression') return null;
    const left = type(node.left), right = type(node.right);
    if (['&&', '||'].includes(node.operator)) return left === 'boolean' && right === 'boolean' ? 'boolean' : null;
    if (['==', '!='].includes(node.operator)) return left === 'boolean' && right === 'boolean' || numeric(left) && numeric(right) ? 'boolean' : null;
    if (['<', '<=', '>', '>='].includes(node.operator)) return numeric(left) && numeric(right) ? 'boolean' : null;
    if (['&', '|', '^'].includes(node.operator) && left === 'boolean' && right === 'boolean') return 'boolean';
    if (['<<', '>>', '>>>'].includes(node.operator)) return integral(left) && integral(right) ? left === 'long' ? 'long' : 'int' : null;
    if (!['+', '-', '*', '&', '|', '^'].includes(node.operator) || !numeric(left) || !numeric(right)
        || ['&', '|', '^'].includes(node.operator) && (!integral(left) || !integral(right))) return null;
    return left === 'double' || right === 'double' ? 'double' : left === 'float' || right === 'float' ? 'float'
      : left === 'long' || right === 'long' ? 'long' : 'int';
  }
  if (refused) return null;
  function reads(node, name, depth = 0) {
    if (!node || depth > 64) return true;
    if (node.kind === 'Identifier' && node.name === name) return true;
    let found = false;
    children(node, child => { if (reads(child, name, depth + 1)) found = true; });
    return found;
  }
  return {pureType, counts, locals, formals, reads};
}

module.exports = {primitiveExpressionProof};
