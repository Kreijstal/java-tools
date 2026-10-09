'use strict';

// An enclosing branch can prove a comparison of a captured primitive local.
// Elide only Boolean identity operands; retain every unknown atom and action.
// Fields, shadowing, later/cyclic writes and absorbing short-circuit paths stay
// opaque. No value is inferred from an initializer or a global control flag.
function simplifyDominatedPredicates(source, proof, {retainDiagnostics = false, parameterNames = []} = {}) {
  const unchanged = () => ({source, conditionsSimplified: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || (!Array.isArray(parameterNames) || parameterNames.some(name => typeof name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(name)) || new Set(parameterNames).size !== parameterNames.length) || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children} = proof;
  const loops = new Set(['WhileStatement', 'ForStatement', 'DoWhileStatement', 'EnhancedForStatement']);
  const names = new Map(), locals = new Map(), writes = new Map(), statementStarts = new Set();
  let invalid = false;
  function walk(node, visit, parent = null, site = 0, cyclic = false, depth = 0) {
    if (depth > 128) { invalid = true; return; }
    site = node.range?.startOffset ?? site; cyclic ||= loops.has(node.kind);
    visit(node, parent, site, cyclic); children(node, child => walk(child, visit, node, site, cyclic, depth + 1));
  }
  const strip = node => { while (node?.kind === 'ParenthesizedExpression') node = node.expression; return node; };
  walk(parsed, (node, parent, site, cyclic) => {
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) invalid = true;
    if (node.kind?.endsWith('Statement') && node.range) statementStarts.add(site);
    if (['VariableDeclarator', 'FormalParameter'].includes(node.kind)) names.set(node.name, (names.get(node.name) || 0) + 1);
    const operand = strip(node.kind === 'AssignmentExpression' ? node.left
      : node.kind === 'UnaryExpression' && ['++', '--'].includes(node.operator) ? node.operand : null);
    if (operand?.kind === 'Identifier') {
      if (!writes.has(operand.name)) writes.set(operand.name, []);
      writes.get(operand.name).push({site, cyclic});
    }
  });
  if (invalid) return unchanged();
  walk(parsed, (node, parent, site, cyclic) => {
    if (node.kind !== 'LocalVariableDeclarationStatement' || parent?.kind !== 'BlockStatement' || node.annotations?.length) return;
    let open = starts.get(parent.range?.startOffset);
    if (open === undefined) {
      const first = starts.get(parent.statements?.[0]?.range?.startOffset);
      if (tokens[first - 1]?.text === '{') open = first - 1;
    }
    const close = closes.get(open), first = starts.get(node.range?.startOffset);
    if (close === undefined || first === undefined) return;
    let end = null;
    for (let index = first; index < close; index++) {
      if (index !== first && statementStarts.has(tokens[index].range.startOffset)) break;
      if (tokens[index].text === ';') { end = index; break; }
      if (tokens[index].text === '}') break;
      if (closes.has(index)) index = closes.get(index);
    }
    if (end === null) return;
    for (const variable of node.declarators) locals.set(variable.name, {
      start: tokens[end].range.endOffset, end: tokens[close].range.startOffset, cyclic,
      integral: !variable.dimensions && node.variableType?.kind === 'PrimitiveType' && node.variableType.name === 'int',
      mutable: !(node.modifiers || []).some(modifier => modifier.name === 'final')
    });
  });
  function visible(name, site) {
    const local = locals.get(name);
    return names.get(name) === 1 && local && site >= local.start && site < local.end ? local : null;
  }
  function comparison(node, site) {
    node = strip(node);
    if (node?.kind !== 'BinaryExpression' || !['==', '!='].includes(node.operator)) return null;
    let id = strip(node.left), literal = strip(node.right);
    if (id?.kind !== 'Identifier') { id = strip(node.right); literal = strip(node.left); }
    let sign = 1;
    if (literal?.kind === 'UnaryExpression' && ['+', '-'].includes(literal.operator)) {
      sign = literal.operator === '-' ? -1 : 1; literal = strip(literal.operand);
    }
    if (id?.kind !== 'Identifier' || literal?.kind !== 'LiteralExpression' || !/^(?:0|[1-9][0-9]*)$/.test(literal.raw || '')) return null;
    const value = sign * Number(literal.raw), local = visible(id.name, site);
    if (value < -2147483648 || value > 2147483647 || !local?.integral || local.cyclic
        || writes.get(id.name)?.some(write => write.cyclic || write.site >= site)) return null;
    return {name: id.name, value, equal: node.operator === '=='};
  }
  const key = comparison => comparison.name + '=' + comparison.value;
  function infer(node, value, env, site, branch, depth = 0) {
    if (!node || depth > 64) return;
    node = strip(node);
    if (node.kind === 'UnaryExpression' && node.operator === '!' && node.prefix === true)
      return infer(node.operand, !value, env, site, branch, depth + 1);
    if (node.kind === 'BinaryExpression' && (node.operator === '&&' && value || node.operator === '||' && !value)) {
      infer(node.left, value, env, site, branch, depth + 1); infer(node.right, value, env, site, branch, depth + 1); return;
    }
    const c = comparison(node, site);
    if (c && env.get(key(c))?.equalityHolds !== (value === c.equal))
      env.set(key(c), {...c, equalityHolds: value === c.equal, guardSite: site - 2, branch});
  }
  function known(c, env) {
    let fact = env.get(key(c));
    if (fact) return {known: fact.equalityHolds === c.equal, fact};
    fact = [...env.values()].find(fact => fact.name === c.name && fact.equalityHolds && fact.value !== c.value);
    return fact ? {known: !c.equal, fact} : null;
  }
  function rootOperator(node, first, end) {
    let index = null;
    for (let i = first; i < end; i++) {
      if (closes.has(i)) i = closes.get(i);
      else if (tokens[i].text === node.operator) index = i;
    }
    return index;
  }
  function nonconstant(node, site, depth = 0) {
    if (!node || depth > 64) return false;
    node = strip(node);
    if (['MethodInvocationExpression', 'ArrayAccessExpression', 'NewClassExpression', 'AssignmentExpression'].includes(node.kind)) return true;
    if (node.kind === 'Identifier') return parameterNames.includes(node.name) || !!visible(node.name, site)?.mutable;
    if (node.kind === 'UnaryExpression') return ['++', '--'].includes(node.operator) || nonconstant(node.operand, site, depth + 1);
    return node.kind === 'BinaryExpression' && (nonconstant(node.left, site, depth + 1) || nonconstant(node.right, site, depth + 1));
  }
  function render(node, first, end, env, site, depth = 0) {
    const opaque = () => ({value: null, proofs: [], cuts: [], removed: [], conjunctions: 0, disjunctions: 0, nonconstant: nonconstant(node, site)});
    if (depth > 64 || first >= end) { invalid = true; return opaque(); }
    if (node.kind === 'ParenthesizedExpression') {
      if (tokens[first]?.text !== '(' || closes.get(first) !== end - 1) { invalid = true; return opaque(); }
      return render(node.expression, first + 1, end - 1, env, site, depth + 1);
    }
    const c = comparison(node, site), evidence = c && known(c, env);
    if (evidence) return {...opaque(), value: evidence.known, proofs: [{...c, ...evidence,
      start: tokens[first].range.startOffset - 2, end: tokens[end - 1].range.endOffset - 2}]};
    if (node.kind === 'LiteralExpression' && ['true', 'false'].includes(node.raw)) return {...opaque(), value: node.raw === 'true'};
    if (node.kind === 'UnaryExpression' && node.operator === '!' && node.prefix === true) {
      if (tokens[first]?.text !== '!') { invalid = true; return opaque(); }
      const r = render(node.operand, first + 1, end, env, site, depth + 1);
      return {...r, value: r.value === null ? null : !r.value};
    }
    if (node.kind !== 'BinaryExpression' || !['&&', '||'].includes(node.operator)) return opaque();
    const index = rootOperator(node, first, end);
    if (index === null || index <= first || index >= end - 1) { invalid = true; return opaque(); }
    const a = render(node.left, first, index, env, site, depth + 1), rightEnv = new Map(env);
    // The right operand runs only after the left has the operator's enabling
    // value. Writes anywhere in that condition invalidate its local facts.
    infer(node.left, node.operator === '&&', rightEnv, site, node.operator === '&&');
    const b = render(node.right, index + 1, end, rightEnv, site, depth + 1);
    if (a.value !== null && b.value !== null) return {...opaque(), value: node.operator === '&&' ? a.value && b.value : a.value || b.value, proofs: [...a.proofs, ...b.proofs]};
    const neutral = node.operator === '&&', chooseRight = a.value === neutral && b.value === null, chooseLeft = b.value === neutral && a.value === null;
    if (chooseLeft || chooseRight) {
      const selected = chooseLeft ? a : b, discarded = chooseLeft ? b : a;
      const cut = chooseLeft ? {start: tokens[index - 1].range.endOffset - 2, end: tokens[end - 1].range.endOffset - 2}
        : {start: tokens[first].range.startOffset - 2, end: tokens[index + 1].range.startOffset - 2};
      return {...selected, cuts: [...selected.cuts, cut], removed: [...selected.removed, ...discarded.proofs],
        conjunctions: selected.conjunctions + (neutral ? 1 : 0), disjunctions: selected.disjunctions + (neutral ? 0 : 1)};
    }
    return {...opaque(), cuts: [...a.cuts, ...b.cuts], removed: [...a.removed, ...b.removed],
      conjunctions: a.conjunctions + b.conjunctions, disjunctions: a.disjunctions + b.disjunctions,
      nonconstant: a.nonconstant || b.nonconstant};
  }
  const edits = [], removedComparisons = [], counts = {comparisonsRemoved: 0, conjunctionsRemoved: 0, disjunctionsRemoved: 0};
  let conditions = 0;
  function condition(node, env) {
    const first = starts.get(node.range?.startOffset); let open;
    if (['IfStatement', 'WhileStatement', 'ForStatement'].includes(node.kind)) open = first + 1;
    else if (node.kind === 'DoWhileStatement' && node.body?.kind === 'BlockStatement') {
      const close = closes.get(starts.get(node.body.range?.startOffset));
      if (tokens[close + 1]?.text === 'while') open = close + 2;
    }
    if (!node.condition || open === undefined) return;
    const close = closes.get(open);
    if (tokens[open]?.text !== '(' || close === undefined) { invalid = true; return; }
    let begin = open + 1, end = close;
    if (node.kind === 'ForStatement') {
      const separators = [];
      for (let i = begin; i < end; i++) { if (closes.has(i)) i = closes.get(i); else if (tokens[i].text === ';') separators.push(i); }
      if (separators.length !== 2) { invalid = true; return; }
      begin = separators[0] + 1; end = separators[1];
    }
    const r = render(node.condition, begin, end, env, node.range.startOffset);
    if (!r.removed.length || r.value !== null || loops.has(node.kind) && !r.nonconstant) return;
    edits.push(...r.cuts); removedComparisons.push(...r.removed); conditions++;
    counts.comparisonsRemoved += r.removed.length; counts.conjunctionsRemoved += r.conjunctions; counts.disjunctionsRemoved += r.disjunctions;
  }
  function statements(node, env, depth = 0) {
    if (!node || depth > 128) return;
    if (node.kind === 'IfStatement') {
      condition(node, env);
      const a = new Map(env), b = new Map(env);
      infer(node.condition, true, a, node.range.startOffset, true); infer(node.condition, false, b, node.range.startOffset, false);
      statements(node.consequent, a, depth + 1); statements(node.alternate, b, depth + 1); return;
    }
    if (loops.has(node.kind)) {
      condition(node, env);
      const bodyEnv = new Map(env);
      if (['WhileStatement', 'ForStatement'].includes(node.kind) && node.condition)
        infer(node.condition, true, bodyEnv, node.range.startOffset, true);
      statements(node.body, bodyEnv, depth + 1); return;
    }
    if (node.kind === 'BlockStatement') { for (const child of node.statements) statements(child, new Map(env), depth + 1); return; }
    if (node.kind === 'TryStatement') {
      statements(node.block, new Map(env), depth + 1);
      for (const clause of node.catches || []) statements(clause.body, new Map(env), depth + 1);
      statements(node.finallyBlock, new Map(env), depth + 1); return;
    }
    if (node.kind === 'LabeledStatement') { statements(node.statement, new Map(env), depth + 1); return; }
    if (node.kind === 'SynchronizedStatement') { statements(node.body, new Map(env), depth + 1); return; }
    if (node.kind === 'SwitchStatement') for (const group of node.groups || []) for (const child of group.statements || []) statements(child, new Map(env), depth + 1);
  }
  statements(parsed, new Map());
  if (invalid || !conditions || edits.length > 4096) return unchanged();
  edits.sort((a,b) => a.start - b.start || a.end - b.end);
  if (edits.some((edit,index) => index && edits[index-1].end > edit.start)) return unchanged();
  let output = source;
  for (const edit of edits.slice().reverse()) output = output.slice(0,edit.start) + output.slice(edit.end);
  return {source: output, conditionsSimplified: conditions,
    ...(retainDiagnostics ? {diagnostics: {counts, deletedRanges: edits, removedComparisons}} : {})};
}

module.exports = {simplifyDominatedPredicates};
