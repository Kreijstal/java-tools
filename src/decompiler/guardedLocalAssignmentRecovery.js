'use strict';

const {primitiveExpressionProof} = require('./primitiveExpressionProof');

function floatingLiteralType(node) {
  if (node.literalKind !== 'number') return null;
  const raw = (node.raw || '').replace(/_/g, '');
  // Decimal or hexadecimal floating literals, with their exact Java type.
  if (!/^(?:(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fFdD]?|0[xX](?:[\da-fA-F]+\.?[\da-fA-F]*|\.[\da-fA-F]+)[pP][+-]?\d+[fFdD]?)$/.test(raw)
      || !/[.eEpPfFdD]/.test(raw)) return null;
  return /[fF]$/.test(raw) ? 'float' : 'double';
}


// A provisional primitive-local value followed by an effect-free keep guard
// can be selected directly. The guard and fallback cannot read the destination:
// in the original body they observe the provisional assignment on that path.
function foldGuardedLocalAssignments(source, proof, {parameters = [], retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, assignmentsFolded: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  if ([...labelCounts.values()].some(count => count !== 1)) return unchanged();
  const primitive = primitiveExpressionProof(proof, parameters, floatingLiteralType);
  if (!primitive) return unchanged();
  const {pureType, counts, locals, reads} = primitive;
  const frames = [], references = new Map();
  function inspect(node) {
    if (node.kind === 'LabeledStatement') frames.push(node);
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind) && node.label)
      references.set(node.label, [...(references.get(node.label) || []), node]);
    children(node, inspect);
  }
  inspect(parsed);
  const range = (first, last) => ({start: tokens[first].range.startOffset - 2, end: tokens[last].range.endOffset - 2});
  function store(statement) {
    const a = statement?.kind === 'ExpressionStatement' && statement.expression;
    if (a?.kind !== 'AssignmentExpression' || a.operator !== '=' || a.left?.kind !== 'Identifier') return null;
    const first = starts.get(statement.range?.startOffset);
    if (tokens[first]?.text !== a.left.name || tokens[first + 1]?.text !== '=') return null;
    let last = first + 2;
    while (last < tokens.length && tokens[last].text !== ';' && tokens[last].text !== '}') {
      if (closes.has(last)) last = closes.get(last);
      last++;
    }
    return tokens[last]?.text === ';' ? {name: a.left.name, expression: a.right, first, last, rhs: range(first + 2, last - 1)} : null;
  }
  const assignments = [];
  for (const frame of frames) {
    const body = frame.statement;
    if (body?.kind !== 'BlockStatement' || body.statements.length !== 2) continue;
    const branch = body.statements[0], fallback = store(body.statements[1]);
    if (branch.kind !== 'IfStatement' || branch.alternate || branch.consequent?.kind !== 'BlockStatement'
        || branch.consequent.statements.length !== 2 || !fallback) continue;
    const provisional = store(branch.consequent.statements[0]), guard = branch.consequent.statements[1];
    if (!provisional || guard.kind !== 'IfStatement' || guard.alternate || provisional.name !== fallback.name) continue;
    const jumpBlock = guard.consequent?.kind === 'BlockStatement';
    const jump = jumpBlock && guard.consequent.statements.length === 1 ? guard.consequent.statements[0] : guard.consequent;
    if (jump?.kind !== 'BreakStatement' || jump.label !== frame.label
        || references.get(frame.label)?.length !== 1 || references.get(frame.label)[0] !== jump) continue;
    const first = starts.get(frame.range?.startOffset), open = first + 2, close = closes.get(open);
    const test = starts.get(branch.range?.startOffset), testClose = closes.get(test + 1);
    const yesOpen = testClose + 1, yesClose = closes.get(yesOpen);
    const keep = starts.get(guard.range?.startOffset), keepClose = closes.get(keep + 1);
    const jumpFirst = starts.get(jump.range?.startOffset), jumpLast = jumpFirst + 2;
    const guardEnd = jumpBlock ? closes.get(keepClose + 1) : jumpLast;
    if (tokens[first]?.text !== frame.label || tokens[first + 1]?.text !== ':' || tokens[open]?.text !== '{' || close === undefined
        || test !== open + 1 || tokens[test]?.text !== 'if' || tokens[test + 1]?.text !== '(' || testClose === undefined
        || tokens[yesOpen]?.text !== '{' || provisional.first !== yesOpen + 1 || keep !== provisional.last + 1
        || tokens[keep]?.text !== 'if' || tokens[keep + 1]?.text !== '(' || keepClose === undefined
        || tokens[jumpFirst]?.text !== 'break' || tokens[jumpFirst + 1]?.text !== frame.label || tokens[jumpLast]?.text !== ';'
        || (jumpBlock ? tokens[keepClose + 1]?.text !== '{' || jumpFirst !== keepClose + 2 || guardEnd !== jumpLast + 1 : jumpFirst !== keepClose + 1)
        || yesClose !== guardEnd + 1 || fallback.first !== yesClose + 1 || close !== fallback.last + 1) continue;
    const local = locals.get(provisional.name), site = tokens[test].range.startOffset;
    if (!local || counts.get(provisional.name) !== 1 || site < local.start || tokens[close].range.endOffset > local.end
        || tokens[close].range.endOffset - tokens[first].range.startOffset > 40000
        || pureType(guard.condition, site) !== 'boolean' || reads(guard.condition, provisional.name)
        || reads(fallback.expression, provisional.name)) continue;
    const valueType = pureType(provisional.expression, site);
    if (!valueType || valueType !== pureType(fallback.expression, site)
        || (local.type === 'boolean') !== (valueType === 'boolean')) continue;
    assignments.push({range: range(first, close), nameRange: range(provisional.first, provisional.first),
      discardedNameRange: range(fallback.first, fallback.first), conditionRange: range(test + 1, testClose),
      guardRange: range(keep + 1, keepClose), provisionalRange: provisional.rhs, fallbackRange: fallback.rhs,
      transferRange: range(jumpFirst, jumpLast), labelRange: range(first, first), variable: provisional.name,
      localType: local.type, valueType, narrowCast: ['byte', 'short', 'char'].includes(local.type) && valueType !== local.type,
      declarationRange: {start: local.declarationStart - 2, end: local.declarationEnd - 2}, blocksRemoved: 2 + Number(jumpBlock)});
    if (assignments.length > 256) return unchanged();
  }
  if (!assignments.length) return unchanged();
  assignments.sort((a, b) => a.range.start - b.range.start);
  if (assignments.some((a, i) => i && assignments[i - 1].range.end > a.range.start)) return unchanged();
  let output = source;
  for (const a of assignments.slice().reverse()) {
    const slice = r => source.slice(r.start, r.end);
    const choice = slice(a.conditionRange) + ' && ' + slice(a.guardRange) + ' ? (' + slice(a.provisionalRange) + ') : (' + slice(a.fallbackRange) + ')';
    const text = slice(a.nameRange) + ' = ' + (a.narrowCast ? '(' + a.localType + ') (' + choice + ')' : choice) + ';';
    output = output.slice(0, a.range.start) + text + output.slice(a.range.end);
  }
  return {source: output, assignmentsFolded: assignments.length, labelsRemoved: assignments.length,
    blocksRemoved: assignments.reduce((n, a) => n + a.blocksRemoved, 0),
    ...(retainDiagnostics ? {diagnostics: {assignments}} : {})};
}

module.exports = {foldGuardedLocalAssignments, floatingLiteralType};
