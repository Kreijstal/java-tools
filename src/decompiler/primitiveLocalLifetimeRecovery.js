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
// loops include their zero-iteration, break and continue paths. Captures remain
// outside this reconstruction's contract.
function splitLocalLifetimes(source, {retainDiagnostics = false, reservedNames = [], nestedBlocks = false, referenceLocals = false, initializedPrimitives = false, arrayDimensionLocals = false, conditionalBranches = false} = {}) {
  let branchIndex = null;
  const unchanged = () => ({source, localsSplit: 0, declarationsAdded: 0,
    ...(retainDiagnostics && branchIndex ? {diagnostics: {work: branchIndex.work}} : {})});
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
  const extended = referenceLocals || initializedPrimitives;
  if (extended && (/\/\/|\/\*/.test(wrapped.slice(tokens.at(-1)?.range.endOffset || 0))
      || typeof retainDiagnostics !== 'boolean' || !Array.isArray(reservedNames))) return unchanged();
  let nodes;
  if (conditionalBranches) {
    branchIndex = indexConditionalReferences(tree, tokens);
    nodes = branchIndex.nodes;
  } else { nodes = []; walk(tree, n => nodes.push(n)); }
  if (nodes.some(n => /^(?:Unsupported|ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|LambdaExpression|SwitchStatement|EnhancedForStatement|MethodReferenceExpression)/.test(n.kind)
      || !extended && /^(?:TryStatement|SynchronizedStatement)/.test(n.kind)
      || n.kind === 'NewClassExpression' && n.body)) return unchanged();
  const statements = tree.statements || [];
  const blockEnds = new Map(), openBlocks = [];
  for (const token of tokens) {
    if (token.text === '{') openBlocks.push(token.range.startOffset);
    else if (token.text === '}') blockEnds.set(openBlocks.pop(), token.range.startOffset);
  }
  if (extended) {
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
  const statementIndices = conditionalBranches ? new Map(statements.map((n,i) => [n,i])) : null;
  const usedNames = new Set([...reservedNames, ...tokens.filter(t => t.kind === 'identifier').map(t => t.text)]);
  const edits = [], added = [], diagnostics = [];
  for (const declaration of declarations) {
    const [variable] = declaration.declarators || [];
    const initializer = variable?.initializer;
    const scalarLiteral = n => n?.kind === 'LiteralExpression' && ['number','boolean','char'].includes(n.literalKind)
      || n?.kind === 'UnaryExpression' && ['+','-'].includes(n.operator) && n.operand?.kind === 'LiteralExpression' && n.operand.literalKind === 'number';
    const initialized = referenceLocals && initializer?.kind === 'LiteralExpression' && initializer.raw === 'null'
      || initializedPrimitives && scalarLiteral(initializer);
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
    const indexed = branchIndex?.references.get(name);
    const arrayUses = conditionalBranches ? indexed?.arrayUse : nodes.filter(n => n.kind === 'NewArrayExpression' && mentions(n, name)).length;
    // Keep existing modes' refusal contract. The optional dimension pass only
    // revisits locals actually used by an array creation expression.
    if (arrayDimensionLocals ? !arrayUses : arrayUses) continue;
    // Refuse all shadows, field/method/type spellings and lexical ambiguities.
    if ((conditionalBranches ? branchIndex.declarators.get(name) : nodes.filter(n => n.kind === 'VariableDeclarator' && n.name === name).length) !== 1) continue;
    const identifiers = conditionalBranches ? indexed?.items.length || 0 : nodes.filter(n => n.kind === 'Identifier' && n.name === name).length;
    const occurrences = conditionalBranches ? branchIndex.tokens.get(name) || [] : tokens.filter(t => t.kind === 'identifier' && t.text === name);
    if (occurrences.length !== identifiers + 1) continue;
    const declarationStart = declaration.range?.startOffset;
    const declarationIndex = conditionalBranches ? statementIndices.get(declaration) : statements.indexOf(declaration);
    const nextStart = statements[declarationIndex + 1]?.range?.startOffset ?? wrapped.length - 1;
    const declarationToken = occurrences.find(t => t.range.startOffset >= declarationStart && t.range.startOffset < nextStart);
    if (!declarationToken) continue;
    const typeText = referenceLocals ? wrapped.slice(declarationStart, declarationToken.range.startOffset).trim() : type.name;
    if (referenceLocals && (typeText === 'var' || !typeText)) continue;
    if (conditionalBranches) {
      const groups = conditionalPrimitiveGroups(indexed, occurrences.filter(t => t !== declarationToken), name, branchIndex, blockEnds);
      // A shared budget bounds all candidate proofs in this method. Discard
      // every pending edit on exhaustion, retaining deterministic idempotence.
      if (branchIndex.work.exhausted) return unchanged();
      // Only an arm that reads the local observes a value of its own. A
      // write-only arm stores a dead value; renaming it would add a
      // declaration without separating any meaning, so it stays in the
      // original lifetime (always sound: every group is a disjoint arm).
      const lifetimes = groups?.filter(group => group.read) || [];
      if (lifetimes.length < 2) continue;
      const ranges = [];
      for (let index = 1; index < lifetimes.length; index++) {
        let suffix = index, fresh;
        do { fresh = `${name}Lifetime${suffix++}`; } while (usedNames.has(fresh));
        usedNames.add(fresh);
        const selected = lifetimes[index].tokens;
        let first = Infinity, last = -Infinity;
        for (const token of selected) edits.push({start: token.range.startOffset, end: token.range.endOffset, text: fresh});
        for (const token of selected) { first = Math.min(first, token.range.startOffset); last = Math.max(last, token.range.endOffset); }
        added.push(`${typeText} ${fresh};`);
        ranges.push({name: fresh, start: first - 2, end: last - 2, references: selected.length});
      }
      diagnostics.push({name, type: typeText, groups: lifetimes.length, conditional: true, initialized, ranges});
      continue;
    }
    // A nested block is eligible only when it contains every use of this
    // local. Loop headers and uses after the block therefore keep a reaching
    // value in its enclosing lifetime. Analyze each execution from unassigned,
    // so an iteration cannot borrow a value from an earlier iteration.
    const container = nestedBlocks || extended ? containingBlock(tree, name, identifiers) : {block: tree, contexts: []};
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
      containerEnd: phaseEnd - 2, ranges, ...(extended ? {reference: referenceLocals, initialized} : {})});
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
  const pieces = []; let end = wrapped.length;
  for (const edit of edits) { pieces.push(wrapped.slice(edit.end, end), edit.text); end = edit.start; }
  pieces.push(wrapped.slice(0, end));
  const result = pieces.reverse().join('');
  return {source: result.slice(2, -2), localsSplit: diagnostics.length, declarationsAdded: added.length,
    ...(retainDiagnostics ? {diagnostics: {locals: diagnostics,
      edits: edits.map(edit => ({...edit, start: edit.start - 2, end: edit.end - 2})),
      ...(branchIndex ? {work: branchIndex.work} : {})}} : {})};
}

function splitPrimitiveLocalLifetimes(source, options = {}) {
  return splitLocalLifetimes(source, {...options, referenceLocals: false, initializedPrimitives: false, arrayDimensionLocals: false});
}
function splitReferenceLocalLifetimes(source, options = {}) {
  return splitLocalLifetimes(source, {...options, referenceLocals: true, initializedPrimitives: false, arrayDimensionLocals: false});
}
function splitNestedReferenceLocalLifetimes(source, options = {}) {
  return splitLocalLifetimes(source, {...options, referenceLocals: true, initializedPrimitives: false, nestedBlocks: true, arrayDimensionLocals: false});
}
function splitInitializedPrimitiveLocalLifetimes(source, options = {}) {
  return splitLocalLifetimes(source, {...options, referenceLocals: false, initializedPrimitives: true, arrayDimensionLocals: false});
}

function splitNestedInitializedPrimitiveLocalLifetimes(source, options = {}) {
  return splitInitializedPrimitiveLocalLifetimes(source, {...options, nestedBlocks: true});
}

function splitConditionalPrimitiveLocalLifetimes(source, options = {}) {
  return splitLocalLifetimes(source, {...options, referenceLocals: false, initializedPrimitives: true,
    nestedBlocks: false, arrayDimensionLocals: false, conditionalBranches: true});
}

function splitArrayDimensionPrimitiveLocalLifetimes(source, options = {}) {
  return splitLocalLifetimes(source, {...options, referenceLocals: false, initializedPrimitives: true, arrayDimensionLocals: true});
}

// One iterative AST index provides exact descendant-identifier intervals, token
// occurrences and enclosing conditional/abrupt-exit contexts. Binary lifting
// finds common conditionals without enumerating paths or rescanning subtrees.
function indexConditionalReferences(tree, tokens) {
  const result = {nodes: [], spans: new WeakMap(), writes: new WeakSet(), references: new Map(), declarators: new Map(),
    tokens: new Map(), work: {nodesIndexed: 0, tokensIndexed: tokens.length, proofSteps: 0,
      mentionQueries: 0, mentionComparisons: 0, limit: tokens.length * 32, exhausted: false}};
  for (const token of tokens) if (token.kind === 'identifier') {
    let group = result.tokens.get(token.text);
    if (!group) result.tokens.set(token.text, group = []);
    group.push(token);
  }
  let order = 0;
  const pending = [{node: tree, conditional: null, context: null, array: false}];
  while (pending.length) {
    const frame = pending.pop(), node = frame.node;
    if (!node || typeof node !== 'object') continue;
    if (frame.exit) { result.spans.get(node).end = order; continue; }
    let conditional = frame.conditional, context = frame.context, array = frame.array;
    if (node.kind) {
      result.nodes.push(node); result.work.nodesIndexed++;
      result.spans.set(node, {start: order, end: order});
      pending.push({node, exit: true});
      // A simple assignment's target is written, not read. Compound
      // assignments and increments read their operand and stay reads.
      if (node.kind === 'AssignmentExpression' && node.operator === '=' && node.left?.kind === 'Identifier')
        result.writes.add(node.left);
      if (node.kind === 'VariableDeclarator')
        result.declarators.set(node.name, (result.declarators.get(node.name) || 0) + 1);
      if (node.kind === 'Identifier') {
        let refs = result.references.get(node.name);
        if (!refs) result.references.set(node.name, refs = {items: [], arrayUse: false});
        refs.items.push({order: order++, conditional, write: result.writes.has(node)});
        refs.arrayUse ||= array;
      }
      if (node.kind === 'IfStatement') {
        const up = [conditional];
        for (let i = 1; up[i - 1]?.up[i - 1]; i++) up.push(up[i - 1].up[i - 1]);
        conditional = {node, context, depth: (conditional?.depth || 0) + 1, up};
      }
      if (node.kind === 'LabeledStatement') context = {entry: {node, label: node.label}, parent: context};
      else if (['ForStatement','WhileStatement','DoWhileStatement'].includes(node.kind))
        context = {entry: {node, loop: true}, parent: context};
      array ||= node.kind === 'NewArrayExpression';
    }
    const children = Array.isArray(node) ? node : Object.entries(node)
      .filter(([key]) => !['range','tokens','meta','kind'].includes(key)).map(([,value]) => value);
    for (let i = children.length - 1; i >= 0; i--)
      if (children[i] && typeof children[i] === 'object') pending.push({node: children[i], conditional, context, array});
  }
  result.tick = () => {
    if (result.work.proofSteps >= result.work.limit) { result.work.exhausted = true; return false; }
    result.work.proofSteps++; return true;
  };
  return result;
}

function commonConditional(a, b, tick) {
  if (!a || !b) return null;
  if (a.depth < b.depth) [a,b] = [b,a];
  let difference = a.depth - b.depth, bit = 0;
  while (difference) {
    if (!tick()) return null;
    if (difference & 1) a = a.up[bit];
    difference >>>= 1; bit++;
  }
  if (a === b) return a;
  for (let i = Math.max(a.up.length, b.up.length) - 1; i >= 0; i--) {
    if (!tick()) return null;
    if (a.up[i] && b.up[i] && a.up[i] !== b.up[i]) { a = a.up[i]; b = b.up[i]; }
  }
  return a.up[0];
}

function conditionalPrimitiveGroups(indexed, tokens, name, index, blockEnds) {
  if (!indexed?.items.length) return null;
  const orders = indexed.items.map(r => r.order);
  const proof = {name, tick: index.tick, contains(node) {
    if (!node) return false;
    index.work.mentionQueries++;
    const span = index.spans.get(node);
    if (!span) return true; // unknown expression forms must not hide a read
    let low = 0, high = orders.length;
    while (low < high) {
      index.work.mentionComparisons++;
      const mid = (low + high) >>> 1;
      if (orders[mid] < span.start) low = mid + 1; else high = mid;
    }
    return low < orders.length && orders[low] < span.end;
  }};
  const groups = [], pending = [{refs: indexed.items, tokens}];
  while (pending.length) {
    const current = pending.pop(), {refs, tokens} = current;
    const candidate = commonConditional(refs[0].conditional, refs.at(-1).conditional, index.tick);
    const a = candidate?.node.consequent, b = candidate?.node.alternate;
    const leftSpan = a && index.spans.get(a), rightSpan = b && index.spans.get(b);
    // Expression nodes do not carry source ranges. Matched lexical braces
    // identify the exact rewrite regions; descendant counts cross-check them
    // against the AST proof. Unbraced arms conservatively remain unchanged.
    const leftStart = a?.range?.startOffset, rightStart = b?.range?.startOffset;
    const leftEnd = a?.kind === 'BlockStatement' ? blockEnds.get(leftStart) : null;
    const rightEnd = b?.kind === 'BlockStatement' ? blockEnds.get(rightStart) : null;
    if (!leftSpan || !rightSpan || leftEnd == null || rightEnd == null) { groups.push({tokens, read: refs.some(ref => !ref.write)}); continue; }
    const left = [], right = [];
    for (const ref of refs) {
      if (!index.tick()) return null;
      if (ref.order >= leftSpan.start && ref.order < leftSpan.end) left.push(ref);
      else if (ref.order >= rightSpan.start && ref.order < rightSpan.end) right.push(ref);
    }
    // Neither the condition nor any outgoing/handler use may observe the
    // shared slot. Both arms must define every read on each execution.
    if (!left.length || !right.length || left.length + right.length !== refs.length) { groups.push({tokens, read: refs.some(ref => !ref.write)}); continue; }
    const leftTokens = [], rightTokens = [];
    for (const token of tokens) {
      if (!index.tick()) return null;
      if (token.range.startOffset > leftStart && token.range.endOffset <= leftEnd) leftTokens.push(token);
      else if (token.range.startOffset > rightStart && token.range.endOffset <= rightEnd) rightTokens.push(token);
    }
    if (leftTokens.length !== left.length || rightTokens.length !== right.length
        || leftTokens.length + rightTokens.length !== tokens.length) { groups.push({tokens, read: refs.some(ref => !ref.write)}); continue; }
    const contexts = [];
    for (let c = candidate.context; c; c = c.parent) {
      if (!index.tick()) return null;
      contexts.push(c.entry);
    }
    contexts.reverse();
    if (!statement(a, false, proof, contexts) || !statement(b, false, proof, contexts)) { groups.push({tokens, read: refs.some(ref => !ref.write)}); continue; }
    pending.push({refs: right, tokens: rightTokens}, {refs: left, tokens: leftTokens});
  }
  return groups;
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
  if (name && typeof name === 'object') return name.contains(node);
  let yes = false; walk(node, n => { if (n.kind === 'Identifier' && n.name === name) yes = true; }); return yes;
}
function expression(node, assigned, name) {
  if (!node || !mentions(node, name)) return assigned;
  if (name && typeof name === 'object' && !name.tick()) return null;
  const localName = name && typeof name === 'object' ? name.name : name;
  const expr = n => expression(n, assigned, name);
  switch (node.kind) {
    case 'Identifier': return assigned ? assigned : null;
    case 'ParenthesizedExpression': return expr(node.expression);
    case 'CastExpression': return expr(node.expression);
    case 'UnaryExpression': return expr(node.operand);
    case 'AssignmentExpression': {
      if (node.left.kind === 'Identifier' && node.left.name === localName) {
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
    case 'NewArrayExpression': {
      // This is assignment-flow analysis, not allocation reconstruction. All
      // dimension expressions remain in place, evaluated left to right before
      // allocation/negative-size checks. Initializers have a separate contract.
      if (node.initializer || !Array.isArray(node.dimensions) || !node.dimensions.length) return null;
      let state = assigned;
      for (const dimension of node.dimensions) {
        if (state === null) break;
        state = expression(dimension, state, name);
      }
      return state;
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
function sequence(statements, assigned, name, contexts, postTestLoops = false) {
  let state = {normal: assigned, exits: []};
  for (const node of statements) {
    if (state.normal === null) return null; // unreachable tails are not reconstructed
    const next = statement(node, state.normal, name, contexts, postTestLoops);
    if (!next) return null;
    // Append once rather than repeatedly copy an increasing prefix of exits.
    for (const exit of next.exits) {
      if (name && typeof name === 'object' && !name.tick()) return null;
      state.exits.push(exit);
    }
    state.normal = next.normal;
  }
  return state;
}
function merge(states, name) {
  const normal = states.map(s => s.normal).filter(s => s !== null);
  const exits = [];
  for (const state of states) for (const exit of state.exits) {
    if (name && typeof name === 'object' && !name.tick()) return null;
    exits.push(exit);
  }
  return {normal: normal.length ? normal.every(Boolean) : null, exits};
}
function chargeExits(exits, name) {
  if (!name || typeof name !== 'object') return true;
  for (const exit of exits) if (!name.tick()) return false;
  return true;
}
function statement(node, assigned, name, contexts, postTestLoops = false) {
  if (!node) return null;
  if (name && typeof name === 'object' && !name.tick()) return null;
  const simple = value => value === null ? null : {normal: value, exits: []};
  const evalExpr = n => expression(n, assigned, name);
  switch (node.kind) {
    case 'EmptyStatement': return simple(assigned);
    case 'BlockStatement': return sequence(node.statements || [], assigned, name, contexts, postTestLoops);
    case 'ExpressionStatement': return simple(evalExpr(node.expression));
    case 'LocalVariableDeclarationStatement': {
      let state = assigned;
      for (const d of node.declarators || []) { state = expression(d.initializer, state, name); if (state === null) return null; }
      return simple(state);
    }
    case 'IfStatement': {
      const condition = evalExpr(node.condition); if (condition === null) return null;
      const a = statement(node.consequent, condition, name, contexts, postTestLoops), b = node.alternate ? statement(node.alternate, condition, name, contexts, postTestLoops) : simple(condition);
      return a && b ? merge([a,b], name) : null;
    }
    case 'LabeledStatement': {
      const body = statement(node.statement, assigned, name, [...contexts, {node, label: node.label}], postTestLoops);
      if (!body) return null;
      if (!chargeExits(body.exits, name)) return null;
      const exits = body.exits.filter(e => e.target === node);
      if (exits.some(e => e.kind !== 'break')) return null;
      const result = merge([body, ...exits.map(e => simple(e.assigned))], name);
      if (!result) return null;
      result.exits = body.exits.filter(e => e.target !== node); return result;
    }
    case 'ForStatement':
    case 'WhileStatement':
    case 'DoWhileStatement': {
      let entry = assigned;
      if (node.kind === 'ForStatement') {
        const init = node.initializer;
        if (init?.kind === 'LocalVariableDeclarationStatement') { const s = statement(init, entry, name, contexts, postTestLoops); if (!s) return null; entry = s.normal; }
        else { entry = expression(init, entry, name); if (entry === null) return null; }
      }
      if (node.kind === 'DoWhileStatement') {
        if (!postTestLoops) return null;
        const body = statement(node.body, entry, name, [...contexts, {node, loop: true}], postTestLoops);
        if (!body) return null;
        if (!chargeExits(body.exits, name)) return null;
        const own = body.exits.filter(e => e.target === node);
        const tests = [body.normal, ...own.filter(e => e.kind === 'continue').map(e => e.assigned)]
          .filter(s => s !== null).map(s => expression(node.condition, s, name));
        if (tests.some(s => s === null)) return null;
        // No zero-iteration entry. Breaks skip the test; normal/continue paths
        // test after the body. Assignment is monotonic on later iterations.
        const result = merge([...tests.map(simple), ...own.filter(e => e.kind === 'break').map(e => simple(e.assigned))], name);
        if (!result) return null;
        result.exits = body.exits.filter(e => e.target !== node);
        return result;
      }
      const tested = expression(node.condition, entry, name); if (tested === null) return null;
      const body = statement(node.body, tested, name, [...contexts, {node, loop: true}], postTestLoops); if (!body) return null;
      if (!chargeExits(body.exits, name)) return null;
      const own = body.exits.filter(e => e.target === node);
      for (const s of [body.normal, ...own.filter(e => e.kind === 'continue').map(e => e.assigned)].filter(s => s !== null)) {
        const updated = expression(node.update, s, name);
        if (updated === null || expression(node.condition, updated, name) === null) return null;
      }
      const breaks = own.filter(e => e.kind === 'break').map(e => simple(e.assigned));
      const result = merge([simple(tested), ...breaks], name); // include zero iterations
      if (!result) return null;
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
function independentlyAssignedLocalSequence(statements, name, contexts = [], {postTestLoops = false} = {}) {
  if (typeof postTestLoops !== 'boolean') return false;
  let arrayUse = false;
  walk(statements, n => { if (n.kind === 'NewArrayExpression' && mentions(n, name)) arrayUse = true; });
  if (arrayUse) return false; // existing control-frame recovery contract
  return sequence(statements, false, name, contexts, postTestLoops) !== null;
}
module.exports = {splitPrimitiveLocalLifetimes, splitNestedPrimitiveLocalLifetimes, splitReferenceLocalLifetimes, splitNestedReferenceLocalLifetimes, splitInitializedPrimitiveLocalLifetimes, splitNestedInitializedPrimitiveLocalLifetimes, splitArrayDimensionPrimitiveLocalLifetimes, splitConditionalPrimitiveLocalLifetimes,
  independentlyAssignedLocalSequence};
