'use strict';
const {JavaParser} = require('../java-frontend/parser');
const {tokenizeJava} = require('../java-frontend/lexer');
const parser = new JavaParser();

// Reconstruction can remove a guard around a continue, exposing a synthetic
// break immediately after it. Both transfers belonged to the same block; the
// second has no execution path. Remove only such effect-free transfers.
function removeUnreachableControlTransfers(source) {
  const unchanged = () => ({source, transfersRemoved: 0});
  if (typeof source !== 'string' || source.length > 400000 || /\\u+[0-9a-fA-F]{4}/.test(source)) return unchanged();
  let root;
  try {
    const lexed = tokenizeJava(source), stack = [];
    if (lexed.diagnostics.length) return unchanged();
    for (const token of lexed.tokens) {
      if (['(', '[', '{'].includes(token.text)) stack.push(token.text);
      else if ([')', ']', '}'].includes(token.text)) {
        const open = stack.pop();
        if (open === undefined || '([{'.indexOf(open) !== ')]}'.indexOf(token.text)) return unchanged();
      }
    }
    if (stack.length) return unchanged();
    root = parser.parseStatement(`{\n${source}\n}`, {requireComplete: true});
  }
  catch {return unchanged();}
  const edits = [];
  const abrupt = new Set(['BreakStatement', 'ContinueStatement', 'ReturnStatement', 'ThrowStatement']);
  const transfers = new Set(['BreakStatement', 'ContinueStatement']);
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) return;
    if (node.kind === 'NewClassExpression' && node.body != null) return;
    if (node.kind === 'BlockStatement') {
      const statements = node.statements || [];
      for (let i = 1; i < statements.length; i++) {
        const statement = statements[i];
        if (!abrupt.has(statements[i - 1].kind) || !transfers.has(statement.kind)) continue;
        const start = statement.range?.startOffset - 2;
        // Parser ranges end at the keyword/label; include the terminating token.
        const end = source.indexOf(';', start) + 1;
        if (!(start >= 0 && end > start && end <= source.length)) continue;
        if (!/^(?:break|continue)(?:\s+[A-Za-z_$][\w$]*)?\s*;$/.test(source.slice(start, end))) continue;
        edits.push({start, end});
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (['range', 'meta', 'tokens', 'kind'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  }
  visit(root);
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + result.slice(edit.end);
  return {source: result, transfersRemoved: edits.length};
}

module.exports = {removeUnreachableControlTransfers};
