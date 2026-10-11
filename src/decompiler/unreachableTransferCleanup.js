'use strict';
const {JavaParser} = require('../java-frontend/parser');
const {tokenizeJava} = require('../java-frontend/lexer');
const parser = new JavaParser();

// Reconstruction can remove a guard around a continue, exposing a synthetic
// break immediately after it. Both transfers belonged to the same block; the
// second has no execution path. Literal endless loops without an own break
// likewise cannot reach a following transfer. Remove only those dead transfers.
function removeUnreachableControlTransfersPass(source) {
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
  const loops = new Set(['WhileStatement', 'ForStatement', 'DoWhileStatement', 'EnhancedForStatement']);
  const captured = node => /ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')
    || node.kind === 'NewClassExpression' && node.body != null;
  const children = (node, callback) => {
    for (const [key, child] of Object.entries(node)) {
      if (['range', 'meta', 'tokens', 'kind'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(value => {if (value && typeof value === 'object') callback(value);});
      else if (child && typeof child === 'object') callback(child);
    }
  };
  function neverCompletesNormally(statement) {
    if (abrupt.has(statement.kind)) return true;
    if (statement.kind === 'BlockStatement') {
      const last = statement.statements?.at(-1);
      return !!last && neverCompletesNormally(last);
    }
    if (statement.kind === 'IfStatement') return !!statement.alternate &&
      neverCompletesNormally(statement.consequent) && neverCompletesNormally(statement.alternate);
    const labels = [];
    while (statement.kind === 'LabeledStatement') {labels.push(statement.label);statement = statement.statement;}
    let condition = statement.condition;
    while (condition?.kind === 'ParenthesizedExpression') condition = condition.expression;
    if (!['WhileStatement', 'ForStatement', 'DoWhileStatement'].includes(statement.kind) ||
        !(statement.kind === 'ForStatement' && !condition || condition?.kind === 'LiteralExpression' && condition.raw === 'true')) return false;
    const loop = statement;
    let exits = false;
    function inspect(node, target = loop) {
      if (captured(node)) return;
      if (node.kind === 'BreakStatement' && (node.label ? labels.includes(node.label) : target === loop)) exits = true;
      if (node !== loop && (loops.has(node.kind) || node.kind === 'SwitchStatement')) target = node;
      children(node, child => inspect(child, target));
    }
    inspect(loop);
    return !exits;
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) return;
    if (node.kind === 'NewClassExpression' && node.body != null) return;
    if (node.kind === 'BlockStatement') {
      const statements = node.statements || [];
      for (let i = 1; i < statements.length; i++) {
        const statement = statements[i];
        if (!neverCompletesNormally(statements[i - 1]) || !transfers.has(statement.kind)) continue;
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

function removeUnreachableControlTransfers(source) {
  let current = source, transfersRemoved = 0;
  for (;;) {
    const next = removeUnreachableControlTransfersPass(current);
    if (!next.transfersRemoved) return {source: current, transfersRemoved};
    // Removing an inner synthetic break can prove that its enclosing literal
    // loop never completes normally. Reparse offsets and repeat that proof;
    // every successful pass strictly shortens the source, so it terminates.
    if (next.source.length >= current.length) return {source: current, transfersRemoved};
    current = next.source;
    transfersRemoved += next.transfersRemoved;
  }
}

module.exports = {removeUnreachableControlTransfers};
