'use strict';

const {
  createNode,
  blockStatement,
  formalParameter,
  classType,
} = require('../java-frontend/ast');
const { JavaParser } = require('../java-frontend/parser');
const { tokenizeJava } = require('../java-frontend/lexer');
const { recoverScalarLabelDispatches: recoverScalarDispatch } = require('./scalarDispatchRecovery');
const { recoverScalarIfDispatches: recoverIfDispatch } = require('./scalarIfDispatchRecovery');
const { simplifyPredicateNegations: simplifyNegations } = require('./predicateNegationRecovery');
const { specializePathGuards: specializeGuards } = require('./pathGuardRecovery');
const { recoverArrayIndexIncrements: recoverIndexIncrements } = require('./incrementCaptureRecovery');
const { foldGuardedAbruptPlainBlockExits: recoverGuardedAbruptExit } = require('./guardedAbruptExitRecovery');
const { foldGuardedLoopContinuations: recoverLoopContinuation, foldNonrepeatingWhileLoops: recoverNonrepeatingLoops,
  foldTrailingLoopContinuations: recoverTrailingLoopContinuation,
  foldLoopExitContinuations: recoverLoopExitContinuation,
  foldTerminalLoopExits: recoverTerminalLoopExit,
  foldNonlocalLoopExits: recoverNonlocalLoopExit,
  foldLoopElseExitGuards: recoverLoopElseExitGuard } = require('./guardedLoopContinuationRecovery');

const rawExpression = (source) => createNode('UnsupportedExpression', { source: String(source) });
const rawStatement = (source) => createNode('UnsupportedStatement', { source: String(source) });
const block = (statements) => blockStatement(statements || []);

function classTypeFromSourceName(sourceName) {
  const parts = String(sourceName).split('.');
  return classType(parts.pop(), { packageName: parts.join('.') || null });
}

function catchParameter(name, types) {
  const alternatives = types.map(classTypeFromSourceName);
  const parameterType = alternatives.length === 1
    ? alternatives[0]
    : createNode('UnionType', { alternatives });
  return formalParameter(name, parameterType);
}

// The CFG structurer expresses every loop as `while (true)` with the exit test
// inside, which is faithful but not what anybody wrote: a plain `for` loop comes
// back as an infinite loop whose false arm carries the entire rest of the method.
// Rotating it back - hoisting the exit arm out and moving the test into the
// header - is only sound when control cannot fall out of that arm into the next
// iteration, so ask whether every path through it leaves.
function alwaysExits(tree, render) {
  if (!tree) return false;
  switch (tree.t) {
    case 'straight': return !!(render.blockTerminates && render.blockTerminates(tree.block));
    case 'seq': return (tree.body || []).some((child) => alwaysExits(child, render));
    // A transfer consumed by this construct completes it normally. It does
    // not leave the surrounding arm, even though its own statement is abrupt.
    // Be conservative about conditional/unreachable breaks: keeping the
    // original loop is safe when we cannot prove the arm always leaves.
    case 'block': return !referencesLabel(tree.body, tree.label, 'break')
      && alwaysExits(tree.body, render);
    case 'loop': return !referencesLabel(tree.body, tree.label, 'break');
    case 'if': return alwaysExits(tree.then, render) && alwaysExits(tree.els, render);
    case 'switch': return !!tree.dflt && tree.cases.every((item) => alwaysExits(item.body, render))
      && alwaysExits(tree.dflt, render);
    // Move an intact protected exit arm only when its normal body and every
    // handler leave. A normally completing catch can resume the loop, and an
    // inner consumed break does not leave this arm. The containing try/catch
    // stays whole, so no expression changes its exception binding.
    case 'try': return !tree.finallyBlock && !tree.finally
      && Array.isArray(tree.catches) && tree.catches.length > 0
      && alwaysExits(tree.body, render)
      && tree.catches.every((item) => alwaysExits(item.body, render));
    // Java releases the monitor for an abrupt completion. Moving this whole
    // arm after the loop test preserves acquisition, evaluation and release;
    // the caller separately refuses references to the rotated loop label.
    case 'synchronized': return alwaysExits(tree.body, render);
    case 'break': return true;
    case 'continue': return true;
    default: return false; // anything new: assume it falls through
  }
}

function referencesLabel(tree, label, transfer = null) {
  if (!tree) return false;
  switch (tree.t) {
    case 'break':
    case 'continue': return tree.label === label && (!transfer || tree.t === transfer);
    case 'seq': return (tree.body || []).some((child) => referencesLabel(child, label, transfer));
    case 'block':
    case 'loop':
    case 'synchronized':
    case 'try': return referencesLabel(tree.body, label, transfer)
      || (tree.catches || []).some((item) => referencesLabel(item.body, label, transfer));
    case 'if': return referencesLabel(tree.then, label, transfer)
      || referencesLabel(tree.els, label, transfer);
    case 'switch': return (tree.cases || []).some((item) => referencesLabel(item.body, label, transfer))
      || referencesLabel(tree.dflt, label, transfer);
    default: return false;
  }
}

// `{loop L, seq[straight, if]}` is the shape the structurer gives a loop whose
// test sits at the top. The straight part has to be empty for the test to move
// into the header - anything computed there runs before the test on every
// iteration and must stay in the body.
function rotatableLoop(tree, render) {
  const body = tree.body;
  if (!body || body.t !== 'seq' || (body.body || []).length < 2) return null;
  const [head, branch, ...rest] = body.body;
  if (!head || head.t !== 'straight' || !branch || branch.t !== 'if') return null;
  if (render.straight(head.block).length) return null;
  return { branch, rest };
}

function endsWithContinueTo(statements, label) {
  const last = statements[statements.length - 1];
  return !!last && last.kind === 'ContinueStatement' && last.label === label;
}

const statementParser = new JavaParser();
// Weak keys keep this proof cache from retaining completed methods or their
// generated source. Parse the whole straight block, not just its first line.
const parsedStraightBlocks = new WeakMap();
function parsedStraightBlock(node) {
  if (!parsedStraightBlocks.has(node)) {
    let parsed = null;
    try {
      parsed = statementParser.parseStatement(`{\n${node.source}\n}`, { requireComplete: true });
    } catch (_) { /* Unknown Java stays in its original scope/control flow. */ }
    parsedStraightBlocks.set(node, parsed);
  }
  return parsedStraightBlocks.get(node);
}

function provenAbrupt(statements) {
  const state = { unreachable: false };
  return !sequenceCompletesNormally(statements, state, true) && !state.unreachable;
}

function continuation(statements) {
  // Removing the enclosing else must not extend a variable or local type's
  // scope into subsequent statements. In doubtful cases keep a plain block.
  const scopedOrNondeclaring = new Set([
    'BlockStatement', 'LabeledStatement', 'IfStatement', 'WhileStatement',
    'ForStatement', 'DoWhileStatement', 'SwitchStatement', 'TryStatement',
    'SynchronizedStatement', 'ExpressionStatement', 'ReturnStatement',
    'ThrowStatement', 'BreakStatement', 'ContinueStatement', 'EmptyStatement',
    'AssertStatement',
  ]);
  const scopeSafe = statements.every((statement) => {
    if (statement.kind !== 'UnsupportedStatement') return scopedOrNondeclaring.has(statement.kind);
    const parsed = parsedStraightBlock(statement);
    return parsed && parsed.statements.every((child) => scopedOrNondeclaring.has(child.kind));
  });
  return scopeSafe ? statements : [block(statements)];
}

function statementCount(statements) {
  let count = 0;
  for (const statement of statements) anyStatement(statement, () => { count++; return false; });
  return count;
}

function primitiveAssignment(statements, localType) {
  if (statements.length !== 1 || statements[0].kind !== 'UnsupportedStatement') return null;
  const parsed = parsedStraightBlock(statements[0]);
  if (!parsed || parsed.statements.length !== 1) return null;
  const statement = parsed.statements[0];
  const assignment = statement.kind === 'ExpressionStatement' && statement.expression;
  if (!assignment || assignment.kind !== 'AssignmentExpression' || assignment.operator !== '='
      || assignment.left.kind !== 'Identifier') return null;
  let value = assignment.right;
  let sign = '';
  if (value.kind === 'UnaryExpression' && value.prefix && ['-', '+'].includes(value.operator)) {
    sign = value.operator;
    value = value.operand;
  }
  if (!sign && value.kind === 'Identifier') {
    const type = localType(value.name);
    return ['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double'].includes(type)
      ? {name: assignment.left.name, type, source: value.name} : null;
  }
  if (value.kind !== 'LiteralExpression') return null;
  if (!sign && value.literalKind === 'boolean') return {
    name: assignment.left.name, type: 'boolean', source: String(value.value),
  };
  if (value.literalKind !== 'number') return null;
  const source = value.raw;
  let type = null;
  // Read the spelling rather than converting through JS Number: large Java
  // integers, negative zero and hexadecimal literals must retain their bits.
  const integer = '(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*)';
  if (new RegExp(`^${integer}$`).test(source)) type = 'int';
  else if (new RegExp(`^${integer}[lL]$`).test(source)) type = 'long';
  else if (/^(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][+-]?[\d_]+)?[fF]$/.test(source)) type = 'float';
  else if (/^(?:\d[\d_]*\.[\d_]*|\.[\d_]+|\d[\d_]*[eE][+-]?[\d_]+)(?:[eE][+-]?[\d_]+)?[dD]?$/.test(source)) type = 'double';
  return type ? {name: assignment.left.name, type, source: sign + source} : null;
}

function valueProducingBranch(condition, thenStatements, elseStatements, localType) {
  if (!localType) return null;
  const taken = primitiveAssignment(thenStatements, localType);
  const other = primitiveAssignment(elseStatements, localType);
  if (!taken || !other || taken.name !== other.name || taken.type !== other.type) return null;
  const destination = localType(taken.name);
  // Same-type primitive arms have no conditional numeric promotion, boxing or
  // reference type inference. Require an identical destination type as well:
  // byte/short/char constant assignment permits narrowing that a ternary might
  // reject. An unproven name could be an unqualified (possibly volatile) field.
  if (destination !== taken.type) return null;
  return rawStatement(`${taken.name} = (${condition}) ? ${taken.source} : ${other.source};`);
}

// Prove every use before changing a generated stack slot's representation.
// AST nodes establish allowed stores/reads; lexer offsets preserve all other
// source bytes. Effectful conditions remain snapshots at their original point.
function promoteBooleanStackCarriers(source, declarations, carrierTypes, localType) {
  const unchanged = () => ({source, declarations, promoted: [], removed: []});
  if (/\\u+[0-9a-fA-F]{4}/.test(source)) return unchanged(); // translated offsets differ
  const candidates = new Map();
  for (const declaration of declarations) {
    const match = /^int (stackIn_\d+_\d+)(?: = ([01]))?;$/.exec(declaration);
    if (match && carrierTypes.get(match[1]) === 'int') candidates.set(match[1], {
      writes: [], reads: [], occurrences: 0, invalid: false,
    });
  }
  if (!candidates.size) return unchanged();
  let parsed, tokens;
  try {
    parsed = statementParser.parseStatement(`{\n${source}\n}`, {requireComplete: true});
    const lexed = tokenizeJava(source);
    if (lexed.diagnostics.length) return unchanged();
    tokens = lexed.tokens.filter(token => !['comment', 'whitespace', 'eof'].includes(token.kind));
  } catch (_) { return unchanged(); }
  const bit = node => node && node.kind === 'LiteralExpression'
    && node.literalKind === 'number' && ['0', '1'].includes(node.raw) ? node.raw : null;
  const zero = node => bit(node) === '0';
  let unknown = false;
  function walk(node, parent = null, key = null, statement = null, blockNode = null, unsafe = false) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) walk(child, parent, key, statement, blockNode, unsafe); return; }
    if (node.kind) {
      if (node.kind.startsWith('Unsupported')) unknown = true;
      unsafe ||= ['ClassDeclaration', 'InterfaceDeclaration', 'EnumDeclaration', 'RecordDeclaration',
        'MethodDeclaration', 'ConstructorDeclaration', 'LambdaExpression'].includes(node.kind)
        || node.kind === 'NewClassExpression' && node.body != null;
      if (node.kind === 'BlockStatement') blockNode = node;
      if (node.kind.endsWith('Statement')) statement = node;
      if (node.kind === 'Identifier' && candidates.has(node.name)) {
        const state = candidates.get(node.name); state.occurrences++;
        if (unsafe) state.invalid = true;
        else if (parent?.kind === 'AssignmentExpression' && key === 'left'
            && parent.operator === '=' && statement?.kind === 'ExpressionStatement'
            && statement.expression === parent) {
          const value = parent.right;
          if (bit(value) !== null || value.kind === 'ConditionalExpression'
              && bit(value.consequent) !== null && bit(value.alternate) !== null)
            state.writes.push({value, statement, blockNode});
          else state.invalid = true;
        } else if (parent?.kind === 'BinaryExpression' && ['==', '!='].includes(parent.operator)
            && (key === 'left' && zero(parent.right) || key === 'right' && zero(parent.left))) {
          state.reads.push({comparison: parent, statement, blockNode});
        } else state.invalid = true;
      }
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (['range', 'tokens', 'meta', 'kind'].includes(childKey)) continue;
      if (child && typeof child === 'object') walk(child, node, childKey, statement, blockNode, unsafe);
    }
  }
  walk(parsed);
  if (unknown) return unchanged();
  const indices = new Map([...candidates.keys()].map(name => [name, []]));
  tokens.forEach((token, index) => { if (token.kind === 'identifier' && indices.has(token.text)) indices.get(token.text).push(index); });
  const edits = [], promoted = [], removed = [];
  const numericTypes = new Set(['byte', 'short', 'char', 'int', 'long', 'float', 'double']);
  const pureNumber = node => {
    if (node.kind === 'ParenthesizedExpression') return pureNumber(node.expression);
    if (node.kind === 'Identifier' && numericTypes.has(localType?.(node.name))) return new Set([node.name]);
    if (node.kind === 'LiteralExpression' && node.literalKind === 'number') return new Set();
    if (node.kind === 'UnaryExpression' && ['+', '-', '~'].includes(node.operator)) return pureNumber(node.operand);
    return null;
  };
  const pureBoolean = node => {
    if (node.kind === 'ParenthesizedExpression') return pureBoolean(node.expression);
    if (node.kind === 'Identifier' && localType?.(node.name) === 'boolean') return new Set([node.name]);
    if (node.kind === 'UnaryExpression' && node.operator === '!') return pureBoolean(node.operand);
    if (node.kind === 'LiteralExpression' && node.literalKind === 'boolean') return new Set();
    if (node.kind === 'BinaryExpression') {
      let left = null, right = null;
      if (['==', '!=', '<', '>', '<=', '>='].includes(node.operator)) {
        left = pureNumber(node.left); right = pureNumber(node.right);
        if ((!left || !right) && ['==', '!='].includes(node.operator)) {
          left = pureBoolean(node.left); right = pureBoolean(node.right);
        }
      } else if (['&&', '||'].includes(node.operator)) {
        left = pureBoolean(node.left); right = pureBoolean(node.right);
      }
      if (left && right) return new Set([...left, ...right]);
    }
    return null;
  };
  function pureSource(node) {
    if (node.kind === 'ParenthesizedExpression') return pureSource(node.expression);
    if (node.kind === 'UnaryExpression') {
      const operand = pureSource(node.operand);
      // Decimal MIN_VALUE literals are legal only directly under unary minus.
      return `${node.operator}${['Identifier', 'LiteralExpression'].includes(node.operand.kind) ? operand : `(${operand})`}`;
    }
    if (node.kind === 'BinaryExpression') return `(${pureSource(node.left)} ${node.operator} ${pureSource(node.right)})`;
    return node.kind === 'Identifier' ? node.name : node.raw || String(node.value);
  }
  function negatePure(value) {
    if (value === 'true') return 'false';
    if (value === 'false') return 'true';
    return value.startsWith('!') ? value.slice(1) : `!${value}`;
  }
  function writesNames(node, names) {
    if (!node || typeof node !== 'object') return false;
    if ((node.kind === 'AssignmentExpression' && node.left?.kind === 'Identifier' && names.has(node.left.name))
        || (node.kind === 'UnaryExpression' && ['++', '--'].includes(node.operator)
          && node.operand?.kind === 'Identifier' && names.has(node.operand.name))) return true;
    return Object.entries(node).some(([key, child]) => !['range', 'tokens', 'meta'].includes(key)
      && child && typeof child === 'object' && writesNames(child, names));
  }
  for (const [name, state] of candidates) {
    if (state.invalid || !state.writes.length || !state.reads.length
        || indices.get(name).length !== state.occurrences) continue;
    const localEdits = [], assignments = [], comparisons = [];
    let valid = true;
    for (const index of indices.get(name)) {
      const token = tokens[index];
      if (tokens[index + 1]?.text === '=') {
        // The semicolon is outside the condition's parentheses/initializers.
        // Literal conditional arms occupy the last four tokens of the RHS.
        let end = index + 2, depth = 0;
        for (; end < tokens.length; end++) {
          const text = tokens[end].text;
          if (text === '(' || text === '[' || text === '{') depth++;
          else if (text === ')' || text === ']' || text === '}') depth--;
          if (text === ';' && depth === 0) break;
        }
        const rhs = tokens.slice(index + 2, end);
        const proof = state.writes[assignments.length];
        let value = null;
        if (proof && bit(proof.value) !== null && rhs.length === 1 && rhs[0].text === bit(proof.value))
          value = rhs[0].text === '1' ? 'true' : 'false';
        else if (proof?.value.kind === 'ConditionalExpression' && rhs.length > 4
            && rhs.at(-4).text === '?' && rhs.at(-3).text === bit(proof.value.consequent)
            && rhs.at(-2).text === ':' && rhs.at(-1).text === bit(proof.value.alternate)) {
          const pure = pureBoolean(proof.value.condition);
          const condition = pure ? pureSource(proof.value.condition)
            : source.slice(rhs[0].range.startOffset, rhs.at(-5).range.endOffset);
          const taken = bit(proof.value.consequent), other = bit(proof.value.alternate);
          value = taken === other ? pure ? String(taken === '1') : `${condition} ? ${taken === '1'} : ${other === '1'}`
            : taken === '1' ? condition : pure ? negatePure(condition)
              : proof.value.condition.kind === 'ParenthesizedExpression' ? `!${condition}` : `!(${condition})`;
        }
        if (value === null || !tokens[end] || depth !== 0) { valid = false; break; }
        assignments.push({proof, value, start: token.range.startOffset, end: tokens[end].range.endOffset});
        localEdits.push({start: rhs[0].range.startOffset, end: rhs.at(-1).range.endOffset, value});
      } else {
        let first = index, last = index + 2;
        if (tokens[index - 1]?.text === '==' || tokens[index - 1]?.text === '!=') {first = index - 2; last = index;}
        const comparison = state.reads[comparisons.length]?.comparison;
        const operator = tokens[first + 1]?.text;
        if (!comparison || comparison.operator !== operator || !['==', '!='].includes(operator)
            || !(tokens[first].text === name && tokens[last]?.text === '0'
              || tokens[first].text === '0' && tokens[last]?.text === name)) {valid = false; break;}
        comparisons.push({start: tokens[first].range.startOffset, end: tokens[last].range.endOffset, operator});
      }
    }
    if (!valid || assignments.length !== state.writes.length || comparisons.length !== state.reads.length) continue;
    let inline = false;
    if (assignments.length === 1 && comparisons.length === 1) {
      const write = assignments[0].proof, read = state.reads[0];
      const names = write.value.kind === 'ConditionalExpression' ? pureBoolean(write.value.condition) : new Set();
      const siblings = write.blockNode?.statements || [];
      inline = !!names && write.blockNode === read.blockNode
        && siblings[siblings.indexOf(write.statement) + 1] === read.statement
        && ['ExpressionStatement', 'ReturnStatement', 'ThrowStatement'].includes(read.statement.kind)
        && !writesNames(read.statement, names);
    }
    if (inline) {
      removed.push(name);
      const assignment = assignments[0];
      let {start, end} = assignment;
      const lineStart = source.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = source.indexOf('\n', end);
      if (lineEnd >= 0 && !source.slice(lineStart, start).trim() && !source.slice(end, lineEnd).trim()) {
        start = lineStart; end = lineEnd + 1;
      }
      edits.push({start, end, value: ''});
    } else {
      promoted.push(name); edits.push(...localEdits);
    }
    for (const comparison of comparisons) {
      const value = inline ? assignments[0].value : name;
      edits.push({...comparison, value: comparison.operator === '!=' ? value : negatePure(value)});
    }
  }
  edits.sort((a, b) => a.start - b.start);
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  const retyped = new Set(promoted), eliminated = new Set(removed);
  declarations = declarations.flatMap(declaration => {
    const match = /^int (stackIn_\d+_\d+)(?: = ([01]))?;$/.exec(declaration);
    if (!match) return [declaration];
    if (eliminated.has(match[1])) return [];
    if (!retyped.has(match[1])) return [declaration];
    return [`boolean ${match[1]}${match[2] === undefined ? '' : ` = ${match[2] === '1'}`};`];
  });
  return {source, declarations, promoted, removed};
}

const emittedStatementSources = new WeakMap();
function statementSource(statement) {
  if (!emittedStatementSources.has(statement))
    emittedStatementSources.set(statement, emitStatements([statement]));
  return emittedStatementSources.get(statement);
}

const transferKinds = new Set(['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement']);
function containsExplicitTransfer(statement) {
  return anyStatement(statement, node => transferKinds.has(node.kind)
    || node.kind === 'UnsupportedStatement' && anyStatement(parsedStraightBlock(node),
      parsed => transferKinds.has(parsed.kind)));
}

function commonBranchTail(thenStatements, elseStatements) {
  // An if introduces no handler, monitor or jump target. Moving an identical
  // whole statement past it retains all three, including a try/lock *inside*
  // that statement. Never extract a tail from inside such a construct.
  // Both prefixes and the tail must have no declarations whose scope changes:
  // an identical spelling can otherwise denote two different branch locals.
  if (continuation(thenStatements) !== thenStatements
      || continuation(elseStatements) !== elseStatements) return 0;
  let count = 0;
  while (count < Math.min(thenStatements.length, elseStatements.length)) {
    const taken = thenStatements[thenStatements.length - count - 1];
    const other = elseStatements[elseStatements.length - count - 1];
    if (statementSource(taken) !== statementSource(other)) break;
    count++;
  }
  // Sharing just `return false` can turn a readable guard ladder into nested
  // positive tests. Keep empty exit guards and prefixes containing transfers;
  // meaningful shared work before the transfer still gets factored.
  const parsed = statement => statement.kind === 'UnsupportedStatement'
    ? parsedStraightBlock(statement) : statement;
  const tail = thenStatements.slice(-count);
  const onlyTransfers = count && tail.every(statement => {
    const node = parsed(statement);
    return node?.kind === 'BlockStatement' ? node.statements.length === 1 && transferKinds.has(node.statements[0].kind)
      : transferKinds.has(node?.kind);
  });
  if (onlyTransfers && (thenStatements.length === count && elseStatements.length !== count
      || elseStatements.length === count && thenStatements.length !== count
      || [...thenStatements.slice(0, -count), ...elseStatements.slice(0, -count)].some(containsExplicitTransfer))) return 0;
  return count;
}

function lowerIfStatements(condition, thenStatements, elseStatements, inverted, localType, factorTails = false) {
  const makeIf = (source, body, alternate = null) => createNode('IfStatement', {
    condition: rawExpression(source), consequent: block(body), alternate,
  });
  // All children have already been rendered in CFG order. Only rearrange the
  // resulting AST, because rendering itself binds local names and types.
  const inverse = () => (inverted && inverted()) || `!(${condition})`;
  const shared = factorTails ? commonBranchTail(thenStatements, elseStatements) : 0;
  if (shared) {
    const taken = thenStatements.slice(0, -shared);
    const other = elseStatements.slice(0, -shared);
    // Even when both prefixes are empty the condition must still execute:
    // field reads, calls and boxed Boolean unboxing can throw or have effects.
    return [...lowerIfStatements(condition, taken, other, inverted, localType, true),
      ...thenStatements.slice(-shared)];
  }
  const value = valueProducingBranch(condition, thenStatements, elseStatements, localType);
  if (value) return [value];
  if (!thenStatements.length && elseStatements.length) {
    return [makeIf(inverse(), elseStatements)];
  }
  if (elseStatements.length) {
    const thenExits = provenAbrupt(thenStatements);
    const elseExits = provenAbrupt(elseStatements);
    // When both arms leave, use the shorter arm as the guard. This avoids
    // retaining a deep conditional ladder in the guard's body.
    if (thenExits && (!elseExits || statementCount(thenStatements) <= statementCount(elseStatements))) {
      return [makeIf(condition, thenStatements), ...continuation(elseStatements)];
    }
    if (elseExits) {
      return [makeIf(inverse(), elseStatements), ...continuation(thenStatements)];
    }
  }
  return [makeIf(condition, thenStatements, elseStatements.length ? block(elseStatements) : null)];
}

// A routing local is dead only if every occurrence is a literal store or a
// pure comparison whose two arms are empty. Take identities from the region
// allocator, not a name heuristic; keep all protected statements in place.
function removeDeadRegionSelectors(source, declarations, selectorNames) {
  const unchanged = () => ({source, declarations, removed: []});
  const candidates = new Map();
  for (const name of selectorNames || []) {
    if (!/^decompiledRegionSelector\d+$/.test(name)) continue;
    const declaration = `int ${name} = 0;`;
    if (declarations.filter(item => item === declaration).length !== 1) continue;
    candidates.set(name, {declaration, allowed: new Set(), edits: []});
  }
  if (!candidates.size || [source, ...declarations].some(text => /\\u+[0-9a-fA-F]{4}/.test(text))) return unchanged();
  const wrapped = `{\n${source}\n}`;
  let parsed, tokens;
  try {
    parsed = statementParser.parseStatement(wrapped, {requireComplete: true});
    const lexed = tokenizeJava(wrapped);
    if (lexed.diagnostics.length) return unchanged();
    tokens = lexed.tokens.filter(token => !['comment', 'whitespace', 'eof'].includes(token.kind));
  } catch (_) { return unchanged(); }
  const starts = new Map(tokens.map((token, index) => [token.range.startOffset, index]));
  const integer = token => token && /^(?:0|[1-9]\d*)$/.test(token.text)
    && Number(token.text) <= 2147483647;
  const empty = node => node?.kind === 'BlockStatement' && node.statements.length === 0;
  let unknown = false;
  function walk(node, parent = null) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) walk(child, parent); return; }
    if (node.kind?.startsWith('Unsupported')) unknown = true;
    const index = starts.get(node.range?.startOffset);
    const first = tokens[index];
    const inBlock = parent?.kind === 'BlockStatement' && parent.statements.includes(node);
    if (inBlock && node.kind === 'ExpressionStatement' && node.expression?.kind === 'AssignmentExpression'
        && node.expression.operator === '=' && node.expression.left.kind === 'Identifier') {
      const state = candidates.get(node.expression.left.name);
      if (state && first?.text === node.expression.left.name && tokens[index + 1]?.text === '='
          && integer(tokens[index + 2]) && tokens[index + 3]?.text === ';') {
        state.allowed.add(index);
        state.edits.push({start: first.range.startOffset, end: tokens[index + 3].range.endOffset});
      }
    } else if (inBlock && node.kind === 'IfStatement' && empty(node.consequent)
        && (!node.alternate || empty(node.alternate))) {
      // Only a known generated int local compared with a literal can be erased.
      // An empty arm with an effectful/nullable/field condition must still run.
      const state = candidates.get(tokens[index + 2]?.text);
      if (state && first?.text === 'if' && tokens[index + 1]?.text === '('
          && ['==', '!='].includes(tokens[index + 3]?.text) && integer(tokens[index + 4])
          && tokens[index + 5]?.text === ')' && tokens[index + 6]?.text === '{'
          && tokens[index + 7]?.text === '}' && (!node.alternate
            || tokens[index + 8]?.text === 'else' && tokens[index + 9]?.text === '{'
              && tokens[index + 10]?.text === '}')) {
        state.allowed.add(index + 2);
        state.edits.push({start: first.range.startOffset,
          end: tokens[index + (node.alternate ? 10 : 7)].range.endOffset});
      }
    }
    for (const [key, child] of Object.entries(node))
      if (!['range', 'meta', 'tokens', 'kind'].includes(key)) walk(child, node);
  }
  walk(parsed);
  if (unknown) return unchanged();
  const removed = [], edits = [];
  for (const [name, state] of candidates) {
    // Account for every identifier token, including shadowing, qualified fields,
    // captures and unrecognized reads. No implicit lexical-binding assumption.
    if (tokens.some((token, index) => token.kind === 'identifier' && token.text === name
        && !state.allowed.has(index))) continue;
    if (declarations.some(declaration => declaration !== state.declaration
        && tokenizeJava(declaration).tokens.some(token => token.kind === 'identifier' && token.text === name))) continue;
    removed.push(name); edits.push(...state.edits);
  }
  edits.sort((a, b) => a.start - b.start);
  for (const edit of edits) {
    const lineStart = wrapped.lastIndexOf('\n', edit.start - 1) + 1;
    const lineEnd = wrapped.indexOf('\n', edit.end);
    if (lineEnd >= 0 && !wrapped.slice(lineStart, edit.start).trim() && !wrapped.slice(edit.end, lineEnd).trim()) {
      edit.start = lineStart; edit.end = lineEnd + 1;
    }
  }
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.reverse()) output = output.slice(0, edit.start) + output.slice(edit.end);
  return {source: output.slice(2, -2), removed,
    declarations: declarations.filter(declaration => !removed.some(name => declaration === candidates.get(name).declaration))};
}

// Remove only allocator-owned, unread Object stack slots whose complete body
// occurrences are standalone stores of this/null. Neither right-hand side can
// throw, allocate, initialize a class or perform a field/array/volatile read.
// Retain all surrounding conditions, protected regions, monitors and transfers.
function removeDeadReceiverSnapshots(source, declarations, carrierNames) {
  const unchanged = () => ({source, declarations, removed: []});
  const candidates = new Map();
  for (const name of carrierNames || []) {
    if (!/^stackIn_\d+_\d+$/.test(name)) continue;
    const declaration = `Object ${name} = null;`;
    if (declarations.filter(item => item === declaration).length === 1)
      candidates.set(name, {declaration, allowed: new Set(), edits: []});
  }
  if (!candidates.size || [source, ...declarations].some(text => /\\u+[0-9a-fA-F]{4}/.test(text))) return unchanged();
  const wrapped = `{\n${source}\n}`;
  let parsed, tokens;
  try {
    parsed = statementParser.parseStatement(wrapped, {requireComplete: true});
    const lexed = tokenizeJava(wrapped);
    if (lexed.diagnostics.length) return unchanged();
    tokens = lexed.tokens.filter(token => !['comment', 'whitespace', 'eof'].includes(token.kind));
  } catch (_) { return unchanged(); }
  const starts = new Map(tokens.map((token, index) => [token.range.startOffset, index]));
  let unknown = false;
  function walk(node, parent = null) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) walk(child, parent); return; }
    if (node.kind?.startsWith('Unsupported')) unknown = true;
    const expression = node.expression;
    if (node.kind === 'ExpressionStatement' && parent?.kind === 'BlockStatement'
        && parent.statements.includes(node) && expression?.kind === 'AssignmentExpression'
        && expression.operator === '=' && expression.left.kind === 'Identifier') {
      const state = candidates.get(expression.left.name);
      const index = starts.get(node.range?.startOffset);
      const right = expression.right;
      if (state && tokens[index]?.text === expression.left.name && tokens[index + 1]?.text === '='
          && tokens[index + 3]?.text === ';' && (right.kind === 'ThisExpression' && tokens[index + 2]?.text === 'this'
            || right.kind === 'LiteralExpression' && right.literalKind === 'null' && tokens[index + 2]?.text === 'null')) {
        state.allowed.add(index);
        state.edits.push({start: tokens[index].range.startOffset, end: tokens[index + 3].range.endOffset});
      }
    }
    for (const [key, child] of Object.entries(node))
      if (!['range', 'meta', 'tokens', 'kind'].includes(key)) walk(child, node);
  }
  walk(parsed);
  if (unknown) return unchanged();
  const removed = [], edits = [];
  for (const [name, state] of candidates) {
    if (tokens.some((token, index) => token.kind === 'identifier' && token.text === name && !state.allowed.has(index))) continue;
    if (declarations.some(declaration => declaration !== state.declaration &&
        tokenizeJava(declaration).tokens.some(token => token.kind === 'identifier' && token.text === name))) continue;
    removed.push(name); edits.push(...state.edits);
  }
  edits.sort((a,b) => a.start - b.start);
  for (const edit of edits) {
    const start = wrapped.lastIndexOf('\n', edit.start - 1) + 1;
    const end = wrapped.indexOf('\n', edit.end);
    if (end >= 0 && !wrapped.slice(start, edit.start).trim() && !wrapped.slice(edit.end, end).trim()) {
      edit.start = start; edit.end = end + 1;
    }
  }
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.reverse()) output = output.slice(0, edit.start) + output.slice(edit.end);
  return {source: output.slice(2, -2), removed,
    declarations: declarations.filter(declaration => !removed.some(name => declaration === candidates.get(name).declaration))};
}

function recoverScalarLabelDispatches(source, options = {}) {
  return recoverScalarDispatch(source, controlCleanupSource(source), options);
}

function recoverScalarIfDispatches(source, options = {}) {
  return recoverIfDispatch(source, controlCleanupSource(source), options);
}

function simplifyPredicateNegations(source, options = {}) {
  return simplifyNegations(source, controlCleanupSource(source), options);
}

function specializePathGuards(source, options = {}) {
  return specializeGuards(source, controlCleanupSource(source), options);
}

function recoverArrayIndexIncrements(source, options = {}) {
  return recoverIndexIncrements(source, controlCleanupSource(source), options);
}

function foldGuardedAbruptPlainBlockExits(source, options = {}) {
  return recoverGuardedAbruptExit(source, controlCleanupSource(source), options);
}

function foldGuardedLoopContinuations(source, options = {}) {
  return recoverLoopContinuation(source, controlCleanupSource(source), options);
}

function foldNonrepeatingWhileLoops(source, options = {}) {
  return recoverNonrepeatingLoops(source, controlCleanupSource(source), options);
}

function foldTrailingLoopContinuations(source, options = {}) {
  return recoverTrailingLoopContinuation(source, controlCleanupSource(source), options);
}

function foldLoopExitContinuations(source, options = {}) {
  return recoverLoopExitContinuation(source, controlCleanupSource(source), options);
}

function foldTerminalLoopExits(source, options = {}) {
  return recoverTerminalLoopExit(source, controlCleanupSource(source), options);
}

function foldLoopElseExitGuards(source, options = {}) {
  return recoverLoopElseExitGuard(source, controlCleanupSource(source), options);
}

function foldNonlocalLoopExits(source, options = {}) {
  return recoverNonlocalLoopExit(source, controlCleanupSource(source), options);
}

// Guard specialization and frame cleanup can expose exits after the ordinary
// exit passes have already run. Revisit only their existing destination/scope
// proofs. Do not infer any new value facts or re-run scalar dispatch selection.
// Every accepted step removes a transfer, transfer label, or label definition;
// this finite AST measure prevents cycling between equivalent source forms.
function recoverPostGuardExits(source, {parameterNames = []} = {}) {
  const original = source;
  const counts = {voidReturnFrames: 0, fallthroughBreaks: 0, exitTreeFrames: 0,
    ifElseFrames: 0, guardedAbruptFrames: 0, guardedAbruptJumps: 0, guardTreeFrames: 0, effectfulExits: 0,
    localizedLoopBreaks: 0, leadingLoopGuards: 0,
    labelsRemoved: 0, jumpsUnlabeled: 0, blocksUnwrapped: 0};
  const unchanged = () => ({source: original, rewrites: 0, counts});
  if (typeof source !== 'string' || !Array.isArray(parameterNames)
      || new Set(parameterNames).size !== parameterNames.length
      || parameterNames.some(name => typeof name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)))
    return unchanged();
  function measure(text) {
    const proof = controlCleanupSource(text);
    if (!proof) return null;
    let weight = 0;
    function visit(node) {
      if (node.kind === 'LabeledStatement') weight++;
      if (node.kind === 'BreakStatement' || node.kind === 'ContinueStatement')
        weight += node.label ? 2 : 1;
      proof.children(node, visit);
    }
    visit(proof.parsed);
    return weight;
  }
  let weight = measure(source), rewrites = 0;
  if (weight === null) return unchanged();
  const passes = [
    [foldVoidReturnExits, 'frames', 'voidReturnFrames'],
    [removeFallthroughLabelBreaks, 'breaksRemoved', 'fallthroughBreaks'],
    [foldLabeledExitTrees, 'framesRemoved', 'exitTreeFrames'],
    [foldLabeledIfElseExits, 'framesRemoved', 'ifElseFrames'],
    [foldGuardedAbruptPlainBlockExits, 'jumpsRemoved', 'guardedAbruptJumps'],
    [foldLabeledGuardTrees, 'framesRemoved', 'guardTreeFrames'],
    [foldEffectfulPlainBlockExits, 'exitsRecovered', 'effectfulExits'],
    [localizePlainBlockLoopBreaks, 'breaksLocalized', 'localizedLoopBreaks'],
    [foldLeadingWhileBreakGuards, 'guardsRecovered', 'leadingLoopGuards']
  ];
  for (;;) {
    let recovered = false;
    for (const [pass, key, counter] of passes) {
      const next = pass(source, {parameterNames});
      if (!next[key] || next.source === source) continue;
      // A refusal leaves the last proven source intact. It must never retain
      // a non-progressing candidate or discard earlier completed rewrites.
      const nextWeight = measure(next.source);
      if (nextWeight === null || nextWeight >= weight) continue;
      source = next.source; weight = nextWeight;
      counts[counter] += next[key]; rewrites++;
      if (pass === foldGuardedAbruptPlainBlockExits) counts.guardedAbruptFrames += next.framesRemoved;
      for (;;) {
        const cleaned = simplifyControlFrames(source);
        if (cleaned.source === source) break;
        const cleanedWeight = measure(cleaned.source);
        if (cleanedWeight === null || cleanedWeight >= weight) break;
        source = cleaned.source; weight = cleanedWeight;
        counts.labelsRemoved += cleaned.labelsRemoved;
        counts.jumpsUnlabeled += cleaned.jumpsUnlabeled;
        counts.blocksUnwrapped += cleaned.blocksUnwrapped;
      }
      recovered = true;
      break;
    }
    if (!recovered) return {source, rewrites, counts};
  }
}

function controlCleanupSource(source) {
  if (/\\u+[0-9a-fA-F]{4}/.test(source)) return null;
  const wrapped = `{\n${source}\n}`;
  let parsed, tokens;
  try {
    parsed = statementParser.parseStatement(wrapped, {requireComplete: true});
    const lexed = tokenizeJava(wrapped);
    if (lexed.diagnostics.length) return null;
    tokens = lexed.tokens.filter(token => !['whitespace', 'eof'].includes(token.kind));
    // The lexer skips trivia. Refuse comment delimiters only in gaps between
    // tokens; delimiters inside quoted literals retain their literal meaning.
    let previousEnd = 0;
    for (const token of tokens) {
      if (/\/\/|\/\*/.test(wrapped.slice(previousEnd, token.range.startOffset))) return null;
      previousEnd = token.range.endOffset;
    }
    if (/\/\/|\/\*/.test(wrapped.slice(previousEnd))) return null;
    if (tokens.some(token => token.text.startsWith('"""'))) return null;
  } catch (_) { return null; }
  const starts = new Map(tokens.map((token, index) => [token.range.startOffset, index]));
  const closes = new Map(), stack = [];
  for (let index = 0; index < tokens.length; index++) {
    const text = tokens[index].text;
    if (['(', '[', '{'].includes(text)) stack.push(index);
    else if ([')', ']', '}'].includes(text)) {
      const open = stack.pop();
      if (open === undefined || '([{'.indexOf(tokens[open].text) !== ')]}'.indexOf(text)) return null;
      closes.set(open, index);
    }
  }
  if (stack.length) return null;
  const labelCounts = new Map();
  let unknown = false;
  function children(node, visit) {
    for (const [key, child] of Object.entries(node)) {
      if (['range', 'meta', 'tokens', 'kind'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(value => value && typeof value === 'object' && visit(value));
      else if (child && typeof child === 'object') visit(child);
    }
  }
  function inspect(node) {
    if (node.kind?.startsWith('Unsupported')) unknown = true;
    if (node.kind === 'LabeledStatement') labelCounts.set(node.label, (labelCounts.get(node.label) || 0) + 1);
    children(node, inspect);
  }
  inspect(parsed);
  return unknown ? null : {wrapped, parsed, tokens, starts, closes, children, labelCounts};
}

// A structurer-owned plain exit block already provides a destination for a
// common return/throw tail. Reuse it rather than introducing another frame.
// Nested loops and plain labels can be exited by that break, but a try/catch,
// finally or monitor between the clone and its destination must stay opaque:
// moving even identical cleanup across it could change exception coverage or
// monitor ownership. Keep the original tail and all surrounding source bytes.
function factorLabeledBlockReturnTails(source) {
  const unchanged = () => ({source, branches: 0});
  const proof = controlCleanupSource(source);
  if (!proof) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  function spans(node) {
    let open = starts.get(node.range?.startOffset);
    // Some parser-owned try/catch/monitor blocks lack their own range. Their
    // first statement and the immediately preceding opening brace still prove
    // the complete lexical extent. Empty/unlocated bodies offer no candidates.
    if (open === undefined) {
      const first = starts.get(node.statements?.[0]?.range?.startOffset);
      if (first !== undefined && tokens[first - 1]?.text === '{') open = first - 1;
    }
    const close = closes.get(open);
    if (node.kind !== 'BlockStatement' || tokens[open]?.text !== '{' || tokens[close]?.text !== '}')
      return [];
    return node.statements.map((statement, index) => {
      const first = starts.get(statement.range?.startOffset);
      const after = index + 1 < node.statements.length
        ? starts.get(node.statements[index + 1].range?.startOffset) : close;
      if (first === undefined || after === undefined || first >= after) throw new Error('unproven statement extent');
      return {statement, first, after, spelling: JSON.stringify(tokens.slice(first, after).map(token => token.text))};
    });
  }
  function safeTail(node) {
    const forbidden = new Set(['TryStatement', 'SynchronizedStatement', 'LabeledStatement',
      'WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement', 'SwitchStatement',
      'BreakStatement', 'ContinueStatement', 'VariableDeclarator', 'LocalVariableDeclarationStatement']);
    if (forbidden.has(node.kind)) return false;
    let safe = true;
    children(node, child => { if (!safeTail(child)) safe = false; });
    return safe;
  }
  // These are exactly the transparent paths to a clone. Discovery may inspect
  // protected bodies for a wholly internal candidate, but replacement never
  // crosses their boundary, even when their source tails happen to match.
  const transparent = new Set(['BlockStatement', 'IfStatement', 'WhileStatement',
    'ForStatement', 'EnhancedForStatement', 'DoWhileStatement', 'LabeledStatement']);
  function find(node) {
    if (node.kind === 'BlockStatement') {
      const items = spans(node);
      const terminal = items.at(-1)?.statement;
      if (['ReturnStatement', 'ThrowStatement'].includes(terminal?.kind)) {
        for (let index = 0; index < items.length - 2; index++) {
          const exit = items[index].statement;
          if (exit.kind !== 'LabeledStatement' || exit.statement?.kind !== 'BlockStatement'
              || labelCounts.get(exit.label) !== 1) continue;
          const tail = items.slice(index + 1);
          if (!tail.every(item => safeTail(item.statement))) continue;
          // Only declarations inside the exit block can change a tail name's
          // binding relative to the following copy. Method locals declared
          // before that block remain in the same enclosing scope on both paths.
          // Reject all inner shadows instead of guessing their exact lifetime.
          const declaredNames = new Set();
          function declarations(child) {
            if (['VariableDeclarator', 'FormalParameter'].includes(child.kind)) declaredNames.add(child.name);
            children(child, declarations);
          }
          declarations(exit.statement);
          if (tokens.slice(tail[0].first, tail.at(-1).after).some(token =>
              token.kind === 'identifier' && declaredNames.has(token.text))) continue;
          const edits = [];
          function replace(child) {
            if (!transparent.has(child.kind)) return;
            if (child.kind === 'BlockStatement') {
              const body = spans(child), suffix = body.slice(-tail.length);
              if (body.length >= tail.length && suffix.every((item, ordinal) => item.spelling === tail[ordinal].spelling)) {
                const first = tokens[suffix[0].first], last = tokens[suffix.at(-1).after - 1];
                if (last.text !== ';') throw new Error('unproven terminal extent');
                edits.push({start: first.range.startOffset, end: last.range.endOffset, text: `break ${exit.label};`});
                return;
              }
            }
            children(child, replace);
          }
          replace(exit.statement);
          if (edits.length) return edits;
        }
      }
    }
    let result;
    children(node, child => { if (!result) result = find(child); });
    return result;
  }
  try {
    const edits = find(parsed);
    if (!edits?.length) return unchanged();
    edits.sort((a,b) => a.start - b.start);
    if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
    let output = wrapped;
    for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    return {source: output.slice(2, -2), branches: edits.length};
  } catch (_) { return unchanged(); }
}

// A break to a plain label is redundant only when its entire path to that
// destination consists of final block statements, if branches and plain labels.
// Leave enclosing cleanup intact and refuse intermediate cleanup/loop/switch
// continuations. Remove the jump, never its predicate or declaration scope.
function removeFallthroughLabelBreaks(source) {
  const unchanged = () => ({source, breaksRemoved: 0});
  const proof = controlCleanupSource(source);
  if (!proof) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const parents = new Map(), targets = new Map(), jumps = [];
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  let refused = false;
  function inspect(node, parent, labels = [], loopDepth = 0, breakDepth = 0) {
    parents.set(node, parent);
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      if (node.label) {
        const target = labels.slice().reverse().find(frame => frame.label === node.label);
        if (!target || node.kind === 'ContinueStatement' && !loops.has(target.statement?.kind)) refused = true;
        else targets.set(node, target);
        if (node.kind === 'BreakStatement') jumps.push(node);
      } else if (!(node.kind === 'ContinueStatement' ? loopDepth : breakDepth)) refused = true;
    }
    if (node.kind === 'ExpressionStatement') {
      const expression = node.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(expression?.kind)
          && !(expression?.kind === 'UnaryExpression' && ['++', '--'].includes(expression.operator))) refused = true;
      let index = starts.get(node.range?.startOffset);
      if (index === undefined) refused = true;
      else {
        while (index < tokens.length && tokens[index].text !== ';' && tokens[index].text !== '}') {
          if (closes.has(index)) index = closes.get(index);
          index++;
        }
        if (tokens[index]?.text !== ';') refused = true;
      }
    }
    children(node, child => inspect(child, node,
      node.kind === 'LabeledStatement' ? [...labels, node] : labels,
      loopDepth + (loops.has(node.kind) ? 1 : 0),
      breakDepth + (loops.has(node.kind) || node.kind === 'SwitchStatement' ? 1 : 0)));
  }
  inspect(parsed, null);
  if (refused || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  function blockExtent(node) {
    const open = starts.get(node.range?.startOffset), close = closes.get(open);
    return tokens[open]?.text === '{' && tokens[close]?.text === '}'
      && (!node.statements.length ? close === open + 1
        : starts.get(node.statements[0].range?.startOffset) === open + 1
          && node.statements.every(statement => {
            const start = starts.get(statement.range?.startOffset);
            return start > open && start < close;
          }));
  }
  const edits = [];
  for (const jump of jumps) {
    const target = targets.get(jump);
    if (target?.statement?.kind !== 'BlockStatement' || !blockExtent(target.statement)) continue;
    const labelStart = starts.get(target.range?.startOffset);
    if (tokens[labelStart]?.text !== target.label || tokens[labelStart + 1]?.text !== ':') continue;
    let child = jump, parent = parents.get(child), terminal = true;
    while (parent && parent !== target) {
      if (parent.kind === 'BlockStatement') {
        if (!blockExtent(parent) || parent.statements.at(-1) !== child) { terminal = false; break; }
      } else if (parent.kind === 'IfStatement') {
        if (parent.consequent !== child && parent.alternate !== child) { terminal = false; break; }
      } else if (parent.kind === 'LabeledStatement') {
        if (parent.statement !== child || child.kind !== 'BlockStatement') { terminal = false; break; }
      } else {
        // A loop/switch has another continuation; a protected region can
        // distinguish normal and abrupt completion. Do not cross either.
        terminal = false; break;
      }
      child = parent;
      parent = parents.get(parent);
    }
    if (!terminal || parent !== target || child !== target.statement) continue;
    const index = starts.get(jump.range?.startOffset);
    if (tokens[index]?.text !== 'break' || tokens[index + 1]?.text !== jump.label
        || tokens[index + 2]?.text !== ';') return unchanged();
    const edit = {start: tokens[index].range.startOffset, end: tokens[index + 2].range.endOffset,
      text: parents.get(jump)?.kind === 'BlockStatement' ? '' : ';'};
    if (!edit.text) {
      const lineStart = wrapped.lastIndexOf('\n', edit.start - 1) + 1;
      const lineEnd = wrapped.indexOf('\n', edit.end);
      if (lineEnd >= 0 && !wrapped.slice(lineStart, edit.start).trim() && !wrapped.slice(edit.end, lineEnd).trim()) {
        edit.start = lineStart; edit.end = lineEnd + 1;
      }
    }
    edits.push(edit);
  }
  if (!edits.length) return unchanged();
  edits.sort((a, b) => a.start - b.start);
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return {source: output.slice(2, -2), breaksRemoved: edits.length};
}

// Exiting the nearest loop also reaches an enclosing plain label when the
// entire continuation after that loop is empty. Change only the break's target
// spelling. Inner cleanup still executes on the same abrupt exit; cleanup,
// switches, other loops and work between the loop and label refuse the proof.
function localizePlainBlockLoopBreaks(source) {
  const unchanged = () => ({source, breaksLocalized: 0});
  const proof = controlCleanupSource(source);
  if (!proof) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  const parents = new Map(), targets = new Map(), nearest = new Map(), jumps = [];
  let refused = false;
  function inspect(node, parent, labels = [], loopDepth = 0, breakStack = []) {
    parents.set(node, parent);
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      if (node.label) {
        const target = labels.slice().reverse().find(frame => frame.label === node.label);
        if (!target || node.kind === 'ContinueStatement' && !loops.has(target.statement?.kind)) refused = true;
        else targets.set(node, target);
        if (node.kind === 'BreakStatement') {
          jumps.push(node);
          nearest.set(node, breakStack.at(-1));
        }
      } else if (!(node.kind === 'ContinueStatement' ? loopDepth : breakStack.length)) refused = true;
    }
    if (node.kind === 'ExpressionStatement') {
      const expression = node.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(expression?.kind)
          && !(expression?.kind === 'UnaryExpression' && ['++', '--'].includes(expression.operator))) refused = true;
      let index = starts.get(node.range?.startOffset);
      if (index === undefined) refused = true;
      else {
        while (index < tokens.length && tokens[index].text !== ';' && tokens[index].text !== '}') {
          if (closes.has(index)) index = closes.get(index);
          index++;
        }
        if (tokens[index]?.text !== ';') refused = true;
      }
    }
    children(node, child => inspect(child, node,
      node.kind === 'LabeledStatement' ? [...labels, node] : labels,
      loopDepth + (loops.has(node.kind) ? 1 : 0),
      loops.has(node.kind) || node.kind === 'SwitchStatement' ? [...breakStack, node] : breakStack));
  }
  inspect(parsed, null);
  if (refused || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  function blockExtent(node) {
    const open = starts.get(node.range?.startOffset), close = closes.get(open);
    return tokens[open]?.text === '{' && tokens[close]?.text === '}'
      && (!node.statements.length ? close === open + 1
        : starts.get(node.statements[0].range?.startOffset) === open + 1
          && node.statements.every(statement => {
            const start = starts.get(statement.range?.startOffset);
            return start > open && start < close;
          }));
  }
  const edits = [];
  for (const jump of jumps) {
    const target = targets.get(jump), loop = nearest.get(jump);
    if (!loops.has(loop?.kind) || target?.statement?.kind !== 'BlockStatement' || !blockExtent(target.statement)) continue;
    const labelStart = starts.get(target.range?.startOffset);
    if (tokens[labelStart]?.text !== target.label || tokens[labelStart + 1]?.text !== ':') continue;
    let child = loop, parent = parents.get(child), terminal = true;
    while (parent && parent !== target) {
      if (parent.kind === 'BlockStatement') {
        if (!blockExtent(parent) || parent.statements.at(-1) !== child) { terminal = false; break; }
      } else if (parent.kind === 'IfStatement') {
        if (parent.consequent !== child && parent.alternate !== child) { terminal = false; break; }
      } else if (parent.kind === 'LabeledStatement') {
        if (parent.statement !== child || child.kind !== 'BlockStatement') { terminal = false; break; }
      } else {
        terminal = false; break;
      }
      child = parent;
      parent = parents.get(parent);
    }
    if (!terminal || parent !== target || child !== target.statement) continue;
    const index = starts.get(jump.range?.startOffset);
    if (tokens[index]?.text !== 'break' || tokens[index + 1]?.text !== jump.label
        || tokens[index + 2]?.text !== ';') return unchanged();
    edits.push({start: tokens[index].range.startOffset, end: tokens[index + 2].range.endOffset, text: 'break;'});
  }
  if (!edits.length) return unchanged();
  edits.sort((a, b) => a.start - b.start);
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return {source: output.slice(2, -2), breaksLocalized: edits.length};
}

// A cast of a local reference back to its exact declared type adds neither a
// runtime check nor a different overload type. Prove a unique block-local
// binding and a bare identifier operand (possibly grouped/identity-cast), then
// replace only that cast/operand with the same identifier. Do not infer fields,
// parameters, supertypes, generics, primitive conversions or Object round trips.
function simplifyIdentityReferenceCasts(source, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, castsRemoved: 0,
    ...(retainDiagnostics ? {removedCastTypeRanges: []} : {})});
  const proof = controlCleanupSource(source);
  if (!proof || typeof retainDiagnostics !== 'boolean') return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children} = proof;
  const counts = new Map(), locals = new Map();
  const primitives = new Set(['boolean', 'byte', 'short', 'char', 'int', 'long', 'float', 'double']);
  let refused = false;
  function typeKey(type) {
    if (type?.annotations?.length) return null;
    if (type?.kind === 'ClassType' && !type.typeArguments?.length && !type.enclosingType && type.name !== 'var')
      return (type.packageName ? type.packageName + '.' : '') + type.name;
    if (type?.kind === 'ArrayType' && Number.isInteger(type.dimensions) && type.dimensions > 0) {
      const component = type.componentType?.kind === 'PrimitiveType' && primitives.has(type.componentType.name)
        && !type.componentType.annotations?.length ? type.componentType.name : typeKey(type.componentType);
      return component && component + '[]'.repeat(type.dimensions);
    }
    return null;
  }
  function inspect(node, parent) {
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (['VariableDeclarator', 'FormalParameter'].includes(node.kind))
      counts.set(node.name, (counts.get(node.name) || 0) + 1);
    if (node.kind === 'ExpressionStatement') {
      const expression = node.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(expression?.kind)
          && !(expression?.kind === 'UnaryExpression' && ['++', '--'].includes(expression.operator))) refused = true;
      let end = starts.get(node.range?.startOffset);
      if (end === undefined) refused = true;
      else {
        while (end < tokens.length && tokens[end].text !== ';' && tokens[end].text !== '}') {
          if (closes.has(end)) end = closes.get(end);
          end++;
        }
        if (tokens[end]?.text !== ';') refused = true;
      }
    }
    if (node.kind === 'LocalVariableDeclarationStatement' && parent?.kind === 'BlockStatement') {
      let open = starts.get(parent.range?.startOffset);
      if (open === undefined) {
        const first = starts.get(parent.statements?.[0]?.range?.startOffset);
        if (tokens[first - 1]?.text === '{') open = first - 1;
      }
      const close = closes.get(open);
      let end = starts.get(node.range?.startOffset);
      if (tokens[open]?.text === '{' && tokens[close]?.text === '}' && end !== undefined) {
        while (end < close && tokens[end].text !== ';') {
          if (closes.has(end)) end = closes.get(end);
          end++;
        }
        if (tokens[end]?.text !== ';') refused = true;
        else for (const variable of node.declarators) {
          const type = !node.annotations?.length && typeKey(node.variableType);
          locals.set(variable.name, {start: end + 1, end: close,
            type: type && type + '[]'.repeat(variable.dimensions || 0)});
        }
      } else refused = true;
    }
    children(node, child => inspect(child, node));
  }
  inspect(parsed, null);
  if (refused) return unchanged();
  function spelling(open, close) {
    let index = open + 1;
    const primitive = primitives.has(tokens[index]?.text);
    if (!primitive && tokens[index]?.kind !== 'identifier') return null;
    index++;
    if (!primitive) while (tokens[index]?.text === '.' && tokens[index + 1]?.kind === 'identifier') index += 2;
    let dimensions = 0;
    while (tokens[index]?.text === '[' && tokens[index + 1]?.text === ']') { dimensions++; index += 2; }
    return index === close && (!primitive || dimensions)
      ? tokens.slice(open + 1, close).map(token => token.text).join('') : null;
  }
  function visible(name, index, type) {
    const local = locals.get(name);
    return counts.get(name) === 1 && local?.type === type && index >= local.start && index < local.end;
  }
  function atom(index, depth = 0) {
    if (depth > 128) { refused = true; return null; }
    if (tokens[index]?.kind === 'identifier') return {index, end: index + 1, casts: []};
    if (tokens[index]?.text !== '(') return null;
    const close = closes.get(index);
    if (close === undefined) return null;
    const type = spelling(index, close), operand = type && atom(close + 1, depth + 1);
    if (operand && visible(tokens[operand.index].text, operand.index, type))
      return {...operand, casts: [{open: index, close, type}, ...operand.casts]};
    const inner = atom(index + 1, depth + 1);
    return inner?.end === close ? {...inner, end: close + 1} : null;
  }
  const edits = [], removed = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].text !== '(') continue;
    const close = closes.get(index), type = close !== undefined && spelling(index, close);
    if (!type) continue;
    const operand = atom(close + 1);
    // A postfix operation belongs to the operand, rather than to the cast.
    // Its result can have a different type, even when its receiver is a local.
    if (!operand || ['.', '[', '(', '++', '--', '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']
      .includes(tokens[operand.end]?.text)) continue;
    const name = tokens[operand.index].text;
    if (!visible(name, operand.index, type)) continue;
    const casts = [{open: index, close, type}, ...operand.casts];
    const start = tokens[index].range.startOffset, end = tokens[operand.end - 1].range.endOffset;
    const word = /[\p{ID_Continue}\p{Sc}$]/u;
    edits.push({start, end, text: (word.test(wrapped[start - 1] || '') ? ' ' : '') + name
      + (word.test(wrapped[end] || '') ? ' ' : '')});
    for (const cast of casts) removed.push({start: tokens[cast.open + 1].range.startOffset - 2,
      end: tokens[cast.close - 1].range.endOffset - 2, type: cast.type, localName: name});
    index = operand.end - 1;
  }
  if (refused || !edits.length) return unchanged();
  let output = wrapped;
  for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return {source: output.slice(2, -2), castsRemoved: removed.length,
    ...(retainDiagnostics ? {removedCastTypeRanges: removed} : {})};
}

// A conditional arm may do work before exiting a plain block. When normal
// completion of its containing block also reaches that destination directly,
// the skipped remainder is its existing else arm. Keep the prefix, predicate,
// effect-arm braces and remainder bytes; never move declarations into a new
// scope or cross a loop/switch/try/finally/monitor continuation.
function foldEffectfulPlainBlockExits(source) {
  const unchanged = () => ({source, exitsRecovered: 0});
  const proof = controlCleanupSource(source);
  if (!proof) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  const parents = new Map(), targets = new Map();
  const nondeclaring = new Set(['BlockStatement', 'LabeledStatement', 'IfStatement', ...loops,
    'SwitchStatement', 'TryStatement', 'SynchronizedStatement', 'ExpressionStatement',
    'ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement', 'EmptyStatement', 'AssertStatement']);
  let refused = false;
  function inspect(node, parent, labels = [], loopDepth = 0, breakDepth = 0) {
    parents.set(node, parent);
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      if (node.label) {
        const target = labels.slice().reverse().find(frame => frame.label === node.label);
        if (!target || node.kind === 'ContinueStatement' && !loops.has(target.statement?.kind)) refused = true;
        else targets.set(node, target);
      } else if (!(node.kind === 'ContinueStatement' ? loopDepth : breakDepth)) refused = true;
    }
    if (node.kind === 'ExpressionStatement') {
      const expression = node.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(expression?.kind)
          && !(expression?.kind === 'UnaryExpression' && ['++', '--'].includes(expression.operator))) refused = true;
      let index = starts.get(node.range?.startOffset);
      if (index === undefined) refused = true;
      else {
        while (index < tokens.length && tokens[index].text !== ';' && tokens[index].text !== '}') {
          if (closes.has(index)) index = closes.get(index);
          index++;
        }
        if (tokens[index]?.text !== ';') refused = true;
      }
    }
    children(node, child => inspect(child, node,
      node.kind === 'LabeledStatement' ? [...labels, node] : labels,
      loopDepth + (loops.has(node.kind) ? 1 : 0),
      breakDepth + (loops.has(node.kind) || node.kind === 'SwitchStatement' ? 1 : 0)));
  }
  inspect(parsed, null);
  if (refused || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  function extent(node) {
    const open = starts.get(node.range?.startOffset), close = closes.get(open);
    if (node.kind !== 'BlockStatement' || tokens[open]?.text !== '{' || tokens[close]?.text !== '}') return null;
    if (!node.statements.length ? close !== open + 1
      : starts.get(node.statements[0].range?.startOffset) !== open + 1
        || node.statements.some(statement => {
          const start = starts.get(statement.range?.startOffset); return !(start > open && start < close);
        })) return null;
    return {open, close};
  }
  function reaches(block, target) {
    if (target?.statement?.kind !== 'BlockStatement' || !extent(target.statement)) return false;
    let child = block, parent = parents.get(child);
    while (parent && parent !== target) {
      if (parent.kind === 'BlockStatement') {
        if (!extent(parent) || parent.statements.at(-1) !== child) return false;
      } else if (parent.kind === 'IfStatement') {
        if (parent.consequent !== child && parent.alternate !== child) return false;
      } else if (parent.kind === 'LabeledStatement') {
        if (parent.statement !== child || child.kind !== 'BlockStatement') return false;
      } else return false;
      child = parent; parent = parents.get(parent);
    }
    return parent === target && child === target.statement;
  }
  function referencesTarget(node, target) {
    if (targets.get(node) === target) return true;
    let found = false; children(node, child => { if (referencesTarget(child, target)) found = true; });
    return found;
  }
  function find(node) {
    const block = extent(node);
    if (block) for (let index = 0; index < node.statements.length - 1; index++) {
      const guard = node.statements[index], effect = guard.consequent;
      if (guard.kind !== 'IfStatement' || guard.alternate || effect?.kind !== 'BlockStatement'
          || effect.statements.length < 2) continue;
      const jump = effect.statements.at(-1), target = targets.get(jump);
      if (jump.kind !== 'BreakStatement' || !jump.label || !reaches(node, target)
          || effect.statements.slice(0, -1).some(statement => referencesTarget(statement, target))) continue;
      const remainder = node.statements.slice(index + 1);
      if (!remainder.every(statement => nondeclaring.has(statement.kind)
          && !(statement.kind === 'LabeledStatement' && !nondeclaring.has(statement.statement.kind)))) continue;
      const arm = extent(effect), start = starts.get(guard.range?.startOffset), conditionEnd = closes.get(start + 1);
      const jumpStart = starts.get(jump.range?.startOffset), restStart = starts.get(remainder[0].range?.startOffset);
      const labelStart = starts.get(target.range?.startOffset);
      if (!arm || tokens[start]?.text !== 'if' || tokens[start + 1]?.text !== '('
          || conditionEnd === undefined || conditionEnd + 1 !== arm.open
          || tokens[jumpStart]?.text !== 'break' || tokens[jumpStart + 1]?.text !== jump.label
          || tokens[jumpStart + 2]?.text !== ';' || arm.close !== jumpStart + 3
          || restStart !== arm.close + 1 || tokens[labelStart]?.text !== target.label
          || tokens[labelStart + 1]?.text !== ':') continue;
      // Only this suffix is replaced. Discovery chooses one candidate per
      // call, so nested suffixes cannot overlap or duplicate one another.
      const head = wrapped.slice(tokens[start].range.startOffset, tokens[jumpStart].range.startOffset);
      const gap = wrapped.slice(tokens[jumpStart + 2].range.endOffset, tokens[arm.close].range.startOffset);
      const rest = wrapped.slice(tokens[arm.close].range.endOffset, tokens[block.close].range.startOffset);
      const prefix = wrapped.slice(wrapped.lastIndexOf('\n', tokens[start].range.startOffset - 1) + 1,
        tokens[start].range.startOffset);
      const multiline = /^[ \t]*$/.test(prefix) && head.includes('\n') && rest.includes('\n');
      if (multiline) {
        const effectLines = head.split('\n');
        if (!effectLines.at(-1).trim() && !gap.trim()) effectLines.pop();
        const restLines = rest.split('\n');
        if (!restLines.at(-1).trim()) restLines.pop();
        const indented = restLines.map(line => line.trim() ? '  ' + line : line).join('\n');
        return {start: tokens[start].range.startOffset, end: tokens[block.close].range.startOffset,
          text: effectLines.join('\n') + '\n' + prefix + '} else {' + indented + '\n' + prefix + '}\n'
            + wrapped.slice(wrapped.lastIndexOf('\n', tokens[block.close].range.startOffset - 1) + 1,
              tokens[block.close].range.startOffset)};
      }
      return {start: tokens[start].range.startOffset, end: tokens[block.close].range.startOffset,
        text: head + (!gap.trim() && /\s$/.test(head) ? '' : gap) + '} else {' + rest + '} '};
    }
    let result; children(node, child => { if (!result) result = find(child); }); return result;
  }
  const edit = find(parsed);
  if (!edit) return unchanged();
  const output = wrapped.slice(0, edit.start) + edit.text + wrapped.slice(edit.end);
  return {source: output.slice(2, -2), exitsRecovered: 1};
}

// A direct first-statement loop exit is the loop's existing entry condition.
// Keep its expression verbatim under logical negation, so effects, unboxing and
// NaNs retain their original evaluation. Require a definitely nonconstant
// expression: replacing a constant if with a while condition can invalidate
// Java reachability (JLS 14.21/15.28). Caller-supplied parameter names identify
// actual emitted formal parameters, never inferred fields or free identifiers.
function foldLeadingWhileBreakGuards(source, {parameterNames = []} = {}) {
  const unchanged = () => ({source, guardsRecovered: 0});
  if (!Array.isArray(parameterNames) || new Set(parameterNames).size !== parameterNames.length
      || parameterNames.some(name => typeof name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))) return unchanged();
  const proof = controlCleanupSource(source);
  if (!proof) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  let refused = false;
  function inspect(node, labels = [], loopDepth = 0, breakDepth = 0) {
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      if (node.label) {
        const target = labels.slice().reverse().find(frame => frame.label === node.label);
        if (!target || node.kind === 'ContinueStatement' && !loops.has(target.statement?.kind)) refused = true;
      } else if (!(node.kind === 'ContinueStatement' ? loopDepth : breakDepth)) refused = true;
    }
    if (node.kind === 'ExpressionStatement') {
      const expression = node.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(expression?.kind)
          && !(expression?.kind === 'UnaryExpression' && ['++', '--'].includes(expression.operator))) refused = true;
      let index = starts.get(node.range?.startOffset);
      if (index === undefined) refused = true;
      else {
        while (index < tokens.length && tokens[index].text !== ';' && tokens[index].text !== '}') {
          if (closes.has(index)) index = closes.get(index);
          index++;
        }
        if (tokens[index]?.text !== ';') refused = true;
      }
    }
    children(node, child => inspect(child,
      node.kind === 'LabeledStatement' ? [...labels, node] : labels,
      loopDepth + (loops.has(node.kind) ? 1 : 0),
      breakDepth + (loops.has(node.kind) || node.kind === 'SwitchStatement' ? 1 : 0)));
  }
  inspect(parsed);
  if (refused || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  function nonconstant(node, scope) {
    if (node.kind === 'Identifier') return scope.get(node.name) === true;
    if (node.kind === 'LiteralExpression') return node.literalKind === 'null';
    if (['MethodInvocationExpression', 'AssignmentExpression', 'ArrayAccessExpression',
      'NewClassExpression', 'NewArrayExpression'].includes(node.kind)) return true;
    if (node.kind === 'UnaryExpression' && ['++', '--'].includes(node.operator)) return true;
    // The parser also uses field access for qualified constant names. A local
    // elsewhere in a chain must not stand in for proof about the field itself.
    if (node.kind === 'FieldAccessExpression') return false;
    let proven = false;
    children(node, child => { if (nonconstant(child, scope)) proven = true; });
    return proven;
  }
  function remember(declaration, scope) {
    if (declaration?.kind !== 'LocalVariableDeclarationStatement') return;
    const dynamic = !declaration.modifiers?.some(modifier => modifier.name === 'final');
    for (const variable of declaration.declarators) scope.set(variable.name, dynamic);
  }
  const edits = [];
  function visit(node, scope) {
    if (node.kind === 'BlockStatement') {
      const nested = new Map(scope);
      for (const statement of node.statements) {
        visit(statement, nested);
        remember(statement, nested);
      }
      return;
    }
    if (node.kind === 'ForStatement') {
      const nested = new Map(scope); remember(node.initializer, nested);
      children(node, child => visit(child, nested)); return;
    }
    if (node.kind === 'EnhancedForStatement' || node.kind === 'CatchClause') {
      const nested = new Map(scope);
      // Parameters have no constant-expression initializer, including final
      // catch/enhanced-for parameters. Their scope ends with this body.
      if (node.parameter?.name) nested.set(node.parameter.name, true);
      visit(node.body, nested); return;
    }
    if (node.kind === 'TryStatement') {
      const nested = new Map(scope);
      for (const resource of node.resources || []) remember(resource, nested);
      visit(node.block, nested);
      for (const handler of node.catches || []) visit(handler, scope);
      if (node.finallyBlock) visit(node.finallyBlock, scope);
      return;
    }
    if (node.kind === 'WhileStatement' && node.condition?.kind === 'LiteralExpression'
        && node.condition.value === true && node.body?.kind === 'BlockStatement') {
      const guard = node.body.statements[0];
      const jump = guard?.consequent?.kind === 'BlockStatement' && guard.consequent.statements.length === 1
        ? guard.consequent.statements[0] : guard?.consequent;
      if (guard?.kind === 'IfStatement' && !guard.alternate && jump?.kind === 'BreakStatement'
          && !jump.label && nonconstant(guard.condition, scope)) {
        const start = starts.get(node.range?.startOffset), open = start + 4, end = closes.get(open);
        const first = starts.get(guard.range?.startOffset), conditionEnd = closes.get(first + 1);
        if (tokens[start]?.text !== 'while' || tokens[start + 1]?.text !== '('
            || tokens[start + 2]?.text !== 'true' || tokens[start + 3]?.text !== ')'
            || tokens[open]?.text !== '{' || tokens[end]?.text !== '}' || first !== open + 1
            || tokens[first]?.text !== 'if' || tokens[first + 1]?.text !== '(' || conditionEnd === undefined) {
          refused = true; return;
        }
        const braced = guard.consequent.kind === 'BlockStatement';
        const jumpStart = conditionEnd + (braced ? 2 : 1), guardEnd = jumpStart + (braced ? 2 : 1);
        if (tokens[jumpStart]?.text !== 'break' || tokens[jumpStart + 1]?.text !== ';'
            || starts.get(jump.range?.startOffset) !== jumpStart
            || braced && (tokens[conditionEnd + 1]?.text !== '{' || closes.get(conditionEnd + 1) !== guardEnd)
            || node.body.statements.length > 1 && starts.get(node.body.statements[1].range?.startOffset) !== guardEnd + 1
            || node.body.statements.length === 1 && end !== guardEnd + 1) {
          refused = true; return;
        }
        const expression = wrapped.slice(tokens[first + 1].range.endOffset, tokens[conditionEnd].range.startOffset);
        edits.push({start: tokens[start].range.startOffset, end: tokens[guardEnd].range.endOffset,
          text: 'while (!(' + expression + ')) {'});
      }
    }
    children(node, child => visit(child, scope));
  }
  visit(parsed, new Map(parameterNames.map(name => [name, true])));
  if (refused || !edits.length) return unchanged();
  edits.sort((a, b) => a.start - b.start);
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return {source: output.slice(2, -2), guardsRecovered: edits.length};
}

// Simplify Java's existing transfer destinations, never infer new CFG edges.
// A labeled loop jump can lose its label only when the corresponding unlabeled
// jump would bind to the exact same AST loop/switch. Plain frames may disappear
// only if no jump needs them and no declaration gains a larger lexical scope.
function simplifyControlFrames(source) {
  const unchanged = () => ({source, labelsRemoved: 0, jumpsUnlabeled: 0, blocksUnwrapped: 0});
  const proof = controlCleanupSource(source);
  if (!proof) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  const nondeclaring = new Set(['BlockStatement', 'LabeledStatement', 'IfStatement',
    ...loops, 'SwitchStatement', 'TryStatement', 'SynchronizedStatement', 'ExpressionStatement',
    'ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement', 'EmptyStatement', 'AssertStatement']);
  const parents = new Map(), frames = new Map(), edits = [], removedFrames = new Set();
  const blocks = [];
  let refused = false, jumpsUnlabeled = 0, blocksUnwrapped = 0;
  function walk(node, parent, labels = [], loopStack = [], breakStack = []) {
    parents.set(node, parent);
    // A nested Java executable body has its own transfer namespace. Keep such
    // methods intact rather than accidentally treating its loops as enclosing.
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) {
      refused = true;
      return;
    }
    if (node.kind === 'BlockStatement') blocks.push(node);
    if (node.kind === 'LabeledStatement') {
      const frame = {node, target: node.statement, references: []};
      frames.set(node, frame);
      children(node, child => walk(child, node, [...labels, frame], loopStack, breakStack));
      return;
    }
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind) && node.label) {
      const frame = labels.slice().reverse().find(item => item.node.label === node.label);
      if (!frame) {refused = true;return;}
      const nearest = node.kind === 'ContinueStatement' ? loopStack.at(-1) : breakStack.at(-1);
      const same = (loops.has(frame.target.kind) || node.kind === 'BreakStatement' && frame.target.kind === 'SwitchStatement')
        && nearest === frame.target && labelCounts.get(node.label) === 1;
      frame.references.push({node, same});
      if (same) {
        const index = starts.get(node.range?.startOffset);
        const keyword = node.kind === 'BreakStatement' ? 'break' : 'continue';
        if (tokens[index]?.text !== keyword || tokens[index + 1]?.text !== node.label || tokens[index + 2]?.text !== ';') {
          refused = true;return;
        }
        const start = tokens[index].range.endOffset, end = tokens[index + 2].range.startOffset;
        // Keep unusual line layout intact. Ordinary generated jumps become
        // `break;`/`continue;`; both forms retain the same exception/lock exits.
        const text = wrapped.slice(start, end).replace(node.label, '');
        edits.push(!text.trim() && !text.includes('\n') ? {start, end}
          : {start:tokens[index + 1].range.startOffset, end:tokens[index + 1].range.endOffset});
        jumpsUnlabeled++;
      }
    }
    const nestedLoops = loops.has(node.kind) ? [...loopStack, node] : loopStack;
    const nestedBreaks = loops.has(node.kind) || node.kind === 'SwitchStatement' ? [...breakStack, node] : breakStack;
    children(node, child => walk(child, node, labels, nestedLoops, nestedBreaks));
  }
  walk(parsed, null);
  if (refused) return unchanged();
  for (const frame of frames.values()) {
    if (labelCounts.get(frame.node.label) !== 1 || frame.references.some(reference => !reference.same)) continue;
    const index = starts.get(frame.node.range?.startOffset);
    if (tokens[index]?.text !== frame.node.label || tokens[index + 1]?.text !== ':') return unchanged();
    let end = tokens[index + 1].range.endOffset;
    while (wrapped[end] === ' ' || wrapped[end] === '\t') end++;
    edits.push({start:tokens[index].range.startOffset, end});
    removedFrames.add(frame.node);
  }
  const lines = wrapped.split('\n'), lineStarts = [];
  let offset = 0;
  for (const line of lines) {lineStarts.push(offset);offset += line.length + 1;}
  const lineAt = position => {
    let lower = 0, upper = lineStarts.length;
    while (lower + 1 < upper) {
      const middle = (lower + upper) >>> 1;
      if (lineStarts[middle] <= position) lower = middle;
      else upper = middle;
    }
    return lower;
  };
  const dedent = new Array(lines.length).fill(0);
  for (const node of blocks) {
    const parent = parents.get(node);
    const direct = parent?.kind === 'BlockStatement' || parent?.kind === 'LabeledStatement'
      && removedFrames.has(parent) && parents.get(parent)?.kind === 'BlockStatement';
    if (!direct || !node.statements.every(statement => nondeclaring.has(statement.kind)
        && !(statement.kind === 'LabeledStatement' && !nondeclaring.has(statement.statement.kind)))) continue;
    const open = starts.get(node.range?.startOffset), close = closes.get(open);
    if (tokens[open]?.text !== '{' || tokens[close]?.text !== '}') continue;
    edits.push({start:tokens[open].range.startOffset,end:tokens[open].range.endOffset},
      {start:tokens[close].range.startOffset,end:tokens[close].range.endOffset});
    blocksUnwrapped++;
    const first = lineAt(tokens[open].range.startOffset), last = lineAt(tokens[close].range.startOffset);
    if (first === last || wrapped.slice(tokens[open].range.endOffset, lineStarts[first] + lines[first].length).trim()
        || wrapped.slice(lineStarts[last], tokens[close].range.startOffset).trim()
        || wrapped.slice(tokens[close].range.endOffset, lineStarts[last] + lines[last].length).trim()) continue;
    const indent = /^[ \t]*/.exec(lines[first])[0].length;
    const interior = lines.slice(first + 1, last).filter(line => line.trim());
    const width = interior.length ? Math.max(0, Math.min(...interior.map(line => /^[ \t]*/.exec(line)[0].length)) - indent) : 0;
    for (let line = first + 1; line < last; line++) dedent[line] += width;
  }
  if (!edits.length) return unchanged();
  edits.sort((a,b) => a.start - b.start);
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  const byLine = new Map();
  for (const edit of edits) {
    const line = lineAt(edit.start);
    if (lineAt(edit.end - 1) !== line) return unchanged();
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push(edit);
  }
  const result = [];
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    for (const edit of (byLine.get(index) || []).slice().reverse())
      line = line.slice(0, edit.start - lineStarts[index]) + line.slice(edit.end - lineStarts[index]);
    if (byLine.has(index) && !line.trim() && lines[index].trim()) continue;
    if (dedent[index]) line = line.slice(Math.min(dedent[index], /^[ \t]*/.exec(line)[0].length));
    result.push(line);
  }
  return {source:result.join('\n').slice(2,-2),labelsRemoved:removedFrames.size,jumpsUnlabeled,blocksUnwrapped};
}

// A forward exit used only to select a literal boolean is a short-circuit
// decision. Keep every predicate in its original evaluation order and scope;
// only the leaf literal stores and their consumed block breaks disappear.
function foldLabeledBooleanDecisions(source) {
  const unchanged = () => ({source, decisions: 0, literalStoresRemoved: 0});
  const proof = controlCleanupSource(source);
  if (!proof) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const parents = new Map(), declarations = new Map(), booleanLocals = new Map(), frames = [];
  let refused = false;
  function inspect(node, parent) {
    parents.set(node, parent);
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (['VariableDeclarator', 'FormalParameter'].includes(node.kind))
      declarations.set(node.name, (declarations.get(node.name) || 0) + 1);
    if (node.kind === 'LocalVariableDeclarationStatement' && parent?.kind === 'BlockStatement'
        && node.variableType?.kind === 'PrimitiveType' && node.variableType.name === 'boolean') {
      for (const variable of node.declarators)
        if (!variable.dimensions) booleanLocals.set(variable.name, {node, block: parent});
    }
    if (node.kind === 'LabeledStatement' && node.statement?.kind === 'BlockStatement') frames.push(node);
    children(node, child => inspect(child, node));
  }
  inspect(parsed, null);
  if (refused) return unchanged();
  function literalAssignment(node) {
    const expression = node?.kind === 'ExpressionStatement' && node.expression;
    if (expression?.kind !== 'AssignmentExpression' || expression.operator !== '='
        || expression.left?.kind !== 'Identifier' || expression.right?.kind !== 'LiteralExpression'
        || expression.right.literalKind !== 'boolean') return null;
    const index = starts.get(node.range?.startOffset), name = expression.left.name;
    const value = expression.right.value;
    if (tokens[index]?.text !== name || tokens[index + 1]?.text !== '='
        || tokens[index + 2]?.text !== String(value) || tokens[index + 3]?.text !== ';') return null;
    return {name, value, index, end: tokens[index + 3].range.endOffset};
  }
  function visibleLocal(name, statement) {
    if (declarations.get(name) !== 1 || !booleanLocals.has(name)) return false;
    const local = booleanLocals.get(name);
    if (!(local.node.range?.startOffset < statement.range?.startOffset)) return false;
    for (let node = parents.get(statement); node; node = parents.get(node)) if (node === local.block) return true;
    return false;
  }
  const edits = [];
  let literalStoresRemoved = 0;
  for (const frame of frames) {
    if (labelCounts.get(frame.label) !== 1) continue;
    const statements = frame.statement.statements, fallback = literalAssignment(statements.at(-1));
    if (!fallback) continue;
    let first = statements.length - 1;
    while (first && statements[first - 1].kind === 'IfStatement') first--;
    if (first === statements.length - 1 || !visibleLocal(fallback.name, statements[first])) continue;
    let stores = 0, predicateTokens = 0;
    function decision(sequence) {
      if (sequence.length === 1 && sequence[0]?.kind === 'BlockStatement') return decision(sequence[0].statements);
      if (sequence.length === 2) {
        const assignment = literalAssignment(sequence[0]), jump = sequence[1];
        const index = starts.get(jump?.range?.startOffset);
        if (assignment?.name === fallback.name && assignment.value === !fallback.value
            && jump.kind === 'BreakStatement' && jump.label === frame.label
            && tokens[index]?.text === 'break' && tokens[index + 1]?.text === frame.label
            && tokens[index + 2]?.text === ';') {
          stores++;
          return {kind: 'constant'};
        }
      }
      if (!sequence.length || !sequence.every(node => node.kind === 'IfStatement' && !node.alternate)) return null;
      const alternatives = [];
      for (const node of sequence) {
        const index = starts.get(node.range?.startOffset), close = closes.get(index + 1);
        if (tokens[index]?.text !== 'if' || tokens[index + 1]?.text !== '(' || close === undefined) return null;
        predicateTokens += close - index - 2;
        if (predicateTokens > 256) return null;
        const text = wrapped.slice(tokens[index + 1].range.endOffset, tokens[close].range.startOffset);
        const body = node.consequent?.kind === 'BlockStatement' ? node.consequent.statements : [node.consequent];
        const taken = decision(body);
        if (!taken || stores > 12) return null;
        const leaf = {kind: 'predicate', text, condition: node.condition};
        alternatives.push(taken.kind === 'constant' ? leaf : {kind: 'and', children: [leaf, taken]});
      }
      return alternatives.length === 1 ? alternatives[0] : {kind: 'or', children: alternatives};
    }
    const tree = decision(statements.slice(first, -1));
    if (!tree || !stores) continue;
    function render(node, inverted) {
      if (node.kind === 'predicate') {
        // A condition is already a Java boolean context. Removing one leading
        // logical negation therefore preserves primitive/unboxing behavior.
        if (inverted && node.condition?.kind === 'UnaryExpression' && node.condition.operator === '!'
            && node.condition.prefix && /^\s*!/.test(node.text)) return `(${node.text.replace(/^(\s*)!/, '$1')})`;
        return inverted ? `!(${node.text})` : `(${node.text})`;
      }
      const operator = (node.kind === 'and') !== inverted ? ' && ' : ' || ';
      const operands = [];
      function collect(child) {
        if (child.kind === node.kind) child.children.forEach(collect);
        else operands.push(child);
      }
      node.children.forEach(collect);
      return `(${operands.map(child => render(child, inverted)).join(operator)})`;
    }
    let expression = render(tree, fallback.value);
    if (tree.kind !== 'predicate') expression = expression.slice(1, -1);
    edits.push({start: statements[first].range.startOffset, end: fallback.end,
      text: `${fallback.name} = ${expression};`});
    literalStoresRemoved += stores;
  }
  edits.sort((a,b) => a.start - b.start);
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.slice().reverse()) output = output.slice(0,edit.start) + edit.text + output.slice(edit.end);
  return {source:output.slice(2,-2),decisions:edits.length,literalStoresRemoved};
}

// A declaration-free chain of braced ifs with no alternate performs exactly
// the same left-to-right short circuit as &&. Keep the innermost block and all
// predicate bytes: no expression, declaration or protected boundary moves.
function foldNestedIfGuards(source) {
  const unchanged = () => ({source, guardsFolded: 0, conditionsMerged: 0});
  const proof = controlCleanupSource(source);
  if (!proof) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children} = proof;
  let refused = false;
  function inspect(node) {
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (node.kind === 'ExpressionStatement') {
      const expression = node.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(expression?.kind)
          && !(expression?.kind === 'UnaryExpression' && ['++','--'].includes(expression.operator))) refused = true;
      let index = starts.get(node.range?.startOffset);
      if (index === undefined) refused = true;
      else {
        while (index < tokens.length && tokens[index].text !== ';' && tokens[index].text !== '}') {
          if (closes.has(index)) index = closes.get(index);
          index++;
        }
        if (tokens[index]?.text !== ';') refused = true;
      }
    }
    children(node, inspect);
  }
  inspect(parsed);
  if (refused) return unchanged();
  function header(node) {
    const start = starts.get(node.range?.startOffset), close = closes.get(start + 1);
    if (node.kind !== 'IfStatement' || node.alternate || node.consequent?.kind !== 'BlockStatement'
        || tokens[start]?.text !== 'if' || tokens[start + 1]?.text !== '(' || close === undefined
        || tokens[close + 1]?.text !== '{' || closes.get(close + 1) === undefined) return null;
    return {node, start, close, open: close + 1, end: closes.get(close + 1),
      text: wrapped.slice(tokens[start + 1].range.endOffset, tokens[close].range.startOffset),
      weight: close - start - 2};
  }
  function indentation(position) {
    const start = wrapped.lastIndexOf('\n', position - 1) + 1;
    const prefix = wrapped.slice(start, position);
    return /^[ \t]*$/.test(prefix) ? prefix : null;
  }
  const edits = [];
  let conditionsMerged = 0;
  function find(node) {
    const first = header(node);
    if (first) {
      const chain = [first];
      for (;;) {
        const statements = chain.at(-1).node.consequent.statements;
        if (statements.length !== 1) break;
        const next = header(statements[0]);
        if (!next) break;
        chain.push(next);
      }
      if (chain.length > 1) {
        // Oversized chains remain intact; do not fold a suffix merely to get
        // around the predicate/operand budget.
        if (chain.length > 16 || chain.reduce((sum, part) => sum + part.weight, 0) > 512) return;
        const last = chain.at(-1), start = tokens[first.start].range.startOffset;
        const outerIndent = indentation(start), innerIndent = indentation(tokens[last.start].range.startOffset);
        const separator = outerIndent === null || innerIndent === null ? ' && ' : ` &&\n${outerIndent}    `;
        const predicate = chain.map(part => `(${part.text})`).join(separator);
        let body = wrapped.slice(tokens[last.open].range.startOffset, tokens[last.end].range.endOffset);
        // Whitespace-only dedenting is independent of semantic reconstruction.
        // Preserve compact/unusual layouts and the bytes of every Java token.
        if (outerIndent !== null && innerIndent !== null && innerIndent.startsWith(outerIndent)) {
          const excess = innerIndent.length - outerIndent.length;
          const lines = body.split('\n');
          body = lines.map((line, index) => index && /^[ \t]*$/.test(line.slice(0, excess))
            && line.length >= excess ? line.slice(excess) : line).join('\n');
        }
        edits.push({start, end: tokens[first.end].range.endOffset, text: `if (${predicate}) ${body}`});
        conditionsMerged += chain.length - 1;
        return;
      }
    }
    children(node, find);
  }
  find(parsed);
  if (!edits.length) return unchanged();
  edits.sort((a,b) => a.start - b.start);
  if (edits.some((edit,index) => index && edits[index-1].end > edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return {source: output.slice(2,-2), guardsFolded: edits.length, conditionsMerged};
}

// A plain labeled block can encode a sequence of skip guards. When every
// reference to its unique label is exactly one of those leading bare breaks,
// negate their original predicates and retain the remainder's block scope.
// No declaration, effect or protected boundary moves across the new guard.
function foldLabeledSkipGuards(source) {
  const unchanged = () => ({source, framesRemoved: 0, guardJumpsRemoved: 0});
  const proof = controlCleanupSource(source);
  if (!proof) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const references = new Map();
  let refused = false;
  function inspect(node,labels=[]) {
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (['BreakStatement','ContinueStatement'].includes(node.kind) && node.label) {
      const target=labels.slice().reverse().find(frame=>frame.label===node.label);
      if (!target || node.kind==='ContinueStatement' && !['WhileStatement','ForStatement','EnhancedForStatement','DoWhileStatement'].includes(target.statement?.kind)) refused=true;
      if (!references.has(node.label)) references.set(node.label,[]);
      references.get(node.label).push(node);
    }
    if (node.kind === 'ExpressionStatement') {
      const expression = node.expression;
      if (!['AssignmentExpression','MethodInvocationExpression','NewClassExpression'].includes(expression?.kind)
          && !(expression?.kind === 'UnaryExpression' && ['++','--'].includes(expression.operator))) refused = true;
      let index = starts.get(node.range?.startOffset);
      if (index === undefined) refused = true;
      else {
        while (index < tokens.length && tokens[index].text !== ';' && tokens[index].text !== '}') {
          if (closes.has(index)) index = closes.get(index);
          index++;
        }
        if (tokens[index]?.text !== ';') refused = true;
      }
    }
    children(node,child=>inspect(child,node.kind==='LabeledStatement'?[...labels,node]:labels));
  }
  inspect(parsed);
  if (refused) return unchanged();
  function guard(node,label) {
    const start = starts.get(node.range?.startOffset), close = closes.get(start+1);
    const statements = node.consequent?.statements;
    if (node.kind !== 'IfStatement' || node.alternate || node.consequent?.kind !== 'BlockStatement'
        || tokens[start]?.text !== 'if' || tokens[start+1]?.text !== '(' || close === undefined
        || tokens[close+1]?.text !== '{' || statements?.length !== 1
        || statements[0].kind !== 'BreakStatement' || statements[0].label !== label) return null;
    const bodyEnd = closes.get(close+1);
    if (bodyEnd !== close+5 || tokens[close+2]?.text !== 'break'
        || tokens[close+3]?.text !== label || tokens[close+4]?.text !== ';') return null;
    return {node,jump:statements[0],start,end:bodyEnd,
      text:wrapped.slice(tokens[start+1].range.endOffset,tokens[close].range.startOffset),
      weight:close-start-2};
  }
  const edits = [];
  let guardJumpsRemoved = 0;
  function find(node) {
    if (node.kind === 'LabeledStatement' && node.statement?.kind === 'BlockStatement'
        && labelCounts.get(node.label) === 1) {
      const start = starts.get(node.range?.startOffset), open = start+2, end = closes.get(open);
      if (tokens[start]?.text !== node.label || tokens[start+1]?.text !== ':'
          || tokens[open]?.text !== '{' || tokens[end]?.text !== '}') return;
      const statements = node.statement.statements, guards = [];
      for (const statement of statements) {
        const part = guard(statement,node.label);
        if (!part) break;
        guards.push(part);
      }
      if (guards.length && guards.length < statements.length
          && references.get(node.label)?.length === guards.length
          && references.get(node.label).every(reference => guards.some(part => part.jump === reference))) {
        if (guards.length > 16 || guards.reduce((sum,part)=>sum+part.weight,0) > 512) return;
        const rest = starts.get(statements[guards.length].range?.startOffset);
        if (guards[0].start !== open+1 || rest !== guards.at(-1).end+1
            || guards.some((part,index)=>index && part.start !== guards[index-1].end+1)) return;
        const prefix = wrapped.slice(wrapped.lastIndexOf('\n',tokens[start].range.startOffset-1)+1,tokens[start].range.startOffset);
        const indent = /^[ \t]*$/.test(prefix) ? prefix : null;
        const multiline=wrapped.slice(tokens[start].range.startOffset,tokens[guards.at(-1).end].range.endOffset).includes('\n');
        const separator = indent === null || !multiline ? ' && ' : ' &&\n'+indent+'    ';
        const predicate = guards.map(part=>'!('+part.text+')').join(separator);
        const restBytes = wrapped.slice(tokens[guards.at(-1).end].range.endOffset,tokens[end].range.endOffset);
        edits.push({start:tokens[start].range.startOffset,end:tokens[end].range.endOffset,
          text:'if ('+predicate+') {'+restBytes});
        guardJumpsRemoved += guards.length;
        return;
      }
    }
    children(node,find);
  }
  find(parsed);
  if (!edits.length) return unchanged();
  edits.sort((a,b)=>a.start-b.start);
  if (edits.some((edit,index)=>index && edits[index-1].end>edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.slice().reverse()) output = output.slice(0,edit.start)+edit.text+output.slice(edit.end);
  return {source:output.slice(2,-2),framesRemoved:edits.length,guardJumpsRemoved};
}

// A direct conditional branch ending in the only break to a plain block has
// an existing alternate: every following statement in that block. Keep both
// branches and the enclosing declaration scope, replacing only the transfer.
function foldLabeledIfElseExits(source) {
  const unchanged = () => ({source, framesRemoved: 0, jumpsRemoved: 0, guardsRecovered: 0});
  const proof = controlCleanupSource(source);
  if (!proof) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const references = new Map(), loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  let refused = false;
  function inspect(node, labels = [], loopDepth = 0, breakDepth = 0) {
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      if (node.label) {
        const target = labels.slice().reverse().find(frame => frame.label === node.label);
        if (!target || node.kind === 'ContinueStatement' && !loops.has(target.statement?.kind)) refused = true;
        if (!references.has(node.label)) references.set(node.label, []);
        references.get(node.label).push(node);
      } else if (!(node.kind === 'ContinueStatement' ? loopDepth : breakDepth)) refused = true;
    }
    if (node.kind === 'ExpressionStatement') {
      const expression = node.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(expression?.kind)
          && !(expression?.kind === 'UnaryExpression' && ['++', '--'].includes(expression.operator))) refused = true;
      let index = starts.get(node.range?.startOffset);
      if (index === undefined) refused = true;
      else {
        while (index < tokens.length && tokens[index].text !== ';' && tokens[index].text !== '}') {
          if (closes.has(index)) index = closes.get(index);
          index++;
        }
        if (tokens[index]?.text !== ';') refused = true;
      }
    }
    children(node, child => inspect(child,
      node.kind === 'LabeledStatement' ? [...labels, node] : labels,
      loopDepth + (loops.has(node.kind) ? 1 : 0),
      breakDepth + (loops.has(node.kind) || node.kind === 'SwitchStatement' ? 1 : 0)));
  }
  inspect(parsed);
  if (refused || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  function blockExtent(node) {
    const open = starts.get(node.range?.startOffset), close = closes.get(open);
    return node.kind === 'BlockStatement' && tokens[open]?.text === '{' && tokens[close]?.text === '}'
      && (!node.statements.length ? close === open + 1
        : starts.get(node.statements[0].range?.startOffset) === open + 1
          && node.statements.every(statement => {
            const start = starts.get(statement.range?.startOffset);
            return start > open && start < close;
          })) ? {open, close} : null;
  }
  const edits = [];
  let guardsRecovered = 0;
  function find(node) {
    if (node.kind === 'LabeledStatement' && node.statement?.kind === 'BlockStatement'
        && references.get(node.label)?.length === 1) {
      const frame = blockExtent(node.statement), start = starts.get(node.range?.startOffset);
      if (!frame || tokens[start]?.text !== node.label || tokens[start + 1]?.text !== ':' || start + 2 !== frame.open) return;
      const statements = node.statement.statements;
      for (let index = 0; index < statements.length - 1; index++) {
        const branch = statements[index], body = branch.consequent;
        if (branch.kind !== 'IfStatement' || branch.alternate || body?.kind !== 'BlockStatement') continue;
        const extent = blockExtent(body), jump = body.statements.at(-1);
        if (!extent || jump?.kind !== 'BreakStatement' || jump.label !== node.label
            || references.get(node.label)[0] !== jump) continue;
        const branchStart = starts.get(branch.range?.startOffset), headerEnd = closes.get(branchStart + 1);
        const jumpStart = starts.get(jump.range?.startOffset), rest = starts.get(statements[index + 1].range?.startOffset);
        if (tokens[branchStart]?.text !== 'if' || tokens[branchStart + 1]?.text !== '(' || headerEnd === undefined
            || headerEnd + 1 !== extent.open || rest !== extent.close + 1
            || tokens[jumpStart]?.text !== 'break' || tokens[jumpStart + 1]?.text !== node.label
            || tokens[jumpStart + 2]?.text !== ';' || jumpStart + 3 !== extent.close) continue;
        const prefix = wrapped.slice(wrapped.lastIndexOf('\n', tokens[branchStart].range.startOffset - 1) + 1,
          tokens[branchStart].range.startOffset);
        const indent = /^[ \t]*$/.test(prefix) ? prefix : '';
        const framePrefix = wrapped.slice(wrapped.lastIndexOf('\n', tokens[start].range.startOffset - 1) + 1,
          tokens[start].range.startOffset);
        const frameIndent = /^[ \t]*$/.test(framePrefix) ? framePrefix : '';
        const multiline = wrapped.slice(tokens[start].range.startOffset, tokens[frame.close].range.endOffset).includes('\n');
        const tailBytes = wrapped.slice(tokens[extent.close].range.endOffset, tokens[frame.close].range.startOffset);
        const suffix = multiline && tailBytes.includes('\n')
          ? tailBytes.replace(/\n([ \t]*)(?=\S)/g, '\n  $1').replace(/[ \t]*$/, indent) + '}'
          : tailBytes + '}';
        let replacement;
        if (body.statements.length === 1) {
          const predicate = wrapped.slice(tokens[branchStart + 1].range.endOffset, tokens[headerEnd].range.startOffset);
          replacement = 'if (!(' + predicate + ')) {' + suffix;
          guardsRecovered++;
        } else {
          let jumpOffset = tokens[jumpStart].range.startOffset;
          const lineStart = wrapped.lastIndexOf('\n', jumpOffset - 1) + 1;
          if (!wrapped.slice(lineStart, jumpOffset).trim()
              && !wrapped.slice(tokens[jumpStart + 2].range.endOffset, tokens[extent.close].range.startOffset).trim()) jumpOffset = lineStart;
          const branchBytes = wrapped.slice(tokens[branchStart].range.startOffset, jumpOffset);
          replacement = branchBytes + (multiline ? indent : '') + '} else {' + suffix;
        }
        const prefixBytes = wrapped.slice(tokens[frame.open].range.endOffset, tokens[branchStart].range.startOffset);
        edits.push({start: tokens[start].range.startOffset, end: tokens[frame.close].range.endOffset,
          text: '{' + prefixBytes + replacement + (multiline ? '\n' + frameIndent : '') + '}'});
        return;
      }
    }
    children(node, find);
  }
  find(parsed);
  if (!edits.length) return unchanged();
  edits.sort((a, b) => a.start - b.start);
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return {source: output.slice(2, -2), framesRemoved: edits.length, jumpsRemoved: edits.length, guardsRecovered};
}

// Multiple conditional exits can describe an ordered decision tree. Each
// selected arm must end in a direct break to the same plain destination;
// rebuilding its remaining sequence as an alternate consumes every exit.
function foldLabeledExitTrees(source) {
  const unchanged = () => ({source, framesRemoved: 0, jumpsRemoved: 0, choicesRecovered: 0, guardsRecovered: 0});
  const proof = controlCleanupSource(source);
  if (!proof) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const references = new Map(), loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  let refused = false;
  function inspect(node, labels = [], loopDepth = 0, breakDepth = 0) {
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      if (node.label) {
        const target = labels.slice().reverse().find(frame => frame.label === node.label);
        if (!target || node.kind === 'ContinueStatement' && !loops.has(target.statement?.kind)) refused = true;
        if (!references.has(node.label)) references.set(node.label, []);
        references.get(node.label).push(node);
      } else if (!(node.kind === 'ContinueStatement' ? loopDepth : breakDepth)) refused = true;
    }
    if (node.kind === 'ExpressionStatement') {
      const expression = node.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(expression?.kind)
          && !(expression?.kind === 'UnaryExpression' && ['++', '--'].includes(expression.operator))) refused = true;
      let index = starts.get(node.range?.startOffset);
      if (index === undefined) refused = true;
      else {
        while (index < tokens.length && tokens[index].text !== ';' && tokens[index].text !== '}') {
          if (closes.has(index)) index = closes.get(index);
          index++;
        }
        if (tokens[index]?.text !== ';') refused = true;
      }
    }
    children(node, child => inspect(child,
      node.kind === 'LabeledStatement' ? [...labels, node] : labels,
      loopDepth + (loops.has(node.kind) ? 1 : 0),
      breakDepth + (loops.has(node.kind) || node.kind === 'SwitchStatement' ? 1 : 0)));
  }
  inspect(parsed);
  if (refused || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  function extent(node) {
    const open = starts.get(node.range?.startOffset), close = closes.get(open);
    return node.kind === 'BlockStatement' && tokens[open]?.text === '{' && tokens[close]?.text === '}'
      && (!node.statements.length ? close === open + 1
        : starts.get(node.statements[0].range?.startOffset) === open + 1
          && node.statements.every(statement => {
            const start = starts.get(statement.range?.startOffset);
            return start > open && start < close;
          })) ? {open, close} : null;
  }
  function indentAt(offset) {
    const prefix = wrapped.slice(wrapped.lastIndexOf('\n', offset - 1) + 1, offset);
    return /^[ \t]*$/.test(prefix) ? prefix : '';
  }
  const indentBody = text => text.replace(/\n([ \t]*)(?=\S)/g, '\n  $1');
  const closeBody = (text, indent) => text.includes('\n') ? text.trimEnd() + '\n' + indent + '}' : text + '}';
  function exitToken(node, label, endOffset) {
    const start = starts.get(node?.range?.startOffset);
    return node?.kind === 'BreakStatement' && node.label === label
      && tokens[start]?.text === 'break' && tokens[start + 1]?.text === label && tokens[start + 2]?.text === ';'
      && tokens[start + 2].range.endOffset <= endOffset
      && !wrapped.slice(tokens[start + 2].range.endOffset, endOffset).trim() ? start : null;
  }
  function sequence(statements, begin, end, label, depth, requireExit = false) {
    if (depth > 16) return null;
    let consumed = [], codeEnd = end;
    const trailing = exitToken(statements.at(-1), label, end);
    if (requireExit && trailing === null) return null;
    if (trailing !== null) {
      const offset = tokens[trailing].range.startOffset, line = wrapped.lastIndexOf('\n', offset - 1) + 1;
      codeEnd = !wrapped.slice(line, offset).trim() ? line : offset;
      consumed = [statements.at(-1)]; statements = statements.slice(0, -1);
    }
    for (let index = 0; index < statements.length; index++) {
      const branch = statements[index], body = branch.consequent;
      if (branch.kind !== 'IfStatement' || branch.alternate || body?.kind !== 'BlockStatement') continue;
      const block = extent(body), start = starts.get(branch.range?.startOffset), header = closes.get(start + 1);
      if (!block || tokens[start]?.text !== 'if' || tokens[start + 1]?.text !== '(' || header === undefined
          || header + 1 !== block.open || exitToken(body.statements.at(-1), label, tokens[block.close].range.startOffset) === null) continue;
      const remaining = statements.slice(index + 1);
      if (remaining.length && starts.get(remaining[0].range?.startOffset) !== block.close + 1) return null;
      const selected = sequence(body.statements, tokens[block.open].range.endOffset,
        tokens[block.close].range.startOffset, label, depth + 1, true);
      const fallback = sequence(remaining, tokens[block.close].range.endOffset, codeEnd, label, depth + 1);
      if (!selected || !fallback) return null;
      const prefix = wrapped.slice(begin, tokens[start].range.startOffset), indent = indentAt(tokens[start].range.startOffset);
      let conditional, guards = 0;
      if (body.statements.length === 1 && remaining.length) {
        const predicate = wrapped.slice(tokens[start + 1].range.endOffset, tokens[header].range.startOffset);
        conditional = 'if (!(' + predicate + ')) {' + closeBody(indentBody(fallback.text), indent); guards++;
      } else {
        conditional = wrapped.slice(tokens[start].range.startOffset, tokens[block.open].range.endOffset)
          + closeBody(selected.text, indent);
        if (remaining.length) conditional += fallback.singleChoice
          ? ' else ' + fallback.text.trim()
          : ' else {' + closeBody(indentBody(fallback.text), indent);
      }
      return {text: prefix + conditional, consumed: [...consumed, ...selected.consumed, ...fallback.consumed],
        choices: 1 + selected.choices + fallback.choices, guards: guards + selected.guards + fallback.guards,
        singleChoice: !prefix.trim()};
    }
    return {text: wrapped.slice(begin, codeEnd), consumed, choices: 0, guards: 0, singleChoice: false};
  }
  const edits = [];
  let jumpsRemoved = 0, choicesRecovered = 0, guardsRecovered = 0;
  function find(node) {
    if (node.kind === 'LabeledStatement' && node.statement?.kind === 'BlockStatement') {
      const refs = references.get(node.label), block = extent(node.statement), start = starts.get(node.range?.startOffset);
      if (refs?.length >= 2 && refs.length <= 32 && block && tokens[start]?.text === node.label
          && tokens[start + 1]?.text === ':' && start + 2 === block.open) {
        const rebuilt = sequence(node.statement.statements, tokens[block.open].range.endOffset,
          tokens[block.close].range.startOffset, node.label, 0);
        if (rebuilt && rebuilt.choices > 0 && rebuilt.choices <= 16 && rebuilt.consumed.length === refs.length
            && refs.every(reference => rebuilt.consumed.includes(reference))) {
          const text = '{' + closeBody(rebuilt.text, indentAt(tokens[start].range.startOffset));
          edits.push({start: tokens[start].range.startOffset, end: tokens[block.close].range.endOffset, text});
          jumpsRemoved += rebuilt.consumed.length; choicesRecovered += rebuilt.choices; guardsRecovered += rebuilt.guards;
          return;
        }
      }
    }
    children(node, find);
  }
  find(parsed);
  if (!edits.length) return unchanged();
  edits.sort((a, b) => a.start - b.start);
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return {source: output.slice(2, -2), framesRemoved: edits.length, jumpsRemoved, choicesRecovered, guardsRecovered};
}

// A tree containing only predicates and breaks to one plain destination can
// guard its remainder directly. Preserve predicate evaluation and its nesting
// using short-circuit AND/OR; never guess complementary floating comparisons.
function foldLabeledGuardTrees(source) {
  const unchanged = () => ({source, framesRemoved: 0, jumpsRemoved: 0, guardsRecovered: 0, predicatesRecovered: 0});
  const proof = controlCleanupSource(source);
  if (!proof) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const parents = new Map(), references = new Map(), loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  let refused = false;
  function inspect(node, parent, labels = [], loopDepth = 0, breakDepth = 0) {
    parents.set(node, parent);
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      if (node.label) {
        const target = labels.slice().reverse().find(frame => frame.label === node.label);
        if (!target || node.kind === 'ContinueStatement' && !loops.has(target.statement?.kind)) refused = true;
        if (!references.has(node.label)) references.set(node.label, []);
        references.get(node.label).push(node);
      } else if (!(node.kind === 'ContinueStatement' ? loopDepth : breakDepth)) refused = true;
    }
    if (node.kind === 'ExpressionStatement') {
      const expression = node.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(expression?.kind)
          && !(expression?.kind === 'UnaryExpression' && ['++', '--'].includes(expression.operator))) refused = true;
      let index = starts.get(node.range?.startOffset);
      if (index === undefined) refused = true;
      else {
        while (index < tokens.length && tokens[index].text !== ';' && tokens[index].text !== '}') {
          if (closes.has(index)) index = closes.get(index);
          index++;
        }
        if (tokens[index]?.text !== ';') refused = true;
      }
    }
    children(node, child => inspect(child, node,
      node.kind === 'LabeledStatement' ? [...labels, node] : labels,
      loopDepth + (loops.has(node.kind) ? 1 : 0),
      breakDepth + (loops.has(node.kind) || node.kind === 'SwitchStatement' ? 1 : 0)));
  }
  inspect(parsed, null);
  if (refused || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  function extent(node) {
    const open = starts.get(node?.range?.startOffset), close = closes.get(open);
    return node?.kind === 'BlockStatement' && tokens[open]?.text === '{' && tokens[close]?.text === '}'
      && (!node.statements.length ? close === open + 1
        : starts.get(node.statements[0].range?.startOffset) === open + 1
          && node.statements.every(statement => {
            const start = starts.get(statement.range?.startOffset);
            return start > open && start < close;
          })) ? {open, close} : null;
  }
  const combine = (operator, parts) => {
    const operands = parts.flatMap(part => part.operator === operator ? part.operands : [part]);
    return operands.length === 1 ? operands[0] : {operator, operands};
  };
  function guard(node, label, depth = 0) {
    if (depth > 16) return null;
    if (node.kind === 'BreakStatement' && node.label === label) {
      const start = starts.get(node.range?.startOffset);
      if (tokens[start]?.text !== 'break' || tokens[start + 1]?.text !== label || tokens[start + 2]?.text !== ';') return null;
      return {expression: {stop: true}, jumps: [node], predicates: 0, weight: 0, start, end: start + 2};
    }
    if (node.kind !== 'IfStatement' || node.alternate || node.consequent?.kind !== 'BlockStatement') return null;
    const body = extent(node.consequent), start = starts.get(node.range?.startOffset), header = closes.get(start + 1);
    if (!body || tokens[start]?.text !== 'if' || tokens[start + 1]?.text !== '(' || header === undefined
        || header + 1 !== body.open || !node.consequent.statements.length) return null;
    const parts = node.consequent.statements.map(statement => guard(statement, label, depth + 1));
    if (parts.some(part => !part) || parts.some((part, index) => index && parts[index - 1].end + 1 !== part.start)
        || parts[0].start !== body.open + 1 || parts.at(-1).end + 1 !== body.close) return null;
    // A direct break must be the only statement: any following predicate is
    // unreachable, and mixing stop with an AND would discard that predicate.
    if (parts.some(part => part.expression.stop) && parts.length !== 1) return null;
    const negated = {text: '!(' + wrapped.slice(tokens[start + 1].range.endOffset, tokens[header].range.startOffset) + ')'};
    const nested = combine('&&', parts.map(part => part.expression));
    return {expression: nested.stop ? negated : combine('||', [negated, nested]),
      jumps: parts.flatMap(part => part.jumps), predicates: 1 + parts.reduce((sum, part) => sum + part.predicates, 0),
      weight: header - start - 2 + parts.reduce((sum, part) => sum + part.weight, 0), start, end: body.close};
  }
  function reachesDestination(block, target) {
    let child = block, parent = parents.get(child);
    while (parent && parent !== target) {
      if (parent.kind === 'BlockStatement') {
        if (!extent(parent) || parent.statements.at(-1) !== child) return false;
      } else if (parent.kind === 'IfStatement') {
        if (parent.consequent !== child && parent.alternate !== child) return false;
      } else if (parent.kind === 'LabeledStatement') {
        if (parent.statement !== child || child.kind !== 'BlockStatement') return false;
      } else return false;
      child = parent; parent = parents.get(parent);
    }
    return parent === target && child === target.statement;
  }
  const render = (expression, indent = null) => expression.text || '(' + expression.operands
    .map(part => render(part, indent === null ? null : indent + '  '))
    .join(' ' + expression.operator + (indent === null ? ' ' : '\n' + indent)) + ')';
  const edits = [];
  let framesRemoved = 0, jumpsRemoved = 0, guardsRecovered = 0, predicatesRecovered = 0;
  function find(node) {
    if (node.kind === 'LabeledStatement' && node.statement?.kind === 'BlockStatement') {
      const refs = references.get(node.label), frame = extent(node.statement), start = starts.get(node.range?.startOffset);
      if (refs?.length && refs.length <= 16 && frame && tokens[start]?.text === node.label
          && tokens[start + 1]?.text === ':' && start + 2 === frame.open) {
        const candidates = [];
        function collect(block) {
          const body = extent(block);
          if (body && reachesDestination(block, node)) {
            for (let index = 0; index < block.statements.length - 1; index++) {
              const parts = [];
              for (let next = index; next < block.statements.length - 1; next++) {
                const part = guard(block.statements[next], node.label);
                if (!part || part.expression.stop) break;
                parts.push(part);
              }
              if (!parts.length) continue;
              const rest = starts.get(block.statements[index + parts.length].range?.startOffset);
              if (rest !== parts.at(-1).end + 1
                  || parts.some((part, i) => i && parts[i - 1].end + 1 !== part.start)) continue;
              const offset = tokens[parts[0].start].range.startOffset;
              const prefix = wrapped.slice(wrapped.lastIndexOf('\n', offset - 1) + 1, offset);
              const indent = /^[ \t]*$/.test(prefix) ? prefix : '';
              const tail = wrapped.slice(tokens[parts.at(-1).end].range.endOffset, tokens[body.close].range.startOffset);
              const multiline = tail.includes('\n');
              const closePrefix = wrapped.slice(wrapped.lastIndexOf('\n', tokens[body.close].range.startOffset - 1) + 1,
                tokens[body.close].range.startOffset);
              const closeIndent = /^[ \t]*$/.test(closePrefix) ? closePrefix : '';
              const condition = render(combine('&&', parts.map(part => part.expression)), multiline ? indent + '    ' : null);
              const text = 'if (' + condition + ') {' + (multiline ? tail.replace(/\n([ \t]*)(?=\S)/g, '\n  $1').trimEnd() + '\n' + indent : tail) + '}'
                + (multiline ? '\n' + closeIndent : '');
              candidates.push({start: offset, end: tokens[body.close].range.startOffset, text,
                jumps: parts.flatMap(part => part.jumps), predicates: parts.reduce((sum, part) => sum + part.predicates, 0),
                weight: parts.reduce((sum, part) => sum + part.weight, 0)});
              return;
            }
          }
          children(block, child => collect(child));
        }
        collect(node.statement);
        const consumed = candidates.flatMap(candidate => candidate.jumps);
        if (candidates.length && consumed.length === refs.length && refs.every(reference => consumed.includes(reference))
            && candidates.reduce((sum, candidate) => sum + candidate.predicates, 0) <= 16
            && candidates.reduce((sum, candidate) => sum + candidate.weight, 0) <= 512) {
          edits.push({start: tokens[start].range.startOffset, end: tokens[frame.open].range.startOffset, text: ''}, ...candidates);
          framesRemoved++; jumpsRemoved += consumed.length; guardsRecovered += candidates.length;
          predicatesRecovered += candidates.reduce((sum, candidate) => sum + candidate.predicates, 0);
          return;
        }
      }
    }
    children(node, find);
  }
  find(parsed);
  if (!edits.length) return unchanged();
  edits.sort((a, b) => a.start - b.start);
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return {source: output.slice(2, -2), framesRemoved, jumpsRemoved, guardsRecovered, predicatesRecovered};
}

// A consumed block break immediately followed by a bare return has no work or
// value evaluation left at its destination. Both transfers leave the same
// cleanup regions, even when a finally overrides them. Completion is separate:
// keep the trailing return if the block can fall through, remove it if it
// cannot, and retain the original frame when that proof is unknown.
function foldVoidReturnExits(source) {
  const unchanged = () => ({source, frames: 0, jumpsReturned: 0, tailsRemoved: 0});
  const proof = controlCleanupSource(source);
  if (!proof) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  const parents = new Map(), references = new Map(), entryCleanup = new Map(), blocks = [];
  const names = new Map(), locals = new Map();
  const expressionStarts = new Map();
  let refused = false;
  function walk(node, parent, labels = [], loopStack = [], breakStack = [], cleanup = []) {
    parents.set(node, parent);
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) {
      refused = true;return;
    }
    if (['VariableDeclarator','FormalParameter'].includes(node.kind)) names.set(node.name,(names.get(node.name)||0)+1);
    if (node.condition && ['IfStatement','WhileStatement','ForStatement'].includes(node.kind)) {
      const start=starts.get(node.range?.startOffset),open=start+1,close=closes.get(open);
      if(tokens[open]?.text==='('&&close!==undefined) {
        let first=open+1;
        if(node.kind==='ForStatement') {
          const separators=[];
          for(let token=first;token<close;token++) {
            if(['(','[','{'].includes(tokens[token].text)){token=closes.get(token);continue;}
            if(tokens[token].text===';')separators.push(token);
          }
          first=separators.length===2 ? separators[0]+1 : close;
        }
        if(first<close)expressionStarts.set(node.condition,tokens[first].range.startOffset);
      }
    }
    if (node.kind === 'LocalVariableDeclarationStatement')
      for (const variable of node.declarators) locals.set(variable.name,{node,scope:parent,variable,
        position:node.range?.startOffset ?? (parent?.kind==='ForStatement'
          ? tokens[starts.get(parent.range?.startOffset)+2]?.range.startOffset : undefined)});
    if (node.kind === 'BlockStatement') blocks.push(node);
    if (node.kind === 'LabeledStatement' || loops.has(node.kind) || node.kind === 'SwitchStatement') entryCleanup.set(node,cleanup);
    if (['BreakStatement','ContinueStatement'].includes(node.kind)) {
      let target;
      if (node.label) {
        const label=labels.slice().reverse().find(frame=>frame.label===node.label);
        if (!label) {refused=true;return;}
        target=node.kind==='ContinueStatement' ? label.statement : label;
        if (node.kind==='ContinueStatement' && !loops.has(target.kind)) {refused=true;return;}
      } else target=node.kind==='ContinueStatement' ? loopStack.at(-1) : breakStack.at(-1);
      if (!target) {refused=true;return;}
      const targets=[target];
      if (node.kind==='BreakStatement' && target.kind==='LabeledStatement'
          && (loops.has(target.statement.kind)||target.statement.kind==='SwitchStatement')) targets.push(target.statement);
      for (const destination of targets) {
        if (!references.has(destination)) references.set(destination,[]);
        references.get(destination).push({node,cleanup:cleanup.filter(owner=>!(entryCleanup.get(destination)||[]).includes(owner))});
      }
    }
    const nestedLabels=node.kind==='LabeledStatement' ? [...labels,node] : labels;
    const nestedLoops=loops.has(node.kind) ? [...loopStack,node] : loopStack;
    const nestedBreaks=loops.has(node.kind)||node.kind==='SwitchStatement' ? [...breakStack,node] : breakStack;
    children(node,child=>walk(child,node,nestedLabels,nestedLoops,nestedBreaks,
      node.kind==='TryStatement' && node.finallyBlock && child!==node.finallyBlock ? [...cleanup,node] : cleanup));
  }
  walk(parsed,null);
  if (refused) return unchanged();
  const either=(a,b)=>a===true||b===true ? true : a===false&&b===false ? false : null;
  const both=(a,b)=>a===false||b===false ? false : a===true&&b===true ? true : null;
  function visible(name, expression) {
    const local=locals.get(name);
    if (names.get(name)!==1 || !local || !['BlockStatement','ForStatement'].includes(local.scope?.kind)) return null;
    let position;
    for(let node=expression;node;node=parents.get(node)) {
      if(expressionStarts.has(node)){position=expressionStarts.get(node);break;}
      if(node.range){position=node.range.startOffset;break;}
    }
    if(!(local.position<position))return null;
    for (let parent=parents.get(expression);parent;parent=parents.get(parent)) if (parent===local.scope) return local;
    return null;
  }
  function constant(node,seen=new Set()) {
    if (!node) return null;
    if (node.kind==='LiteralExpression'&&node.literalKind==='boolean') return node.value;
    if (node.kind==='ParenthesizedExpression') return constant(node.expression,seen);
    if (node.kind==='UnaryExpression'&&node.operator==='!') {
      const value=constant(node.operand,seen);return value===null ? null : !value;
    }
    if (node.kind==='Identifier'&&!seen.has(node.name)) {
      const local=visible(node.name,node);
      if (local?.node.variableType?.kind==='PrimitiveType'&&local.node.variableType.name==='boolean'
          && local.node.modifiers.some(modifier=>modifier.name==='final')&&!local.variable.dimensions)
        return constant(local.variable.initializer,new Set([...seen,node.name]));
    }
    return null;
  }
  function runtimePredicate(node,identifiers=true) {
    if (!node) return false;
    if (['MethodInvocationExpression','AssignmentExpression','ArrayAccessExpression','InstanceOfExpression',
      'NewClassExpression','NewArrayExpression'].includes(node.kind)) return true;
    if (node.kind==='UnaryExpression'&&['++','--'].includes(node.operator)) return true;
    if (node.kind==='Identifier'&&identifiers) {
      const local=visible(node.name,node);
      if (local&&!local.node.modifiers.some(modifier=>modifier.name==='final')) return true;
    }
    // Qualified constant fields may use a receiver spelling also owned by a
    // local. Receiver identifiers alone do not establish a runtime predicate.
    const nestedIdentifiers=identifiers&&node.kind!=='FieldAccessExpression';
    let result=false;children(node,child=>{result=runtimePredicate(child,nestedIdentifiers)||result;});return result;
  }
  const completion=new Map();
  function escaping(node,kind) {
    let result=false;
    for (const reference of references.get(node)||[]) if (reference.node.kind===kind) {
      let finishes=true;
      for (const owner of reference.cleanup) finishes=both(finishes,complete(owner.finallyBlock));
      result=either(result,finishes);
    }
    return result;
  }
  function complete(node) {
    if (!node) return true;
    if (completion.has(node)) return completion.get(node);
    completion.set(node,null);
    let result=null;
    switch(node.kind) {
      case 'ExpressionStatement': case 'LocalVariableDeclarationStatement': case 'EmptyStatement': case 'AssertStatement': result=true;break;
      case 'BreakStatement': case 'ContinueStatement': case 'ReturnStatement': case 'ThrowStatement': result=false;break;
      case 'BlockStatement':
        result=true;for(const statement of node.statements)result=both(result,complete(statement));break;
      case 'IfStatement':result=either(complete(node.consequent),complete(node.alternate));break;
      case 'LabeledStatement':result=either(complete(node.statement),escaping(node,'BreakStatement'));break;
      case 'SynchronizedStatement':result=complete(node.body);break;
      case 'TryStatement':
        result=complete(node.block);for(const handler of node.catches||[])result=either(result,complete(handler.body));
        if(node.finallyBlock)result=both(result,complete(node.finallyBlock));break;
      case 'EnhancedForStatement':result=true;break;
      case 'WhileStatement': case 'ForStatement': case 'DoWhileStatement': {
        const value=node.kind==='ForStatement'&&!node.condition ? true : constant(node.condition);
        const predicate=value===true ? false : value===false||runtimePredicate(node.condition) ? true : null;
        const reachesTest=node.kind==='DoWhileStatement' ? either(complete(node.body),escaping(node,'ContinueStatement')) : true;
        result=either(escaping(node,'BreakStatement'),both(reachesTest,predicate));break;
      }
      // Switch completion and unknown constant expressions need a stronger
      // proof; they cannot force removal or retention of an unreachable tail.
      default:break;
    }
    completion.set(node,result);return result;
  }
  const edits=[];
  let frames=0,jumpsReturned=0,tailsRemoved=0;
  for(const block of blocks)for(let index=0;index+1<block.statements.length;index++) {
    const frame=block.statements[index],tail=block.statements[index+1];
    if(frame.kind!=='LabeledStatement'||frame.statement.kind!=='BlockStatement'||labelCounts.get(frame.label)!==1
        ||tail.kind!=='ReturnStatement'||tail.expression)continue;
    const tailStart=starts.get(tail.range?.startOffset);
    if(tokens[tailStart]?.text!=='return'||tokens[tailStart+1]?.text!==';')continue;
    const jumps=references.get(frame)||[];
    if(!jumps.length||jumps.some(reference=>reference.node.kind!=='BreakStatement'))continue;
    const normal=complete(frame.statement);
    if(normal===null)continue;
    const changes=[];
    for(const reference of jumps) {
      const start=starts.get(reference.node.range?.startOffset);
      if(tokens[start]?.text!=='break'||tokens[start+1]?.text!==frame.label||tokens[start+2]?.text!==';') {changes.length=0;break;}
      changes.push({start:tokens[start].range.startOffset,end:tokens[start+2].range.endOffset,text:'return;'});
    }
    if(changes.length!==jumps.length)continue;
    edits.push(...changes);frames++;jumpsReturned+=changes.length;
    if(!normal) {
      let start=tokens[tailStart].range.startOffset,end=tokens[tailStart+1].range.endOffset;
      const beginning=wrapped.lastIndexOf('\n',start-1)+1,ending=wrapped.indexOf('\n',end);
      if(ending>=0&&ending<wrapped.length-2&&!wrapped.slice(beginning,start).trim()&&!wrapped.slice(end,ending).trim()) {
        start=beginning;end=ending+1;
      }
      edits.push({start,end,text:''});tailsRemoved++;
    }
  }
  edits.sort((a,b)=>a.start-b.start);
  if(edits.some((edit,index)=>index&&edits[index-1].end>edit.start))return unchanged();
  let output=wrapped;
  for(const edit of edits.slice().reverse())output=output.slice(0,edit.start)+edit.text+output.slice(edit.end);
  return {source:output.slice(2,-2),frames,jumpsReturned,tailsRemoved};
}

// Run after stack-carrier cleanup: two copies of the same CFG tail may initially
// spell the same Boolean argument using different temporary names. Parse the
// final source for control/scope proofs, while retaining original expression
// bytes (the parser's node ranges often cover only the leading token).
function factorCommonBranchTails(source, {integralConditions = new Set(), localType = null} = {}) {
  const unchanged = () => ({source, branches: 0});
  if (/\\u+[0-9a-fA-F]{4}/.test(source)) return unchanged();
  let parsed, tokens;
  const wrapped = `{\n${source}\n}`;
  try {
    parsed = statementParser.parseStatement(wrapped, {requireComplete: true});
    const lexed = tokenizeJava(wrapped);
    if (lexed.diagnostics.length) return unchanged();
    tokens = lexed.tokens.filter(token => !['comment', 'whitespace', 'eof'].includes(token.kind));
  } catch (_) { return unchanged(); }
  function known(node) {
    if (!node || typeof node !== 'object') return true;
    if (Array.isArray(node)) return node.every(known);
    if (node.kind?.startsWith('Unsupported')) return false;
    return Object.entries(node).every(([key, value]) => ['range', 'meta', 'tokens'].includes(key) || known(value));
  }
  if (!known(parsed)) return unchanged();
  const declaredNames = new Set();
  function declarations(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {node.forEach(declarations);return;}
    if (['VariableDeclarator', 'FormalParameter'].includes(node.kind)) declaredNames.add(node.name);
    for (const [key, value] of Object.entries(node))
      if (!['range', 'tokens', 'meta'].includes(key)) declarations(value);
  }
  declarations(parsed);
  // The caller proves lifted-local/parameter types. An inline declaration can
  // shadow that identity, so refuse the whole spelling rather than guessing
  // its lexical scope. Protected/monitor/loop/label bodies remain opaque here.
  const unshadowedLocalType = name => declaredNames.has(name) ? null : localType?.(name);

  const starts = new Map(tokens.map((token, index) => [token.range.startOffset, index]));
  const pairs = new Map(), stack = [];
  for (let index = 0; index < tokens.length; index++) {
    const text = tokens[index].text;
    if (['(', '[', '{'].includes(text)) stack.push(index);
    else if ([')', ']', '}'].includes(text)) {
      const open = stack.pop();
      if (open === undefined || '([{'.indexOf(tokens[open].text) !== ')]}'.indexOf(text)) return unchanged();
      pairs.set(open, index);
    }
  }
  if (stack.length) return unchanged();
  let branches = 0;
  function inverse(condition) {
    // Equality has an exact complement even for floating-point NaNs. Relational
    // complements additionally require the cached JVM predicate's integral
    // evidence; an unproven !(x < y) must still include NaN.
    let text = condition.trim();
    try {
      let expression = statementParser.parseStatement(`if (${text}) {}`, {requireComplete: true}).condition;
      let items = tokenizeJava(text).tokens.filter(token => !['comment', 'whitespace', 'eof'].includes(token.kind));
      while (expression.kind === 'ParenthesizedExpression') {
        text = text.slice(items[0].range.endOffset, items.at(-1).range.startOffset).trim();
        items = tokenizeJava(text).tokens.filter(token => !['comment', 'whitespace', 'eof'].includes(token.kind));
        expression = expression.expression;
      }
      if (expression.kind === 'UnaryExpression' && expression.operator === '!')
        return text.slice(items[0].range.endOffset).trim();
      const opposites = {'==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>'};
      if (expression.kind === 'BinaryExpression' && (['==', '!='].includes(expression.operator)
          || integralConditions.has(text) && ['<', '>=', '>', '<='].includes(expression.operator))) {
        let depth = 0;
        for (const token of items) {
          if (['(', '[', '{'].includes(token.text)) depth++;
          else if ([')', ']', '}'].includes(token.text)) depth--;
          else if (!depth && token.text === expression.operator)
            return text.slice(0, token.range.startOffset) + opposites[token.text] + text.slice(token.range.endOffset);
        }
      }
    } catch (_) { /* Preserve an unknown condition verbatim under negation. */ }
    return `!(${condition})`;
  }
  const fragment = (start, end) => {
    const text = wrapped.slice(start, end).trim();
    const lines = text.split('\n');
    // Strings keep their token spelling. Java 8 has no text blocks; only
    // indentation before subsequent source lines is adjusted.
    const indent = Math.min(...lines.slice(1).filter(line => line.trim()).map(line => /^\s*/.exec(line)[0].length));
    return lines.map((line, index) => index ? line.slice(Math.min(indent, /^\s*/.exec(line)[0].length)) : line).join('\n');
  };
  function statements(node) {
    if (node.kind !== 'BlockStatement') throw new Error('unproven block');
    const open = starts.get(node.range?.startOffset), close = pairs.get(open);
    if (tokens[open]?.text !== '{' || tokens[close]?.text !== '}') throw new Error('unproven block extent');
    let result = [];
    for (let index = 0; index < node.statements.length; index++) {
      const child = node.statements[index];
      const start = child.range?.startOffset;
      const end = node.statements[index + 1]?.range?.startOffset ?? tokens[close].range.startOffset;
      if (!starts.has(start) || end <= start) throw new Error('unproven statement extent');
      if (child.kind === 'IfStatement' && child.consequent?.kind === 'BlockStatement'
          && (!child.alternate || child.alternate.kind === 'BlockStatement')) {
        const keyword = starts.get(start), conditionOpen = keyword + 1, conditionClose = pairs.get(conditionOpen);
        if (tokens[keyword].text !== 'if' || tokens[conditionOpen]?.text !== '(' || conditionClose === undefined)
          throw new Error('unproven condition extent');
        const condition = wrapped.slice(tokens[conditionOpen].range.endOffset, tokens[conditionClose].range.startOffset);
        const taken = statements(child.consequent), other = child.alternate ? statements(child.alternate) : [];
        if (commonBranchTail(taken, other)) branches++;
        const value = valueProducingBranch(condition, taken, other, unshadowedLocalType);
        if (value) {branches++;result.push(value);}
        else result.push(...lowerIfStatements(condition, taken, other, () => inverse(condition), unshadowedLocalType, true));
      } else if (child.kind === 'BlockStatement') {
        // Reconstruct tails within an existing plain block, keeping its scope
        // intact. Try/monitor/loop/label bodies remain opaque at this layer.
        result.push(block(statements(child)));
      } else {
        result.push(rawStatement(fragment(start, end)));
      }
    }
    // Early-exit lowering can have already put one clone after its guard.
    // Reconstitute only a proven abrupt arm with an identical block suffix.
    // A return/throw/outer jump still skips the shared tail on the same paths.
    for (let index = result.length - 2; index >= 0; index--) {
      const child = result[index];
      if (child.kind !== 'IfStatement' || child.alternate || !provenAbrupt(child.consequent.statements)) continue;
      const rest = result.slice(index + 1);
      if (!commonBranchTail(child.consequent.statements, rest)) continue;
      branches++;
      result = [...result.slice(0, index), ...lowerIfStatements(child.condition.source,
        child.consequent.statements, rest, () => inverse(child.condition.source), unshadowedLocalType, true)];
    }
    return terminalContinuation(result) ? contextualTails(result) : result;
  }
  function terminalContinuation(items) {
    if (!items.length) return false;
    const last = items.at(-1);
    const parsed = last.kind === 'UnsupportedStatement' ? parsedStraightBlock(last) : last;
    const statement = parsed?.kind === 'BlockStatement' && parsed.statements.length === 1
      ? parsed.statements[0] : parsed;
    return ['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'].includes(statement?.kind);
  }
  function acceptsContinuation(body) {
    if (continuation(body) !== body) return false;
    // The existing abrupt-completion proof is deliberately conservative about
    // loops and switches. Do not append a continuation after such a construct:
    // a missed infinite loop would make the appended Java unreachable. A raw
    // try/monitor is kept whole; its completion can be proved without entering
    // its exception/monitor region or changing any internal transfer destination.
    const uncertain = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement',
      'DoWhileStatement', 'SwitchStatement', 'LabeledStatement']);
    return !body.some(statement => anyStatement(statement, node => uncertain.has(node.kind)
      || node.kind === 'UnsupportedStatement' && anyStatement(parsedStraightBlock(node),
        parsed => uncertain.has(parsed.kind))));
  }
  const labelNames = new Set(tokens.filter(token => token.kind === 'identifier').map(token => token.text));
  const generatedLabels = new Set();
  let labelOrdinal = 0;
  function doesNotDuplicate(before, after) {
    const rawCounts = statements => {
      const counts = new Map();
      for (const statement of statements) anyStatement(statement, node => {
        // createNode deep-copies its children, so object identity is not a
        // provenance key. Exact source spelling survives those AST copies.
        if (node.kind === 'UnsupportedStatement') counts.set(node.source, (counts.get(node.source) || 0) + 1);
        return false;
      });
      return counts;
    };
    const originalRaw = rawCounts(before);
    if ([...rawCounts(after)].some(([node, count]) => count > (originalRaw.get(node) || 0))) return false;
    const identifiers = statements => {
      const counts = new Map();
      for (const token of tokenizeJava(emitStatements(statements)).tokens)
        if (token.kind === 'identifier' && !generatedLabels.has(token.text))
          counts.set(token.text, (counts.get(token.text) || 0) + 1);
      return counts;
    };
    const originalNames = identifiers(before);
    return [...identifiers(after)].every(([name, count]) => count <= (originalNames.get(name) || 0));
  }
  function labeledTail(child, following) {
    // A break from a new plain block skips all intervening prefix statements
    // exactly as the original terminal clone did. No condition is evaluated
    // again, and no try/monitor/loop/old-label body is entered by the search.
    for (let length = following.length; length >= 2; length--) {
      const suffix = following.slice(-length), prefix = [child, ...following.slice(0, -length)];
      if (continuation(suffix) !== suffix || continuation(prefix) !== prefix) continue;
      const last = suffix.at(-1), parsedLast = last.kind === 'UnsupportedStatement' ? parsedStraightBlock(last) : last;
      const terminal = parsedLast?.kind === 'BlockStatement' && parsedLast.statements.length === 1
        ? parsedLast.statements[0] : parsedLast;
      if (!['ReturnStatement', 'ThrowStatement'].includes(terminal?.kind)) continue;
      let label, matches = 0;
      function replace(body) {
        if (continuation(body) !== body) return body;
        if (body.length >= suffix.length && suffix.every((statement, index) =>
            statementSource(statement) === statementSource(body[body.length - suffix.length + index]))) {
          if (!label) {
            do { label = `sharedTailExit_${labelOrdinal++}`; } while (labelNames.has(label));
            labelNames.add(label); generatedLabels.add(label);
          }
          matches++;
          return [...body.slice(0, -suffix.length), createNode('BreakStatement', {label})];
        }
        return body.map(statement => statement.kind === 'IfStatement' ? createNode('IfStatement', {
          condition: statement.condition, consequent: block(replace(statement.consequent.statements)),
          alternate: statement.alternate ? block(replace(statement.alternate.statements)) : null,
        }) : statement);
      }
      function trimTerminalBreak(body) {
        if (!body.length) return body;
        const last = body.at(-1);
        if (last.kind === 'BreakStatement' && last.label === label) return body.slice(0, -1);
        if (last.kind === 'IfStatement') return [...body.slice(0, -1), createNode('IfStatement', {
          condition: last.condition, consequent: block(trimTerminalBreak(last.consequent.statements)),
          alternate: last.alternate ? block(trimTerminalBreak(last.alternate.statements)) : null,
        })];
        if (last.kind === 'BlockStatement') return [...body.slice(0, -1), block(trimTerminalBreak(last.statements))];
        // Do not enter existing labels, loops, monitors or protected regions.
        return body;
      }
      const rewritten = trimTerminalBreak(replace(prefix));
      if (matches) {
        // A break at the very end of the newly introduced block is redundant:
        // normal completion reaches the identical suffix. Keep conditions and
        // original scopes; drop only our new label if no transfer uses it.
        if (!rewritten.some(statement => anyStatement(statement,
          node => node.kind === 'BreakStatement' && node.label === label))) {
          branches += matches;
          return [...rewritten, ...suffix];
        }
        // Avoid wrapping a large method prefix in another exit frame just to
        // share a small cleanup. Count tokens, not indentation or line layout.
        const prefixTokens = tokenizeJava(emitStatements(rewritten)).tokens
          .filter(token => !['comment', 'whitespace', 'eof'].includes(token.kind));
        if (prefixTokens.length > 512) continue;
        branches += matches;
        return [createNode('LabeledStatement', {label, statement: block(rewritten)}), ...suffix];
      }
    }
    return null;
  }
  function contextualTails(body, following = []) {
    // Normalize both arms with their actual enclosing continuation, then share
    // identical suffixes immediately. An existing return/throw/jump ends its
    // path and discards that virtual continuation. This also preserves skipped
    // statements at multiple enclosing levels without inventing a jump label.
    // Scope checks precede every copy; branch-local declarations must never
    // capture a name from a continuation that originally followed the if.
    let result = following;
    for (let index = body.length - 1; index >= 0; index--) {
      const child = body[index];
      if (child.kind === 'IfStatement' && acceptsContinuation(result)
          && acceptsContinuation(child.consequent.statements)
          && (!child.alternate || acceptsContinuation(child.alternate.statements))
          && !(result.length === 1 && terminalContinuation(result)
            && !child.consequent.statements.some(containsExplicitTransfer)
            && !(child.alternate?.statements || []).some(containsExplicitTransfer))) {
        const original = [child, ...result], previousBranches = branches;
        const taken = contextualTails(child.consequent.statements, result);
        const other = child.alternate ? contextualTails(child.alternate.statements, result) : result;
        const lowered = lowerIfStatements(child.condition.source, taken, other,
          () => inverse(child.condition.source), unshadowedLocalType, true);
        if (doesNotDuplicate(original, lowered)) {
          if (emitStatements(lowered) !== emitStatements(original)) branches++;
          result = lowered;
        } else {
          branches = previousBranches;
          result = labeledTail(child, result) || original;
        }
      } else {
        // If loop/label completion is uncertain, do not append a continuation
        // inside it. The existing labeled-tail proof can instead replace exact
        // terminal clones with a skip over the intact prefix.
        result = provenAbrupt([child]) ? [child]
          : child.kind === 'IfStatement' ? labeledTail(child, result) || [child, ...result]
            : [child, ...result];
      }
    }
    return result;
  }
  try {
    const result = statements(parsed);
    return branches ? {source: emitStatements(result), branches} : unchanged();
  } catch (_) { return unchanged(); }
}

function treeToStatements(tree, render) {
  if (!tree) return [];
  switch (tree.t) {
    case 'seq': return tree.body.flatMap((child) => treeToStatements(child, render));
    case 'straight': return render.straight(tree.block).map(rawStatement);
    case 'block': return [createNode('LabeledStatement', {
      label: tree.label,
      statement: block(treeToStatements(tree.body, render)),
    })];
    case 'loop': {
      const rotatable = rotatableLoop(tree, render);
      if (rotatable) {
        const { branch, rest } = rotatable;
        // Render in the order the untransformed tree would have: the condition,
        // then the taken arm, then the fall arm. Reordering the *rendered*
        // statements afterwards is safe; reordering the rendering is not, because
        // expression reconstruction binds local names as it goes.
        const taken = render.cond(branch.block);
        const notTaken = render.condInverted ? render.condInverted(branch.block) : null;
        const thenStatements = treeToStatements(branch.then, render);
        const elseStatements = branch.els ? treeToStatements(branch.els, render) : [];
        const restStatements = rest.flatMap((child) => treeToStatements(child, render));
        const restExits = rest.length === 0 || rest.some((child) => alwaysExits(child, render));
        const arms = [
          {
            condition: notTaken, bodyTree: branch.els, body: elseStatements,
            exitTree: branch.then, exit: thenStatements,
          },
          {
            condition: taken, bodyTree: branch.then, body: thenStatements,
            exitTree: branch.els, exit: elseStatements,
          },
        ];
        for (const arm of arms) {
          if (!arm.condition || referencesLabel(arm.exitTree, tree.label)) continue;
          const loopsBack = endsWithContinueTo(arm.body, tree.label);
          // Two shapes reach here. Without trailing statements the other arm is
          // the exit and has to leave on every path, or rotating it out would
          // change an iteration into a fall-through. With trailing statements the
          // other arm must be empty - the test simply falls past the loop - and
          // the statements after it are the exit, which likewise has to leave.
          if (rest.length === 0) {
            if (!loopsBack || !alwaysExits(arm.exitTree, render)) continue;
            return [
              createNode('LabeledStatement', {
                label: tree.label,
                statement: createNode('WhileStatement', {
                  condition: rawExpression(arm.condition),
                  body: block(arm.body.slice(0, -1)),
                }),
              }),
              ...arm.exit,
            ];
          }
          // The trailing statements leave the loop, so nothing in them may jump
          // back into it: a `continue` there is proof they are part of the loop
          // body and not what follows it.
          if (rest.some((child) => referencesLabel(child, tree.label))) continue;
          if (arm.exit.length || !restExits || !referencesLabel(arm.bodyTree, tree.label)) continue;
          // Falling off the end of the body used to land in the trailing
          // statements; they are outside the loop now, so that path breaks.
          const loopBody = loopsBack ? arm.body.slice(0, -1) : [
            ...arm.body, createNode('BreakStatement', { label: null }),
          ];
          return [
            createNode('LabeledStatement', {
              label: tree.label,
              statement: createNode('WhileStatement', {
                condition: rawExpression(arm.condition),
                body: block(loopBody),
              }),
            }),
            ...restStatements,
          ];
        }
        return [createNode('LabeledStatement', {
          label: tree.label,
          statement: createNode('WhileStatement', {
            condition: rawExpression('true'),
            body: block([
              ...(taken === 'true' ? thenStatements : taken === 'false' ? elseStatements
                : lowerIfStatements(taken, thenStatements, elseStatements, () => notTaken, render.localType)),
              ...restStatements,
            ]),
          }),
        })];
      }
      return [createNode('LabeledStatement', {
        label: tree.label,
        statement: createNode('WhileStatement', {
          condition: rawExpression('true'),
          body: block(treeToStatements(tree.body, render)),
        }),
      })];
    }
    case 'if': {
      const conditionSource = render.cond(tree.block);
      if (conditionSource === 'true') return treeToStatements(tree.then, render);
      if (conditionSource === 'false') return tree.els ? treeToStatements(tree.els, render) : [];
      const thenStatements = treeToStatements(tree.then, render);
      const elseStatements = tree.els ? treeToStatements(tree.els, render) : [];
      return lowerIfStatements(conditionSource, thenStatements, elseStatements,
        render.condInverted ? () => render.condInverted(tree.block) : null, render.localType);
    }
    case 'switch': return [createNode('SwitchStatement', {
      expression: rawExpression(render.switchValue(tree.block)),
      groups: [
        ...tree.cases.map((item) => ({
          label: createNode('SwitchLabel', {
            labelKind: 'case', expression: rawExpression(item.key), separator: ':',
          }),
          statements: treeToStatements(item.body, render),
        })),
        ...(tree.dflt ? [{
          label: createNode('SwitchLabel', { labelKind: 'default', expression: null, separator: ':' }),
          statements: treeToStatements(tree.dflt, render),
        }] : []),
      ],
    })];
    case 'break': return [createNode('BreakStatement', { label: tree.label })];
    case 'continue': return [createNode('ContinueStatement', { label: tree.label })];
    case 'synchronized': return [createNode('SynchronizedStatement', {
      lock: rawExpression(render.syncLock
        ? render.syncLock(tree.lockLocal, tree.lockPc)
        : `lock${tree.lockLocal}`),
      body: block(treeToStatements(tree.body, render)),
    })];
    case 'try': return [createNode('TryStatement', {
      resources: [],
      block: block(treeToStatements(tree.body, render)),
      catches: tree.catches.map((item) => createNode('CatchClause', {
        parameter: catchParameter(item.varName, item.types || [item.type]),
        body: block([
          ...(item.carrierName ? [rawStatement(`${item.carrierName} = ${item.varName};`)] : []),
          ...treeToStatements(item.body, render),
        ]),
      })),
      finallyBlock: null,
    })];
    default: throw new Error(`unknown structured Java node ${tree.t}`);
  }
}

function emitStatements(statements) {
  const lines = [];
  for (const statement of statements || []) emitStatement(statement, 0, lines);
  return lines.join('\n');
}

function emitBlock(node, indent, lines) {
  for (const statement of (node && node.statements) || []) emitStatement(statement, indent, lines);
}

function emitStatement(node, indent, lines) {
  const emit = (text, level = indent) => lines.push(`${'  '.repeat(level)}${text}`);
  switch (node.kind) {
    case 'UnsupportedStatement':
      for (const line of node.source.split('\n')) emit(line);
      return;
    case 'BlockStatement':
      emit('{'); emitBlock(node, indent + 1, lines); emit('}');
      return;
    case 'LabeledStatement':
      if (node.statement.kind === 'WhileStatement') {
        emit(`${node.label}: while (${emitExpression(node.statement.condition)}) {`);
        emitBlock(node.statement.body, indent + 1, lines);
        emit('}');
      } else {
        emit(`${node.label}: {`); emitBlock(node.statement, indent + 1, lines); emit('}');
      }
      return;
    case 'IfStatement':
      emit(`if (${emitExpression(node.condition)}) {`);
      emitBlock(node.consequent, indent + 1, lines);
      if (node.alternate) {
        emit('} else {'); emitBlock(node.alternate, indent + 1, lines);
      }
      emit('}');
      return;
    case 'SwitchStatement':
      emit(`switch (${emitExpression(node.expression)}) {`);
      for (const group of node.groups || []) {
        emit(group.label.labelKind === 'default' ? 'default:' : `case ${emitExpression(group.label.expression)}:`, indent + 1);
        for (const statement of group.statements || []) emitStatement(statement, indent + 2, lines);
      }
      emit('}');
      return;
    case 'BreakStatement': emit(`break${node.label ? ` ${node.label}` : ''};`); return;
    case 'ContinueStatement': emit(`continue${node.label ? ` ${node.label}` : ''};`); return;
    case 'SynchronizedStatement':
      emit(`synchronized (${emitExpression(node.lock)}) {`);
      emitBlock(node.body, indent + 1, lines);
      emit('}');
      return;
    case 'TryStatement':
      emit('try {'); emitBlock(node.block, indent + 1, lines);
      for (const item of node.catches || []) {
        emit(`} catch (${emitType(item.parameter.parameterType)} ${item.parameter.name}) {`);
        emitBlock(item.body, indent + 1, lines);
      }
      emit('}');
      return;
    default: throw new Error(`cannot emit Java statement node ${node.kind}`);
  }
}

function emitExpression(node) {
  if (node && node.kind === 'UnsupportedExpression') return node.source;
  throw new Error(`cannot emit Java expression node ${node && node.kind}`);
}

function emitType(node) {
  if (node && node.kind === 'UnionType') return node.alternatives.map(emitType).join(' | ');
  if (node && node.kind === 'ClassType') {
    return `${node.packageName ? `${node.packageName}.` : ''}${node.name}`;
  }
  throw new Error(`cannot emit Java type node ${node && node.kind}`);
}

// ---------------------------------------------------------------------------
// Reachability (JLS 14.21 "can complete normally") over the emitted Java
// statement AST. This runs on the *folded* statements `treeToStatements`
// produces — dead if-branches (constant `render.cond`) are already gone — so it
// sees exactly the control flow javac will. It answers one question: is any
// statement rendered after a sibling that can never complete normally? The owned
// structurer emits dead loop-continuation clones for some irreducible CFGs
// (`Lx: while (true) { … continue Lx; }` whose header nothing can reach after a
// preceding infinite loop / all-paths-break block); javac rejects those as
// "unreachable statement". A true result routes the method to the CFG state
// machine, which prunes unreachable states, instead of shipping invalid Java.
// Every uncertain construct is biased toward completing so valid output is never
// misflagged.
function anyStatement(node, predicate) {
  if (!node) return false;
  if (predicate(node)) return true;
  switch (node.kind) {
    case 'BlockStatement': return (node.statements || []).some((s) => anyStatement(s, predicate));
    case 'LabeledStatement': return anyStatement(node.statement, predicate);
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'ForStatement':
    case 'SynchronizedStatement':
      return anyStatement(node.body, predicate);
    case 'IfStatement': return anyStatement(node.consequent, predicate) || anyStatement(node.alternate, predicate);
    case 'SwitchStatement':
      return (node.groups || []).some((g) => (g.statements || []).some((s) => anyStatement(s, predicate)));
    case 'TryStatement':
      return anyStatement(node.block, predicate)
        || (node.catches || []).some((c) => anyStatement(c.body, predicate))
        || anyStatement(node.finallyBlock, predicate);
    default: return false;
  }
}

const containsBreakToLabel = (node, label) =>
  anyStatement(node, (n) => n.kind === 'BreakStatement' && n.label === label);
// Conservative: any unlabeled break counts as a live exit for the nearest loop,
// even one really captured by a nested loop/switch — only risks a missed flag.
const containsUnlabeledBreak = (node) =>
  anyStatement(node, (n) => n.kind === 'BreakStatement' && !n.label);

// A raw (straight-block) statement completes normally unless its last rendered
// line is an unconditional transfer.
function rawStatementCompletes(source) {
  const lines = String(source).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return true;
  return !/^(return|throw|break|continue)\b/.test(lines[lines.length - 1]);
}

function statementCompletesNormally(node, state, parseRaw = false) {
  if (!node) return true;
  switch (node.kind) {
    case 'BlockStatement': return sequenceCompletesNormally(node.statements || [], state, parseRaw);
    case 'UnsupportedStatement': {
      if (!parseRaw) return rawStatementCompletes(node.source);
      // Parser-produced unsupported statements have no source and cannot
      // establish a proof. A last-line return alone is not enough: it might
      // belong to an unbraced conditional.
      if (node.source == null) return true;
      const parsed = parsedStraightBlock(node);
      return parsed ? statementCompletesNormally(parsed, state, true) : true;
    }
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'ReturnStatement':
    case 'ThrowStatement':
      return false;
    case 'LabeledStatement':
      return statementCompletesNormally(node.statement, state, parseRaw)
        || containsBreakToLabel(node.statement, node.label);
    case 'WhileStatement': {
      statementCompletesNormally(node.body, state, parseRaw); // walk for nested unreachable
      const cond = node.condition && node.condition.kind === 'UnsupportedExpression'
        ? String(node.condition.source).trim() : '';
      return cond === 'true' ? containsUnlabeledBreak(node.body) : true;
    }
    case 'DoWhileStatement':
    case 'ForStatement':
      statementCompletesNormally(node.body, state, parseRaw);
      return true; // conservative: a non-`while (true)` loop may exit
    case 'IfStatement': {
      const thenCompletes = statementCompletesNormally(node.consequent, state, parseRaw);
      const elseCompletes = node.alternate ? statementCompletesNormally(node.alternate, state, parseRaw) : true;
      return thenCompletes || elseCompletes;
    }
    case 'SwitchStatement':
      for (const group of node.groups || []) sequenceCompletesNormally(group.statements || [], state, parseRaw);
      return true; // conservative
    case 'TryStatement': {
      const bodyCompletes = statementCompletesNormally(node.block, state, parseRaw);
      let anyCatchCompletes = false;
      for (const clause of node.catches || []) {
        if (statementCompletesNormally(clause.body, state, parseRaw)) anyCatchCompletes = true;
      }
      if (node.finallyBlock && !statementCompletesNormally(node.finallyBlock, state, parseRaw)) return false;
      return bodyCompletes || anyCatchCompletes;
    }
    case 'SynchronizedStatement': return statementCompletesNormally(node.body, state, parseRaw);
    default: return true;
  }
}

function sequenceCompletesNormally(statements, state, parseRaw = false) {
  let reachable = true;
  for (const statement of statements) {
    if (!reachable) { state.unreachable = true; return false; }
    reachable = statementCompletesNormally(statement, state, parseRaw);
  }
  return reachable;
}

function hasUnreachableStatement(statements) {
  const state = { unreachable: false };
  sequenceCompletesNormally(statements || [], state);
  return state.unreachable;
}

module.exports = {
  treeToStatements, emitStatements, rawExpression, rawStatement, hasUnreachableStatement,
  promoteBooleanStackCarriers,
  factorCommonBranchTails,
  factorLabeledBlockReturnTails,
  simplifyControlFrames,
  removeFallthroughLabelBreaks,
  localizePlainBlockLoopBreaks,
  foldLeadingWhileBreakGuards,
  foldEffectfulPlainBlockExits,
  foldGuardedAbruptPlainBlockExits,
  foldGuardedLoopContinuations,
  foldNonrepeatingWhileLoops,
  foldTrailingLoopContinuations,
  foldLoopExitContinuations,
  foldTerminalLoopExits,
  foldNonlocalLoopExits,
  foldLoopElseExitGuards,
  simplifyIdentityReferenceCasts,
  recoverScalarLabelDispatches,
  recoverScalarIfDispatches,
  simplifyPredicateNegations,
  specializePathGuards,
  recoverArrayIndexIncrements,
  recoverPostGuardExits,
  foldLabeledBooleanDecisions,
  foldVoidReturnExits,
  foldNestedIfGuards,
  foldLabeledSkipGuards,
  foldLabeledIfElseExits,
  foldLabeledExitTrees,
  foldLabeledGuardTrees,
  removeDeadRegionSelectors,
  removeDeadReceiverSnapshots,
};
