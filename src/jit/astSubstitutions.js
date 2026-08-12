'use strict';

const { parse } = require('acorn');

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    if (Array.isArray(child)) {
      for (const entry of child) walk(entry, visit);
    } else if (child && typeof child.type === 'string') {
      walk(child, visit);
    }
  }
}

function applyEdits(source, edits) {
  edits.sort((left, right) => right.start - left.start || right.end - left.end);
  let rewritten = source;
  let previousStart = source.length;
  for (const edit of edits) {
    if (edit.end > previousStart) continue;
    rewritten = rewritten.slice(0, edit.start) + edit.replacement +
      rewritten.slice(edit.end);
    previousStart = edit.start;
  }
  return rewritten;
}

function stackArgumentIndex(node) {
  if (node?.type !== 'MemberExpression' || !node.computed ||
      node.object?.type !== 'Identifier' || node.object.name !== 'stack' ||
      node.property?.type !== 'BinaryExpression' || node.property.operator !== '+' ||
      node.property.left?.type !== 'Identifier' || node.property.left.name !== 'base' ||
      node.property.right?.type !== 'Literal') return null;
  const index = node.property.right.value;
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function substituteStackArguments(source, arguments_, expression = false) {
  const prefix = expression
    ? 'function __jvmInlineExpression() { return ('
    : 'function __jvmInlineStatements() {\n';
  const suffix = expression ? '); }' : '\n}';
  const program = parse(`${prefix}${source}${suffix}`, { ecmaVersion: 'latest' });
  const edits = [];
  walk(program, (node) => {
    const index = stackArgumentIndex(node);
    if (index === null || index >= arguments_.length) return;
    edits.push({
      start: node.start - prefix.length,
      end: node.end - prefix.length,
      replacement: `(${arguments_[index]})`,
    });
  });
  return applyEdits(source, edits);
}

module.exports = { substituteStackArguments };
