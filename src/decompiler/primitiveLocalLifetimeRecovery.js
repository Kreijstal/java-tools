'use strict';
const {JavaParser} = require('../java-frontend/parser');
const {tokenizeJava} = require('../java-frontend/lexer');
const parser = new JavaParser();
const primitiveTypes = new Set(['boolean', 'byte', 'short', 'char', 'int', 'long', 'float', 'double']);

// Primitive callers split only uninitialized method locals. Reference callers
// additionally retain literal-null initializers and select one block containing
// every use, including a protected body. Unsupported protected statements within
// a phase refuse analysis, so no reaching value crosses a handler boundary.
// Keep all statements, operators, evaluation order, types and aliases intact.
// Every read in each phase must be dominated by an assignment within that phase;
// loops include their zero-iteration, break and continue paths. Captures and
// captures remain outside this reconstruction's contract.
function splitLocalLifetimes(source, {retainDiagnostics = false, reservedNames = [], nestedBlocks = false, referenceLocals = false} = {}) {
  const unchanged = () => ({source, localsSplit: 0, declarationsAdded: 0});
  if (typeof source !== 'string' || /\\u+[0-9a-fA-F]{4}/.test(source)) return unchanged();
  const wrapped = `{\n${source}\n}`;
  let tree, tokens;
  try {
    tree = parser.parseStatement(wrapped, {requireComplete: true});
    const lexed = tokenizeJava(wrapped);
    if (lexed.diagnostics.length) return unchanged();
    tokens = lexed.tokens.filter(t => !['whitespace', 'comment', 'eof'].includes(t.kind));
    let end = 0;
    for (const t of tokens) {
      if (/\/\/|\/\*/.test(wrapped.slice(end, t.range.startOffset))) return unchanged();
      end = t.range.endOffset;
    }
  } catch (_) { return unchanged(); }
  if (referenceLocals && (/\/\/|\/\*/.test(wrapped.slice(tokens.at(-1)?.range.endOffset || 0))
      || typeof retainDiagnostics !== 'boolean' || !Array.isArray(reservedNames))) return unchanged();
  const nodes = [];
  walk(tree, n => nodes.push(n));
  if (nodes.some(n => /^(?:Unsupported|ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|LambdaExpression|SwitchStatement|EnhancedForStatement|MethodReferenceExpression)/.test(n.kind)
      || !referenceLocals && /^(?:TryStatement|SynchronizedStatement)/.test(n.kind)
      || n.kind === 'NewClassExpression' && n.body)) return unchanged();
  const statements = tree.statements || [];
  const blockEnds = new Map(), openBlocks = [];
  for (const token of tokens) {
    if (token.text === '{') openBlocks.push(token.range.startOffset);
    else if (token.text === '}') blockEnds.set(openBlocks.pop(), token.range.startOffset);
  }
  if (referenceLocals) {
    // Parser-owned try/catch/monitor blocks can omit their brace range. Repair
    // only those bounds from their first direct statement and matched tokens.
    const starts = new Map(tokens.map((t,i) => [t.range.startOffset,i]));
    for (const node of nodes) if (node.kind === 'BlockStatement' && !node.range) {
      const first = starts.get(node.statements?.[0]?.range?.startOffset), open = tokens[first - 1];
      const close = open?.text === '{' ? blockEnds.get(open.range.startOffset) : null;
      if (close != null) node.range = {startOffset: open.range.startOffset, endOffset: close + 1};
    }
  }
  const declarations = statements.filter(n => n.kind === 'LocalVariableDeclarationStatement');
  const usedNames = new Set([...reservedNames, ...tokens.filter(t => t.kind === 'identifier').map(t => t.text)]);
  const edits = [], added = [], diagnostics = [];
  for (const declaration of declarations) {
    const [variable] = declaration.declarators || [];
    const initialized = referenceLocals && variable?.initializer?.kind === 'LiteralExpression'
      && variable.initializer.raw === 'null';
    const type = declaration.variableType;
    if (declaration.declarators?.length !== 1 || variable.initializer && !initialized || variable.dimensions
        || declaration.modifiers?.length || declaration.annotations?.length
        || (referenceLocals ? !['ClassType','ArrayType','ParameterizedType'].includes(type?.kind) : type?.kind !== 'PrimitiveType')
        || declaration.variableType.annotations?.length
        || (!referenceLocals && !primitiveTypes.has(type.name))) continue;
    if (referenceLocals) {
      let annotated = false; walk(type, n => { if (n.annotations?.length) annotated = true; });
      if (annotated) continue;
    }
    const name = variable.name;
    // Refuse all shadows, field/method/type spellings and lexical ambiguities.
    if (nodes.filter(n => n.kind === 'VariableDeclarator' && n.name === name).length !== 1) continue;
    const identifiers = nodes.filter(n => n.kind === 'Identifier' && n.name === name).length;
    const occurrences = tokens.filter(t => t.kind === 'identifier' && t.text === name);
    if (occurrences.length !== identifiers + 1) continue;
    const declarationStart = declaration.range?.startOffset;
    const declarationIndex = statements.indexOf(declaration);
    const nextStart = statements[declarationIndex + 1]?.range?.startOffset ?? wrapped.length - 1;
    const declarationToken = occurrences.find(t => t.range.startOffset >= declarationStart && t.range.startOffset < nextStart);
    if (!declarationToken) continue;
    const typeText = referenceLocals ? wrapped.slice(declarationStart, declarationToken.range.startOffset).trim() : type.name;
    if (referenceLocals && (typeText === 'var' || !typeText)) continue;
    // A nested block is eligible only when it contains every use of this
    // local. Loop headers and uses after the block therefore keep a reaching
    // value in its enclosing lifetime. Analyze each execution from unassigned,
    // so an iteration cannot borrow a value from an earlier iteration.
    const container = nestedBlocks || referenceLocals ? containingBlock(tree, name, identifiers) : {block: tree, contexts: []};
    if (!container) continue;
    if (nestedBlocks && container.block === tree) continue;
    // A root initializer cannot supply an independent first phase on every
    // execution of a nested loop body: its incoming value may be from the
    // previous iteration's later phase. Each iteration must define its reads.
    const initialAvailable = initialized && !container.contexts.some(c => c.loop);
    const phaseStatements = container.block.statements || [];
    const phaseEnd = blockEnds.get(container.block.range?.startOffset);
    if (phaseEnd == null) continue;
    const phaseStart = container.block === tree ? declarationIndex + 1 : 0;
    const groups = [];
    let invalid = false;
    for (let index = phaseStart; index < phaseStatements.length; index++) {
      const statement = phaseStatements[index];
      if (!mentions(statement, name)) continue;
      const closed = sequence([statement], false, name, container.contexts);
      if (closed) groups.push({start: index, end: index});
      else if (groups.length) groups.at(-1).end = index;
      else if (initialAvailable && !groups.length) groups.push({start: index, end: index});
      else { invalid = true; break; }
    }
    if (invalid || groups.length < 2) continue;
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      if (sequence(phaseStatements.slice(group.start, group.end + 1), index === 0 && initialAvailable, name, container.contexts)) continue;
      // A conditional reset may still depend on the incoming value at a later
      // join. Merge it back into the preceding lifetime rather than detach it.
      if (!index) { invalid = true; break; }
      groups[index - 1].end = group.end;
      groups.splice(index, 1);
      index -= 2;
    }
    if (invalid || groups.length < 2) continue;
    const ranges = [];
    for (let index = 1; index < groups.length; index++) {
      const group = groups[index];
      let suffix = index, fresh;
      do { fresh = `${name}Lifetime${suffix++}`; } while (usedNames.has(fresh));
      usedNames.add(fresh);
      const start = phaseStatements[group.start].range.startOffset;
      const end = phaseStatements[group.end + 1]?.range?.startOffset ?? phaseEnd;
      const selected = occurrences.filter(t => t.range.startOffset >= start && t.range.startOffset < end);
      for (const token of selected) edits.push({start: token.range.startOffset, end: token.range.endOffset, text: fresh});
      added.push(`${typeText} ${fresh};`);
      ranges.push({name: fresh, start: start - 2, end: end - 2, references: selected.length});
    }
    diagnostics.push({name, type: typeText, groups: groups.length,
      nested: container.block !== tree, containerStart: container.block.range.startOffset - 2,
      containerEnd: phaseEnd - 2, ranges, ...(referenceLocals ? {reference: true, initialized} : {})});
  }
  if (!added.length) return unchanged();
  // Declarations have no initializer and no runtime effect. Append them after
  // the original leading declarations, retaining original declaration order.
  let index = statements[0]?.kind === 'ExpressionStatement'
    && statements[0].expression?.kind === 'MethodInvocationExpression'
    && statements[0].expression.name === '<init>' ? 1 : 0;
  while (index < statements.length && statements[index].kind === 'LocalVariableDeclarationStatement') index++;
  const insertion = statements[index]?.range?.startOffset;
  if (insertion == null) return unchanged();
  const lineStart = wrapped.lastIndexOf('\n', insertion - 1) + 1;
  const prefix = wrapped.slice(lineStart, insertion);
  const indent = /^\s*$/.test(prefix) ? prefix : '';
  edits.push({start: insertion, end: insertion, text: added.join('\n' + indent) + '\n' + indent});
  edits.sort((a,b) => b.start - a.start || b.end - a.end);
  let result = wrapped;
  for (const edit of edits) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return {source: result.slice(2, -2), localsSplit: diagnostics.length, declarationsAdded: added.length,
    ...(retainDiagnostics ? {diagnostics: {locals: diagnostics,
      edits: edits.map(edit => ({...edit, start: edit.start - 2, end: edit.end - 2}))}} : {})};
}

function splitPrimitiveLocalLifetimes(source, options = {}) {
  return splitLocalLifetimes(source, {...options, referenceLocals: false});
}
function splitReferenceLocalLifetimes(source, options = {}) {
  return splitLocalLifetimes(source, {...options, referenceLocals: true});
}
function splitNestedReferenceLocalLifetimes(source, options = {}) {
  return splitLocalLifetimes(source, {...options, referenceLocals: true, nestedBlocks: true});
}

function containingBlock(tree, name, count) {
  let result = null, bestDepth = -1;
  function visit(node, contexts = [], depth = 0) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => visit(n, contexts, depth)); return; }
    if (node.kind === 'BlockStatement') {
      let occurrences = 0;
      walk(node, n => { if (n.kind === 'Identifier' && n.name === name) occurrences++; });
      if (occurrences === count && depth > bestDepth) {
        result = {block: node, contexts}; bestDepth = depth;
      }
    }
    let children = contexts;
    if (node.kind === 'LabeledStatement') children = [...contexts, {node, label: node.label}];
    else if (['ForStatement','WhileStatement','DoWhileStatement'].includes(node.kind))
      children = [...contexts, {node, loop: true}];
    for (const [key, value] of Object.entries(node))
      if (!['range', 'tokens', 'meta', 'kind'].includes(key)) visit(value, children, depth + 1);
  }
  visit(tree);
  return result;
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => walk(n, visit)); return; }
  if (node.kind) visit(node);
  for (const [key, value] of Object.entries(node))
    if (!['range', 'tokens', 'meta', 'kind'].includes(key)) walk(value, visit);
}
function mentions(node, name) {
  let yes = false; walk(node, n => { if (n.kind === 'Identifier' && n.name === name) yes = true; }); return yes;
}
function expression(node, assigned, name) {
  if (!node || !mentions(node, name)) return assigned;
  const expr = n => expression(n, assigned, name);
  switch (node.kind) {
    case 'Identifier': return assigned ? assigned : null;
    case 'ParenthesizedExpression': return expr(node.expression);
    case 'CastExpression': return expr(node.expression);
    case 'UnaryExpression': return expr(node.operand);
    case 'AssignmentExpression': {
      if (node.left.kind === 'Identifier' && node.left.name === name) {
        if (node.operator !== '=' && !assigned) return null;
        const right = expression(node.right, assigned, name);
        return right === null ? null : true;
      }
      const left = expr(node.left);
      return left === null ? null : expression(node.right, left, name);
    }
    case 'BinaryExpression': {
      const left = expr(node.left);
      if (left === null) return null;
      const right = expression(node.right, left, name);
      return right === null ? null : ['&&','||'].includes(node.operator) ? left && right : right;
    }
    case 'ConditionalExpression': {
      const condition = expr(node.condition);
      if (condition === null) return null;
      const a = expression(node.consequent, condition, name), b = expression(node.alternate, condition, name);
      return a === null || b === null ? null : a && b;
    }
    case 'FieldAccessExpression': return expr(node.target);
    case 'ArrayAccessExpression': {
      const array = expr(node.array); return array === null ? null : expression(node.index, array, name);
    }
    case 'MethodInvocationExpression':
    case 'NewClassExpression': {
      let state = expr(node.target);
      for (const arg of node.arguments || []) { if (state === null) break; state = expression(arg, state, name); }
      return state;
    }
    default: return null;
  }
}
function sequence(statements, assigned, name, contexts) {
  let state = {normal: assigned, exits: []};
  for (const node of statements) {
    if (state.normal === null) return null; // unreachable tails are not reconstructed
    const next = statement(node, state.normal, name, contexts);
    if (!next) return null;
    state = {normal: next.normal, exits: [...state.exits, ...next.exits]};
  }
  return state;
}
function merge(states) {
  const normal = states.map(s => s.normal).filter(s => s !== null);
  return {normal: normal.length ? normal.every(Boolean) : null, exits: states.flatMap(s => s.exits)};
}
function statement(node, assigned, name, contexts) {
  if (!node) return null;
  const simple = value => value === null ? null : {normal: value, exits: []};
  const evalExpr = n => expression(n, assigned, name);
  switch (node.kind) {
    case 'EmptyStatement': return simple(assigned);
    case 'BlockStatement': return sequence(node.statements || [], assigned, name, contexts);
    case 'ExpressionStatement': return simple(evalExpr(node.expression));
    case 'LocalVariableDeclarationStatement': {
      let state = assigned;
      for (const d of node.declarators || []) { state = expression(d.initializer, state, name); if (state === null) return null; }
      return simple(state);
    }
    case 'IfStatement': {
      const condition = evalExpr(node.condition); if (condition === null) return null;
      const a = statement(node.consequent, condition, name, contexts), b = node.alternate ? statement(node.alternate, condition, name, contexts) : simple(condition);
      return a && b ? merge([a,b]) : null;
    }
    case 'LabeledStatement': {
      const body = statement(node.statement, assigned, name, [...contexts, {node, label: node.label}]);
      if (!body) return null;
      const exits = body.exits.filter(e => e.target === node);
      if (exits.some(e => e.kind !== 'break')) return null;
      const result = merge([body, ...exits.map(e => simple(e.assigned))]);
      result.exits = body.exits.filter(e => e.target !== node); return result;
    }
    case 'ForStatement':
    case 'WhileStatement':
    case 'DoWhileStatement': {
      let entry = assigned;
      if (node.kind === 'ForStatement') {
        const init = node.initializer;
        if (init?.kind === 'LocalVariableDeclarationStatement') { const s = statement(init, entry, name, contexts); if (!s) return null; entry = s.normal; }
        else { entry = expression(init, entry, name); if (entry === null) return null; }
      }
      if (node.kind === 'DoWhileStatement') return null;
      const tested = expression(node.condition, entry, name); if (tested === null) return null;
      const body = statement(node.body, tested, name, [...contexts, {node, loop: true}]); if (!body) return null;
      const own = body.exits.filter(e => e.target === node);
      for (const s of [body.normal, ...own.filter(e => e.kind === 'continue').map(e => e.assigned)].filter(s => s !== null)) {
        const updated = expression(node.update, s, name);
        if (updated === null || expression(node.condition, updated, name) === null) return null;
      }
      const breaks = own.filter(e => e.kind === 'break').map(e => simple(e.assigned));
      const result = merge([simple(tested), ...breaks]); // include zero iterations
      result.exits = body.exits.filter(e => e.target !== node); return result;
    }
    case 'BreakStatement':
    case 'ContinueStatement': {
      const kind = node.kind === 'BreakStatement' ? 'break' : 'continue';
      let target;
      if (node.label) {
        const ctx = [...contexts].reverse().find(c => c.label === node.label);
        if (!ctx) return null;
        target = kind === 'continue' ? ctx.node.statement : ctx.node;
        if (kind === 'continue' && !['ForStatement','WhileStatement','DoWhileStatement'].includes(target?.kind)) return null;
      } else target = [...contexts].reverse().find(c => c.loop)?.node;
      if (!target) return null;
      return {normal: null, exits: [{kind, target, assigned}]};
    }
    case 'ReturnStatement':
    case 'ThrowStatement': return evalExpr(node.expression) === null ? null : {normal: null, exits: []};
    default: return null;
  }
}
function splitNestedPrimitiveLocalLifetimes(source, options = {}) {
  return splitPrimitiveLocalLifetimes(source, {...options, nestedBlocks: true});
}
function independentlyAssignedLocalSequence(statements, name, contexts = []) {
  return sequence(statements, false, name, contexts) !== null;
}
module.exports = {splitPrimitiveLocalLifetimes, splitNestedPrimitiveLocalLifetimes, splitReferenceLocalLifetimes, splitNestedReferenceLocalLifetimes,
  independentlyAssignedLocalSequence};
