'use strict';

// A block containing only another if introduces no binding or work. Recover
// an ordered else-if chain, rotating a decision only when its true arm is that
// block. Negate the complete predicate: do not complement floating relations,
// duplicate reads, or assume that a condition has no effects.
function flattenElseIfChains(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, blocksRemoved: 0, decisionsRotated: 0});
  if (!proof || source.length > 400000 || typeof retainDiagnostics !== 'boolean') return unchanged();
  const {parsed, tokens, starts, closes, children} = proof;
  const candidates = [];
  let refused = false;
  function walk(node, parent = null, depth = 0) {
    if (depth > 128) {refused = true; return;}
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(node.kind || '')
        || node.kind === 'NewClassExpression' && node.body != null) refused = true;
    // Restrict roots to statement lists. Removing an alternate's block under
    // an unbraced enclosing if/loop could change a dangling else's owner.
    if (node.kind === 'IfStatement' && parent?.kind === 'BlockStatement'
        && parent.statements.includes(node)) candidates.push(node);
    children(node, child => walk(child, node, depth + 1));
  }
  walk(parsed);
  if (refused) return unchanged();
  candidates.sort((a, b) => a.range.startOffset - b.range.startOffset);
  const range = (first, last) => ({start: tokens[first].range.startOffset - 2,
    end: tokens[last].range.endOffset - 2});
  function shape(node) {
    const first = starts.get(node.range?.startOffset), conditionEnd = closes.get(first + 1);
    const yesOpen = conditionEnd + 1, yesEnd = closes.get(yesOpen);
    if (tokens[first]?.text !== 'if' || tokens[first + 1]?.text !== '(' || conditionEnd === undefined
        || node.consequent?.kind !== 'BlockStatement' || tokens[yesOpen]?.text !== '{' || yesEnd === undefined) return null;
    let noOpen, noEnd;
    if (node.alternate) {
      noOpen = yesEnd + 2; noEnd = closes.get(noOpen);
      if (node.alternate.kind !== 'BlockStatement' || tokens[yesEnd + 1]?.text !== 'else'
          || tokens[noOpen]?.text !== '{' || noEnd === undefined) return null;
    }
    return {first, condition: range(first + 1, conditionEnd),
      yes: range(yesOpen, yesEnd), no: node.alternate ? range(noOpen, noEnd) : null,
      whole: range(first, noEnd ?? yesEnd)};
  }
  const soleIf = block => block?.kind === 'BlockStatement' && block.statements.length === 1
    && block.statements[0].kind === 'IfStatement' ? block.statements[0] : null;
  const edits = [];
  let blocksRemoved = 0, decisionsRotated = 0;
  for (const candidate of candidates) {
    const first = starts.get(candidate.range?.startOffset);
    if (first === undefined || edits.at(-1)?.end > tokens[first].range.startOffset - 2) continue;
    const initial = shape(candidate);
    if (!initial) continue;
    const controls = [], segments = [];
    let current = candidate, removed = 0, rotated = 0;
    for (;;) {
      const bounds = shape(current);
      if (!bounds) break;
      const right = soleIf(current.alternate), left = soleIf(current.consequent);
      const next = right && shape(right) ? right : left && bounds.no && shape(left) ? left : null;
      const rotate = next !== null && next === left && next !== right;
      controls.push({conditionRange: bounds.condition, rotated: rotate});
      if (controls.length > 32) return unchanged();
      segments.push({text: controls.length === 1 ? 'if (' : ' else if ('},
        ...(rotate ? [{text: '!'}] : []), {range: bounds.condition}, {text: ') '},
        {range: rotate ? bounds.no : bounds.yes});
      if (!next) {
        if (bounds.no) segments.push({text: ' else '}, {range: bounds.no});
        break;
      }
      removed++; rotated += Number(rotate); current = next;
    }
    if (!removed) continue;
    edits.push({...initial.whole, text: segments.map(s => s.text ?? source.slice(s.range.start, s.range.end)).join(''),
      controls, segments, blocksRemoved: removed, decisionsRotated: rotated});
    blocksRemoved += removed; decisionsRotated += rotated;
    if (edits.length > 256) return unchanged();
  }
  if (!edits.length) return unchanged();
  const pieces = []; let offset = 0;
  for (const edit of edits) {
    pieces.push(source.slice(offset, edit.start), edit.text); offset = edit.end;
  }
  pieces.push(source.slice(offset));
  return {source: pieces.join(''), blocksRemoved, decisionsRotated,
    ...(retainDiagnostics ? {diagnostics: {edits}} : {})};
}

module.exports = {flattenElseIfChains};
