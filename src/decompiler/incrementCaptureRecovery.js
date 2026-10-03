'use strict';

// Restore array indexing only when all moved evaluations are reads of uniquely
// bound locals. Java evaluates an array-assignment target's reference/index,
// then its RHS, and only then checks the target for null/bounds/store failures.
// Thus both counters still advance before a failing source read or target store.
// A single read can also be the first evaluation in a return, local assignment
// or if condition. Later condition evaluations retain their original order.
// Array fields/calls, compound stores, intervening work and escaping captures
// refuse recovery. No statement moves across a block, handler or monitor boundary.
function recoverArrayIndexIncrements(source, proof, {parameters = []} = {}) {
  const unchanged = () => ({source, capturesFolded: 0});
  if (!proof || !Array.isArray(parameters)) return unchanged();
  const validName = name => typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
  if (parameters.some(p => !p || !validName(p.name) || typeof p.type !== 'string')
      || new Set(parameters.map(p => p.name)).size !== parameters.length) return unchanged();
  const {parsed, wrapped, tokens, starts, children} = proof;
  const bindings = new Map(), counts = new Map(), candidates = new Map();
  let refused = false;
  function remember(name) { counts.set(name, (counts.get(name) || 0) + 1); }
  for (const p of parameters) {
    remember(p.name);
    bindings.set(p.name, {type: p.type, start: -1});
  }
  function inspect(node) {
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (['VariableDeclarator', 'FormalParameter'].includes(node.kind)) remember(node.name);
    if (node.kind === 'LocalVariableDeclarationStatement' && node.declarators.length === 1
        && !node.modifiers.length && !node.annotations.length
        && node.variableType.kind === 'PrimitiveType' && node.variableType.name === 'int') {
      const d = node.declarators[0], start = starts.get(node.range?.startOffset);
      if (!d.dimensions && /^incrementValue\$\d+$/.test(d.name)
          && d.initializer?.kind === 'Identifier'
          && texts(start, ['int', d.name, '=', d.initializer.name, ';']))
        candidates.set(d.name, {inline: true, declaration: start});
    }
    children(node, inspect);
  }
  inspect(parsed);
  if (refused) return unchanged();
  function texts(start, values) {
    return values.every((value, offset) => tokens[start + offset]?.text === value);
  }
  for (const node of parsed.statements) {
    if (node.kind !== 'LocalVariableDeclarationStatement' || node.declarators.length !== 1
        || node.modifiers.length || node.annotations.length) continue;
    const d = node.declarators[0], start = starts.get(node.range?.startOffset);
    const type = node.variableType;
    if (d.dimensions) continue;
    if (type.kind === 'PrimitiveType' && type.name === 'int')
      bindings.set(d.name, {type: 'int', start: node.range.startOffset});
    else if (type.kind === 'ArrayType' && type.dimensions === 1)
      bindings.set(d.name, {type: 'array', start: node.range.startOffset});
    if (type.kind === 'PrimitiveType' && type.name === 'int'
        && /^incrementValue\$\d+$/.test(d.name)
        && texts(start, ['int', d.name, '=', '0', ';'])) {
      candidates.set(d.name, {declaration: start});
    }
  }
  const visible = (name, site) => counts.get(name) === 1 && bindings.has(name)
    && bindings.get(name).start < site;
  const integer = (name, site) => visible(name, site) && bindings.get(name).type === 'int';
  const array = (name, site) => visible(name, site) && (bindings.get(name).type === 'array'
    || /^(?!.*\[\]\[\]).+\[\]$/.test(bindings.get(name).type));
  function capture(store, increment) {
    let s = store?.expression;
    const inline = store?.kind === 'LocalVariableDeclarationStatement'
      && store.declarators.length === 1 && candidates.get(store.declarators[0].name)?.inline;
    if (inline) s = {kind: 'AssignmentExpression', operator: '=',
      left: {kind: 'Identifier', name: store.declarators[0].name}, right: store.declarators[0].initializer};
    const i = increment?.expression;
    if ((!inline && store?.kind !== 'ExpressionStatement') || increment?.kind !== 'ExpressionStatement'
        || s?.kind !== 'AssignmentExpression' || s.operator !== '='
        || s.left.kind !== 'Identifier' || s.right.kind !== 'Identifier'
        || i?.kind !== 'UnaryExpression' || i.prefix || !['++', '--'].includes(i.operator)
        || i.operand?.kind !== 'Identifier' || i.operand.name !== s.right.name) return null;
    const name = s.left.name, counter = s.right.name, site = store.range.startOffset;
    const state = candidates.get(name), a = starts.get(site), b = starts.get(increment.range.startOffset);
    if (!state || counts.get(name) !== 1 || (!inline && !integer(name, site)) || !integer(counter, site)
        || !!state.inline !== !!inline
        || !texts(a, inline ? ['int', name, '=', counter, ';'] : [name, '=', counter, ';'])
        || !texts(b, [counter, i.operator, ';'])) return null;
    return {name, counter, operator: i.operator, state, a, b, inline: !!inline};
  }
  function arrayAccess(node, name, site) {
    return node?.kind === 'ArrayAccessExpression' && node.array?.kind === 'Identifier'
      && array(node.array.name, site) && node.index?.kind === 'Identifier' && node.index.name === name;
  }
  function readUse(node, first) {
    if (!node) return null;
    const site = node.range.startOffset;
    let read, prefix;
    if (node.kind === 'ReturnStatement') {
      read = node.expression;
      prefix = ['return'];
    } else if (node.kind === 'IfStatement') {
      const condition = node.condition;
      read = condition?.kind === 'BinaryExpression'
        && ['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(condition.operator)
        ? condition.left : condition;
      prefix = ['if', '('];
    } else if (node.kind === 'ExpressionStatement') {
      const e = node.expression;
      if (e?.kind !== 'AssignmentExpression' || e.operator !== '='
          || e.left?.kind !== 'Identifier' || !integer(e.left.name, site)) return null;
      read = e.right;
      prefix = [e.left.name, '='];
    } else if (node.kind === 'LocalVariableDeclarationStatement'
        && node.declarators.length === 1 && !node.modifiers.length && !node.annotations.length
        && node.variableType.kind === 'PrimitiveType' && !node.declarators[0].dimensions) {
      const d = node.declarators[0];
      if (counts.get(d.name) !== 1) return null;
      read = d.initializer;
      prefix = [node.variableType.name, d.name, '='];
    } else return null;
    if (!arrayAccess(read, first.name, site)) return null;
    const at = starts.get(site);
    if (!texts(at, [...prefix, read.array.name, '[', first.name, ']'])) return null;
    return at + prefix.length + 2;
  }
  const groups = [];
  function walk(node) {
    if (node.kind === 'BlockStatement') {
      const items = node.statements;
      for (let n = 0; n + 2 < items.length; n++) {
        const first = capture(items[n], items[n + 1]);
        if (!first) continue;
        const read = readUse(items[n + 2], first);
        if (read !== null) {
          groups.push({captures: [first], uses: [read], read: true});
          n += 2;
          continue;
        }
        let second = capture(items[n + 2], items[n + 3]);
        const end = items[n + (second ? 4 : 2)], e = end?.expression;
        if (end?.kind !== 'ExpressionStatement' || e?.kind !== 'AssignmentExpression' || e.operator !== '='
            || !arrayAccess(e.left, first.name, end.range.startOffset)) continue;
        const at = starts.get(end.range.startOffset), left = e.left.array.name;
        let uses;
        if (second) {
          if (first.name === second.name || !arrayAccess(e.right, second.name, end.range.startOffset)) continue;
          if (!texts(at, [left, '[', first.name, ']', '=', e.right.array.name, '[', second.name, ']', ';'])) continue;
          uses = [at + 2, at + 7];
        } else {
          const rhs = e.right;
          if (!(rhs.kind === 'LiteralExpression' && /^(?:0|[1-9]\d*)$/.test(rhs.raw)
                || rhs.kind === 'Identifier' && visible(rhs.name, end.range.startOffset))) continue;
          if (!texts(at, [left, '[', first.name, ']', '=', rhs.raw || rhs.name, ';'])) continue;
          uses = [at + 2];
        }
        const captures = [first, ...(second ? [second] : [])];
        groups.push({captures, uses});
        n += second ? 4 : 2;
      }
    }
    children(node, walk);
  }
  walk(parsed);
  // Every capture must appear exactly at its declaration, optional separate
  // store and selected index use. Reject qualified references and shadows.
  const occurrences = new Map();
  tokens.forEach((token, index) => {
    if (token.kind === 'identifier' && candidates.has(token.text)) {
      if (!occurrences.has(token.text)) occurrences.set(token.text, []);
      occurrences.get(token.text).push(index);
    }
  });
  const accepted = groups.filter(group => group.captures.every((capture, i) => {
    const allowed = [capture.state.declaration + 1, ...(capture.inline ? [] : [capture.a]), group.uses[i]];
    const uses = occurrences.get(capture.name) || [];
    return uses.length === allowed.length && uses.every(index => allowed.includes(index));
  }));
  if (!accepted.length) return unchanged();
  const edits = [], removed = new Set();
  function remove(start, length) {
    let a = tokens[start].range.startOffset, b = tokens[start + length - 1].range.endOffset;
    const lineStart = wrapped.lastIndexOf('\n', a - 1) + 1, lineEnd = wrapped.indexOf('\n', b);
    if (lineEnd >= 0 && !wrapped.slice(lineStart, a).trim() && !wrapped.slice(b, lineEnd).trim()) {
      a = lineStart; b = lineEnd + 1;
    }
    edits.push({start: a, end: b, text: ''});
  }
  for (const group of accepted) group.captures.forEach((capture, i) => {
    if (removed.has(capture.name)) { refused = true; return; }
    removed.add(capture.name);
    remove(capture.state.declaration, 5);
    if (!capture.inline) remove(capture.a, 4);
    remove(capture.b, 3);
    const token = tokens[group.uses[i]];
    edits.push({start: token.range.startOffset, end: token.range.endOffset, text: capture.counter + capture.operator});
  });
  edits.sort((a, b) => a.start - b.start);
  if (refused || edits.some((edit, i) => i && edits[i - 1].end > edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return {source: output.slice(2, -2), capturesFolded: removed.size,
    readCapturesFolded: accepted.filter(group => group.read).length};
}

module.exports = {recoverArrayIndexIncrements};
