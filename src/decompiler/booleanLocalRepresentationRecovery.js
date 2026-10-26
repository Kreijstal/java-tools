'use strict';

// A closed network of local int slots whose every store is a bit and whose
// only external reads are equality tests can retain the Boolean value rather
// than repeatedly materializing 0/1. No snapshot, condition or eager bitwise
// operation moves; a numeric observer rejects the entire connected network.
function recoverBooleanLocalRepresentations(source, proof, {reservedNames = []} = {}) {
  const unchanged = () => ({source, localsPromoted: 0, comparisonsRecovered: 0, selectionsRecovered: 0});
  if (!proof || typeof source !== 'string' || source.length > 400000 || !Array.isArray(reservedNames)
      || reservedNames.some(name => typeof name !== 'string')) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children} = proof;
  const parents = new Map(), counts = new Map(), nodes = [], identifiers = [], numbers = [];
  let refused = false;
  function walk(node, parent = null, depth = 0) {
    if (depth > 128) {refused = true; return;}
    parents.set(node, parent); nodes.push(node);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(node.kind || '')
        || node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (['VariableDeclarator', 'FormalParameter'].includes(node.kind)) counts.set(node.name, (counts.get(node.name) || 0) + 1);
    if (node.kind === 'Identifier') identifiers.push(node);
    if (node.kind === 'LiteralExpression' && node.literalKind === 'number') numbers.push(node);
    children(node, child => walk(child, node, depth + 1));
  }
  walk(parsed);
  if (refused) return unchanged();
  // Expression nodes have no source offsets. Match their lexical leaves to
  // tokens in order, and validate each editable expression's complete grammar.
  const numericTokens = tokens.map((token, index) => ({token, index})).filter(({token}) => token.kind === 'number');
  if (numericTokens.length !== numbers.length || numbers.some((node, index) => node.raw !== numericTokens[index].token.text)) return unchanged();
  const leaf = new Map(numbers.map((node, index) => [node, numericTokens[index].index]));
  const candidates = new Map(), groups = [];
  function endStatement(first) {
    for (let index = first; index < tokens.length; index++) {
      if (tokens[index].text === ';') return index;
      if (tokens[index].text === '}') return null;
      if (closes.has(index)) index = closes.get(index);
    }
    return null;
  }
  for (const declaration of nodes) {
    if (declaration.kind !== 'LocalVariableDeclarationStatement' || parents.get(declaration)?.kind !== 'BlockStatement'
        || declaration.variableType?.kind !== 'PrimitiveType' || declaration.variableType.name !== 'int'
        || declaration.annotations?.length || declaration.variableType.annotations?.length
        || declaration.modifiers?.some(modifier => modifier.name !== 'final')) continue;
    const first = starts.get(declaration.range?.startOffset), last = endStatement(first);
    if (first === undefined || last === null) continue;
    let type = first;
    while (tokens[type]?.text === 'final') type++;
    if (tokens[type]?.text !== 'int') continue;
    const parts = []; let begin = type + 1;
    for (let index = begin; index <= last; index++) {
      if ([',', ';'].includes(tokens[index].text)) {parts.push([begin, index]); begin = index + 1;}
      else if (closes.has(index)) index = closes.get(index);
    }
    if (parts.length !== declaration.declarators.length || parts.some(([start, end], index) =>
      tokens[start]?.text !== declaration.declarators[index].name || declaration.declarators[index].dimensions
      || end > start + 1 && tokens[start + 1]?.text !== '=')) continue;
    const group = {declaration, type, names: []}; groups.push(group);
    for (const [index, variable] of declaration.declarators.entries()) {
      if (counts.get(variable.name) !== 1 || reservedNames.includes(variable.name)) continue;
      const [start, end] = parts[index];
      group.names.push(variable.name);
      candidates.set(variable.name, {name: variable.name, variable, scope: parents.get(declaration), group,
        declaration: start, initializer: variable.initializer ? [start + 2, end - 1] : null,
        invalid: false, writes: [], neighbors: new Set(), readCount: 0});
    }
    // A declaration's written type is shared by all its declarators.
    if (group.names.length !== declaration.declarators.length) for (const name of group.names) candidates.get(name).invalid = true;
  }
  if (!candidates.size || candidates.size > 4096) return unchanged();
  const astNames = new Map([...candidates.keys()].map(name => [name, []]));
  const tokenNames = new Map([...candidates.keys()].map(name => [name, []]));
  for (const node of identifiers) if (astNames.has(node.name)) astNames.get(node.name).push(node);
  tokens.forEach((token, index) => {
    if (token.kind === 'identifier' && tokenNames.has(token.text)) tokenNames.get(token.text).push(index);
  });
  const positions = new Map();
  for (const [name, candidate] of candidates) {
    const occurrences = astNames.get(name);
    const indices = tokenNames.get(name).filter(index => index !== candidate.declaration);
    if (occurrences.length !== indices.length) {candidate.invalid = true; continue;}
    occurrences.forEach((node, index) => {
      const position = indices[index]; positions.set(node, position); leaf.set(node, position);
      let owner = node;
      while (owner && owner !== candidate.scope) owner = parents.get(owner);
      if (!owner || position <= candidate.declaration) candidate.invalid = true;
    });
  }
  const peel = node => {while (node?.kind === 'ParenthesizedExpression') node = node.expression; return node;};
  const bit = node => {node = peel(node); return node?.kind === 'LiteralExpression' && node.literalKind === 'number' && ['0', '1'].includes(node.raw) ? node.raw : null;};
  const stores = [], comparisons = [], classified = new Set();
  function connect(names) {
    const list = [...names];
    for (let index = 1; index < list.length; index++) {
      candidates.get(list[0]).neighbors.add(list[index]); candidates.get(list[index]).neighbors.add(list[0]);
    }
  }
  function shape(node, first, last, conditional = true, depth = 0) {
    if (!node || first > last || depth > 64) return null;
    const exact = (text, mapped) => first === last && tokens[first]?.text === text && mapped === first;
    if (node.kind === 'Identifier') return candidates.has(node.name) && exact(node.name, positions.get(node))
      ? {node, first, last, refs: [node], names: new Set([node.name])} : null;
    if (node.kind === 'LiteralExpression') return bit(node) !== null && exact(node.raw, leaf.get(node))
      ? {node, first, last, refs: [], names: new Set()} : null;
    if (node.kind === 'ParenthesizedExpression') {
      if (tokens[first]?.text !== '(' || closes.get(first) !== last) return null;
      const inner = shape(node.expression, first + 1, last - 1, conditional, depth + 1);
      return inner ? {node, first, last, parts: [inner], refs: inner.refs, names: inner.names} : null;
    }
    function join(parts) {return {node, first, last, parts, refs: parts.flatMap(part => part.refs), names: new Set(parts.flatMap(part => [...part.names]))};}
    if (node.kind === 'BinaryExpression' && ['&', '|', '^'].includes(node.operator)) {
      let operator = null;
      for (let index = first; index <= last; index++) {
        if (closes.has(index)) index = closes.get(index);
        else if (tokens[index].text === node.operator) operator = index;
      }
      if (operator === null) return null;
      const left = shape(node.left, first, operator - 1, conditional, depth + 1), right = shape(node.right, operator + 1, last, conditional, depth + 1);
      return left && right ? join([left, right]) : null;
    }
    if (conditional && node.kind === 'ConditionalExpression') {
      let question = null, colon = null, nested = 0;
      for (let index = first; index <= last; index++) {
        if (closes.has(index)) {index = closes.get(index); continue;}
        if (tokens[index].text === '?') {if (question === null) question = index; else nested++;}
        if (tokens[index].text === ':' && question !== null) {if (nested) nested--; else {colon = index; break;}}
      }
      if (question === null || colon === null || question === first) return null;
      const yes = shape(node.consequent, question + 1, colon - 1, conditional, depth + 1), no = shape(node.alternate, colon + 1, last, conditional, depth + 1);
      return yes && no ? {...join([yes, no]), condition: [first, question - 1]} : null;
    }
    return null;
  }
  function store(candidate, expression, span) {
    const value = span && shape(expression, ...span);
    if (!value) {candidate.invalid = true; return;}
    const names = new Set([candidate.name, ...value.names]); connect(names);
    for (const reference of value.refs) classified.add(reference);
    const record = {candidate, value, names}; candidate.writes.push(record); stores.push(record);
  }
  for (const candidate of candidates.values()) if (candidate.initializer) store(candidate, candidate.variable.initializer, candidate.initializer);
  for (const node of nodes) {
    if (node.kind !== 'AssignmentExpression' || node.left?.kind !== 'Identifier' || !candidates.has(node.left.name)) continue;
    const candidate = candidates.get(node.left.name), statement = parents.get(node), first = positions.get(node.left);
    if (node.operator !== '=' || statement?.kind !== 'ExpressionStatement' || statement.expression !== node
        || starts.get(statement.range?.startOffset) !== first || tokens[first + 1]?.text !== '=') continue;
    classified.add(node.left);
    const end = endStatement(first);
    store(candidate, node.right, end === null ? null : [first + 2, end - 1]);
  }
  // Locate a comparison operand only through a verified tree of local leaves,
  // literal bits and eager operators. Unknown calls/fields stay opaque.
  function bounds(node) {
    if (node.kind === 'Identifier' || node.kind === 'LiteralExpression') {
      const index = leaf.get(node); return index === undefined ? null : [index, index];
    }
    if (node.kind === 'ParenthesizedExpression') {
      const inner = bounds(node.expression);
      return inner && tokens[inner[0] - 1]?.text === '(' && closes.get(inner[0] - 1) === inner[1] + 1 ? [inner[0] - 1, inner[1] + 1] : null;
    }
    if (node.kind === 'BinaryExpression' && ['&', '|', '^'].includes(node.operator)) {
      const left = bounds(node.left), right = bounds(node.right);
      return left && right && right[0] === left[1] + 2 && tokens[left[1] + 1]?.text === node.operator ? [left[0], right[1]] : null;
    }
    return null;
  }
  for (const node of nodes) if (node.kind === 'BinaryExpression' && ['==', '!='].includes(node.operator)) {
    const leftSpan = bounds(node.left), rightSpan = bounds(node.right);
    if (!leftSpan || !rightSpan || rightSpan[0] !== leftSpan[1] + 2 || tokens[leftSpan[1] + 1]?.text !== node.operator) continue;
    const left = shape(node.left, ...leftSpan, false), right = shape(node.right, ...rightSpan, false);
    if (!left || !right) continue;
    const names = new Set([...left.names, ...right.names]);
    if (!names.size) continue;
    connect(names); for (const reference of [...left.refs, ...right.refs]) classified.add(reference);
    comparisons.push({node, left, right, names, first: leftSpan[0], last: rightSpan[1]});
  }
  for (const node of identifiers) if (candidates.has(node.name)) {
    const candidate = candidates.get(node.name);
    if (!classified.has(node)) candidate.invalid = true;
    else if (!(parents.get(node)?.kind === 'AssignmentExpression' && parents.get(node).left === node)) candidate.readCount++;
  }
  for (const group of groups) connect(new Set(group.names));
  for (const candidate of candidates.values()) if (!candidate.writes.length || !candidate.readCount) candidate.invalid = true;
  const pending = [...candidates.values()].filter(candidate => candidate.invalid);
  for (let index = 0; index < pending.length; index++) for (const name of pending[index].neighbors) {
    const candidate = candidates.get(name);
    if (!candidate.invalid) {candidate.invalid = true; pending.push(candidate);}
  }
  const valid = names => [...names].every(name => !candidates.get(name).invalid);
  const selected = [...candidates.values()].filter(candidate => !candidate.invalid);
  if (!selected.length) return unchanged();
  const edits = [], comparisonEdits = [];
  const range = (first, last, text) => ({start: tokens[first].range.startOffset, end: tokens[last].range.endOffset, text});
  function slice(first, last) {return wrapped.slice(tokens[first].range.startOffset, tokens[last].range.endOffset);}
  function apply(first, last, changes) {
    const start = tokens[first].range.startOffset, end = tokens[last].range.endOffset;
    let text = wrapped.slice(start, end);
    for (const edit of changes.filter(edit => edit.start >= start && edit.end <= end).sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start - start) + edit.text + text.slice(edit.end - start);
    return text;
  }
  let selectionsRecovered = 0;
  function render(value, countSelections = false) {
    if (!value.parts) return value.node.kind === 'LiteralExpression' ? bit(value.node) === '1' ? 'true' : 'false' : slice(value.first, value.last);
    const changes = value.parts.map(part => range(part.first, part.last, render(part, countSelections)));
    if (value.condition) {
      let [first, last] = value.condition;
      while (tokens[first]?.text === '(' && closes.get(first) === last) {first++; last--;}
      const condition = apply(first, last, comparisonEdits), yes = bit(value.node.consequent), no = bit(value.node.alternate);
      if (yes !== null && no !== null && yes !== no) {
        if (countSelections) selectionsRecovered++;
        return yes === '1' ? '(' + condition + ')' : '!(' + condition + ')';
      }
      changes.push(range(...value.condition, condition));
    }
    return apply(value.first, value.last, changes);
  }
  for (const comparison of comparisons) if (valid(comparison.names)) {
    const leftBit = bit(comparison.node.left), rightBit = bit(comparison.node.right);
    let text;
    if (leftBit !== null || rightBit !== null) {
      const literal = leftBit ?? rightBit, operand = render(leftBit !== null ? comparison.right : comparison.left);
      const inverse = (comparison.node.operator === '==') === (literal === '0');
      text = inverse ? '(!(' + operand + '))' : '(' + operand + ')';
    } else text = '(' + render(comparison.left) + ' ' + comparison.node.operator + ' ' + render(comparison.right) + ')';
    comparisonEdits.push(range(comparison.first, comparison.last, text));
  }
  for (const group of groups) if (group.names.length && valid(new Set(group.names))) edits.push(range(group.type, group.type, 'boolean'));
  for (const record of stores) if (valid(record.names)) edits.push(range(record.value.first, record.value.last, render(record.value, true)));
  // Comparisons in a selected store's conditional test are already included
  // in its replacement. Every other comparison stays at its original site.
  for (const edit of comparisonEdits) if (!edits.some(owner => edit.start >= owner.start && edit.end <= owner.end)) edits.push(edit);
  edits.sort((a, b) => a.start - b.start);
  if (edits.some((edit, index) => index && edits[index - 1].end > edit.start)) return unchanged();
  let output = wrapped;
  for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return {source: output.slice(2, -2), localsPromoted: selected.length, comparisonsRecovered: comparisonEdits.length, selectionsRecovered};
}

module.exports = {recoverBooleanLocalRepresentations};
