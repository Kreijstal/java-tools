'use strict';

// An exit guard is irrelevant only if both paths reach the same lexical exit
// and evaluating the guard cannot have effects or fail. Keep declarations and
// their initializers; infer types and scope, never the value of a captured flag.
function foldRedundantExitGuards(source, proof, {parameters = [], retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, guardsRemoved: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || !Array.isArray(parameters) || source.length > 400000) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const primitives = new Set(['boolean', 'byte', 'short', 'char', 'int', 'long', 'float', 'double']);
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  const counts = new Map(), locals = new Map(), formals = new Map(), targets = new Map(), lists = [], statementStarts = new Set();
  const returnTarget = {};
  let refused = false;
  function walk(node, visit, parent = null, depth = 0) {
    if (depth > 128) {refused = true; return;}
    visit(node, parent); children(node, child => walk(child, visit, node, depth + 1));
  }
  walk(parsed, node => {
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (node.kind === 'ExpressionStatement') {
      const expression = node.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(expression?.kind)
          && !(expression?.kind === 'UnaryExpression' && ['++', '--'].includes(expression.operator))) refused = true;
      let end = starts.get(node.range?.startOffset);
      if (end === undefined) refused = true;
      else {
        while (end < tokens.length && tokens[end].text !== ';' && tokens[end].text !== '}') {
          if (closes.has(end)) end = closes.get(end);
          end++;
        }
        if (tokens[end]?.text !== ';') refused = true;
      }
    }
    if (['VariableDeclarator', 'FormalParameter'].includes(node.kind)) counts.set(node.name, (counts.get(node.name) || 0) + 1);
    if (node.kind?.endsWith('Statement') && node.range) statementStarts.add(node.range.startOffset);
  });
  if (refused || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  for (const parameter of parameters) {
    if (!parameter || typeof parameter.name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(parameter.name)
        || typeof parameter.type !== 'string' || formals.has(parameter.name)) return unchanged();
    formals.set(parameter.name, primitives.has(parameter.type) ? parameter.type : null);
  }
  walk(parsed, (node, parent) => {
    if (node.kind !== 'LocalVariableDeclarationStatement' || parent?.kind !== 'BlockStatement'
        || node.annotations?.length || node.variableType?.annotations?.length
        || node.variableType?.kind !== 'PrimitiveType' || !primitives.has(node.variableType.name)) return;
    let open = starts.get(parent.range?.startOffset);
    if (open === undefined) {
      const first = starts.get(parent.statements?.[0]?.range?.startOffset);
      if (tokens[first - 1]?.text === '{') open = first - 1;
    }
    const close = closes.get(open), first = starts.get(node.range?.startOffset);
    if (tokens[open]?.text !== '{' || close === undefined || first === undefined) return;
    let end = null;
    for (let index = first; index < close; index++) {
      if (index !== first && statementStarts.has(tokens[index].range.startOffset)) break;
      if (tokens[index].text === ';') {end = index; break;}
      if (tokens[index].text === '}') break;
      if (closes.has(index)) index = closes.get(index);
    }
    if (end === null) return;
    for (const variable of node.declarators) if (variable.dimensions === 0) locals.set(variable.name, {
      type: node.variableType.name, start: tokens[end].range.endOffset, end: tokens[close].range.startOffset,
    });
  });
  const numeric = type => primitives.has(type) && type !== 'boolean';
  const integral = type => ['byte', 'short', 'char', 'int', 'long'].includes(type);
  function pureType(node, site, depth = 0) {
    if (!node || depth > 64) return null;
    const type = child => pureType(child, site, depth + 1);
    if (node.kind === 'ParenthesizedExpression') return type(node.expression);
    if (node.kind === 'Identifier') {
      if (formals.has(node.name)) return counts.has(node.name) ? null : formals.get(node.name);
      const local = locals.get(node.name);
      return counts.get(node.name) === 1 && local && site >= local.start && site < local.end ? local.type : null;
    }
    if (node.kind === 'LiteralExpression') {
      if (['true', 'false'].includes(node.raw)) return 'boolean';
      if (node.literalKind === 'char') return 'char';
      const raw = (node.raw || '').replace(/_/g, '');
      if (node.literalKind === 'number' && /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)[lL]?$/.test(raw)) return /[lL]$/.test(raw) ? 'long' : 'int';
      return null;
    }
    if (node.kind === 'UnaryExpression') {
      const operand = type(node.operand);
      if (node.operator === '!' && node.prefix === true && operand === 'boolean') return 'boolean';
      if (['+', '-'].includes(node.operator) && numeric(operand)) return integral(operand) && operand !== 'long' ? 'int' : operand;
      if (node.operator === '~' && integral(operand)) return operand === 'long' ? 'long' : 'int';
      return null;
    }
    if (node.kind !== 'BinaryExpression') return null;
    const left = type(node.left), right = type(node.right);
    if (['&&', '||'].includes(node.operator)) return left === 'boolean' && right === 'boolean' ? 'boolean' : null;
    if (['==', '!='].includes(node.operator)) return left === 'boolean' && right === 'boolean' || numeric(left) && numeric(right) ? 'boolean' : null;
    if (['<', '<=', '>', '>='].includes(node.operator)) return numeric(left) && numeric(right) ? 'boolean' : null;
    if (['&', '|', '^'].includes(node.operator) && left === 'boolean' && right === 'boolean') return 'boolean';
    if (['<<', '>>', '>>>'].includes(node.operator)) return integral(left) && integral(right) ? left === 'long' ? 'long' : 'int' : null;
    if (!['+', '-', '*', '&', '|', '^'].includes(node.operator) || !numeric(left) || !numeric(right)
        || ['&', '|', '^'].includes(node.operator) && (!integral(left) || !integral(right))) return null;
    return left === 'double' || right === 'double' ? 'double' : left === 'float' || right === 'float' ? 'float'
      : left === 'long' || right === 'long' ? 'long' : 'int';
  }
  function inspect(node, labels = [], loopStack = [], breakStack = []) {
    if (node.kind === 'BlockStatement') lists.push(node.statements);
    if (node.kind === 'SwitchStatement') {
      if (node.groups.some(group => group.labels.some(label => label.separator !== ':'))) refused = true;
      for (let index = 0; index < node.groups.length; index++) {
        const group = node.groups[index]; let next = index + 1;
        while (next < node.groups.length && !node.groups[next].statements.length) next++;
        lists.push([...group.statements, ...(node.groups[next]?.statements.slice(0, 1) || [])]);
      }
    }
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      const frame = node.label && labels.slice().reverse().find(label => label.label === node.label);
      const target = node.label ? frame : node.kind === 'ContinueStatement' ? loopStack.at(-1) : breakStack.at(-1);
      if (!target || node.kind === 'ContinueStatement' && node.label && !loops.has(frame.statement?.kind)) refused = true;
      else targets.set(node, target);
    } else if (node.kind === 'ReturnStatement' && !node.expression) targets.set(node, returnTarget);
    const nestedLabels = node.kind === 'LabeledStatement' ? [...labels, node] : labels;
    const nestedLoops = loops.has(node.kind) ? [...loopStack, node] : loopStack;
    const nestedBreaks = loops.has(node.kind) || node.kind === 'SwitchStatement' ? [...breakStack, node] : breakStack;
    children(node, child => inspect(child, nestedLabels, nestedLoops, nestedBreaks));
  }
  inspect(parsed);
  if (refused) return unchanged();
  function jump(node) {
    if (node?.kind === 'BlockStatement') return node.statements.length === 1 ? jump(node.statements[0]) : null;
    return targets.has(node) ? node : null;
  }
  const same = (a, b) => a && b && a.kind === b.kind && (a.label || null) === (b.label || null) && targets.get(a) === targets.get(b);
  const empty = node => !node || node.kind === 'EmptyStatement' || node.kind === 'BlockStatement' && node.statements.length === 0;
  function finish(node) {
    const first = starts.get(node?.range?.startOffset);
    if (node?.kind === 'BlockStatement' && tokens[first]?.text === '{') return closes.get(first);
    if (node?.kind === 'EmptyStatement' && tokens[first]?.text === ';') return first;
    if (!targets.has(node)) return null;
    const keyword = {BreakStatement: 'break', ContinueStatement: 'continue', ReturnStatement: 'return'}[node.kind];
    if (tokens[first]?.text !== keyword) return null;
    const end = first + (node.label ? 2 : 1);
    return tokens[end]?.text === ';' ? end : null;
  }
  const selected = new Map();
  for (const list of lists) for (let index = 0; index < list.length; index++) {
    const guard = list[index];
    if (guard.kind !== 'IfStatement' || selected.has(guard)) continue;
    const first = starts.get(guard.range?.startOffset), open = first + 1, close = closes.get(open), yes = jump(guard.consequent);
    if (!yes || tokens[first]?.text !== 'if' || tokens[open]?.text !== '(' || close === undefined
        || pureType(guard.condition, tokens[first].range.startOffset) !== 'boolean') continue;
    const no = jump(guard.alternate), following = jump(list[index + 1]);
    const bothArms = Boolean(same(yes, no)), adjacent = empty(guard.alternate) && same(yes, following);
    if (!bothArms && !adjacent) continue;
    const last = finish(guard.alternate || guard.consequent), jumpFirst = starts.get(yes.range?.startOffset), jumpLast = finish(yes);
    if (last === null || jumpFirst === undefined || jumpLast === null) continue;
    let start = tokens[first].range.startOffset, end = tokens[last].range.endOffset;
    const ranges = bothArms ? [{start, end: tokens[jumpFirst].range.startOffset}, {start: tokens[jumpLast].range.endOffset, end}] : [{start, end}];
    if (adjacent) {
      const lineStart = wrapped.lastIndexOf('\n', start - 1) + 1, lineEnd = wrapped.indexOf('\n', end);
      if (lineEnd >= 0 && !wrapped.slice(lineStart, start).trim() && !wrapped.slice(end, lineEnd).trim()) {
        ranges[0] = {start: lineStart, end: lineEnd + 1};
      }
    }
    selected.set(guard, {ranges, guard: {start: start - 2, end: end - 2,
      conditionStart: tokens[open].range.endOffset - 2, conditionEnd: tokens[close].range.startOffset - 2,
      exitKind: yes.kind, exitLabel: yes.label || null, bothArms}});
  }
  if (!selected.size) return unchanged();
  const edits = [...selected.values()].flatMap(item => item.ranges).filter(range => range.start < range.end).sort((a, b) => a.start - b.start);
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + output.slice(edit.end);
  return {source: output.slice(2, -2), guardsRemoved: selected.size, ...(retainDiagnostics ? {diagnostics: {
    deletedRanges: edits.map(edit => ({start: edit.start - 2, end: edit.end - 2})),
    removedGuards: [...selected.values()].map(item => item.guard),
  }} : {})};
}

module.exports = {foldRedundantExitGuards};
