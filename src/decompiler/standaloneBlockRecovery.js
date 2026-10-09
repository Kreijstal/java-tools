'use strict';

// A block used as a direct block statement contributes no scope when all its
// immediate children retain their own scopes or declare nothing. Keep branch,
// loop, label and protected bodies intact. Edit only braces and whitespace.
function flattenStandaloneBlocks(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, blocksFlattened: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children} = proof;
  const nondeclaring = new Set(['BlockStatement', 'LabeledStatement', 'IfStatement',
    'WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement',
    'SwitchStatement', 'TryStatement', 'SynchronizedStatement', 'ExpressionStatement',
    'ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement', 'EmptyStatement', 'AssertStatement']);
  const candidates = [];
  let refused = false;
  function visit(node, parent = null, depth = 0) {
    if (depth > 128 || /Unsupported|ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass|Pattern/.test(node.kind || '')
        || node.kind === 'NewClassExpression' && node.body != null) { refused = true; return; }
    if (node.kind === 'BlockStatement' && parent?.kind === 'BlockStatement'
        && parent.statements.includes(node) && node.statements.every(s => nondeclaring.has(s.kind)
          && !(s.kind === 'LabeledStatement' && !nondeclaring.has(s.statement?.kind)))) {
      const open = starts.get(node.range?.startOffset), close = closes.get(open);
      if (tokens[open]?.text === '{' && tokens[close]?.text === '}')
        candidates.push({start: tokens[open].range.startOffset - 2,
          end: tokens[close].range.endOffset - 2, statements: node.statements.length});
    }
    children(node, child => visit(child, node, depth + 1));
  }
  visit(parsed);
  if (refused || !candidates.length) return unchanged();
  const lines = source.split('\n'), offsets = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const lineAt = position => {
    let low = 0, high = offsets.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1;
      if (offsets[middle] <= position) low = middle; else high = middle; }
    return low;
  };
  const braces = new Map(), dedent = new Array(lines.length).fill(0);
  for (const block of candidates) {
    for (const position of [block.start, block.end - 1]) {
      const line = lineAt(position); if (!braces.has(line)) braces.set(line, []);
      braces.get(line).push(position);
    }
    const first = lineAt(block.start), last = lineAt(block.end - 1);
    if (first === last || source.slice(block.start + 1, offsets[first] + lines[first].length).trim()
        || source.slice(offsets[last], block.end - 1).trim()
        || source.slice(block.end, offsets[last] + lines[last].length).trim()) continue;
    const indent = /^[ \t]*/.exec(lines[first])[0].length;
    const interior = lines.slice(first + 1, last).filter(line => line.trim());
    const width = interior.length ? Math.max(0, Math.min(...interior.map(line => /^[ \t]*/.exec(line)[0].length)) - indent) : 0;
    for (let line = first + 1; line < last; line++) dedent[line] += width;
  }
  const edits = [];
  for (let line = 0; line < lines.length; line++) {
    const positions = (braces.get(line) || []).sort((a,b) => b-a);
    let remaining = lines[line];
    for (const position of positions) { const local = position - offsets[line];
      remaining = remaining.slice(0, local) + remaining.slice(local + 1); }
    if (positions.length && !remaining.trim()) {
      edits.push({start: offsets[line], end: Math.min(source.length, offsets[line] + lines[line].length + 1), kind: 'vacant-brace-line'});
    } else {
      for (const position of positions) edits.push({start: position, end: position + 1, kind: 'brace'});
      const width = Math.min(dedent[line], /^[ \t]*/.exec(lines[line])[0].length);
      if (width) edits.push({start: offsets[line], end: offsets[line] + width, kind: 'indent'});
    }
  }
  edits.sort((a,b) => a.start-b.start || a.end-b.end);
  if (edits.some((e,i) => e.start < 0 || e.end > source.length || i && edits[i-1].end > e.start)) return unchanged();
  let output = source;
  for (const e of edits.slice().reverse()) output = output.slice(0,e.start) + output.slice(e.end);
  return {source: output, blocksFlattened: candidates.length,
    ...(retainDiagnostics ? {diagnostics: {blocks: candidates, deletedRanges: edits}} : {})};
}
module.exports = {flattenStandaloneBlocks};
