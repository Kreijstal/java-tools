'use strict';

// Share a bounded, declaration-free continuation between exclusive source arms.
// Every original expression executes once on its original paths. Only terminal
// block/if/label corridors are allowed; protected boundaries stay in place.
function foldSharedStatementFallbacks(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, guardsRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children, labelCounts} = proof;
  if (labelCounts.size > 256 || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  const parents = new Map(), refs = new Map(), frames = [], blocks = []; let refused = false;
  function walk(node, parent = null, depth = 0) {
    if (depth > 128) {refused = true; return;}
    parents.set(node, parent);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(node.kind || '') || node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (node.kind === 'LabeledStatement' && node.statement?.kind === 'BlockStatement') frames.push(node);
    if (node.kind === 'BlockStatement') blocks.push(node);
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind) && node.label) refs.set(node.label, [...(refs.get(node.label) || []), node]);
    children(node, child => walk(child, node, depth + 1));
  }
  walk(parsed); if (refused) return unchanged();
  const range = (a, b) => ({start: tokens[a].range.startOffset - 2, end: tokens[b].range.endOffset - 2});
  const bounds = node => {const open = starts.get(node?.range?.startOffset), close = closes.get(open); return node?.kind === 'BlockStatement' && tokens[open]?.text === '{' && tokens[close]?.text === '}' ? {open, close} : null;};
  for (const frame of frames) {
    const body = bounds(frame.statement), references = refs.get(frame.label), label = starts.get(frame.range?.startOffset);
    if (!body || !references?.length || references.length > 128 || references.some(jump => jump.kind !== 'BreakStatement') || tokens[label]?.text !== frame.label || tokens[label + 1]?.text !== ':' || label + 2 !== body.open || tokens[body.close].range.endOffset - tokens[label].range.startOffset > 40000) continue;
    for (const block of blocks) {
      const container = bounds(block); if (!container) continue;
      let current = block; const corridorKinds = [];
      while (current !== frame.statement) {
        const parent = parents.get(current);
        if (parent?.kind === 'BlockStatement' && parent.statements.at(-1) === current || parent?.kind === 'IfStatement' && [parent.consequent, parent.alternate].includes(current) || parent?.kind === 'LabeledStatement' && parent.statement === current) {corridorKinds.push(parent.kind); current = parent;}
        else break;
      }
      if (current !== frame.statement) continue;
      const statements = block.statements;
      for (let branchIndex = 0; branchIndex < statements.length - 1; branchIndex++) {
        const branch = statements[branchIndex], arm = bounds(branch?.consequent), suffix = statements.slice(branchIndex + 1);
        if (branch?.kind !== 'IfStatement' || branch.alternate || !arm || suffix.length > 8) continue;
        let leaves = 0, conditions = 0, nodes = 0;
        function supported(statement, depth = 0) {
          if (++nodes > 24 || depth > 4) return false;
          if (statement.kind === 'BlockStatement') return statement.statements.length > 0 && statement.statements.every(s => supported(s, depth + 1));
          if (statement.kind === 'IfStatement') return ++conditions <= 4 && supported(statement.consequent, depth + 1) && (!statement.alternate || supported(statement.alternate, depth + 1));
          if (statement.kind !== 'ExpressionStatement' || ++leaves > 8) return false;
          const e = statement.expression;
          return ['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(e?.kind) || e?.kind === 'UnaryExpression' && ['++', '--'].includes(e.operator);
        }
        if (!suffix.every(s => supported(s))) continue;
        const prefix = branch.consequent.statements.slice(0, -1), guard = branch.consequent.statements.at(-1);
        if (!prefix.length || prefix.some(statement => statement.kind === 'LocalVariableDeclarationStatement') || guard?.kind !== 'IfStatement' || guard.alternate) continue;
        const braced = guard.consequent?.kind === 'BlockStatement', jump = braced && guard.consequent.statements.length === 1 ? guard.consequent.statements[0] : guard.consequent;
        if (!references.includes(jump)) continue;
        const first = starts.get(branch.range?.startOffset), conditionClose = closes.get(first + 1), keep = starts.get(guard.range?.startOffset), keepClose = closes.get(keep + 1), jumpFirst = starts.get(jump.range?.startOffset), jumpLast = jumpFirst + 2, guardLast = braced ? closes.get(keepClose + 1) : jumpLast, fall = starts.get(suffix[0].range?.startOffset);
        if (tokens[first]?.text !== 'if' || tokens[first + 1]?.text !== '(' || conditionClose + 1 !== arm.open || tokens[keep]?.text !== 'if' || tokens[keep + 1]?.text !== '(' || keepClose === undefined || tokens[jumpFirst]?.text !== 'break' || tokens[jumpFirst + 1]?.text !== frame.label || tokens[jumpLast]?.text !== ';' || (braced ? tokens[keepClose + 1]?.text !== '{' || jumpFirst !== keepClose + 2 || guardLast !== jumpLast + 1 : jumpFirst !== keepClose + 1) || arm.close !== guardLast + 1 || fall !== arm.close + 1) continue;
        const fallbackRange = range(fall, container.close - 1);
        if (![';', '}'].includes(tokens[container.close - 1]?.text) || container.close - fall > 256 || fallbackRange.end - fallbackRange.start > 2048) continue;
        const labelRetained = references.length > 1, keepFrame = labelRetained || parents.get(frame)?.kind !== 'BlockStatement' || frame.statement.statements.some(statement => statement.kind === 'LocalVariableDeclarationStatement');
        const frameRange = range(label, body.close), contentStart = labelRetained ? frameRange.start : keepFrame ? tokens[body.open].range.startOffset - 2 : tokens[starts.get(frame.statement.statements[0].range.startOffset)].range.startOffset - 2, contentEnd = keepFrame ? frameRange.end : tokens[body.close].range.startOffset - 2;
        const indentAt = offset => {const value = source.slice(source.lastIndexOf('\n', offset - 1) + 1, offset); return /^[ \t]*$/.test(value) ? value : null;};
        const frameIndent = indentAt(frameRange.start), branchIndent = indentAt(tokens[first].range.startOffset - 2), guardIndent = indentAt(tokens[keep].range.startOffset - 2), fallIndent = indentAt(fallbackRange.start), multiline = frameIndent !== null && branchIndent !== null && guardIndent !== null && fallIndent !== null;
        const segments = [
          {range: {start: contentStart, end: tokens[keep].range.startOffset - 2}}, {text: 'if (!'}, {range: range(keep + 1, keepClose)}, {text: ') {' + (multiline ? '\n' + guardIndent + '  ' : '')},
          {range: fallbackRange, copy: true, indent: multiline ? guardIndent.length + 2 - fallIndent.length : 0}, {text: multiline ? '\n' + guardIndent + '}\n' + branchIndent : '}'}, {range: range(arm.close, arm.close)},
          {text: ' else {' + (multiline ? '\n' + branchIndent + '  ' : '')}, {range: fallbackRange, indent: multiline ? branchIndent.length + 2 - fallIndent.length : 0}, {text: multiline ? '\n' + branchIndent + '}' : '}'}, {range: {start: fallbackRange.end, end: contentEnd}},
        ];
        let text = segments.map(segment => segment.text ?? source.slice(segment.range.start, segment.range.end).replace(/\n([ \t]*)(?=\S)/g, (_, indent) => '\n' + ' '.repeat(segment.indent || 0) + indent)).join(''), dedent = null;
        if (!keepFrame && multiline) {const indent = indentAt(contentStart); if (indent !== null && indent.startsWith(frameIndent) && indent.length > frameIndent.length) {dedent = {indent, delta: indent.length - frameIndent.length}; text = text.split('\n').map((line, i) => i && line.startsWith(indent) ? line.slice(dedent.delta) : line).join('\n');} text = text.trimEnd();}
        return {source: source.slice(0, frameRange.start) + text + source.slice(frameRange.end), guardsRecovered: 1, labelsRemoved: Number(!labelRetained), sharedFramesRetained: Number(labelRetained), fallbackStatementSitesAdded: leaves, fallbackConditionsAdded: conditions, fallbackIdentifierCopiesAdded: tokens.slice(fall, container.close).filter(token => token.kind === 'identifier').length,
          ...(retainDiagnostics ? {diagnostics: {range: frameRange, segments, dedent, trimEnd: !keepFrame && multiline, label: frame.label, labelRetained, frameScopeRetained: keepFrame, containerRange: range(container.open, container.close), branchRange: range(first, arm.close), conditionRange: range(first + 1, conditionClose), guardRange: range(keep + 1, keepClose), jumpRange: range(jumpFirst, jumpLast), fallbackRange, fallbackStatements: suffix.length, fallbackLeaves: leaves, fallbackConditions: conditions, prefixStatements: prefix.length, corridorKinds}} : {})};
      }
    }
  }
  return unchanged();
}
module.exports = {foldSharedStatementFallbacks};
