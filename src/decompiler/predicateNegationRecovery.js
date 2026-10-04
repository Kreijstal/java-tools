'use strict';

// Boolean control conditions require a primitive result. De Morgan, equality
// complements and double negation preserve short-circuit order and unboxing.
// Keep arbitrary atoms verbatim. Relational complements require scoped
// primitive integral operands; unknown and floating operands retain NaNs.
function simplifyPredicateNegations(source, proof, {retainDiagnostics = false, parameters = [], complementIntegralRelations = true} = {}) {
  const unchanged = () => ({source, predicatesSimplified: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || typeof complementIntegralRelations !== 'boolean' || !Array.isArray(parameters) || source.length > 400000) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children} = proof;
  const edits = [], counts = {doubleNegations: 0, equalityComplements: 0, deMorganOperators: 0, booleanLiterals: 0, relationalComplements: 0};
  const relationalComparisons = [];
  let invalid = false, predicates = 0;
  function walk(node, visit, depth = 0, parent = null) {
    if (depth > 128) { invalid = true; return; }
    visit(node, parent); children(node, child => walk(child, visit, depth + 1, node));
  }
  walk(parsed, node => {
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) invalid = true;
  });
  if (invalid) return unchanged();
  const integral = type => ['byte', 'short', 'char', 'int', 'long'].includes(type);
  const declarations = new Map(), locals = new Map(), formalTypes = new Map();
  const statementStarts = new Set();
  walk(parsed, node => {
    if (node.kind?.endsWith('Statement') && node.range) statementStarts.add(node.range.startOffset);
    if (['VariableDeclarator', 'FormalParameter'].includes(node.kind))
      declarations.set(node.name, (declarations.get(node.name) || 0) + 1);
  });
  function sourceType(node) {
    if (!node || node.annotations?.length) return null;
    if (node.kind === 'PrimitiveType') return node.name;
    if (node.kind === 'ClassType') return 'reference';
    if (node.kind === 'ArrayType') {
      const component = sourceType(node.componentType);
      return component && Number.isInteger(node.dimensions) && node.dimensions > 0 && node.dimensions <= 255
        ? component + '[]'.repeat(node.dimensions) : null;
    }
    return null;
  }
  for (const parameter of parameters) {
    if (!parameter || typeof parameter.name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(parameter.name)
        || typeof parameter.type !== 'string' || formalTypes.has(parameter.name)) return unchanged();
    const match = /^([\w.$]+)((?:\[\])*)$/.exec(parameter.type);
    formalTypes.set(parameter.name, match ?
      (['byte', 'short', 'char', 'int', 'long', 'float', 'double', 'boolean'].includes(match[1]) ? match[1] : 'reference') + match[2] : null);
  }
  walk(parsed, (node, parent) => {
    if (node.kind !== 'LocalVariableDeclarationStatement' || parent?.kind !== 'BlockStatement' || node.annotations?.length) return;
    // Some parser-owned try/catch/monitor blocks omit their own range. The
    // first direct statement and its immediately preceding brace establish
    // the same lexical scope without crossing any protected boundary.
    let open = starts.get(parent.range?.startOffset);
    if (open === undefined) {
      const firstStatement = starts.get(parent.statements?.[0]?.range?.startOffset);
      if (tokens[firstStatement - 1]?.text === '{') open = firstStatement - 1;
    }
    const type = sourceType(node.variableType), close = closes.get(open);
    let end = null;
    const first = starts.get(node.range?.startOffset);
    if (!type || close === undefined || first === undefined) return;
    for (let index = first; index < close; index++) {
      if (index !== first && statementStarts.has(tokens[index].range.startOffset)) break;
      if (tokens[index].text === ';') { end = index; break; }
      if (tokens[index].text === '}') break;
      if (closes.has(index)) index = closes.get(index);
    }
    if (end === null) return;
    for (const variable of node.declarators) if (Number.isInteger(variable.dimensions)
        && variable.dimensions >= 0 && variable.dimensions <= 255)
      locals.set(variable.name, {type: type + '[]'.repeat(variable.dimensions),
        start: tokens[end].range.endOffset, end: tokens[close].range.startOffset});
  });
  function operandType(node, site, depth = 0) {
    if (!node || depth > 64) return null;
    const childType = child => operandType(child, site, depth + 1);
    if (node.kind === 'ParenthesizedExpression') return childType(node.expression);
    if (node.kind === 'Identifier') {
      if (formalTypes.has(node.name)) return declarations.has(node.name) ? null : formalTypes.get(node.name);
      const local = locals.get(node.name);
      return declarations.get(node.name) === 1 && local && site >= local.start && site < local.end ? local.type : null;
    }
    if (node.kind === 'CastExpression') return sourceType(node.castType);
    if (node.kind === 'LiteralExpression') {
      if (node.literalKind === 'char') return 'char';
      const raw = (node.raw || '').replace(/_/g, '');
      if (node.literalKind === 'number' && /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)[lL]?$/.test(raw))
        return /[lL]$/.test(raw) ? 'long' : 'int';
      return null;
    }
    if (node.kind === 'ArrayAccessExpression') {
      const type = childType(node.array);
      return type?.endsWith('[]') ? type.slice(0, -2) : null;
    }
    if (node.kind === 'FieldAccessExpression' && node.name === 'length')
      return childType(node.target)?.endsWith('[]') ? 'int' : null;
    if (node.kind === 'UnaryExpression' && ['+', '-', '~', '++', '--'].includes(node.operator)) {
      const type = childType(node.operand);
      return integral(type) ? ['++', '--'].includes(node.operator) ? type : type === 'long' ? 'long' : 'int' : null;
    }
    if (node.kind === 'BinaryExpression' && ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>'].includes(node.operator)) {
      const left = childType(node.left), right = childType(node.right);
      if (!integral(left) || !integral(right)) return null;
      return ['<<', '>>', '>>>'].includes(node.operator) ? left === 'long' ? 'long' : 'int'
        : left === 'long' || right === 'long' ? 'long' : 'int';
    }
    // Calls, fields, boxed values and unsupported scopes have no proven type.
    return null;
  }
  const relational = node => node?.kind === 'BinaryExpression' && ['<', '<=', '>', '>='].includes(node.operator);
  const typedRelation = (node, site) => complementIntegralRelations && relational(node) && integral(operandType(node.left, site)) && integral(operandType(node.right, site));
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
  function supported(node, site) {
    while (node?.kind === 'ParenthesizedExpression') node = node.expression;
    return node?.kind === 'UnaryExpression' && node.operator === '!' && node.prefix === true
      || node?.kind === 'BinaryExpression' && ['&&', '||', '==', '!='].includes(node.operator)
      || node?.kind === 'LiteralExpression' && ['true', 'false'].includes(node.raw)
      || typedRelation(node, site);
  }
  function inverse(node, first, end, depth) {
    if (depth > 64 || first >= end) { invalid = true; return; }
    if (parenthesized(node, first, end)) return inverse(node.expression, first + 1, end - 1, depth + 1);
    if (node.kind === 'ParenthesizedExpression') { invalid = true; return; }
    if (node.kind === 'UnaryExpression' && node.operator === '!' && node.prefix === true) {
      if (tokens[first]?.text !== '!') { invalid = true; return; }
      replace(first, ''); counts.doubleNegations++; return;
    }
    if (node.kind === 'BinaryExpression' && (['&&', '||', '==', '!='].includes(node.operator)
        || typedRelation(node, tokens[first].range.startOffset))) {
      const index = operator(node, first, end);
      if (index === null || index <= first || index >= end - 1) { invalid = true; return; }
      replace(index, {'&&': '||', '||': '&&', '==': '!=', '!=': '==', '<': '>=', '<=': '>', '>': '<=', '>=': '<'}[node.operator]);
      if (relational(node)) {
        counts.relationalComplements++;
        relationalComparisons.push({start: tokens[index].range.startOffset - 2,
          end: tokens[index].range.endOffset - 2, operator: node.operator,
          leftType: operandType(node.left, tokens[first].range.startOffset),
          rightType: operandType(node.right, tokens[first].range.startOffset)});
        return;
      }
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
    if (node.kind === 'UnaryExpression' && node.operator === '!' && node.prefix === true && supported(node.operand, tokens[first].range.startOffset)) {
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
    ...(retainDiagnostics ? {diagnostics: {counts, tokenEdits: edits, relationalComparisons}} : {})};
}

module.exports = {simplifyPredicateNegations};
