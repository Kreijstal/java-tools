'use strict';

const {primitiveExpressionProof} = require('./primitiveExpressionProof');
const {negateControlCondition} = require('./guardedAbruptExitRecovery');

// Keep each prefix/fallback action once, replacing its single labeled skip by
// ordinary conditions. A repeated outer condition must be total and invariant
// across the prefix; an empty prefix needs no repetition or purity assumption.
// Optional terminal containers preserve their complete scopes. Other exits keep
// their original label until the final reference is recovered.
function foldStableGuardedFallbacks(source, proof, {parameters = [], fpStrict = false, retainDiagnostics = false, nestedContainers = false, preserveSharedFrames = false} = {}) {
  const unchanged = () => ({source, framesRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || typeof fpStrict !== 'boolean' || typeof nestedContainers !== 'boolean' || typeof preserveSharedFrames !== 'boolean' || source.length > 400000) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  if (labelCounts.size > 256 || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  const primitive = primitiveExpressionProof(proof, parameters);
  if (!primitive) return unchanged();
  const frames = [], blocks = [], references = new Map(), parents = new Map();
  let refused = false;
  function walk(node, visit, parent = null) { visit(node, parent); children(node, child => walk(child, visit, node)); }
  walk(parsed, (node, parent) => {
    parents.set(node, parent);
    if (node.kind === 'LabeledStatement') frames.push(node);
    if (node.kind === 'BlockStatement') blocks.push(node);
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind) && node.label)
      references.set(node.label, [...(references.get(node.label) || []), node]);
    if (node.kind === 'ExpressionStatement' && !['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(node.expression?.kind)
        && !(node.expression?.kind === 'UnaryExpression' && ['++', '--'].includes(node.expression.operator))) refused = true;
  });
  if (refused) return unchanged();
  const range = (start, end) => ({start: start - 2, end: end - 2});
  const unparen = node => {while (node?.kind === 'ParenthesizedExpression') node = node.expression; return node;};
  const extent = node => {
    const open = starts.get(node?.range?.startOffset), close = closes.get(open);
    return node?.kind === 'BlockStatement' && tokens[open]?.text === '{' && tokens[close]?.text === '}' ? {open, close} : null;
  };
  function negative(node, open, close, copy) {
    const start = tokens[open].range.endOffset, end = tokens[close].range.startOffset;
    const content = wrapped.slice(start, end), text = negateControlCondition(node, open, close, proof);
    if (text === '!(' + content + ')') return [{text: '!('}, {range: range(start, end), copy}, {text: ')'}];
    let offset = 0; while (offset < content.length && content[offset] === text[offset]) offset++;
    const old = content.slice(offset, offset + 2), next = text.slice(offset, offset + 2);
    if (content.length !== text.length || !['==', '!='].includes(old) || !['==', '!='].includes(next)
        || old === next || content.slice(offset + 2) !== text.slice(offset + 2)
        || tokens[starts.get(start + offset)]?.text !== old) return null;
    return [{range: range(start, end), copy, replacements: [{range: range(start + offset, start + offset + 2), text: next}]}];
  }
  for (const frame of frames) {
    const body = frame.statement, bounds = extent(body), refs = references.get(frame.label);
    if (!bounds || !refs?.length || refs.length > 128 || !preserveSharedFrames && refs.length !== 1 || refs.some(jump => jump.kind !== 'BreakStatement')) continue;
    const label = starts.get(frame.range?.startOffset);
    if (tokens[label]?.text !== frame.label || tokens[label + 1]?.text !== ':' || label + 2 !== bounds.open
        || tokens[bounds.close].range.endOffset - tokens[label].range.startOffset > 40000) continue;
    for (const container of nestedContainers ? blocks : [body]) {
      const containerBounds = extent(container); if (!containerBounds) continue;
      let current = container; const corridorKinds = [];
      while (current !== body) {
        const parent = parents.get(current);
        if (parent?.kind === 'BlockStatement' && parent.statements.at(-1) === current
            || parent?.kind === 'IfStatement' && [parent.consequent, parent.alternate].includes(current)) {
          corridorKinds.push(parent.kind); current = parent;
        } else break;
      }
      if (current !== body) continue;
      const statements = container.statements;
      for (let index = 0; index < statements.length - 1; index++) {
        const branch = statements[index], arm = extent(branch.consequent);
        if (branch.kind !== 'IfStatement' || branch.alternate || !arm) continue;
        const prefix = branch.consequent.statements.slice(0, -1), guard = branch.consequent.statements.at(-1);
        if (guard?.kind !== 'IfStatement' || guard.alternate) continue;
        const braced = guard.consequent?.kind === 'BlockStatement';
        const jump = braced && guard.consequent.statements.length === 1 ? guard.consequent.statements[0] : guard.consequent;
        if (!refs.includes(jump)) continue;
        const first = starts.get(branch.range?.startOffset), conditionClose = closes.get(first + 1);
        const keep = starts.get(guard.range?.startOffset), keepClose = closes.get(keep + 1);
        const jumpStart = starts.get(jump.range?.startOffset), jumpEnd = jumpStart + 2;
        const guardEnd = braced ? closes.get(keepClose + 1) : jumpEnd;
        const fallbackStart = starts.get(statements[index + 1].range?.startOffset);
        if (tokens[first]?.text !== 'if' || tokens[first + 1]?.text !== '(' || conditionClose === undefined || conditionClose + 1 !== arm.open
            || tokens[keep]?.text !== 'if' || tokens[keep + 1]?.text !== '(' || keepClose === undefined
            || tokens[jumpStart]?.text !== 'break' || tokens[jumpStart + 1]?.text !== frame.label || tokens[jumpEnd]?.text !== ';'
            || (braced ? tokens[keepClose + 1]?.text !== '{' || jumpStart !== keepClose + 2 || guardEnd !== jumpEnd + 1 : jumpStart !== keepClose + 1)
            || arm.close !== guardEnd + 1 || fallbackStart !== arm.close + 1) continue;
        const conditionReads = new Set(), writes = new Set(), declared = new Set(), guardReads = new Set();
        let conditionReadOccurrences = 0;
        let uncertainFloatingArithmetic = false;
        walk(branch.condition, node => {
          if (node.kind === 'Identifier') {conditionReads.add(node.name); conditionReadOccurrences++;}
          // Java8-16 may choose extended exponents independently at arithmetic
          // sites (JLS5.1.13). Stored-value comparisons are stable; arithmetic
          // needs an actual FP-strict source context, never a guessed JVM mode.
          if (!fpStrict && node.kind === 'BinaryExpression' && ['+', '-', '*'].includes(node.operator)
              && ['float', 'double'].includes(primitive.pureType(node, tokens[first].range.startOffset))) uncertainFloatingArithmetic = true;
        });
        for (const statement of prefix) walk(statement, node => {
          const destination = node.kind === 'AssignmentExpression' ? unparen(node.left)
            : node.kind === 'UnaryExpression' && ['++', '--'].includes(node.operator) ? unparen(node.operand) : null;
          if (destination?.kind === 'Identifier') writes.add(destination.name);
          if (node.kind === 'VariableDeclarator') declared.add(node.name);
        });
        walk(guard.condition, node => {if (node.kind === 'Identifier') guardReads.add(node.name);});
        const copied = prefix.length > 0;
        if (copied && (primitive.pureType(branch.condition, tokens[first].range.startOffset) !== 'boolean'
            || uncertainFloatingArithmetic || [...conditionReads].some(name => writes.has(name))) || [...guardReads].some(name => declared.has(name))) continue;
        const outerNegative = negative(branch.condition, first + 1, conditionClose, copied);
        const guardNegative = negative(guard.condition, keep + 1, keepClose, false);
        if (!outerNegative || !guardNegative) continue;
        const lineStart = wrapped.lastIndexOf('\n', tokens[first].range.startOffset - 1) + 1;
        const indent = wrapped.slice(lineStart, tokens[first].range.startOffset);
        const multiline = /^[ \t]*$/.test(indent) && wrapped.slice(tokens[label].range.startOffset, tokens[bounds.close].range.endOffset).includes('\n');
        const labelRetained = refs.length > 1;
        const keepFrame = labelRetained || container !== body || parents.get(frame)?.kind !== 'BlockStatement'
          || statements.slice(0, index).some(statement => statement.kind === 'LocalVariableDeclarationStatement');
        const segments = [];
        if (keepFrame) segments.push({range: range(tokens[labelRetained ? label : bounds.open].range.startOffset, tokens[first].range.startOffset)});
        else {
          const prefixStart = multiline ? tokens[starts.get(statements[0].range.startOffset)].range.startOffset : tokens[bounds.open].range.endOffset;
          segments.push({range: range(prefixStart, tokens[first].range.startOffset)});
        }
        if (copied) segments.push({range: range(tokens[first].range.startOffset, tokens[keep].range.startOffset), trimEnd: true},
          {text: multiline ? '\n' + indent : ''}, {range: range(tokens[arm.close].range.startOffset, tokens[arm.close].range.endOffset)},
          {text: multiline ? '\n' + indent : ' '});
        segments.push({text: 'if ('}, ...outerNegative, {text: ' || '}, ...guardNegative, {text: ') {'},
          {range: range(tokens[arm.close].range.endOffset, tokens[containerBounds.close].range.startOffset), indent: multiline ? 2 : 0}, {text: '}'});
        if (container !== body) segments.push({range: range(tokens[containerBounds.close].range.startOffset, tokens[bounds.close].range.endOffset)});
        else if (keepFrame) segments.push({text: multiline ? '\n' + wrapped.slice(wrapped.lastIndexOf('\n', tokens[bounds.close].range.startOffset - 1) + 1, tokens[bounds.close].range.startOffset) : ' '},
          {range: range(tokens[bounds.close].range.startOffset, tokens[bounds.close].range.endOffset)});
        let text = segments.map(segment => {
          if (segment.text !== undefined) return segment.text;
          let value = source.slice(segment.range.start, segment.range.end);
          for (const replacement of (segment.replacements || []).slice().reverse()) value = value.slice(0, replacement.range.start - segment.range.start)
            + replacement.text + value.slice(replacement.range.end - segment.range.start);
          if (segment.trimEnd) value = value.trimEnd();
          if (segment.indent) value = value.replace(/\n([ \t]*)(?=\S)/g, '\n  $1').replace(/[ \t]*$/, indent);
          return value;
        }).join('');
        let dedent = null;
        if (!keepFrame && multiline) {
          const labelIndent = wrapped.slice(wrapped.lastIndexOf('\n', tokens[label].range.startOffset - 1) + 1, tokens[label].range.startOffset);
          if (/^[ \t]*$/.test(labelIndent) && indent.startsWith(labelIndent)) {
            dedent = {indent, delta: indent.length - labelIndent.length};
            text = text.split('\n').map((line, i) => i && line.startsWith(indent) ? line.slice(dedent.delta) : line).join('\n');
          }
        }
        const editRange = range(tokens[label].range.startOffset, tokens[bounds.close].range.endOffset);
        return {source: source.slice(0, editRange.start) + text + source.slice(editRange.end), framesRecovered: 1,
          labelsRemoved: Number(!labelRetained), conditionCopiesAdded: Number(copied), primitiveReadCopiesAdded: copied ? conditionReadOccurrences : 0,
          ...(retainDiagnostics ? {diagnostics: {range: editRange, segments, dedent, label: frame.label, copied,
            prefixStatements: prefix.length, frameScopeRetained: keepFrame, labelRetained, corridorKinds,
            containerRange: range(tokens[containerBounds.open].range.startOffset, tokens[containerBounds.close].range.endOffset),
            branchRange: range(tokens[first].range.startOffset, tokens[arm.close].range.endOffset),
            conditionRange: range(tokens[first + 1].range.endOffset, tokens[conditionClose].range.startOffset),
            guardRange: range(tokens[keep + 1].range.endOffset, tokens[keepClose].range.startOffset),
            jumpRange: range(tokens[jumpStart].range.startOffset, tokens[jumpEnd].range.endOffset)}} : {})};
      }
    }
  }
  return unchanged();
}

module.exports = {foldStableGuardedFallbacks};
