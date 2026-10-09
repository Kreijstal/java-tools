'use strict';

// Convert a ladder of transparent label blocks into a scalar switch. The
// classifier must read unique, scoped int locals through equality tests only.
// Partitioning each input into its mentioned constants and an Other class is
// exhaustive for this grammar; no game flag or selector value is assumed.
// Preserve action order, guards, scopes, cleanup and fallthrough verbatim.
// The caller supplies the complete-parser/lexer proof and runs frame cleanup.
function recoverScalarLabelDispatches(source, proof, {
  retainDiagnostics = false
} = {}) {
  const unchanged = () => ({
    source,
    dispatchesRecovered: 0
  });
  if (!proof) return unchanged();
  const {
    wrapped,
    parsed,
    tokens,
    starts,
    closes,
    children,
    labelCounts
  } = proof;
  const parents = new Map(),
    targets = new Map(),
    nearest = new Map(),
    counts = new Map(),
    locals = new Map();
  const statementStarts = new Set();
  function collectStarts(node) {
    if (node.kind?.endsWith('Statement') && node.range) statementStarts.add(node.range.startOffset);
    children(node, collectStarts);
  }
  collectStarts(parsed);
  function semicolon(node) {
    let index = starts.get(node.range?.startOffset);
    if (index === undefined) return null;
    const first = index;
    for (; index < tokens.length; index++) {
      if (index !== first && statementStarts.has(tokens[index].range.startOffset)) return null;
      if (tokens[index].text === ';') return index;
      if (tokens[index].text === '}') return null;
      if (closes.has(index)) index = closes.get(index);
    }
    return null;
  }
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  let refused = false;
  function extent(n) {
    if (n?.kind !== 'BlockStatement') return null;
    let open = starts.get(n.range?.startOffset);
    if (open === undefined) {
      const first = starts.get(n.statements?.[0]?.range?.startOffset);
      if (tokens[first - 1]?.text === '{') open = first - 1;
    }
    const close = closes.get(open);
    if (tokens[open]?.text !== '{' || tokens[close]?.text !== '}' || (!n.statements.length ? close !== open + 1 : starts.get(n.statements[0].range?.startOffset) !== open + 1 || n.statements.some(s => {
      const i = starts.get(s.range?.startOffset);
      return !(i > open && i < close);
    }))) return null;
    return {
      open,
      close
    };
  }
  function inspect(n, parent, labels = [], breaks = [], loopDepth = 0) {
    parents.set(n, parent);
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(n.kind || '')) refused = true;
    if (['VariableDeclarator', 'FormalParameter'].includes(n.kind)) counts.set(n.name, (counts.get(n.name) || 0) + 1);
    if (n.kind === 'LocalVariableDeclarationStatement' && parent?.kind === 'BlockStatement' && n.variableType?.kind === 'PrimitiveType' && n.variableType.name === 'int' && !n.annotations?.length && !n.variableType.annotations?.length && (n.modifiers || []).every(m => m.kind === 'Modifier' && m.name === 'final')) {
      const block = extent(parent);
      let end = starts.get(n.range?.startOffset);
      if (block && end !== undefined) {
        while (end < block.close && tokens[end].text !== ';') {
          if (closes.has(end)) end = closes.get(end);
          end++;
        }
        if (tokens[end]?.text === ';') for (const d of n.declarators) if (!d.dimensions) locals.set(d.name, {
          start: end + 1,
          end: block.close
        });
      }
    }
    if (['BreakStatement', 'ContinueStatement'].includes(n.kind)) {
      const start = starts.get(n.range?.startOffset),
        after = start + (n.label ? 2 : 1);
      if (tokens[start]?.text !== (n.kind === 'BreakStatement' ? 'break' : 'continue') || n.label && tokens[start + 1]?.text !== n.label || tokens[after]?.text !== ';') refused = true;
      if (n.label) {
        const target = labels.slice().reverse().find(l => l.label === n.label);
        if (!target || n.kind === 'ContinueStatement' && !loops.has(target.statement?.kind)) refused = true;
        else targets.set(n, target);
      } else if (!(n.kind === 'ContinueStatement' ? loopDepth : breaks.length)) refused = true;
      if (n.kind === 'BreakStatement') nearest.set(n, breaks.at(-1));
    }
    if (['ReturnStatement', 'ThrowStatement', 'AssertStatement'].includes(n.kind) && semicolon(n) === null) refused = true;
    if (n.kind === 'LocalVariableDeclarationStatement') {
      if (parent?.kind === 'ForStatement' && parent.initializer === n) {
        // For initializers have no individual parser range. Their declaration
        // stays inside the original loop; verify the two header separators.
        const start = starts.get(parent.range?.startOffset), close = closes.get(start + 1);
        let separators = 0;
        if (tokens[start + 1]?.text !== '(' || close === undefined) refused = true;
        else for (let index = start + 2; index < close; index++) {
          if (tokens[index].text === ';') separators++;
          if (closes.has(index)) index = closes.get(index);
        }
        if (separators !== 2) refused = true;
      } else if (semicolon(n) === null) refused = true;
    }
    if (n.kind === 'ExpressionStatement') {
      const e = n.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(e?.kind) && !(e?.kind === 'UnaryExpression' && ['++', '--'].includes(e.operator))) refused = true;
      if (semicolon(n) === null) refused = true;
    }
    children(n, c => inspect(c, n, n.kind === 'LabeledStatement' ? [...labels, n] : labels, loops.has(n.kind) || n.kind === 'SwitchStatement' ? [...breaks, n] : breaks, loopDepth + (loops.has(n.kind) ? 1 : 0)));
  }
  inspect(parsed, null);
  if (refused || [...labelCounts.values()].some(c => c !== 1)) return unchanged();
  const strip = n => {
    while (n?.kind === 'ParenthesizedExpression') n = n.expression;
    return n;
  };
  function literal(n) {
    n = strip(n);
    let sign = 1;
    if (n?.kind === 'UnaryExpression' && ['+', '-'].includes(n.operator)) {
      sign = n.operator === '-' ? -1 : 1;
      n = strip(n.expression || n.operand);
    }
    if (n?.kind !== 'LiteralExpression' || !/^(?:0|[1-9][0-9]*)$/.test(n.raw || '')) return null;
    const v = sign * Number(n.raw);
    return v >= -2147483648 && v <= 2147483647 ? v : null;
  }
  function condition(n, site, variables, depth = 0) {
    if (depth > 64) return null;
    n = strip(n);
    if (n?.kind === 'UnaryExpression' && n.operator === '!') {
      const inner = condition(n.expression || n.operand, site, variables, depth + 1);
      return inner && {
        not: inner
      };
    }
    if (n?.kind === 'BinaryExpression' && ['&&', '||'].includes(n.operator)) {
      const left = condition(n.left, site, variables, depth + 1),
        right = condition(n.right, site, variables, depth + 1);
      return left && right && {
        op: n.operator,
        left,
        right
      };
    }
    if (n?.kind !== 'BinaryExpression' || !['==', '!='].includes(n.operator)) return null;
    let id = strip(n.left),
      value = literal(n.right);
    if (id?.kind !== 'Identifier' || value === null) {
      id = strip(n.right);
      value = literal(n.left);
    }
    const local = locals.get(id?.name),
      index = starts.get(site.range?.startOffset);
    if (id?.kind !== 'Identifier' || value === null || counts.get(id.name) !== 1 || !local || !(index >= local.start && index < local.end)) return null;
    if (!variables.has(id.name)) variables.set(id.name, new Set());
    variables.get(id.name).add(value);
    return {
      op: n.operator,
      name: id.name,
      value
    };
  }
  function evaluate(n, values) {
    if (n.not) return !evaluate(n.not, values);
    if (n.op === '&&') return evaluate(n.left, values) && evaluate(n.right, values);
    if (n.op === '||') return evaluate(n.left, values) || evaluate(n.right, values);
    return n.op === '==' ? values[n.name] === n.value : values[n.name] !== n.value;
  }
  const nondeclaring = new Set(['ExpressionStatement', 'BlockStatement', 'IfStatement', ...loops, 'SwitchStatement', 'TryStatement', 'SynchronizedStatement', 'LabeledStatement', 'ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement', 'EmptyStatement', 'AssertStatement']);
  function completion(n) {
    if (!n) return true;
    if (['ExpressionStatement', 'EmptyStatement', 'AssertStatement'].includes(n.kind)) return true;
    if (['BreakStatement', 'ContinueStatement', 'ReturnStatement', 'ThrowStatement'].includes(n.kind)) return false;
    if (n.kind === 'IfStatement') {
      if (!n.alternate) return true;
      const a = completion(n.consequent),
        b = completion(n.alternate);
      return a === true || b === true ? true : a === false && b === false ? false : null;
    }
    if (n.kind === 'BlockStatement') return completion(n.statements.at(-1));
    return null;
  }
  function candidate(outer) {
    if (outer.kind !== 'LabeledStatement' || outer.statement?.kind !== 'BlockStatement') return null;
    const chain = [];
    let current = outer;
    for (;;) {
      const block = extent(current.statement);
      if (!block) return null;
      chain.push({
        node: current,
        block
      });
      if (chain.length > 32) return null;
      const child = current.statement.statements[0];
      if (child?.kind !== 'LabeledStatement' || child.statement?.kind !== 'BlockStatement') break;
      current = child;
    }
    if (chain.length < 3) return null;
    const inner = chain.at(-1),
      statements = inner.node.statement.statements;
    let index = 0;
    while (statements[index]?.kind === 'ExpressionStatement') index++;
    const first = statements[index];
    if (first?.kind !== 'IfStatement') return null;
    const chainSet = new Set(chain.map(c => c.node)),
      groups = [],
      destinations = new Map(),
      conditions = [];
    let endGroup = null,
      externalGroups = [];
    const makeGroup = (nodes, block, name) => {
      const start = nodes.length ? starts.get(nodes[0].range?.startOffset) : block.close;
      if (start === undefined) return null;
      const group = {
        nodes,
        start: tokens[start].range.startOffset,
        end: tokens[block.close].range.startOffset,
        name
      };
      groups.push(group);
      return group;
    };
    // First construct the physical continuation sequence, innermost to outermost.
    let restIndex = index + 1;
    const variables = new Map();
    let invalid = false;
    function recordCondition(node) {
      const c = condition(node.condition, node, variables),
        start = starts.get(node.range?.startOffset),
        end = closes.get(start + 1);
      if (!c || tokens[start]?.text !== 'if' || tokens[start + 1]?.text !== '(' || end === undefined) {
        invalid = true;
        return null;
      }
      if (conditions.length >= 128) {
        invalid = true;
        return null;
      }
      conditions.push({
        start: tokens[start + 1].range.endOffset - 2,
        end: tokens[end].range.startOffset - 2
      });
      return c;
    }
    function pure(node, depth = 0) {
      if (depth > 64) return null;
      if (!node || node.kind === 'EmptyStatement') return {
        normal: true
      };
      if (node.kind === 'BlockStatement') {
        if (!extent(node)) return null;
        // Do not erase unreachable statements from a malformed input block.
        if (node.statements.slice(0, -1).some(child => completion(child) === false)) return null;
        const sequence = node.statements.map(child => pure(child, depth + 1));
        return sequence.every(Boolean) ? {
          sequence
        } : null;
      }
      if (node.kind === 'BreakStatement' && node.label && targets.has(node)) return {
        jump: node
      };
      if (node.kind === 'IfStatement') {
        const then = pure(node.consequent, depth + 1),
          els = pure(node.alternate, depth + 1);
        if (!then || !els) return null;
        const test = recordCondition(node);
        return test && {
          test,
          then,
          els
        };
      }
      return null;
    }
    // Probe without recording failed branches: only the initial then arm may be
    // an effectful entry. Every alternate decision must contain pure jumps only.
    const oldConditions = conditions.length,
      oldVariables = new Map([...variables].map(([n, s]) => [n, new Set(s)]));
    let then = pure(first.consequent);
    if (!then) {
      conditions.length = oldConditions;
      variables.clear();
      for (const [n, s] of oldVariables) variables.set(n, s);
      invalid = false;
      const nodes = first.consequent?.kind === 'BlockStatement' ? first.consequent.statements : [first.consequent];
      const block = first.consequent?.kind === 'BlockStatement' ? extent(first.consequent) : null;
      if (!block || !nodes.length) return null;
      const effect = makeGroup(nodes, block, 'effect');
      if (!effect) return null;
      then = {
        entry: effect
      };
    }
    const els = pure(first.alternate),
      test = recordCondition(first);
    if (!els || !test || invalid) return null;
    const dispatcher = [{
      test,
      then,
      els
    }];
    // Subsequent pure jump decisions still belong to the classifier. Stop at the
    // first effectful statement, preserving that entire existing remainder.
    while (restIndex < statements.length) {
      const saved = conditions.length,
        vars = new Map([...variables].map(([n, s]) => [n, new Set(s)])),
        next = pure(statements[restIndex]);
      if (!next || invalid) {
        conditions.length = saved;
        variables.clear();
        for (const [n, s] of vars) variables.set(n, s);
        invalid = false;
        break;
      }
      dispatcher.push(next);
      restIndex++;
    }
    // The first effect arm may fall through into actions, but not into another
    // discarded classifier: that arm could have changed a classifier input.
    if (groups.length && dispatcher.length !== 1) return null;
    const fallthrough = makeGroup(statements.slice(restIndex), inner.block, 'inner-remainder');
    if (!fallthrough) return null;
    for (let i = chain.length - 1; i > 0; i--) {
      const parent = chain[i - 1],
        group = makeGroup(parent.node.statement.statements.slice(1), parent.block, 'after-' + chain[i].node.label);
      if (!group) return null;
      destinations.set(chain[i].node, group);
    }
    function destination(jump) {
      const target = targets.get(jump);
      if (destinations.has(target)) return destinations.get(target);
      if (target === outer) {
        if (!endGroup) endGroup = {
          nodes: [],
          name: 'frame-end',
          endEntry: true
        };
        return endGroup;
      }
      let p = parents.get(outer);
      while (p && p !== target) p = parents.get(p);
      if (!p) {
        invalid = true;
        return null;
      }
      let external = externalGroups.find(g => g.target === target);
      if (!external) {
        const start = starts.get(jump.range?.startOffset);
        if (tokens[start]?.text !== 'break' || tokens[start + 1]?.text !== jump.label || tokens[start + 2]?.text !== ';') {
          invalid = true;
          return null;
        }
        external = {
          nodes: [jump],
          start: tokens[start].range.startOffset,
          end: tokens[start + 2].range.endOffset,
          target,
          name: 'external-' + jump.label
        };
        externalGroups.push(external);
      }
      return external;
    }
    function choose(tree, values) {
      if (tree.entry) return tree.entry;
      if (tree.jump) return destination(tree.jump);
      if (tree.test) return choose(evaluate(tree.test, values) ? tree.then : tree.els, values);
      if (tree.sequence) {
        for (const child of tree.sequence) {
          const selected = choose(child, values);
          if (selected) return selected;
        }
      }
      return null;
    }
    function selected(values) {
      for (const tree of dispatcher) {
        const group = choose(tree, values);
        if (group) return group;
      }
      return fallthrough;
    }
    const entries = [...variables];
    if (entries.length < 1 || entries.length > 2) return null;
    const primaries = entries.filter(([_, s]) => s.size >= 3);
    if (primaries.length !== 1) return null;
    const [primary, constants] = primaries[0],
      secondary = entries.find(([n]) => n !== primary);
    if (secondary && secondary[1].size !== 1) return null;
    if (constants.size > 32) return null;
    const sentinel = set => {
      let value = -1;
      while (set.has(value)) value--;
      return value;
    };
    const other = sentinel(constants),
      guard = secondary && secondary[0],
      normal = secondary && [...secondary[1]][0],
      otherGuard = secondary && sentinel(secondary[1]);
    const valuesFor = (value, mode) => ({
      [primary]: value,
      ...(guard ? {
        [guard]: mode
      } : {})
    });
    const defaultGroup = selected(valuesFor(other, normal)),
      labels = new Map();
    for (const value of constants) {
      const group = selected(valuesFor(value, normal));
      if (!group) return null;
      if (!labels.has(group)) labels.set(group, []);
      labels.get(group).push(value);
    }
    const allowed = [];
    if (guard) {
      if (selected(valuesFor(other, otherGuard)) !== defaultGroup) return null;
      for (const value of constants) {
        const normalGroup = selected(valuesFor(value, normal)),
          alternate = selected(valuesFor(value, otherGuard));
        if (alternate === normalGroup) allowed.push(value);
        else if (alternate !== defaultGroup) return null;
      }
    }
    if (invalid || !defaultGroup) return null;
    if (endGroup) groups.push(endGroup);
    groups.push(...externalGroups);
    // Empty, unselected continuations have no effects or declarations. They
    // need no synthetic case; selected empty destinations still get a label.
    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index];
      if (!group.nodes.length && !group.endEntry && group !== defaultGroup && !labels.has(group)) groups.splice(index, 1);
    }
    if (groups.some(group => group !== defaultGroup && !labels.has(group))) return null;
    for (const group of groups) {
      if (!group.nodes.every(n => nondeclaring.has(n.kind))) return null;
      let bad = false;
      const descendants = new Set();
      function visit(n) {
        descendants.add(n);
        children(n, visit);
      }
      group.nodes.forEach(visit);
      for (const node of descendants) {
        if (node.kind === 'LabeledStatement' && !nondeclaring.has(node.statement?.kind)) bad = true;
        if (['BreakStatement', 'ContinueStatement'].includes(node.kind) && node.label && chainSet.has(targets.get(node)) && targets.get(node) !== outer) bad = true;
        if (node.kind === 'BreakStatement' && !node.label && !descendants.has(nearest.get(node))) bad = true;
      }
      if (bad) return null;
    }
    const outerStart = starts.get(outer.range?.startOffset);
    if (tokens[outerStart]?.text !== outer.label || tokens[outerStart + 1]?.text !== ':') return null;
    const prefixStart = tokens[inner.block.open].range.endOffset,
      prefixEnd = tokens[starts.get(first.range.startOffset)].range.startOffset;
    const base = wrapped.slice(wrapped.lastIndexOf('\n', tokens[outerStart].range.startOffset - 1) + 1, tokens[outerStart].range.startOffset);
    if (!/^[ \t]*$/.test(base)) return null;
    function reindent(text, indent, start) {
      if (start !== undefined && !/^\s/.test(text)) {
        const old = wrapped.slice(wrapped.lastIndexOf('\n', start - 1) + 1, start);
        if (/^[ \t]*$/.test(old)) text = old + text;
      }
      const lines = text.split('\n');
      while (lines.length && !lines[0].trim()) lines.shift();
      while (lines.length && !lines.at(-1).trim()) lines.pop();
      if (!lines.length) return [];
      const minimum = Math.min(...lines.filter(l => l.trim()).map(l => /^[ \t]*/.exec(l)[0].length));
      return lines.map(l => l.trim() ? indent + l.slice(minimum) : '');
    }
    let expression = primary,
      gates = null;
    if (guard && allowed.length !== constants.size) {
      gates = [guard + ' == ' + normal, ...allowed.slice().sort((a, b) => a - b).map(v => primary + ' == ' + v)];
      expression = '(' + gates.join(' || ') + ') ? ' + primary + ' : ' + other;
    }
    const out = reindent(wrapped.slice(prefixStart, prefixEnd), base);
    if (gates) {
      out.push(base + outer.label + ': switch ((' + gates[0]);
      for (const gate of gates.slice(1)) out.push(base + '    || ' + gate);
      out.push(base + '  ) ? ' + primary + ' : ' + other + ') {');
    } else out.push(base + outer.label + ': switch (' + expression + ') {');
    const physical = groups.filter(g => !g.target);
    for (const group of physical) {
      for (const value of labels.get(group) || []) out.push(base + '  case ' + value + ':');
      if (group === defaultGroup) out.push(base + '  default:');
      const text = group.endEntry ? 'break ' + outer.label + ';' : wrapped.slice(group.start, group.end);
      out.push(...reindent(text, base + '    ', group.endEntry ? undefined : group.start));
      if (group === physical.at(-1) && externalGroups.length && !group.endEntry) {
        const complete = completion(group.nodes.at(-1));
        if (complete === null) return null;
        if (complete) out.push(base + '    break ' + outer.label + ';');
      }
    }
    for (const group of externalGroups) {
      for (const value of labels.get(group) || []) out.push(base + '  case ' + value + ':');
      if (group === defaultGroup) out.push(base + '  default:');
      out.push(...reindent(wrapped.slice(group.start, group.end), base + '    ', group.start));
    }
    out.push(base + '}');
    let text = out.join('\n');
    if (text.startsWith(base)) text = text.slice(base.length);
    return {
      start: tokens[outerStart].range.startOffset,
      end: tokens[chain[0].block.close].range.endOffset,
      text,
      labelsConsumed: chain.length,
      primary,
      guard,
      constants: [...constants],
      allowedNonmatchingGuardValues: allowed,
      conditionRanges: conditions,
      selectorExpression: expression
    };
  }
  let edit;
  function find(n) {
    if (!edit) edit = candidate(n);
    if (!edit) children(n, find);
  }
  find(parsed);
  if (!edit) return unchanged();
  return {
    source: (wrapped.slice(0, edit.start) + edit.text + wrapped.slice(edit.end)).slice(2, -2),
    dispatchesRecovered: 1,
    ...(retainDiagnostics ? {
      diagnostics: {
        ...edit,
        start: edit.start - 2,
        end: edit.end - 2,
        text: undefined
      }
    } : {})
  };
}
module.exports = {
  recoverScalarLabelDispatches
};
