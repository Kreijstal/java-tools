'use strict';

// A guarded break skips the frame's remainder. When the containing block ends
// that frame through only terminal blocks/if arms, guard its complete suffix
// directly. Work, declarations and protected constructs keep one occurrence.
function foldTerminalGuardedFrameExits(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, guardsRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children, labelCounts} = proof;
  if (labelCounts.size > 256 || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  const parents = new Map(), targets = new Map(), refs = new Map(), blocks = [];
  const loopKinds = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  let refused = false;
  function walk(node, parent = null, labels = [], breaks = [], loops = [], depth = 0) {
    if (depth > 128) {refused = true; return;}
    parents.set(node, parent);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass|Pattern/.test(node.kind || '') || node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (node.kind === 'BlockStatement') blocks.push(node);
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      const target = node.label ? labels.slice().reverse().find(frame => frame.label === node.label) : node.kind === 'ContinueStatement' ? loops.at(-1) : breaks.at(-1);
      const first = starts.get(node.range?.startOffset);
      if (!target || node.kind === 'ContinueStatement' && !loopKinds.has(target.kind) && !loopKinds.has(target.statement?.kind) || tokens[first]?.text !== (node.kind === 'BreakStatement' ? 'break' : 'continue') || tokens[first + (node.label ? 2 : 1)]?.text !== ';' || node.label && tokens[first + 1]?.text !== node.label) refused = true;
      else {targets.set(node, target); refs.set(target, [...(refs.get(target) || []), node]);}
    }
    children(node, child => walk(child, node, node.kind === 'LabeledStatement' ? [...labels, node] : labels, loopKinds.has(node.kind) || node.kind === 'SwitchStatement' ? [...breaks, node] : breaks, loopKinds.has(node.kind) ? [...loops, node] : loops, depth + 1));
  }
  walk(parsed); if (refused) return unchanged();
  const range = (a, b) => ({start: tokens[a].range.startOffset - 2, end: tokens[b].range.endOffset - 2});
  const bounds = node => {const open = starts.get(node?.range?.startOffset), close = closes.get(open); return node?.kind === 'BlockStatement' && tokens[open]?.text === '{' && tokens[close]?.text === '}' ? {open, close} : null;};
  const candidates = [];
  for (const block of blocks) for (let index = 0; index < block.statements.length - 1; index++) {
    const guard = block.statements[index]; if (guard.kind !== 'IfStatement' || guard.alternate) continue;
    const braced = guard.consequent?.kind === 'BlockStatement', jump = braced && guard.consequent.statements.length === 1 ? guard.consequent.statements[0] : guard.consequent, frame = targets.get(jump);
    if (jump?.kind !== 'BreakStatement' || !jump.label || frame?.kind !== 'LabeledStatement' || frame.statement?.kind !== 'BlockStatement') continue;
    let current = block; const corridorKinds = [];
    while (current !== frame.statement) {
      const parent = parents.get(current);
      if (parent?.kind === 'BlockStatement' && parent.statements.at(-1) === current || parent?.kind === 'IfStatement' && [parent.consequent, parent.alternate].includes(current)) {corridorKinds.push(parent.kind); current = parent;}
      else break;
    }
    if (current === frame.statement) candidates.push({frame, block, guard, jump, index, braced, corridorKinds});
  }
  // Recover the last guard first. Earlier guards then keep their original
  // containers; newly introduced suffix blocks never become proof assumptions.
  candidates.sort((a, b) => b.guard.range.startOffset - a.guard.range.startOffset);
  for (const {frame, block, guard, jump, index, braced, corridorKinds} of candidates) {
    const body = bounds(frame.statement), container = bounds(block), references = refs.get(frame), first = starts.get(guard.range?.startOffset), conditionClose = closes.get(first + 1), jumpFirst = starts.get(jump.range?.startOffset), jumpLast = jumpFirst + 2, guardLast = braced ? closes.get(conditionClose + 1) : jumpLast, suffixFirst = starts.get(block.statements[index + 1].range?.startOffset), label = starts.get(frame.range?.startOffset);
    if (!body || !container || !references?.length || references.length > 128 || references.some(reference => reference.kind !== 'BreakStatement') || tokens[label]?.text !== frame.label || tokens[label + 1]?.text !== ':' || label + 2 !== body.open || tokens[body.close].range.endOffset - tokens[label].range.startOffset > 40000 || tokens[first]?.text !== 'if' || tokens[first + 1]?.text !== '(' || conditionClose === undefined || tokens[jumpFirst]?.text !== 'break' || tokens[jumpFirst + 1]?.text !== frame.label || tokens[jumpLast]?.text !== ';' || (braced ? tokens[conditionClose + 1]?.text !== '{' || jumpFirst !== conditionClose + 2 || guardLast !== jumpLast + 1 : jumpFirst !== conditionClose + 1) || suffixFirst !== guardLast + 1) continue;
    const labelRetained = references.length > 1;
    const keepFrame = labelRetained || parents.get(frame)?.kind !== 'BlockStatement' || frame.statement.statements.some(statement => statement.kind === 'LocalVariableDeclarationStatement');
    const suffixRange = range(suffixFirst, container.close - 1), regionRange = range(first, container.close - 1), frameRange = range(label, body.close);
    const contentStart = labelRetained ? frameRange.start : keepFrame ? tokens[body.open].range.startOffset - 2 : tokens[starts.get(frame.statement.statements[0].range.startOffset)].range.startOffset - 2, contentEnd = keepFrame ? frameRange.end : tokens[body.close].range.startOffset - 2;
    const indentAt = offset => {const value = source.slice(source.lastIndexOf('\n', offset - 1) + 1, offset); return /^[ \t]*$/.test(value) ? value : null;};
    const indent = indentAt(regionRange.start), multiline = indent !== null && source.slice(regionRange.start, regionRange.end).includes('\n');
    const segments = [
      {range: {start: contentStart, end: regionRange.start}}, {range: range(first, first)}, {text: ' (!'}, {range: range(first + 1, conditionClose)}, {text: ') {' + (multiline ? '\n' + indent + '  ' : '')},
      {range: suffixRange, indent: multiline ? 2 : 0}, {text: multiline ? '\n' + indent + '}' : '}', suffixEndBoundary: true}, {range: {start: regionRange.end, end: contentEnd}},
    ];
    let text = segments.map(segment => segment.text ?? source.slice(segment.range.start, segment.range.end).replace(/\n([ \t]*)(?=\S)/g, (_, oldIndent) => '\n' + ' '.repeat(segment.indent || 0) + oldIndent)).join(''), dedent = null;
    if (!keepFrame && multiline) {
      const frameIndent = indentAt(frameRange.start), contentIndent = indentAt(contentStart);
      if (frameIndent !== null && contentIndent !== null && contentIndent.startsWith(frameIndent) && contentIndent.length > frameIndent.length) {dedent = {indent: contentIndent, delta: contentIndent.length - frameIndent.length}; text = text.split('\n').map((line, i) => i && line.startsWith(contentIndent) ? line.slice(dedent.delta) : line).join('\n');}
      text = text.trimEnd();
    }
    return {source: source.slice(0, frameRange.start) + text + source.slice(frameRange.end), guardsRecovered: 1, labelsRemoved: Number(!labelRetained), frameScopesFlattened: Number(!keepFrame),
      ...(retainDiagnostics ? {diagnostics: {range: frameRange, regionRange, containerRange: range(container.open, container.close), conditionRange: range(first + 1, conditionClose), jumpRange: range(jumpFirst, jumpLast), suffixRange, suffixStatements: block.statements.length - index - 1, segments, dedent, trimEnd: !keepFrame && multiline, label: frame.label, labelRetained, frameScopeRetained: keepFrame, corridorKinds}} : {})};
  }
  return unchanged();
}
module.exports = {foldTerminalGuardedFrameExits};
