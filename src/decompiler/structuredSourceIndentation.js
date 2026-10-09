'use strict';

// Only replace leading horizontal whitespace. Tokens, line endings, quoted
// values and statement scopes stay byte exact. Unknown/commented source is
// excluded by the shared statement proof before this function runs.
function reindentStructuredSource(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, linesReindented: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {parsed, tokens, starts, closes, children} = proof, switchOpens = new Set();
  function visit(node) {
    if (node.kind === 'SwitchStatement') {
      const first = starts.get(node.range.startOffset), close = closes.get(first + 1);
      if (tokens[close + 1]?.text === '{') switchOpens.add(close + 1);
    }
    children(node, visit);
  }
  visit(parsed);
  const stack = [], seen = new Set(), edits = [];
  let parentheses = 0, brackets = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], offset = token.range.startOffset - 2;
    if (offset < 0 || token.range.endOffset - 2 > source.length) continue;
    const line = token.range.start.line;
    if (!seen.has(line)) {
      seen.add(line);
      const begin = source.lastIndexOf('\n', offset - 1) + 1, old = source.slice(begin, offset);
      if (/^[ \t]*$/.test(old)) {
        const active = token.text === '}' ? stack.slice(0, -1) : stack,
          isCase = ['case', 'default'].includes(token.text) && active.at(-1)?.isSwitch,
          cases = active.filter(s => s.isSwitch && s.inCase).length - Number(isCase && active.at(-1)?.inCase),
          continuation = token.text !== '}' && (parentheses > 0 || brackets > 0) ? 1 : 0,
          text = '  '.repeat(active.length + cases + continuation);
        if (old !== text) edits.push({start: begin, end: offset, text});
      }
    }
    if (token.text === '{') stack.push({isSwitch: switchOpens.has(index), inCase: false});
    else if (token.text === '}') stack.pop();
    else if (['case', 'default'].includes(token.text) && stack.at(-1)?.isSwitch) stack.at(-1).inCase = true;
    else if (token.text === '(') parentheses++;
    else if (token.text === ')') parentheses--;
    else if (token.text === '[') brackets++;
    else if (token.text === ']') brackets--;
  }
  if (!edits.length) return unchanged();
  edits.sort((a, b) => b.start - a.start);
  let result = source;
  for (const edit of edits) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return {source: result, linesReindented: edits.length, ...(retainDiagnostics ? {diagnostics: {edits}} : {})};
}

module.exports = {reindentStructuredSource};
