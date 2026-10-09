'use strict';

const {primitiveExpressionProof} = require('./primitiveExpressionProof');
const {floatingLiteralType} = require('./guardedLocalAssignmentRecovery');

// If a total guard cannot observe the provisional primitive stores, evaluate
// it before them and select the complete assignment sequence with an if/else.
// A discarded sequence must be total, and fallback values cannot observe it.
function foldGuardedAssignmentSequences(source, proof, {parameters = [], retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, sequencesFolded: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  if (labelCounts.size > 256 || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  const primitive = primitiveExpressionProof(proof, parameters, floatingLiteralType);
  if (!primitive) return unchanged();
  const {pureType, counts, locals, formals, reads} = primitive, frames = [], references = new Map();
  function walk(node) {
    if (node.kind === 'LabeledStatement') frames.push(node);
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind) && node.label)
      references.set(node.label, [...(references.get(node.label) || []), node]);
    children(node, walk);
  }
  walk(parsed);
  const range = (start, end) => ({start: start - 2, end: end - 2});
  function store(statement) {
    const expression = statement?.kind === 'ExpressionStatement' && statement.expression;
    if (expression?.kind !== 'AssignmentExpression' || expression.operator !== '=' || expression.left?.kind !== 'Identifier') return null;
    const first = starts.get(statement.range?.startOffset);
    if (tokens[first]?.text !== expression.left.name || tokens[first + 1]?.text !== '=') return null;
    let last = first + 2;
    while (last < tokens.length && tokens[last].text !== ';' && tokens[last].text !== '}') {
      if (closes.has(last)) last = closes.get(last);
      last++;
    }
    return tokens[last]?.text === ';' ? {name: expression.left.name, expression: expression.right, first, last,
      nameRange: range(tokens[first].range.startOffset, tokens[first].range.endOffset),
      valueRange: range(tokens[first + 2].range.startOffset, tokens[last - 1].range.endOffset)} : null;
  }
  const selections = [];
  for (const frame of frames) {
    const body = frame.statement;
    if (body?.kind !== 'BlockStatement' || body.statements.length < 3 || body.statements.length > 17) continue;
    const branch = body.statements[0], fallback = body.statements.slice(1).map(store);
    if (branch.kind !== 'IfStatement' || branch.alternate || branch.consequent?.kind !== 'BlockStatement'
        || branch.consequent.statements.length !== body.statements.length || fallback.some(item => !item)) continue;
    const provisional = branch.consequent.statements.slice(0, -1).map(store), guard = branch.consequent.statements.at(-1);
    if (provisional.some(item => !item) || guard.kind !== 'IfStatement' || guard.alternate) continue;
    const names = new Set(provisional.map(item => item.name));
    if (names.size !== provisional.length || new Set(fallback.map(item => item.name)).size !== names.size
        || fallback.some(item => !names.has(item.name))) continue;
    const braced = guard.consequent?.kind === 'BlockStatement';
    const jump = braced && guard.consequent.statements.length === 1 ? guard.consequent.statements[0] : guard.consequent;
    if (jump?.kind !== 'BreakStatement' || jump.label !== frame.label || references.get(frame.label)?.length !== 1
        || references.get(frame.label)[0] !== jump) continue;
    const first = starts.get(frame.range?.startOffset), open = first + 2, close = closes.get(open);
    const test = starts.get(branch.range?.startOffset), testClose = closes.get(test + 1), yesOpen = testClose + 1, yesClose = closes.get(yesOpen);
    const keep = starts.get(guard.range?.startOffset), keepClose = closes.get(keep + 1);
    const jumpFirst = starts.get(jump.range?.startOffset), jumpLast = jumpFirst + 2, guardLast = braced ? closes.get(keepClose + 1) : jumpLast;
    if (tokens[first]?.text !== frame.label || tokens[first + 1]?.text !== ':' || tokens[open]?.text !== '{' || close === undefined
        || test !== open + 1 || tokens[test]?.text !== 'if' || tokens[test + 1]?.text !== '(' || testClose === undefined
        || tokens[yesOpen]?.text !== '{' || provisional[0].first !== yesOpen + 1 || keep !== provisional.at(-1).last + 1
        || tokens[keep]?.text !== 'if' || tokens[keep + 1]?.text !== '(' || keepClose === undefined
        || tokens[jumpFirst]?.text !== 'break' || tokens[jumpFirst + 1]?.text !== frame.label || tokens[jumpLast]?.text !== ';'
        || (braced ? tokens[keepClose + 1]?.text !== '{' || jumpFirst !== keepClose + 2 || guardLast !== jumpLast + 1 : jumpFirst !== keepClose + 1)
        || yesClose !== guardLast + 1 || fallback[0].first !== yesClose + 1 || close !== fallback.at(-1).last + 1
        || [...provisional, ...fallback].some((item, index, all) => index && index !== provisional.length && item.first !== all[index - 1].last + 1)) continue;
    const site = tokens[test].range.startOffset;
    if (tokens[close].range.endOffset - tokens[first].range.startOffset > 40000 || pureType(guard.condition, site) !== 'boolean') continue;
    const destinations = [];
    let refused = false;
    for (const name of names) {
      const local = locals.get(name), formal = formals.get(name), isFormal = !counts.has(name) && typeof formal === 'string';
      if ((!local || counts.get(name) !== 1 || site < local.start || tokens[close].range.endOffset > local.end) && !isFormal
          || reads(guard.condition, name) || fallback.some(item => reads(item.expression, name))) {refused = true; break;}
      destinations.push({name, type: isFormal ? formal : local.type, formal: isFormal,
        ...(isFormal ? {} : {declarationRange: range(local.declarationStart, local.declarationEnd)})});
    }
    if (refused || [...provisional, ...fallback].some(item => !pureType(item.expression, site))) continue;
    const selection = {range: range(tokens[first].range.startOffset, tokens[close].range.endOffset),
      conditionRange: range(tokens[test + 1].range.startOffset, tokens[testClose].range.endOffset),
      guardRange: range(tokens[keep + 1].range.startOffset, tokens[keepClose].range.endOffset),
      provisionalRange: range(tokens[provisional[0].first].range.startOffset, tokens[provisional.at(-1).last].range.endOffset),
      fallbackRange: range(tokens[fallback[0].first].range.startOffset, tokens[fallback.at(-1).last].range.endOffset),
      transferRange: range(tokens[jumpFirst].range.startOffset, tokens[jumpLast].range.endOffset),
      label: frame.label, destinations, provisional, fallback};
    selections.push(selection); if (selections.length > 256) return unchanged();
  }
  if (!selections.length) return unchanged();
  selections.sort((a, b) => a.range.start - b.range.start);
  if (selections.some((item, index) => index && selections[index - 1].range.end > item.range.start)) return unchanged();
  let output = source;
  for (const item of selections.slice().reverse()) {
    const slice = r => source.slice(r.start, r.end);
    const lineStart = source.lastIndexOf('\n', item.range.start - 1) + 1, indent = source.slice(lineStart, item.range.start);
    const multiline = /^[ \t]*$/.test(indent) && slice(item.range).includes('\n');
    const body = r => slice(r).split('\n').map((line, index) => index ? line.trimStart() : line).join('\n' + indent + '  ');
    const text = multiline ? 'if (' + slice(item.conditionRange) + ' && ' + slice(item.guardRange) + ') {\n' + indent + '  '
      + body(item.provisionalRange) + '\n' + indent + '} else {\n' + indent + '  ' + body(item.fallbackRange) + '\n' + indent + '}'
      : 'if (' + slice(item.conditionRange) + ' && ' + slice(item.guardRange) + ') {' + slice(item.provisionalRange) + '} else {' + slice(item.fallbackRange) + '}';
    output = output.slice(0, item.range.start) + text + output.slice(item.range.end);
  }
  return {source: output, sequencesFolded: selections.length, labelsRemoved: selections.length,
    assignmentsSelected: selections.reduce((sum, item) => sum + item.destinations.length, 0),
    ...(retainDiagnostics ? {diagnostics: {selections}} : {})};
}

module.exports = {foldGuardedAssignmentSequences};
