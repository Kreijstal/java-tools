'use strict';

// Specialize a pure equality guard only when preceding branches establish its
// value for the same captured primitive int local. Never assume a field or a
// global client flag is constant. A later or cyclic write invalidates the fact.
// Preserve the selected arm's scope, then prove Java completion and prune only
// unreachable suffixes with no declarations. Track labeled/unlabeled transfers,
// finally overrides, loop completion and colon-switch fallthrough before
// editing. Checked-catch regions and switch-rule forms remain opaque. One
// candidate per call avoids overlap.
function discoverPathGuards(source, proof) {
  if (!proof) return [];
  const {
    parsed,
    tokens,
    starts,
    closes,
    children
  } = proof;
  const declarations = new Map(),
    counts = new Map(),
    writes = new Map(),
    parents = new Map();
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  let refused = false;
  const strip = n => {
    while (n?.kind === 'ParenthesizedExpression') n = n.expression;
    return n;
  };
  function inspect(n, parent, site, cyclic = false) {
    parents.set(n, parent);
    cyclic = cyclic || loops.has(n.kind);
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(n.kind || '')) refused = true;
    if (n.range) site = n.range.startOffset;
    if (['VariableDeclarator', 'FormalParameter'].includes(n.kind)) counts.set(n.name, (counts.get(n.name) || 0) + 1);
    if (n.kind === 'LocalVariableDeclarationStatement' && parent?.kind === 'BlockStatement' && n.variableType?.kind === 'PrimitiveType' && n.variableType.name === 'int' && !n.annotations?.length) {
      const blockStart = starts.get(parent.range?.startOffset),
        blockEnd = closes.get(blockStart);
      if (tokens[blockStart]?.text === '{') for (const d of n.declarators) if (!d.dimensions) declarations.set(d.name, {
        start: site,
        end: tokens[blockEnd].range.startOffset,
        cyclic
      });
    }
    const operand = strip(n.kind === 'AssignmentExpression' ? n.left : n.kind === 'UnaryExpression' && ['++', '--'].includes(n.operator) ? n.expression || n.operand : null);
    if (operand?.kind === 'Identifier') {
      if (!writes.has(operand.name)) writes.set(operand.name, []);
      writes.get(operand.name).push({
        site,
        cyclic
      });
    }
    children(n, c => inspect(c, n, site, cyclic));
  }
  inspect(parsed, null, 0);
  if (refused) return [];
  function comparison(n, site) {
    n = strip(n);
    if (n?.kind !== 'BinaryExpression' || !['==', '!='].includes(n.operator)) return null;
    let id = strip(n.left),
      literal = strip(n.right);
    if (id?.kind !== 'Identifier') {
      id = strip(n.right);
      literal = strip(n.left);
    }
    let sign = 1;
    if (literal?.kind === 'UnaryExpression' && ['-', '+'].includes(literal.operator)) {
      sign = literal.operator === '-' ? -1 : 1;
      literal = strip(literal.expression || literal.operand);
    }
    if (id?.kind !== 'Identifier' || literal?.kind !== 'LiteralExpression' || !/^(?:0|[1-9][0-9]*)$/.test(literal.raw || '')) return null;
    const value = sign * Number(literal.raw);
    if (value < -2147483648 || value > 2147483647) return null;
    const declaration = declarations.get(id.name);
    if (counts.get(id.name) !== 1 || !declaration || declaration.cyclic || site <= declaration.start || site >= declaration.end || writes.get(id.name)?.some(w => w.cyclic || w.site >= site)) return null;
    return {
      name: id.name,
      value,
      equal: n.operator === '=='
    };
  }
  // Facts describe a single captured value. Equality to one constant excludes
  // every other constant; a false conjunction or true disjunction contributes
  // a fact only when the other operand is already established. Conditions with
  // effects may establish necessary facts on their arms, but only entirely
  // pure local comparisons are candidates for replacement.
  const key = c => c.name + '=' + c.value;
  function truth(n, env, site, depth = 0) {
    if (depth > 128) return null;
    n = strip(n);
    if (n?.kind === 'UnaryExpression' && n.operator === '!') {
      const inner = truth(n.expression || n.operand, env, site, depth + 1);
      return inner === null ? null : !inner;
    }
    if (n?.kind === 'BinaryExpression' && ['&&', '||'].includes(n.operator)) {
      const a = truth(n.left, env, site, depth + 1),
        b = truth(n.right, env, site, depth + 1);
      return n.operator === '&&' ? a === false || b === false ? false : a === true && b === true ? true : null : a === true || b === true ? true : a === false && b === false ? false : null;
    }
    const c = comparison(n, site);
    if (!c) return null;
    if (env.has(key(c))) return env.get(key(c)) === c.equal;
    if ([...env].some(([k, v]) => k.startsWith(c.name + '=') && v && k !== key(c))) return !c.equal;
    return null;
  }
  function infer(n, value, env, site, depth = 0) {
    if (depth > 128) return env;
    n = strip(n);
    if (n?.kind === 'UnaryExpression' && n.operator === '!') return infer(n.expression || n.operand, !value, env, site, depth + 1);
    if (n?.kind === 'BinaryExpression' && ['&&', '||'].includes(n.operator)) {
      if (n.operator === '&&' && value || n.operator === '||' && !value) {
        infer(n.left, value, env, site, depth + 1);
        infer(n.right, value, env, site, depth + 1);
      } else {
        if (truth(n.left, env, site) === (n.operator === '&&')) infer(n.right, value, env, site);
        if (truth(n.right, env, site) === (n.operator === '&&')) infer(n.left, value, env, site);
      }
      return env;
    }
    const c = comparison(n, site);
    if (c) env.set(key(c), value === c.equal);
    return env;
  }
  function pure(n, site, depth = 0) {
    if (depth > 128) return false;
    n = strip(n);
    if (comparison(n, site)) return true;
    if (n?.kind === 'UnaryExpression' && n.operator === '!') return pure(n.expression || n.operand, site, depth + 1);
    return n?.kind === 'BinaryExpression' && ['&&', '||'].includes(n.operator) && pure(n.left, site, depth + 1) && pure(n.right, site, depth + 1);
  }
  function exits(n) {
    if (!n) return false;
    if (['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'].includes(n.kind)) return true;
    if (n.kind === 'BlockStatement') return exits(n.statements.at(-1));
    return n.kind === 'IfStatement' && n.alternate && exits(n.consequent) && exits(n.alternate);
  }
  const results = [];
  function walk(n, env, loopDepth = 0, protectedDepth = 0) {
    if (!n) return env;
    if (n.kind === 'BlockStatement') {
      env = new Map(env);
      for (const child of n.statements) env = walk(child, env, loopDepth, protectedDepth);
      return env;
    }
    if (n.kind === 'IfStatement') {
      const site = n.range.startOffset,
        known = truth(n.condition, env, site),
        test = starts.get(site),
        close = closes.get(test + 1);
      if (known !== null && pure(n.condition, site)) {
        let decl = false;
        children(known ? n.alternate || {} : n.consequent, c => {
          function scan(x) {
            if (['VariableDeclarator', 'FormalParameter'].includes(x.kind)) decl = true;
            children(x, scan);
          }
          scan(c);
        });
        results.push({
          site: site - 2,
          condition: source.slice(tokens[test + 1].range.endOffset - 2, tokens[close].range.startOffset - 2),
          known,
          loopDepth,
          protectedDepth,
          chosenExits: exits(known ? n.consequent : n.alternate),
          discardedDeclarations: decl
        });
      }
      const thenEnv = infer(n.condition, true, new Map(env), site),
        elseEnv = infer(n.condition, false, new Map(env), site);
      const a = walk(n.consequent, thenEnv, loopDepth, protectedDepth),
        b = walk(n.alternate, elseEnv, loopDepth, protectedDepth);
      if (exits(n.consequent)) return b;
      if (n.alternate && exits(n.alternate)) return a;
      return new Map([...a].filter(([k, v]) => b.has(k) && b.get(k) === v));
    }
    if (loops.has(n.kind)) {
      walk(n.body, new Map(env), loopDepth + 1, protectedDepth);
      return env;
    }
    if (n.kind === 'TryStatement') {
      walk(n.block, new Map(env), loopDepth, protectedDepth + 1);
      for (const c of n.catches || []) walk(c.body, new Map(env), loopDepth, protectedDepth + 1);
      walk(n.finallyBlock, new Map(env), loopDepth, protectedDepth + 1);
      return env;
    }
    if (n.kind === 'LabeledStatement') {
      walk(n.statement, new Map(env), loopDepth, protectedDepth);
      return env;
    }
    if (n.kind === 'SynchronizedStatement') {
      walk(n.body, new Map(env), loopDepth, protectedDepth + 1);
      return env;
    }
    if (n.kind === 'SwitchStatement') {
      // Every case is a possible entry. Facts from a preceding case must not
      // leak into another case, even when that preceding case falls through.
      for (const group of n.groups || []) {
        let entry = new Map(env);
        for (const statement of group.statements || [])
          entry = walk(statement, entry, loopDepth, protectedDepth);
      }
      return env;
    }
    return env;
  }
  walk(parsed, new Map());
  return results;
}
function specializePathGuards(source, proof, {
  parameterNames = [],
  retainDiagnostics = false,
  preserveActions = false
} = {}) {
  const unchanged = () => ({
    source,
    guardsSpecialized: 0
  });
  if (typeof preserveActions !== 'boolean') return unchanged();
  const candidates = discoverPathGuards(source, proof).filter(c => !c.discardedDeclarations);
  if (!candidates.length) return unchanged();
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
  const statementStarts = new Set();
  function collectStarts(node) {
    if (node.kind?.endsWith('Statement') && node.range) statementStarts.add(node.range.startOffset);
    children(node, collectStarts);
  }
  collectStarts(parsed);
  function terminator(node) {
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
  const parents = new Map(),
    targets = new Map(),
    nodes = new Map(),
    locals = new Map(),
    counts = new Map();
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  const switches = new Map();
  let refused = false;
  function extent(n) {
    if (n?.kind !== 'BlockStatement') return null;
    let open = starts.get(n.range?.startOffset);
    if (open === undefined) {
      const first = starts.get(n.statements?.[0]?.range?.startOffset);
      if (tokens[first - 1]?.text === '{') open = first - 1;
    }
    const close = closes.get(open);
    if (tokens[open]?.text !== '{' || tokens[close]?.text !== '}') return null;
    return {
      open,
      close
    };
  }
  function switchExtent(n) {
    const start = starts.get(n.range?.startOffset),
      conditionEnd = closes.get(start + 1),
      open = conditionEnd + 1,
      close = closes.get(open);
    if (tokens[start]?.text !== 'switch' || tokens[start + 1]?.text !== '('
        || tokens[open]?.text !== '{' || tokens[close]?.text !== '}') return null;
    return {open, close};
  }
  // The parser deliberately tolerates some missing punctuation. Prove every
  // colon label and statement boundary against the original token stream;
  // neither an arrow rule nor a malformed case can enter completion analysis.
  function switchShape(n) {
    const block = switchExtent(n);
    if (!block || !Array.isArray(n.groups)) return null;
    let index = block.open + 1;
    try {
      for (const group of n.groups) {
        if (group.kind !== 'SwitchBlockStatementGroup' || !group.labels?.length
            || !Array.isArray(group.statements)) return null;
        for (const label of group.labels) {
          if (label.kind !== 'SwitchLabel' || label.separator !== ':'
              || !['case', 'default'].includes(label.labelKind)
              || tokens[index]?.text !== label.labelKind) return null;
          index++;
          if (label.labelKind === 'case') {
            const first = index;
            let ternaries = 0;
            for (; index < block.close; index++) {
              const text = tokens[index].text;
              if (['case', 'default', ';', '{', '->'].includes(text)) return null;
              if (closes.has(index)) { index = closes.get(index); continue; }
              if (text === '?') ternaries++;
              if (text === ':') {
                if (!ternaries) break;
                ternaries--;
              }
            }
            if (index === first || index >= block.close) return null;
          }
          if (tokens[index]?.text !== ':') return null;
          index++;
        }
        for (const statement of group.statements) {
          if (starts.get(statement.range?.startOffset) !== index) return null;
          index = end(statement);
          if (index > block.close) return null;
        }
      }
    } catch (_) { return null; }
    return index === block.close ? block : null;
  }
  function inspect(n, parent, labels = [], breaks = [], activeLoops = []) {
    parents.set(n, parent);
    if (n.range) nodes.set(n.range.startOffset, n);
    if (['VariableDeclarator', 'FormalParameter'].includes(n.kind)) counts.set(n.name, (counts.get(n.name) || 0) + 1);
    if (n.kind === 'LocalVariableDeclarationStatement' && !(n.modifiers || []).some(m => m.name === 'final')) for (const d of n.declarators) locals.set(d.name, {
      declaration: n,
      parent
    });
    if (['BreakStatement', 'ContinueStatement'].includes(n.kind)) {
      const target = n.label ? labels.slice().reverse().find(l => l.label === n.label) : n.kind === 'ContinueStatement' ? activeLoops.at(-1) : breaks.at(-1);
      const start = starts.get(n.range?.startOffset);
      if (!target || n.kind === 'ContinueStatement' && !(loops.has(target.kind) || loops.has(target.statement?.kind)) || tokens[start]?.text !== (n.kind === 'BreakStatement' ? 'break' : 'continue') || n.label && tokens[start + 1]?.text !== n.label || tokens[start + (n.label ? 2 : 1)]?.text !== ';') refused = true;else targets.set(n, target);
    }
    if (['ReturnStatement', 'ThrowStatement', 'AssertStatement', 'ExpressionStatement'].includes(n.kind) && terminator(n) === null) refused = true;
    if (n.kind === 'ExpressionStatement') {
      const e = n.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(e?.kind) && !(e?.kind === 'UnaryExpression' && ['++', '--'].includes(e.operator))) refused = true;
    }
    if (n.kind === 'LocalVariableDeclarationStatement') {
      if ((n.modifiers || []).some(m => m.kind !== 'Modifier' || m.name !== 'final')) refused = true;
      if (parent?.kind === 'ForStatement' && parent.initializer === n) {
        const start = starts.get(parent.range?.startOffset),
          close = closes.get(start + 1);
        let separators = 0;
        if (tokens[start + 1]?.text !== '(' || close === undefined) refused = true;else for (let i = start + 2; i < close; i++) {
          if (tokens[i].text === ';') separators++;
          if (closes.has(i)) i = closes.get(i);
        }
        if (separators !== 2) refused = true;
      } else if (terminator(n) === null) refused = true;
    }
    if (n.kind === 'SwitchStatement') {
      const shape = switchShape(n);
      if (!shape) refused = true;
      else switches.set(n, shape);
    }
    children(n, c => inspect(c, n, n.kind === 'LabeledStatement' ? [...labels, n] : labels, loops.has(n.kind) || n.kind === 'SwitchStatement' ? [...breaks, n] : breaks, loops.has(n.kind) ? [...activeLoops, n] : activeLoops));
  }
  inspect(parsed, null);
  if (refused || [...labelCounts.values()].some(c => c !== 1)) return unchanged();
  const strip = n => {
    while (n?.kind === 'ParenthesizedExpression') n = n.expression;
    return n;
  };
  function nonconstant(n, site, depth = 0) {
    if (depth > 128) return false;
    n = strip(n);
    if (!n) return false;
    if (['MethodInvocationExpression', 'ArrayAccessExpression', 'NewClassExpression', 'AssignmentExpression'].includes(n.kind)) return true;
    if (n.kind === 'Identifier') {
      if (parameterNames.includes(n.name)) return true;
      const local = locals.get(n.name);
      if (counts.get(n.name) !== 1 || !local) return false;
      if (local.parent?.kind === 'ForStatement') return true;
      const block = extent(local.parent);
      return block && site > local.declaration.range?.startOffset && site < tokens[block.close].range.startOffset;
    }
    if (n.kind === 'UnaryExpression') return ['++', '--'].includes(n.operator) || nonconstant(n.expression || n.operand, site, depth + 1);
    return n.kind === 'BinaryExpression' && (nonconstant(n.left, site, depth + 1) || nonconstant(n.right, site, depth + 1));
  }
  function end(n) {
    if (!n) throw Error('missing statement');
    const start = starts.get(n.range?.startOffset);
    if (n.kind === 'BlockStatement') {
      const block = extent(n);
      if (!block) throw Error('block extent');
      return block.close + 1;
    }
    if (n.kind === 'IfStatement') return end(n.alternate || n.consequent);
    if (n.kind === 'LabeledStatement') return end(n.statement);
    if (['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'SynchronizedStatement'].includes(n.kind)) return end(n.body);
    if (n.kind === 'DoWhileStatement') {
      const after = end(n.body),
        close = closes.get(after + 1);
      if (tokens[after]?.text !== 'while' || tokens[after + 1]?.text !== '(' || tokens[close + 1]?.text !== ';') throw Error('do extent');
      return close + 2;
    }
    if (n.kind === 'TryStatement') return end(n.finallyBlock || n.catches?.at(-1)?.body || n.block);
    if (n.kind === 'SwitchStatement') {
      const block = switchExtent(n);
      if (!block) throw Error('switch extent');
      return block.close + 1;
    }
    if (start === undefined) throw Error('statement start');
    let index = start;
    while (index < tokens.length && ![';', '}'].includes(tokens[index].text)) {
      if (closes.has(index)) index = closes.get(index);
      index++;
    }
    if (tokens[index]?.text !== ';') throw Error('statement terminator');
    return index + 1;
  }
  function declarations(n) {
    let found = false;
    function visit(x) {
      if (['VariableDeclarator', 'FormalParameter'].includes(x.kind)) found = true;
      children(x, visit);
    }
    if (n) visit(n);
    return found;
  }
  const union = (...sets) => new Set(sets.flatMap(s => [...s]));
  const result = (normal, jumps = new Set()) => ({
    normal,
    jumps
  });
  for (const candidate of candidates) {
    const chosenIf = nodes.get(candidate.site + 2);
    if (chosenIf?.kind !== 'IfStatement') continue;
    let blocked = false;
    for (let p = parents.get(chosenIf); p; p = parents.get(p)) if (p.kind === 'TryStatement' && (p.catches || []).some(c => {
      const type = c.parameter.parameterType;
      const types = type.kind === 'UnionType' ? type.alternatives : [type];
      return types.some(t => t.kind !== 'ClassType' || t.packageName !== 'java.lang' || !['RuntimeException', 'Error', 'Exception', 'Throwable'].includes(t.name));
    })) blocked = true;
    if (blocked) continue;
    const selected = candidate.known ? chosenIf.consequent : chosenIf.alternate,
      discarded = candidate.known ? chosenIf.alternate : chosenIf.consequent;
    // The optional late pass retains every original action and selected scope.
    // Its only deletion is a path-proven pure local condition. Existing callers
    // retain the broader completion-aware specialization contract.
    if (preserveActions && (!candidate.known || discarded || selected?.kind !== 'BlockStatement')) continue;
    if (declarations(discarded)) continue;
    const edits = [],
      pruned = [];
    let fails = false;
    function containsChosen(n) {
      if (n === chosenIf) return true;
      let found = false;
      children(n, c => {
        if (containsChosen(c)) found = true;
      });
      return found;
    }
    // Java completion determines both suffix reachability and which frame
    // consumes a transfer. A finally that cannot complete normally overrides
    // pending transfers. Unrecognized or possibly-constant loop conditions
    // stop proof rather than inventing a normal exit.
    function complete(n, replace = true) {
      if (!n) return result(true);
      if (n === chosenIf && replace) return complete(selected, false);
      if (['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'].includes(n.kind)) return result(false, new Set([n]));
      if (['ExpressionStatement', 'EmptyStatement', 'AssertStatement', 'LocalVariableDeclarationStatement'].includes(n.kind)) return result(true);
      if (n.kind === 'BlockStatement') {
        let normal = true,
          jumps = new Set();
        for (let index = 0; index < n.statements.length; index++) {
          const statement = n.statements[index];
          if (!normal) {
            if (!replace || !containsChosen(n) || declarations({
              kind: 'BlockStatement',
              statements: n.statements.slice(index)
            })) {
              fails = true;
              return result(false, jumps);
            }
            const block = extent(n),
              start = starts.get(statement.range?.startOffset);
            if (!block || start === undefined) {
              fails = true;
              return result(false, jumps);
            }
            let first = tokens[start].range.startOffset,
              last = tokens[block.close].range.startOffset;
            const firstLine = wrapped.lastIndexOf('\n', first - 1) + 1,
              lastLine = wrapped.lastIndexOf('\n', last - 1) + 1;
            if (/^[ \t]*$/.test(wrapped.slice(firstLine, first)) && /^[ \t]*$/.test(wrapped.slice(lastLine, last)) && firstLine < lastLine) {
              first = firstLine;
              last = lastLine;
            }
            if (n === parsed) last = Math.min(last, wrapped.length - 2);
            const span = {
              start: first,
              end: last,
              text: ''
            };
            edits.push(span);
            pruned.push({
              start: span.start - 2,
              end: span.end - 2
            });
            break;
          }
          const next = complete(statement, replace);
          normal = next.normal;
          jumps = union(jumps, next.jumps);
        }
        return result(normal, jumps);
      }
      if (n.kind === 'IfStatement') {
        const a = complete(n.consequent, replace),
          b = complete(n.alternate, replace);
        return result(a.normal || b.normal, union(a.jumps, b.jumps));
      }
      if (n.kind === 'SwitchStatement') {
        if (!switches.has(n)) { fails = true; return result(true); }
        let lastNormal = true, jumps = new Set(), hasDefault = false;
        for (const group of n.groups) {
          // A label reestablishes reachability independently of fallthrough.
          // Keep direct case-group suffixes opaque: unlike a BlockStatement,
          // they have shared declaration scope and no closing-brace extent.
          let normal = true;
          hasDefault ||= group.labels.some(label => label.labelKind === 'default');
          for (const statement of group.statements) {
            if (!normal) { fails = true; return result(false, jumps); }
            const next = complete(statement, replace);
            normal = next.normal;
            jumps = union(jumps, next.jumps);
          }
          lastNormal = normal;
        }
        const ownBreak = [...jumps].some(j => j.kind === 'BreakStatement' && targets.get(j) === n);
        return result(!hasDefault || lastNormal || ownBreak,
          new Set([...jumps].filter(j => !(j.kind === 'BreakStatement' && targets.get(j) === n))));
      }
      if (n.kind === 'LabeledStatement') {
        const child = complete(n.statement, replace),
          jumps = new Set([...child.jumps].filter(j => !(j.kind === 'BreakStatement' && targets.get(j) === n)));
        return result(child.normal || jumps.size !== child.jumps.size, jumps);
      }
      if (loops.has(n.kind)) {
        const body = complete(n.body, replace),
          ownBreak = [...body.jumps].some(j => j.kind === 'BreakStatement' && targets.get(j) === n),
          ownContinue = [...body.jumps].some(j => j.kind === 'ContinueStatement' && (targets.get(j) === n || targets.get(j)?.statement === n));
        const jumps = new Set([...body.jumps].filter(j => !(j.kind === 'BreakStatement' && targets.get(j) === n) && !(j.kind === 'ContinueStatement' && (targets.get(j) === n || targets.get(j)?.statement === n))));
        if (n.kind === 'EnhancedForStatement') return result(true, jumps);
        const condition = strip(n.condition),
          never = condition?.kind === 'LiteralExpression' && condition.raw === 'false',
          always = condition?.kind === 'LiteralExpression' && condition.raw === 'true' || n.kind === 'ForStatement' && !n.condition;
        if (never && n.kind === 'DoWhileStatement') return result(ownBreak || body.normal || ownContinue, jumps);
        if (!always && !nonconstant(n.condition, n.range?.startOffset)) {
          fails = true;
          return result(true, jumps);
        }
        return result(ownBreak || !always && (n.kind !== 'DoWhileStatement' || body.normal || ownContinue), jumps);
      }
      if (n.kind === 'TryStatement') {
        const body = complete(n.block, replace),
          catches = (n.catches || []).map(c => complete(c.body, replace));
        let normal = body.normal || catches.some(c => c.normal),
          jumps = union(body.jumps, ...catches.map(c => c.jumps));
        if (n.finallyBlock) {
          const cleanup = complete(n.finallyBlock, replace);
          jumps = cleanup.normal ? union(jumps, cleanup.jumps) : cleanup.jumps;
          normal = normal && cleanup.normal;
        }
        return result(normal, jumps);
      }
      if (n.kind === 'SynchronizedStatement') return complete(n.body, replace);
      fails = true;
      return result(true);
    }
    try {
      complete(parsed);
      if (fails || preserveActions && pruned.length) continue;
      const start = starts.get(chosenIf.range.startOffset),
        after = end(chosenIf),
        selectedStart = selected ? selected.kind === 'BlockStatement' ? extent(selected)?.open : starts.get(selected.range?.startOffset) : null,
        selectedEnd = selected ? end(selected) : null;
      if (selected && selectedStart === undefined) continue;
      let text = selected ? wrapped.slice(tokens[selectedStart].range.startOffset, tokens[selectedEnd - 1].range.endOffset) : parents.get(chosenIf)?.kind === 'BlockStatement' ? '' : ';';
      if (selected && selected.kind !== 'BlockStatement') text = '{ ' + text + ' }';
      const edit = {
        start: tokens[start].range.startOffset,
        end: tokens[after - 1].range.endOffset,
        text
      };
      if (!selected && !text) {
        // Delete a whole vacant statement line when possible. Retain the
        // wrapper's final newline, which belongs to the parser, not the source.
        const lineStart = wrapped.lastIndexOf('\n', edit.start - 1) + 1;
        const lineEnd = wrapped.indexOf('\n', edit.end);
        if (lineEnd >= 0 && !wrapped.slice(lineStart, edit.start).trim()
            && !wrapped.slice(edit.end, lineEnd).trim()) {
          edit.start = lineStart;
          edit.end = Math.min(lineEnd + 1, wrapped.length - 2);
        }
      }
      edits.push(edit);
      edits.sort((a, b) => a.start - b.start);
      if (edits.some((e, i) => i && edits[i - 1].end > e.start)) continue;
      let output = wrapped;
      for (const e of edits.slice().reverse()) output = output.slice(0, e.start) + e.text + output.slice(e.end);
      return {
        source: output.slice(2, -2),
        guardsSpecialized: 1,
        ...(retainDiagnostics ? {
          diagnostics: {
            ...candidate,
            edit: {
              ...edit,
              start: edit.start - 2,
              end: edit.end - 2,
              selectedStart: selected ? tokens[selectedStart].range.startOffset - 2 : null,
              selectedEnd: selected ? tokens[selectedEnd - 1].range.endOffset - 2 : null
            },
            prunedRanges: pruned,
            removedRanges: [{
              start: edit.start - 2,
              end: selected ? tokens[selectedStart].range.startOffset - 2 : edit.end - 2
            }, ...(selected ? [{
              start: tokens[selectedEnd - 1].range.endOffset - 2,
              end: edit.end - 2
            }] : []), ...pruned]
          }
        } : {})
      };
    } catch (error) {
      continue;
    }
  }
  return unchanged();
}
module.exports = {
  specializePathGuards
};
