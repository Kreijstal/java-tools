'use strict';

// A captured primitive integer can classify a transparent if ladder once.
// Keep all effectful actions and flag guards, in their original lexical order.
// Accept only paths that are contiguous runs or leave the existing plain label;
// never duplicate a shared action or assume another guard's value.
function recoverScalarIfDispatches(source, proof, {retainDiagnostics = false, nestedRegions = false} = {}) {
  const unchanged = () => ({source, dispatchesRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || typeof nestedRegions !== 'boolean'
      || source.length > 400000) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const loops = new Set(['WhileStatement', 'ForStatement', 'DoWhileStatement', 'EnhancedForStatement']);
  const parents = new Map(), targets = new Map(), locals = new Map(), names = new Map(), ends = new Map();
  const statementStarts = new Set();
  const walk = (node, visit) => { visit(node); children(node, child => walk(child, visit)); };
  walk(parsed, node => { if (node.kind?.endsWith('Statement') && node.range) statementStarts.add(node.range.startOffset); });
  let invalid = false;
  const strip = node => { while (node?.kind === 'ParenthesizedExpression') node = node.expression; return node; };
  function semicolon(node) {
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
  function inspect(node, parent, labels = [], breakFrames = [], activeLoops = []) {
    parents.set(node, parent);
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) invalid = true;
    if (['VariableDeclarator', 'FormalParameter'].includes(node.kind)) names.set(node.name, (names.get(node.name) || 0) + 1);
    if (node.kind === 'LocalVariableDeclarationStatement' && parent?.kind === 'BlockStatement'
        && node.variableType?.kind === 'PrimitiveType' && node.variableType.name === 'int' && !node.annotations?.length) {
      const close = closes.get(starts.get(parent.range?.startOffset)), end = semicolon(node);
      if (close !== undefined && end !== null) for (const variable of node.declarators)
        if (!variable.dimensions) locals.set(variable.name, {start: tokens[end].range.endOffset, end: tokens[close].range.startOffset});
    }
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      const target = node.label ? labels.slice().reverse().find(label => label.label === node.label)
        : node.kind === 'ContinueStatement' ? activeLoops.at(-1) : breakFrames.at(-1);
      const first = starts.get(node.range?.startOffset);
      if (!target || node.kind === 'ContinueStatement' && !(loops.has(target.kind) || loops.has(target.statement?.kind))
          || tokens[first]?.text !== (node.kind === 'BreakStatement' ? 'break' : 'continue')
          || node.label && tokens[first + 1]?.text !== node.label
          || tokens[first + (node.label ? 2 : 1)]?.text !== ';') invalid = true;
      else targets.set(node, target);
    }
    if (['ExpressionStatement', 'ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement', 'AssertStatement'].includes(node.kind)) {
      const end = semicolon(node); if (end === null) invalid = true; else ends.set(node, end);
    }
    if (node.kind === 'ExpressionStatement' && !['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(node.expression?.kind)
        && !(node.expression?.kind === 'UnaryExpression' && ['++', '--'].includes(node.expression.operator))) invalid = true;
    children(node, child => inspect(child, node,
      node.kind === 'LabeledStatement' ? [...labels, node] : labels,
      loops.has(node.kind) || node.kind === 'SwitchStatement' ? [...breakFrames, node] : breakFrames,
      loops.has(node.kind) ? [...activeLoops, node] : activeLoops));
  }
  inspect(parsed, null);
  if (invalid || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  function finish(node) {
    if (ends.has(node)) return ends.get(node);
    const first = starts.get(node.range?.startOffset);
    if (node.kind === 'BlockStatement') return closes.get(first);
    if (node.kind === 'EmptyStatement') return tokens[first]?.text === ';' ? first : null;
    if (node.kind === 'IfStatement') return finish(node.alternate || node.consequent);
    if (node.kind === 'SynchronizedStatement') return closes.get(closes.get(first + 1) + 1);
    if (node.kind === 'TryStatement') {
      let end = closes.get(first + 1);
      if (tokens[first + 1]?.text !== '{' || end === undefined) return null;
      for (const clause of node.catches || []) {
        if (tokens[end + 1]?.text !== 'catch') return null;
        end = closes.get(closes.get(end + 2) + 1);
        if (end === undefined) return null;
      }
      if (node.finallyBlock) {
        if (tokens[end + 1]?.text !== 'finally') return null;
        end = closes.get(end + 2);
      }
      return end;
    }
    return null;
  }
  function normal(node) {
    if (!node) return true;
    if (['BreakStatement', 'ContinueStatement', 'ReturnStatement', 'ThrowStatement'].includes(node.kind)) return false;
    if (node.kind === 'IfStatement') { const yes = normal(node.consequent), no = normal(node.alternate); return yes || no; }
    if (node.kind === 'BlockStatement') {
      let reachable = true;
      for (const statement of node.statements) {
        if (!reachable) { invalid = true; return false; }
        reachable = normal(statement);
      }
      return reachable;
    }
    if (node.kind === 'TryStatement') {
      const body = normal(node.block), catches = (node.catches || []).map(clause => normal(clause.body));
      const final = !node.finallyBlock || normal(node.finallyBlock);
      return final && (body || catches.some(Boolean));
    }
    if (node.kind === 'SynchronizedStatement') return normal(node.body);
    return true;
  }
  function comparison(node) {
    node = strip(node); let negate = false;
    while (node?.kind === 'UnaryExpression' && node.operator === '!') { negate = !negate; node = strip(node.expression || node.operand); }
    if (node?.kind !== 'BinaryExpression' || !['==', '!='].includes(node.operator)) return null;
    let id = strip(node.left), value = strip(node.right);
    if (id?.kind !== 'Identifier') { id = strip(node.right); value = strip(node.left); }
    let sign = 1;
    if (value?.kind === 'UnaryExpression' && ['+', '-'].includes(value.operator)) {
      sign = value.operator === '-' ? -1 : 1; value = strip(value.expression || value.operand);
    }
    if (id?.kind !== 'Identifier' || value?.kind !== 'LiteralExpression' || !/^(?:0|[1-9][0-9]*)$/.test(value.raw || '')) return null;
    const number = sign * Number(value.raw);
    if (number < -2147483648 || number > 2147483647) return null;
    return {name: id.name, value: number, equal: (node.operator === '==') !== negate, identifier: id};
  }
  function candidate(frame, block = frame.statement, offset) {
    if (frame.kind !== 'LabeledStatement' || frame.statement?.kind !== 'BlockStatement'
        || block?.kind !== 'BlockStatement') return null;
    const open = starts.get(block.range?.startOffset), close = closes.get(open);
    if (tokens[open]?.text !== '{' || tokens[close]?.text !== '}'
        || tokens[close].range.endOffset - tokens[open].range.startOffset > 40000) return null;
    let first = offset ?? 0;
    if (offset === undefined) while (['ExpressionStatement', 'EmptyStatement'].includes(block.statements[first]?.kind)) first++;
    const initial = block.statements[first], initialTest = initial?.kind === 'IfStatement' && comparison(initial.condition);
    if (!initialTest) return null;
    // The prefix stays byte-for-byte in place, outside the new switch. Its
    // declarations, switches, loop exits and selector writes therefore keep
    // their scopes/destinations. Only the selected suffix is classified.
    const dispatch = {kind: 'BlockStatement', statements: block.statements.slice(first)};
    let refused = false;
    const classifiers = new Map();
    walk(dispatch, node => {
      // Do not merge declaration scopes or change destinations of bare breaks.
      // Inner control frames are opaque until a separate proof supports them.
      if (['LocalVariableDeclarationStatement', 'LabeledStatement', 'SwitchStatement', ...loops].includes(node.kind)
          || node.kind === 'BreakStatement' && !node.label) refused = true;
      if (node.kind === 'IfStatement') {
        const test = comparison(node.condition), local = locals.get(test?.name);
        if (test && names.get(test.name) === 1 && local && initial.range.startOffset >= local.start
            && tokens[close].range.endOffset <= local.end) {
          if (!classifiers.has(test.name)) classifiers.set(test.name, new Set());
          classifiers.get(test.name).add(test.value);
        }
      }
    });
    if (refused) return null;
    for (const [name, values] of classifiers) {
      if (values.size < 3 || values.size > 16) continue;
      if (!initialTest || initialTest.name !== name) continue;
      const prefixEnd = tokens[starts.get(initial.range.startOffset)].range.startOffset;
      let written = false;
      walk(dispatch, node => {
        const operand = strip(node.kind === 'AssignmentExpression' ? node.left
          : node.kind === 'UnaryExpression' && ['++', '--'].includes(node.operator) ? node.expression || node.operand : null);
        if (operand?.kind === 'Identifier' && operand.name === name) written = true;
      });
      if (written) continue;
      const actions = [], conditions = [];
      function build(node, depth = 0) {
        if (!node) return {sequence: []};
        if (depth > 32 || actions.length > 128 || conditions.length > 32) return null;
        if (node.kind === 'BlockStatement') {
          const sequence = node.statements.map(statement => build(statement, depth + 1));
          return sequence.every(Boolean) ? {sequence} : null;
        }
        const test = node.kind === 'IfStatement' && comparison(node.condition);
        if (test && test.name === name) {
          const first = starts.get(node.range.startOffset), conditionEnd = closes.get(first + 1);
          if (tokens[first]?.text !== 'if' || conditionEnd === undefined) return null;
          const identifiers = tokens.slice(first + 2, conditionEnd).filter(token => token.kind === 'identifier' && token.text === name);
          if (identifiers.length !== 1) return null;
          conditions.push({start: tokens[first + 1].range.endOffset, end: tokens[conditionEnd].range.startOffset,
            identifierStart: identifiers[0].range.startOffset, value: test.value});
          const yes = build(node.consequent, depth + 1), no = build(node.alternate, depth + 1);
          return yes && no ? {test, yes, no} : null;
        }
        const end = finish(node), first = starts.get(node.range?.startOffset);
        if (end == null || first === undefined) return null;
        const action = {node, first, end, normal: normal(node), ownExit: node.kind === 'BreakStatement' && targets.get(node) === frame};
        actions.push(action); return {action: actions.length - 1};
      }
      normal(dispatch);
      const tree = build(dispatch);
      if (!tree || invalid || conditions.length < 3 || conditions.length > 32 || actions.length > 128) continue;
      function path(tree, value, result) {
        if (tree.action !== undefined) {
          result.push(tree.action); return actions[tree.action].normal;
        }
        if (tree.test) return path((value === tree.test.value) === tree.test.equal ? tree.yes : tree.no, value, result);
        for (const child of tree.sequence) if (!path(child, value, result)) return false;
        return true;
      }
      let other = -1; while (values.has(other)) other--;
      const paths = [...values, other].map(value => { const steps = []; path(tree, value, steps); return {value, steps, default: value === other}; });
      const used = new Set(paths.flatMap(path => path.steps));
      if (used.size !== actions.length) continue; // retain even syntactically dead work
      const nexts = actions.map(() => new Set()), entries = actions.map(() => []), empty = [];
      for (const p of paths) {
        if (!p.steps.length) empty.push(p); else entries[p.steps[0]].push(p);
        p.steps.forEach((step, index) => {
          if (actions[step].normal) nexts[step].add(p.steps[index + 1] ?? -1);
        });
      }
      const cuts = new Set(); let compatible = true;
      for (let index = 0; index < actions.length; index++) {
        if (!actions[index].normal) continue;
        const successors = nexts[index];
        if (successors.size === 1 && successors.has(index + 1)) continue;
        // Skipping only a bare break to this plain frame is equivalent to
        // leaving the new switch and falling straight out of that frame.
        if ([...successors].every(next => next === -1 || actions[next]?.ownExit)) cuts.add(index);
        else { compatible = false; break; }
      }
      // Every cut starts a new case entry. Otherwise Java fallthrough would
      // accidentally reach work that an original path never selected.
      for (let index = 1; index < actions.length; index++)
        if ((!actions[index - 1].normal || cuts.has(index - 1)) && !entries[index].length) compatible = false;
      if (!compatible) continue;
      return {frame, open, close, name, prefixEnd, actions, conditions, entries, empty, cuts};
    }
    return null;
  }
  let selected;
  walk(parsed, node => { if (!selected) selected = candidate(node); });
  if (!selected && nestedRegions) {
    let attempts = 0;
    walk(parsed, block => {
      if (selected || attempts >= 128 || block.kind !== 'BlockStatement') return;
      let frame = parents.get(block);
      while (frame && !(frame.kind === 'LabeledStatement' && frame.statement?.kind === 'BlockStatement')) frame = parents.get(frame);
      if (!frame) return;
      for (let index = 0; index < block.statements.length && !selected && attempts < 128; index++) {
        const node = block.statements[index];
        if (node.kind !== 'IfStatement' || !comparison(node.condition)) continue;
        attempts++;
        selected = candidate(frame, block, index);
      }
    });
  }
  if (!selected) return unchanged();
  const {frame, open, close, name, prefixEnd, actions, conditions, entries, empty, cuts} = selected;
  const begin = tokens[open].range.endOffset, end = tokens[close].range.startOffset;
  const line = wrapped.slice(wrapped.lastIndexOf('\n', tokens[open].range.startOffset - 1) + 1, tokens[open].range.startOffset);
  const indent = (line.match(/^[ \t]*/) || [''])[0] + '  ';
  const chunks = [wrapped.slice(begin, prefixEnd).trimEnd() + '\n' + indent + 'switch (' + name + ') {'];
  const labels = entries => entries.map(p => indent + '  ' + (p.default ? 'default:' : 'case ' + p.value + ':'));
  for (let index = 0; index < actions.length; index++) {
    chunks.push(...labels(entries[index]));
    const action = actions[index], bytes = wrapped.slice(tokens[action.first].range.startOffset, tokens[action.end].range.endOffset);
    const originalIndent = wrapped.slice(wrapped.lastIndexOf('\n', tokens[action.first].range.startOffset - 1) + 1, tokens[action.first].range.startOffset);
    chunks.push(indent + '    ' + bytes.split('\n').map((line, offset) => offset && /^[ \t]*$/.test(originalIndent) && line.startsWith(originalIndent)
      ? indent + '    ' + line.slice(originalIndent.length) : line).join('\n'));
    if (cuts.has(index)) chunks.push(indent + '    break;');
  }
  if (empty.length) chunks.push(...labels(empty), indent + '    break;');
  chunks.push(indent + '}', indent.slice(0, -2));
  const output = wrapped.slice(0, begin) + chunks.join('\n') + wrapped.slice(end);
  return {source: output.slice(2, -2), dispatchesRecovered: 1, ...(retainDiagnostics ? {diagnostics: {
    label: frame.label, selector: name, regionRange: {start: begin - 2, end: end - 2},
    prefixRange: {start: begin - 2, end: prefixEnd - 2},
    selectorOrigin: conditions[0].identifierStart - 2,
    conditionRanges: conditions.map(condition => ({start: condition.start - 2, end: condition.end - 2})),
    actions: actions.map((action, index) => ({range: {start: tokens[action.first].range.startOffset - 2, end: tokens[action.end].range.endOffset - 2},
      cases: entries[index].filter(p => !p.default).map(p => p.value), default: entries[index].some(p => p.default), exitAdded: cuts.has(index)})),
    emptyCases: empty.filter(p => !p.default).map(p => p.value), emptyDefault: empty.some(p => p.default),
  }} : {})};
}

module.exports = {recoverScalarIfDispatches};
