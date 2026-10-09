'use strict';

// Capture the leading exit decision in the loop header. Other loop breaks
// retain their own destinations and skip the separate exit-only work. Keep the
// old body, condition and work once, within the original protected scopes.
function foldLeadingLoopExitWork(source, proof, {retainDiagnostics = false, reservedNames = []} = {}) {
  const unchanged = () => ({source, loopsRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || !Array.isArray(reservedNames) || reservedNames.some(n => typeof n !== 'string') || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children, labelCounts} = proof;
  if ([...labelCounts.values()].some(n => n !== 1)) return unchanged();
  const loopKinds = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  const parents = new Map(), targets = new Map(), references = new Map(), loops = [], uninitialized = new Set();
  let refused = false;
  function visit(node, parent = null, labels = [], activeLoops = [], breaks = [], depth = 0) {
    if (depth > 128) {refused = true; return;}
    parents.set(node, parent);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(node.kind || '') || node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (node.kind === 'VariableDeclarator' && !node.initializer) uninitialized.add(node.name);
    if (node.kind === 'WhileStatement') loops.push(node);
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      const target = node.label ? labels.slice().reverse().find(n => n.label === node.label)
        : node.kind === 'ContinueStatement' ? activeLoops.at(-1) : breaks.at(-1);
      if (!target || node.kind === 'ContinueStatement' && node.label && !loopKinds.has(target.statement?.kind)) refused = true;
      else {targets.set(node, target); references.set(target, [...references.get(target) || [], node]);}
    }
    children(node, child => visit(child, node, node.kind === 'LabeledStatement' ? [...labels, node] : labels,
      loopKinds.has(node.kind) ? [...activeLoops, node] : activeLoops,
      loopKinds.has(node.kind) || node.kind === 'SwitchStatement' ? [...breaks, node] : breaks, depth + 1));
  }
  visit(parsed);
  if (refused) return unchanged();
  const bounds = node => {
    const open = starts.get(node?.range?.startOffset), close = closes.get(open);
    return node?.kind === 'BlockStatement' && tokens[open]?.text === '{' && tokens[close]?.text === '}' ? {open, close} : null;
  };
  const span = (first, last) => ({start: tokens[first].range.startOffset - 2, end: tokens[last].range.endOffset - 2});
  const occupied = new Set([...reservedNames, ...tokens.filter(t => t.kind === 'identifier').map(t => t.text)]);
  function contains(root, target) {let found = root === target; children(root, child => {if (contains(child, target)) found = true;}); return found;}
  for (const loop of loops.sort((a, b) => b.range.startOffset - a.range.startOffset)) {
    if (loop.condition?.kind !== 'LiteralExpression' || loop.condition.value !== true) continue;
    const body = bounds(loop.body), guard = loop.body?.statements?.[0], work = bounds(guard?.consequent), statements = guard?.consequent?.statements;
    if (!body || guard?.kind !== 'IfStatement' || guard.alternate || !work || statements.length < 2 || loop.body.statements.length < 2) continue;
    const exit = statements.at(-1), label = parents.get(loop)?.kind === 'LabeledStatement' ? parents.get(loop) : null;
    if (exit?.kind !== 'BreakStatement' || ![loop, label].includes(targets.get(exit))) continue;
    const selfReferences = [...references.get(loop) || [], ...references.get(label) || []];
    // Exit-only work moves outside this loop; any other self transfer in that
    // work could resume/reexit the loop and must remain at its old site.
    if (selfReferences.some(j => j !== exit && contains(guard.consequent, j))) continue;
    const first = starts.get(loop.range.startOffset), guardFirst = starts.get(guard.range.startOffset), conditionClose = closes.get(guardFirst + 1), exitFirst = starts.get(exit.range.startOffset), exitLast = exitFirst + (exit.label ? 2 : 1);
    if (tokens[first]?.text !== 'while' || tokens[first + 1]?.text !== '(' || tokens[first + 2]?.text !== 'true' || tokens[first + 3]?.text !== ')' || first + 4 !== body.open || guardFirst !== body.open + 1 || tokens[guardFirst]?.text !== 'if' || tokens[guardFirst + 1]?.text !== '(' || conditionClose + 1 !== work.open || tokens[exitFirst]?.text !== 'break' || tokens[exitLast]?.text !== ';' || exitLast + 1 !== work.close) continue;
    const workRange = {start: tokens[work.open].range.endOffset - 2, end: tokens[exitFirst].range.startOffset - 2};
    const names = new Set(tokens.slice(work.open + 1, exitFirst).filter(t => t.kind === 'identifier').map(t => t.text));
    if ([...uninitialized].some(n => names.has(n))) continue;
    const region = span(label ? starts.get(label.range.startOffset) : first, body.close);
    if (region.end - region.start > 100000) continue;
    let number = 0, name; do {name = 'decompiledNaturalLoopExit' + number++;} while (occupied.has(name));
    const condition = span(guardFirst + 1, conditionClose), prefix = {start: region.start, end: tokens[first].range.startOffset - 2}, remainder = {start: tokens[work.close].range.endOffset - 2, end: tokens[body.close].range.startOffset - 2};
    const indent = source.slice(source.lastIndexOf('\n', region.start - 1) + 1, region.start), multiline = /^[ \t]*$/.test(indent) && source.slice(region.start, region.end).includes('\n'), newline = multiline ? '\n' + indent : '';
    const segments = [{text: '{' + newline + `boolean ${name} = false;` + newline}, {range: prefix}, {range: span(first, first)}, {text: ` (!(${name} = `}, {range: condition}, {text: ')) '}, {range: span(body.open, body.open)}, {range: remainder}, {range: span(body.close, body.close)}, {text: newline + `if (${name}) {`}, {range: workRange}, {text: '}' + newline + '}'}];
    const replacement = segments.map(s => s.text ?? source.slice(s.range.start, s.range.end)).join('');
    return {source: source.slice(0, region.start) + replacement + source.slice(region.end), loopsRecovered: 1,
      ...(retainDiagnostics ? {diagnostics: {range: region, name, conditionRange: condition, workRange, remainderRange: remainder, removedExitRange: span(exitFirst, exitLast), originalLoopRange: span(first, body.close), label: label?.label || null, otherLoopBreaks: selfReferences.filter(j => j !== exit && j.kind === 'BreakStatement').length, segments}} : {})};
  }
  return unchanged();
}
module.exports = {foldLeadingLoopExitWork};
