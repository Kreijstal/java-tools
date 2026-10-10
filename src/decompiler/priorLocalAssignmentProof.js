'use strict';
const {independentlyAssignedLocalSequence} = require('./primitiveLocalLifetimeRecovery');
const loops = new Set(['WhileStatement', 'ForStatement', 'DoWhileStatement', 'EnhancedForStatement']);

// Initialization on normal entry into one remainder, not on entry into the
// whole frame. The original assignment stays in its original branch/scope.
function priorLocalAssignment(entry, name, {parents, declarations, contexts, reservedNames}) {
  const locals = declarations.get(name) || [];
  if (locals.length !== 1 || locals[0].initializer || reservedNames.includes(name)) return null;
  const declaration = parents.get(locals[0]), scope = parents.get(declaration);
  if (declaration?.kind !== 'LocalVariableDeclarationStatement' || scope?.kind !== 'BlockStatement') return null;
  let cursor = entry;
  while (parents.has(cursor)) {
    const owner = parents.get(cursor);
    if (!owner) break;
    if (owner.kind === 'BlockStatement') {
      const index = owner.statements.indexOf(cursor);
      if (index < 0) break;
      for (const statement of owner.statements.slice(0, index)) {
        const assignment = statement.kind === 'ExpressionStatement' ? statement.expression : null;
        if (assignment?.kind !== 'AssignmentExpression' || assignment.operator !== '=' ||
            assignment.left.kind !== 'Identifier' || assignment.left.name !== name ||
            !(declaration.range.startOffset < statement.range.startOffset)) continue;
        let lexical = owner;
        while (lexical && lexical !== scope) lexical = parents.get(lexical);
        if (lexical !== scope || !independentlyAssignedLocalSequence([statement], name, contexts.get(owner))) continue;
        return {name, declarationOffset: declaration.range.startOffset - 2,
          assignmentOffset: statement.range.startOffset - 2, entryOffset: entry.range.startOffset - 2};
      }
    } else if (owner.kind === 'IfStatement') {
      if (![owner.consequent, owner.alternate].includes(cursor)) break;
    } else if (owner.kind === 'LabeledStatement') {
      if (owner.statement !== cursor) break;
    } else if (loops.has(owner.kind)) {
      if (owner.body !== cursor) break;
    } else break; // no switch/catch/finally/protected entry is inferred
    cursor = owner;
  }
  return null;
}
module.exports = {priorLocalAssignment};
