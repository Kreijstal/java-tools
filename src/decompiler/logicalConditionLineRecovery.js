'use strict';

// Replace only horizontal trivia after logical operators in a single-line
// control condition. Tokens, grouping, quoted values and evaluation stay exact.
function wrapLogicalConditionLines(source, proof, {retainDiagnostics = false} = {}) {
  const unchanged = () => ({source, conditionsWrapped: 0, operatorsWrapped: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || source.length > 400000) return unchanged();
  const {tokens, closes} = proof, edits = [], conditions = [];
  // Java reserves these keywords. Their following parentheses identify control
  // headers even when the AST omits a scalar do-while body's end positions.
  for (let first = 0; first < tokens.length - 2; first++) {
    if (!['if', 'while', 'for'].includes(tokens[first].text)) continue;
    const open = first + 1, close = closes.get(open);
    if (tokens[open]?.text !== '(' || close === undefined) continue;
    let begin = open + 1, end = close;
    if (tokens[first].text === 'for') {
      const separators = [];
      for (let i = begin; i < end; i++) {
        if (closes.has(i)) i = closes.get(i);
        else if (tokens[i].text === ';') separators.push(i);
      }
      if (separators.length !== 2) continue;
      begin = separators[0] + 1; end = separators[1];
    }
    const start = tokens[open].range.startOffset - 2, finish = tokens[close].range.endOffset - 2;
    if (source.slice(start, finish).includes('\n')) continue;
    let count = 0;
    for (let i = begin; i < end - 1; i++) if (['&&', '||'].includes(tokens[i].text)) {
      const a = tokens[i].range.endOffset - 2, b = tokens[i + 1].range.startOffset - 2;
      if (/^[ \t]*$/.test(source.slice(a, b))) {
        edits.push({start: a, end: b, text: '\n'}); count++;
      }
    }
    if (count) conditions.push({start, end: finish, operators: count});
  }
  if (!edits.length) return unchanged();
  edits.sort((a, b) => a.start - b.start);
  if (edits.some((e, i) => i && edits[i - 1].end > e.start)) return unchanged();
  let output = source;
  for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return {source: output, conditionsWrapped: conditions.length, operatorsWrapped: edits.length,
    ...(retainDiagnostics ? {diagnostics: {conditions, edits}} : {})};
}
module.exports = {wrapLogicalConditionLines};
