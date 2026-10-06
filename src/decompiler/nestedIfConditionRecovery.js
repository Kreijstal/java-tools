'use strict';

// A sole nested if has the same guarded completion as an ordered conjunction.
// Keep complete original conditions and the deepest body; intermediate blocks
// contain no declaration, action or protected boundary to move or duplicate.
function foldNestedIfConditions(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, ifsMerged: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children} = proof;
  const candidates = []; let refused = false;
  function walk(node, depth = 0) {
    if (depth > 128) {refused = true; return;}
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass|Pattern/.test(node.kind || '') || node.kind === 'NewClassExpression' && node.body != null) refused = true;
    if (node.kind === 'IfStatement' && !node.alternate) candidates.push(node);
    children(node, child => walk(child, depth + 1));
  }
  walk(parsed); if (refused) return unchanged();
  candidates.sort((a, b) => a.range.startOffset - b.range.startOffset);
  const range = (a, b) => ({start: tokens[a].range.startOffset - 2, end: tokens[b].range.endOffset - 2});
  for (const outer of candidates) {
    const chain = [outer], controls = [], blockEnds = [];
    let current = outer;
    while (current.consequent?.kind === 'BlockStatement' && current.consequent.statements.length === 1) {
      const inner = current.consequent.statements[0];
      if (inner.kind !== 'IfStatement' || inner.alternate) break;
      chain.push(inner); current = inner;
      if (chain.length > 32) return unchanged();
    }
    if (chain.length < 2 || chain.length > 32) continue;
    let invalid = false;
    for (let index = 0; index < chain.length; index++) {
      const node = chain[index], first = starts.get(node.range?.startOffset), close = closes.get(first + 1);
      if (tokens[first]?.text !== 'if' || tokens[first + 1]?.text !== '(' || close === undefined) {invalid = true; break;}
      controls.push({keywordRange: range(first, first), conditionRange: range(first + 1, close), conditionClose: close});
      if (index < chain.length - 1) {
        const block = node.consequent, open = starts.get(block.range?.startOffset), end = closes.get(open), nested = starts.get(chain[index + 1].range?.startOffset);
        if (close + 1 !== open || tokens[open]?.text !== '{' || tokens[end]?.text !== '}' || nested !== open + 1) {invalid = true; break;}
        blockEnds.push(end);
      }
    }
    const body = current.consequent, first = controls.at(-1)?.conditionClose + 1, last = blockEnds.at(-1) - 1, begin = starts.get(outer.range?.startOffset), end = blockEnds[0];
    if (invalid || first === undefined || last < first || end < begin) continue;
    const bodyRange = range(first, last), whole = range(begin, end);
    if (whole.end - whole.start > 40000) continue;
    const indentAt = offset => {const text = source.slice(source.lastIndexOf('\n', offset - 1) + 1, offset); return /^[ \t]*$/.test(text) ? text : null;};
    const outerIndent = indentAt(whole.start), bodyIndent = indentAt(controls.at(-1).keywordRange.start), multiline = outerIndent !== null && bodyIndent !== null;
    const segments = [{range: controls[0].keywordRange}, {text: ' ('}];
    for (let index = 0; index < controls.length; index++) {
      if (index) segments.push({text: ' && '});
      segments.push({range: controls[index].conditionRange});
    }
    segments.push({text: ') '}, {range: bodyRange});
    let text = segments.map(segment => segment.text ?? source.slice(segment.range.start, segment.range.end)).join(''), dedent = null;
    if (multiline && bodyIndent.startsWith(outerIndent) && bodyIndent.length > outerIndent.length) {
      dedent = {indent: bodyIndent, delta: bodyIndent.length - outerIndent.length};
      text = text.split('\n').map((line, index) => index && line.startsWith(bodyIndent) ? line.slice(dedent.delta) : line).join('\n');
    }
    return {source: source.slice(0, whole.start) + text + source.slice(whole.end), ifsMerged: chain.length - 1, conditionsJoined: chain.length,
      ...(retainDiagnostics ? {diagnostics: {range: whole, controls, bodyRange, segments, dedent}} : {})};
  }
  return unchanged();
}
module.exports = {foldNestedIfConditions};
