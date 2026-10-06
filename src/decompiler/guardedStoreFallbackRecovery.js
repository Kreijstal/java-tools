'use strict';
const {primitiveExpressionProof} = require('./primitiveExpressionProof');

// Preserve an unstable condition/guard once. A bounded sequence of integral or
// boolean stores can occupy exclusive arms, so no selector or predicate copy is
// needed. Only terminal plain-block/if corridors may lead to the frame exit.
function foldGuardedStoreFallbacks(source, proof, {parameters = [], ownedFields = null, retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, framesRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children, labelCounts} = proof;
  if (labelCounts.size > 256 || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  const primitive = primitiveExpressionProof(proof, parameters);
  if (!primitive) return unchanged();
  const supported = new Set(['boolean', 'byte', 'short', 'char', 'int', 'long']);
  const fields = new Map();
  if (ownedFields !== null) {
    if (!ownedFields || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(ownedFields.owner || '') || !Array.isArray(ownedFields.fields) || ownedFields.fields.length > 4096 || ownedFields.classQualifierUnshadowed !== undefined && typeof ownedFields.classQualifierUnshadowed !== 'boolean') return unchanged();
    for (const field of ownedFields.fields) {
      if (!field || !/^[A-Za-z_$][\w$]*$/.test(field.name || '') || typeof field.type !== 'string' || typeof field.static !== 'boolean' || fields.has(field.name)) return unchanged();
      fields.set(field.name, field);
    }
  }
  const parents = new Map(), references = new Map(), frames = [], blocks = [];
  let refused = false;
  function walk(node, parent = null, depth = 0) {
    if (depth > 128) {refused = true; return;}
    parents.set(node, parent);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass|Pattern/.test(node.kind || '') || node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (node.kind === 'LabeledStatement') frames.push(node);
    if (node.kind === 'BlockStatement') blocks.push(node);
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind) && node.label) references.set(node.label, [...(references.get(node.label) || []), node]);
    children(node, child => walk(child, node, depth + 1));
  }
  walk(parsed); if (refused) return unchanged();
  const range = (a, b) => ({start: tokens[a].range.startOffset - 2, end: tokens[b].range.endOffset - 2});
  const bounds = node => {const open = starts.get(node?.range?.startOffset), close = closes.get(open); return node?.kind === 'BlockStatement' && tokens[open]?.text === '{' && tokens[close]?.text === '}' ? {open, close} : null;};
  const bare = node => {while (node?.kind === 'ParenthesizedExpression') node = node.expression; return node;};
  function valueType(node, site) {
    const inferred = primitive.pureType(node, site);
    if (supported.has(inferred)) return inferred;
    node = bare(node);
    if (node?.kind === 'Identifier' && !primitive.counts.has(node.name) && !primitive.formals.has(node.name)) return fields.get(node.name)?.type;
    if (node?.kind === 'FieldAccessExpression') {
      const target = bare(node.target), field = fields.get(node.name);
      if (target?.kind === 'ThisExpression' || target?.kind === 'Identifier' && target.name === ownedFields?.owner && ownedFields.classQualifierUnshadowed === true && !fields.has(ownedFields.owner) && field?.static && !primitive.counts.has(target.name) && !primitive.formals.has(target.name)) return field?.type;
    }
    return null;
  }
  function simpleValue(node, site) {
    node = bare(node);
    return supported.has(valueType(node, site)) && (['Identifier', 'LiteralExpression', 'FieldAccessExpression'].includes(node?.kind) || node?.kind === 'UnaryExpression' && node.prefix === true && ['+', '-'].includes(node.operator) && bare(node.operand)?.kind === 'LiteralExpression');
  }
  function simpleStore(statement) {
    const store = statement?.expression, destination = bare(store?.left), site = statement?.range?.startOffset;
    return statement?.kind === 'ExpressionStatement' && store?.kind === 'AssignmentExpression' && store.operator === '=' && ['Identifier', 'FieldAccessExpression'].includes(destination?.kind) && supported.has(valueType(destination, site)) && simpleValue(store.right, site);
  }
  function corridor(block, frame) {
    const kinds = []; let current = block;
    while (current !== frame.statement) {
      const parent = parents.get(current);
      if (parent?.kind === 'BlockStatement' && parent.statements.at(-1) === current || parent?.kind === 'IfStatement' && [parent.consequent, parent.alternate].includes(current)) {kinds.push(parent.kind); current = parent;}
      else return null;
    }
    return kinds;
  }
  for (const frame of frames) {
    const body = bounds(frame.statement), refs = references.get(frame.label), label = starts.get(frame.range?.startOffset);
    if (!body || refs?.length !== 1 || refs[0].kind !== 'BreakStatement' || tokens[label]?.text !== frame.label || tokens[label + 1]?.text !== ':' || label + 2 !== body.open || tokens[body.close].range.endOffset - tokens[label].range.startOffset > 40000) continue;
    for (const block of blocks) {
      const corridorKinds = corridor(block, frame), container = bounds(block);
      if (!corridorKinds || !container) continue;
      for (let index = Math.max(0, block.statements.length - 9); index < block.statements.length - 1; index++) {
        const branch = block.statements[index], arm = bounds(branch?.consequent), fallback = block.statements.slice(index + 1);
        if (branch?.kind !== 'IfStatement' || branch.alternate || !arm || fallback.length > 8 || !fallback.every(simpleStore)) continue;
        const prefix = branch.consequent.statements.slice(0, -1), guard = branch.consequent.statements.at(-1);
        if (!prefix.length || prefix.some(statement => statement.kind === 'LocalVariableDeclarationStatement') || guard?.kind !== 'IfStatement' || guard.alternate) continue;
        const braced = guard.consequent?.kind === 'BlockStatement', jump = braced && guard.consequent.statements.length === 1 ? guard.consequent.statements[0] : guard.consequent;
        if (jump !== refs[0]) continue;
        const first = starts.get(branch.range?.startOffset), conditionClose = closes.get(first + 1), keep = starts.get(guard.range?.startOffset), keepClose = closes.get(keep + 1), jumpFirst = starts.get(jump.range?.startOffset), jumpLast = jumpFirst + 2, guardLast = braced ? closes.get(keepClose + 1) : jumpLast, fall = starts.get(fallback[0].range?.startOffset);
        if (tokens[first]?.text !== 'if' || tokens[first + 1]?.text !== '(' || conditionClose + 1 !== arm.open || tokens[keep]?.text !== 'if' || tokens[keep + 1]?.text !== '(' || keepClose === undefined || tokens[jumpFirst]?.text !== 'break' || tokens[jumpFirst + 1]?.text !== frame.label || tokens[jumpLast]?.text !== ';' || (braced ? tokens[keepClose + 1]?.text !== '{' || jumpFirst !== keepClose + 2 || guardLast !== jumpLast + 1 : jumpFirst !== keepClose + 1) || arm.close !== guardLast + 1 || fall !== arm.close + 1) continue;
        const fallbackRange = range(fall, container.close - 1);
        if (tokens[container.close - 1]?.text !== ';' || container.close - fall > 128 || fallbackRange.end - fallbackRange.start > 1024) continue;
        const keepFrame = parents.get(frame)?.kind !== 'BlockStatement' || frame.statement.statements.some(statement => statement.kind === 'LocalVariableDeclarationStatement');
        const indentAt = offset => {const value = source.slice(source.lastIndexOf('\n', offset - 1) + 1, offset); return /^[ \t]*$/.test(value) ? value : null;};
        const frameIndent = indentAt(tokens[label].range.startOffset - 2), branchIndent = indentAt(tokens[first].range.startOffset - 2), guardIndent = indentAt(tokens[keep].range.startOffset - 2), multiline = frameIndent !== null && branchIndent !== null && guardIndent !== null;
        const contentStart = keepFrame ? tokens[body.open].range.startOffset - 2 : tokens[starts.get(frame.statement.statements[0].range.startOffset)].range.startOffset - 2, contentEnd = keepFrame ? tokens[body.close].range.endOffset - 2 : tokens[body.close].range.startOffset - 2;
        const segments = [
          {range: {start: contentStart, end: tokens[keep].range.startOffset - 2}},
          {text: 'if (!'}, {range: range(keep + 1, keepClose)}, {text: ') {' + (multiline ? '\n' + guardIndent + '  ' : '')},
          {range: fallbackRange, copy: true, indent: multiline ? guardIndent.length + 2 - branchIndent.length : 0},
          {text: multiline ? '\n' + guardIndent + '}\n' + branchIndent : '}'}, {range: range(arm.close, arm.close)},
          {text: ' else {' + (multiline ? '\n' + branchIndent + '  ' : '')}, {range: fallbackRange, indent: multiline ? 2 : 0},
          {text: multiline ? '\n' + branchIndent + '}' : '}'}, {range: {start: fallbackRange.end, end: contentEnd}},
        ];
        let text = segments.map(segment => segment.text ?? source.slice(segment.range.start, segment.range.end).replace(/\n([ \t]*)(?=\S)/g, (_, indent) => '\n' + ' '.repeat(segment.indent || 0) + indent)).join(''), dedent = null;
        if (!keepFrame && multiline) {
          const contentIndent = indentAt(contentStart);
          if (contentIndent !== null && contentIndent.startsWith(frameIndent) && contentIndent.length > frameIndent.length) {dedent = {indent: contentIndent, delta: contentIndent.length - frameIndent.length}; text = text.split('\n').map((line, i) => i && line.startsWith(contentIndent) ? line.slice(dedent.delta) : line).join('\n');}
          text = text.trimEnd();
        }
        const editRange = range(label, body.close);
        return {source: source.slice(0, editRange.start) + text + source.slice(editRange.end), framesRecovered: 1, fallbackAssignmentsCopied: fallback.length, fallbackIdentifierCopiesAdded: tokens.slice(fall, container.close).filter(token => token.kind === 'identifier').length,
          ...(retainDiagnostics ? {diagnostics: {range: editRange, segments, dedent, label: frame.label, frameScopeRetained: keepFrame, corridorKinds, containerRange: range(container.open, container.close), branchRange: range(first, arm.close), conditionRange: range(first + 1, conditionClose), guardRange: range(keep + 1, keepClose), jumpRange: range(jumpFirst, jumpLast), fallbackRange, prefixStatements: prefix.length}} : {})};
      }
    }
  }
  return unchanged();
}
module.exports = {foldGuardedStoreFallbacks};
