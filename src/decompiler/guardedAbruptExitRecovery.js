'use strict';

// A direct arm ending in `if (guard) break Frame; suffix; abrupt;` skips the
// frame's remainder on both paths. Express that remainder as the outer else,
// and keep the complete suffix and abrupt statement under the inverse guard.
// No suffix statement moves across another statement or protected boundary.
// Prefix locals retain their scope; suffix locals have no following arm work
// that could escape their new braces. The complete fallback stays together.
// If the fallback also exits this frame, keep its original label and braces:
// only the selected guarded jump disappears, never the fallback's destination.
function foldGuardedAbruptPlainBlockExits(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, framesRemoved: 0, jumpsRemoved: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean') return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  const parents = new Map(), targets = new Map(), references = new Map(), ends = new Map(), statementStarts = new Set();
  let refused = false;
  function collect(node) {
    if (node.kind?.endsWith('Statement') && node.range) statementStarts.add(node.range.startOffset);
    children(node, collect);
  }
  collect(parsed);
  function terminator(node) {
    const first = starts.get(node.range?.startOffset);
    if (first === undefined) return null;
    for (let index = first; index < tokens.length; index++) {
      if (index !== first && statementStarts.has(tokens[index].range.startOffset)) return null;
      if (tokens[index].text === ';') return index;
      if (tokens[index].text === '}') return null;
      if (closes.has(index)) index = closes.get(index);
    }
    return null;
  }
  function inspect(node, parent, labels = [], breaks = [], activeLoops = []) {
    parents.set(node, parent);
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      const target = node.label ? labels.slice().reverse().find(frame => frame.label === node.label)
        : node.kind === 'ContinueStatement' ? activeLoops.at(-1) : breaks.at(-1);
      const start = starts.get(node.range?.startOffset);
      if (!target || node.kind === 'ContinueStatement' && !(loops.has(target.kind) || loops.has(target.statement?.kind))
          || tokens[start]?.text !== (node.kind === 'BreakStatement' ? 'break' : 'continue')
          || node.label && tokens[start + 1]?.text !== node.label
          || tokens[start + (node.label ? 2 : 1)]?.text !== ';') refused = true;
      else {
        targets.set(node, target);
        if (!references.has(target)) references.set(target, []);
        references.get(target).push(node);
      }
    }
    if (['ExpressionStatement', 'ReturnStatement', 'ThrowStatement', 'AssertStatement', 'BreakStatement', 'ContinueStatement'].includes(node.kind)
        || node.kind === 'LocalVariableDeclarationStatement' && !(parent?.kind === 'ForStatement' && parent.initializer === node)) {
      const end = terminator(node);
      if (end === null) refused = true;
      else ends.set(node, end);
    }
    if (node.kind === 'ExpressionStatement') {
      const expression = node.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(expression?.kind)
          && !(expression?.kind === 'UnaryExpression' && ['++', '--'].includes(expression.operator))) refused = true;
    }
    children(node, child => inspect(child, node,
      node.kind === 'LabeledStatement' ? [...labels, node] : labels,
      loops.has(node.kind) || node.kind === 'SwitchStatement' ? [...breaks, node] : breaks,
      loops.has(node.kind) ? [...activeLoops, node] : activeLoops));
  }
  inspect(parsed, null);
  if (refused || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  function extent(node) {
    const open = starts.get(node?.range?.startOffset), close = closes.get(open);
    if (node?.kind !== 'BlockStatement' || tokens[open]?.text !== '{' || tokens[close]?.text !== '}') return null;
    if (!node.statements.length ? close !== open + 1
      : starts.get(node.statements[0].range?.startOffset) !== open + 1
        || node.statements.some(statement => {
          const start = starts.get(statement.range?.startOffset);
          return !(start > open && start < close);
        })) return null;
    return {open, close};
  }
  function negate(condition, open, close) {
    const first = tokens[open].range.endOffset, last = tokens[close].range.startOffset;
    while (condition?.kind === 'ParenthesizedExpression') condition = condition.expression;
    // Equality and inequality are exact logical complements, including NaNs,
    // nullable unboxing and effectful operands. Relational operators are not.
    if (condition?.kind === 'BinaryExpression' && ['==', '!='].includes(condition.operator)) {
      let begin = open + 1, end = close;
      while (tokens[begin]?.text === '(' && closes.get(begin) === end - 1) { begin++; end--; }
      const operators = [];
      for (let index = begin; index < end; index++) {
        if (closes.has(index)) { index = closes.get(index); continue; }
        if (tokens[index].text === condition.operator) operators.push(index);
      }
      if (operators.length === 1) {
        const operator = tokens[operators[0]];
        return wrapped.slice(first, operator.range.startOffset)
          + (condition.operator === '==' ? '!=' : '==') + wrapped.slice(operator.range.endOffset, last);
      }
    }
    return '!(' + wrapped.slice(first, last) + ')';
  }
  function find(node) {
    if (node.kind === 'LabeledStatement' && node.statement?.kind === 'BlockStatement'
        && references.get(node)?.length) {
      const frame = extent(node.statement), labelStart = starts.get(node.range?.startOffset);
      if (frame && tokens[labelStart]?.text === node.label && tokens[labelStart + 1]?.text === ':' && labelStart + 2 === frame.open) {
        const statements = node.statement.statements;
        for (let index = 0; index < statements.length - 1; index++) {
          const branch = statements[index], body = branch.consequent, arm = extent(body);
          if (branch.kind !== 'IfStatement' || branch.alternate || !arm || body.statements.length < 2) continue;
          // The selected reference must be a direct guarded break in this arm.
          // Any other references must be in the complete fallback, not the
          // prefix or effect arm. Their original enclosing frame stays labeled.
          const guardIndex = body.statements.findIndex(statement => {
            if (statement.kind !== 'IfStatement') return false;
            const consequent = statement.consequent;
            const jump = consequent?.kind === 'BlockStatement' && consequent.statements.length === 1
              ? consequent.statements[0] : consequent;
            return jump?.kind === 'BreakStatement' && targets.get(jump) === node;
          });
          if (guardIndex < 0 || guardIndex >= body.statements.length - 1) continue;
          const guard = body.statements[guardIndex], abrupt = body.statements.at(-1);
          const jump = guard?.consequent?.kind === 'BlockStatement' && guard.consequent.statements.length === 1
            ? guard.consequent.statements[0] : guard?.consequent;
          if (guard?.kind !== 'IfStatement' || guard.alternate || jump?.kind !== 'BreakStatement'
              || targets.get(jump) !== node
              || !['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'].includes(abrupt.kind)
              || targets.get(abrupt) === node) continue;
          const branchStart = starts.get(branch.range?.startOffset), headerEnd = closes.get(branchStart + 1);
          const guardStart = starts.get(guard.range?.startOffset), guardEnd = closes.get(guardStart + 1);
          const jumpStart = starts.get(jump.range?.startOffset), jumpEnd = ends.get(jump);
          const suffixStart = starts.get(body.statements[guardIndex + 1].range?.startOffset);
          const abruptStart = starts.get(abrupt.range?.startOffset), abruptEnd = ends.get(abrupt);
          const restStart = starts.get(statements[index + 1].range?.startOffset);
          const braced = guard.consequent.kind === 'BlockStatement';
          if (tokens[branchStart]?.text !== 'if' || tokens[branchStart + 1]?.text !== '(' || headerEnd + 1 !== arm.open
              || tokens[guardStart]?.text !== 'if' || tokens[guardStart + 1]?.text !== '(' || guardEnd === undefined
              || braced && (tokens[guardEnd + 1]?.text !== '{' || closes.get(guardEnd + 1) !== jumpEnd + 1)
              || jumpStart !== guardEnd + (braced ? 2 : 1)
              || suffixStart !== jumpEnd + (braced ? 2 : 1) || abruptStart < suffixStart
              || abruptEnd + 1 !== arm.close
              || restStart !== arm.close + 1) continue;
          if (references.get(node).some(reference => reference !== jump
              && (starts.get(reference.range.startOffset) < restStart
                || starts.get(reference.range.startOffset) >= frame.close))) continue;
          const keepLabel = references.get(node).length > 1;
          const predicate = negate(guard.condition, guardStart + 1, guardEnd);
          const suffixBytes = wrapped.slice(tokens[suffixStart].range.startOffset, tokens[abruptEnd].range.endOffset);
          const prefix = wrapped.slice(wrapped.lastIndexOf('\n', tokens[guardStart].range.startOffset - 1) + 1,
            tokens[guardStart].range.startOffset);
          const indent = /^[ \t]*$/.test(prefix) ? prefix : '';
          const multiline = indent && wrapped.slice(tokens[guardStart].range.startOffset, tokens[arm.close].range.endOffset).includes('\n');
          const transfer = multiline ? 'if (' + predicate + ') {\n' + indent + '  '
            + suffixBytes.replace(/\n([ \t]*)(?=\S)/g, '\n  $1') + '\n' + indent + '}'
            : 'if (' + predicate + ') { ' + suffixBytes + ' }';
          const branchBytes = wrapped.slice(tokens[branchStart].range.startOffset, tokens[guardStart].range.startOffset)
            + transfer + wrapped.slice(tokens[abruptEnd].range.endOffset, tokens[arm.close].range.endOffset);
          const remainder = wrapped.slice(tokens[arm.close].range.endOffset, tokens[frame.close].range.startOffset);
          const branchPrefix = wrapped.slice(wrapped.lastIndexOf('\n', tokens[branchStart].range.startOffset - 1) + 1,
            tokens[branchStart].range.startOffset);
          const branchIndent = /^[ \t]*$/.test(branchPrefix) ? branchPrefix : '';
          const tail = multiline ? remainder.replace(/\n([ \t]*)(?=\S)/g, '\n  $1').replace(/[ \t]*$/, branchIndent) : remainder;
          const framePrefix = wrapped.slice(tokens[frame.open].range.endOffset, tokens[branchStart].range.startOffset);
          const frameIndent = wrapped.slice(wrapped.lastIndexOf('\n', tokens[frame.close].range.startOffset - 1) + 1,
            tokens[frame.close].range.startOffset);
          // Only prefix declarations still need the old frame scope: arm
          // declarations keep their braces, and all fallback declarations are
          // confined to the complete else. A statement-position frame keeps
          // its braces so multiple prefix statements cannot escape an if/loop.
          const keepFrame = keepLabel || parents.get(node)?.kind !== 'BlockStatement'
            || statements.slice(0, index).some(statement => statement.kind === 'LocalVariableDeclarationStatement');
          let text = branchBytes + ' else {' + tail + '}';
          if (keepFrame) text = (keepLabel ? wrapped.slice(tokens[labelStart].range.startOffset, tokens[frame.open].range.startOffset) : '')
            + '{' + framePrefix + text + (multiline ? '\n' + frameIndent : ' ') + '}';
          else {
            const prefixStart = multiline ? tokens[starts.get(statements[0].range.startOffset)].range.startOffset
              : tokens[frame.open].range.endOffset;
            text = wrapped.slice(prefixStart, tokens[branchStart].range.startOffset) + text;
            const labelIndent = wrapped.slice(wrapped.lastIndexOf('\n', tokens[labelStart].range.startOffset - 1) + 1,
              tokens[labelStart].range.startOffset);
            if (multiline && /^[ \t]*$/.test(labelIndent) && branchIndent.startsWith(labelIndent)) {
              const delta = branchIndent.length - labelIndent.length;
              // Comments and text blocks were refused by the shared proof;
              // Java8 literal tokens cannot contain raw newlines. Only line
              // indentation changes as the nondeclaring frame disappears.
              text = text.split('\n').map((line, i) => i && line.startsWith(branchIndent) ? line.slice(delta) : line).join('\n');
            }
          }
          return {start: tokens[labelStart].range.startOffset, end: tokens[frame.close].range.endOffset,
            text, labelRetained: keepLabel,
            diagnostics: {label: node.label, abruptKind: abrupt.kind, predicate, frameScopeRetained: keepFrame,
              labelRetained: keepLabel,
              guardedSuffixStatements: body.statements.length - guardIndex - 1,
              labelRange: {start: tokens[labelStart].range.startOffset - 2, end: tokens[labelStart + 1].range.endOffset - 2},
              jumpRange: {start: tokens[jumpStart].range.startOffset - 2, end: tokens[jumpEnd].range.endOffset - 2}}};
        }
      }
    }
    let result;
    children(node, child => { if (!result) result = find(child); });
    return result;
  }
  const edit = find(parsed);
  if (!edit) return unchanged();
  return {source: (wrapped.slice(0, edit.start) + edit.text + wrapped.slice(edit.end)).slice(2, -2),
    framesRemoved: edit.labelRetained ? 0 : 1, jumpsRemoved: 1,
    ...(retainDiagnostics ? {diagnostics: edit.diagnostics} : {})};
}

module.exports = {foldGuardedAbruptPlainBlockExits};
