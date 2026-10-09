'use strict';

// A loop ending a plain frame shares its exit. Move the frame's existing name
// onto that loop, or merge into its existing name. Every frame reference must
// already lie in that loop; only action-free terminal corridors are accepted.
function foldTerminalFrameLoops(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, framesRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children, labelCounts} = proof;
  if (labelCounts.size > 256 || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  const loopKinds = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  const parents = new Map(), refs = new Map(), bareTargets = new Map(), frames = [], loops = []; let refused = false;
  function walk(node, parent = null, labels = [], breaks = [], activeLoops = [], depth = 0) {
    if (depth > 128) {refused = true; return;}
    parents.set(node, parent);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass|Pattern/.test(node.kind || '') || node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (node.kind === 'LabeledStatement' && node.statement?.kind === 'BlockStatement') frames.push(node);
    if (loopKinds.has(node.kind)) loops.push(node);
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      const target = node.label ? labels.slice().reverse().find(frame => frame.label === node.label) : node.kind === 'ContinueStatement' ? activeLoops.at(-1) : breaks.at(-1), first = starts.get(node.range?.startOffset);
      if (!target || node.kind === 'ContinueStatement' && !loopKinds.has(target.kind) && !loopKinds.has(target.statement?.kind) || tokens[first]?.text !== (node.kind === 'BreakStatement' ? 'break' : 'continue') || tokens[first + (node.label ? 2 : 1)]?.text !== ';' || node.label && tokens[first + 1]?.text !== node.label) refused = true;
      else {refs.set(target, [...(refs.get(target) || []), node]); if (node.kind === 'BreakStatement') bareTargets.set(node, breaks.at(-1));}
    }
    children(node, child => walk(child, node, node.kind === 'LabeledStatement' ? [...labels, node] : labels, loopKinds.has(node.kind) || node.kind === 'SwitchStatement' ? [...breaks, node] : breaks, loopKinds.has(node.kind) ? [...activeLoops, node] : activeLoops, depth + 1));
  }
  walk(parsed); if (refused) return unchanged();
  const range = (a, b) => ({start: tokens[a].range.startOffset - 2, end: tokens[b].range.endOffset - 2});
  const bounds = node => {const open = starts.get(node?.range?.startOffset), close = closes.get(open); return node?.kind === 'BlockStatement' && tokens[open]?.text === '{' && tokens[close]?.text === '}' ? {open, close} : null;};
  for (const frame of frames) {
    const body = bounds(frame.statement), references = refs.get(frame), label = starts.get(frame.range?.startOffset);
    if (!body || !references?.length || references.length > 128 || references.some(jump => jump.kind !== 'BreakStatement') || tokens[label]?.text !== frame.label || tokens[label + 1]?.text !== ':' || label + 2 !== body.open || tokens[body.close].range.endOffset - tokens[label].range.startOffset > 40000) continue;
    for (const loop of loops) {
      const loopBody = bounds(loop.body), first = starts.get(loop.range?.startOffset); if (!loopBody || first === undefined) continue;
      let last = loopBody.close;
      if (loop.kind === 'DoWhileStatement') {const close = closes.get(last + 2); if (tokens[last + 1]?.text !== 'while' || tokens[last + 2]?.text !== '(' || tokens[close + 1]?.text !== ';') continue; last = close + 1;}
      if (first <= body.open || last >= body.close || references.some(jump => jump.range.startOffset <= tokens[first].range.startOffset || jump.range.startOffset >= tokens[last].range.endOffset)) continue;
      const loopLabel = parents.get(loop)?.kind === 'LabeledStatement' ? parents.get(loop) : null;
      const localised = references.every(jump => bareTargets.get(jump) === loop), targetLabel = localised ? '' : loopLabel?.label || frame.label, corridorKinds = []; let current = loopLabel || loop;
      while (current !== frame.statement) {
        const parent = parents.get(current);
        if (parent?.kind === 'BlockStatement' && parent.statements.at(-1) === current || parent?.kind === 'IfStatement' && [parent.consequent, parent.alternate].includes(current) || parent?.kind === 'LabeledStatement' && parent.statement === current) {corridorKinds.push(parent.kind); current = parent;}
        else break;
      }
      if (current !== frame.statement) continue;
      const frameRange = range(label, body.close), loopRange = range(first, last), labelRange = range(label, label + 1), transfers = [];
      const keepScope = parents.get(frame)?.kind !== 'BlockStatement' || frame.statement.statements.some(statement => statement.kind === 'LocalVariableDeclarationStatement');
      const contentRange = keepScope ? range(body.open, body.close) : range(starts.get(frame.statement.statements[0].range.startOffset), body.close - 1);
      let text = source.slice(contentRange.start, contentRange.end); const edits = [];
      for (const jump of references) {const start = starts.get(jump.range.startOffset), jumpRange = range(start, start + 2), jumpLabelRange = range(start + 1, start + 1); transfers.push({range: jumpRange, labelRange: jumpLabelRange}); if (localised) edits.push({start: tokens[start].range.endOffset - 2, end: jumpLabelRange.end, text: ''}); else if (loopLabel) edits.push({...jumpLabelRange, text: targetLabel});}
      if (!localised && !loopLabel) edits.push({start: loopRange.start, end: loopRange.start, text: source.slice(labelRange.start, labelRange.end) + ' '});
      for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start - contentRange.start) + edit.text + text.slice(edit.end - contentRange.start);
      const indentAt = offset => {const value = source.slice(source.lastIndexOf('\n', offset - 1) + 1, offset); return /^[ \t]*$/.test(value) ? value : null;}; let dedent = null;
      if (!keepScope) {const frameIndent = indentAt(frameRange.start), contentIndent = indentAt(contentRange.start); if (frameIndent !== null && contentIndent !== null && contentIndent.startsWith(frameIndent) && contentIndent.length > frameIndent.length) {dedent = {indent: contentIndent, delta: contentIndent.length - frameIndent.length}; text = text.split('\n').map((line, i) => i && line.startsWith(contentIndent) ? line.slice(dedent.delta) : line).join('\n');}}
      return {source: source.slice(0, frameRange.start) + text + source.slice(frameRange.end), framesRecovered: 1, breaksLocalized: Number(localised) * references.length, labelsRemoved: Number(localised || Boolean(loopLabel)), labelsLifted: Number(!localised && !loopLabel), labelsMerged: Number(!localised && Boolean(loopLabel)), frameScopesFlattened: Number(!keepScope), breakTargetsRedirected: references.length,
        ...(retainDiagnostics ? {diagnostics: {frameRange, bodyRange: range(body.open, body.close), contentRange, loopRange, loopBodyRange: range(loopBody.open, loopBody.close), loopKeywordRange: range(first, first), labelRange, loopLabelRange: loopLabel ? range(starts.get(loopLabel.range.startOffset), starts.get(loopLabel.range.startOffset) + 1) : null, frameLabel: frame.label, targetLabel, localised, keepScope, dedent, corridorKinds, transfers}} : {})};
    }
  }
  return unchanged();
}
module.exports = {foldTerminalFrameLoops};
