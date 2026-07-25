'use strict';

const {
  createNode,
  blockStatement,
  formalParameter,
  classType,
} = require('../java-frontend/ast');

const rawExpression = (source) => createNode('UnsupportedExpression', { source: String(source) });
const rawStatement = (source) => createNode('UnsupportedStatement', { source: String(source) });
const block = (statements) => blockStatement(statements || []);

function classTypeFromSourceName(sourceName) {
  const parts = String(sourceName).split('.');
  return classType(parts.pop(), { packageName: parts.join('.') || null });
}

function catchParameter(name, types) {
  const alternatives = types.map(classTypeFromSourceName);
  const parameterType = alternatives.length === 1
    ? alternatives[0]
    : createNode('UnionType', { alternatives });
  return formalParameter(name, parameterType);
}

function treeToStatements(tree, render) {
  if (!tree) return [];
  switch (tree.t) {
    case 'seq': return tree.body.flatMap((child) => treeToStatements(child, render));
    case 'straight': return render.straight(tree.block).map(rawStatement);
    case 'block': return [createNode('LabeledStatement', {
      label: tree.label,
      statement: block(treeToStatements(tree.body, render)),
    })];
    case 'loop': return [createNode('LabeledStatement', {
      label: tree.label,
      statement: createNode('WhileStatement', {
        condition: rawExpression('true'),
        body: block(treeToStatements(tree.body, render)),
      }),
    })];
    case 'if': {
      const conditionSource = render.cond(tree.block);
      if (conditionSource === 'true') return treeToStatements(tree.then, render);
      if (conditionSource === 'false') return tree.els ? treeToStatements(tree.els, render) : [];
      return [createNode('IfStatement', {
        condition: rawExpression(conditionSource),
        consequent: block(treeToStatements(tree.then, render)),
        alternate: tree.els ? block(treeToStatements(tree.els, render)) : null,
      })];
    }
    case 'switch': return [createNode('SwitchStatement', {
      expression: rawExpression(render.switchValue(tree.block)),
      groups: [
        ...tree.cases.map((item) => ({
          label: createNode('SwitchLabel', {
            labelKind: 'case', expression: rawExpression(item.key), separator: ':',
          }),
          statements: treeToStatements(item.body, render),
        })),
        ...(tree.dflt ? [{
          label: createNode('SwitchLabel', { labelKind: 'default', expression: null, separator: ':' }),
          statements: treeToStatements(tree.dflt, render),
        }] : []),
      ],
    })];
    case 'break': return [createNode('BreakStatement', { label: tree.label })];
    case 'continue': return [createNode('ContinueStatement', { label: tree.label })];
    case 'synchronized': return [createNode('SynchronizedStatement', {
      lock: rawExpression(render.syncLock
        ? render.syncLock(tree.lockLocal, tree.lockPc)
        : `lock${tree.lockLocal}`),
      body: block(treeToStatements(tree.body, render)),
    })];
    case 'try': return [createNode('TryStatement', {
      resources: [],
      block: block(treeToStatements(tree.body, render)),
      catches: tree.catches.map((item) => createNode('CatchClause', {
        parameter: catchParameter(item.varName, item.types || [item.type]),
        body: block([
          ...(item.carrierName ? [rawStatement(`${item.carrierName} = ${item.varName};`)] : []),
          ...treeToStatements(item.body, render),
        ]),
      })),
      finallyBlock: null,
    })];
    default: throw new Error(`unknown structured Java node ${tree.t}`);
  }
}

function emitStatements(statements) {
  const lines = [];
  for (const statement of statements || []) emitStatement(statement, 0, lines);
  return lines.join('\n');
}

function emitBlock(node, indent, lines) {
  for (const statement of (node && node.statements) || []) emitStatement(statement, indent, lines);
}

function emitStatement(node, indent, lines) {
  const emit = (text, level = indent) => lines.push(`${'  '.repeat(level)}${text}`);
  switch (node.kind) {
    case 'UnsupportedStatement':
      for (const line of node.source.split('\n')) emit(line);
      return;
    case 'BlockStatement':
      emit('{'); emitBlock(node, indent + 1, lines); emit('}');
      return;
    case 'LabeledStatement':
      if (node.statement.kind === 'WhileStatement') {
        emit(`${node.label}: while (${emitExpression(node.statement.condition)}) {`);
        emitBlock(node.statement.body, indent + 1, lines);
        emit('}');
      } else {
        emit(`${node.label}: {`); emitBlock(node.statement, indent + 1, lines); emit('}');
      }
      return;
    case 'IfStatement':
      emit(`if (${emitExpression(node.condition)}) {`);
      emitBlock(node.consequent, indent + 1, lines);
      if (node.alternate) {
        emit('} else {'); emitBlock(node.alternate, indent + 1, lines);
      }
      emit('}');
      return;
    case 'SwitchStatement':
      emit(`switch (${emitExpression(node.expression)}) {`);
      for (const group of node.groups || []) {
        emit(group.label.labelKind === 'default' ? 'default:' : `case ${emitExpression(group.label.expression)}:`, indent + 1);
        for (const statement of group.statements || []) emitStatement(statement, indent + 2, lines);
      }
      emit('}');
      return;
    case 'BreakStatement': emit(`break${node.label ? ` ${node.label}` : ''};`); return;
    case 'ContinueStatement': emit(`continue${node.label ? ` ${node.label}` : ''};`); return;
    case 'SynchronizedStatement':
      emit(`synchronized (${emitExpression(node.lock)}) {`);
      emitBlock(node.body, indent + 1, lines);
      emit('}');
      return;
    case 'TryStatement':
      emit('try {'); emitBlock(node.block, indent + 1, lines);
      for (const item of node.catches || []) {
        emit(`} catch (${emitType(item.parameter.parameterType)} ${item.parameter.name}) {`);
        emitBlock(item.body, indent + 1, lines);
      }
      emit('}');
      return;
    default: throw new Error(`cannot emit Java statement node ${node.kind}`);
  }
}

function emitExpression(node) {
  if (node && node.kind === 'UnsupportedExpression') return node.source;
  throw new Error(`cannot emit Java expression node ${node && node.kind}`);
}

function emitType(node) {
  if (node && node.kind === 'UnionType') return node.alternatives.map(emitType).join(' | ');
  if (node && node.kind === 'ClassType') {
    return `${node.packageName ? `${node.packageName}.` : ''}${node.name}`;
  }
  throw new Error(`cannot emit Java type node ${node && node.kind}`);
}

// ---------------------------------------------------------------------------
// Reachability (JLS 14.21 "can complete normally") over the emitted Java
// statement AST. This runs on the *folded* statements `treeToStatements`
// produces — dead if-branches (constant `render.cond`) are already gone — so it
// sees exactly the control flow javac will. It answers one question: is any
// statement rendered after a sibling that can never complete normally? The owned
// structurer emits dead loop-continuation clones for some irreducible CFGs
// (`Lx: while (true) { … continue Lx; }` whose header nothing can reach after a
// preceding infinite loop / all-paths-break block); javac rejects those as
// "unreachable statement". A true result routes the method to the CFG state
// machine, which prunes unreachable states, instead of shipping invalid Java.
// Every uncertain construct is biased toward completing so valid output is never
// misflagged.
function anyStatement(node, predicate) {
  if (!node) return false;
  if (predicate(node)) return true;
  switch (node.kind) {
    case 'BlockStatement': return (node.statements || []).some((s) => anyStatement(s, predicate));
    case 'LabeledStatement': return anyStatement(node.statement, predicate);
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'ForStatement':
    case 'SynchronizedStatement':
      return anyStatement(node.body, predicate);
    case 'IfStatement': return anyStatement(node.consequent, predicate) || anyStatement(node.alternate, predicate);
    case 'SwitchStatement':
      return (node.groups || []).some((g) => (g.statements || []).some((s) => anyStatement(s, predicate)));
    case 'TryStatement':
      return anyStatement(node.block, predicate)
        || (node.catches || []).some((c) => anyStatement(c.body, predicate))
        || anyStatement(node.finallyBlock, predicate);
    default: return false;
  }
}

const containsBreakToLabel = (node, label) =>
  anyStatement(node, (n) => n.kind === 'BreakStatement' && n.label === label);
// Conservative: any unlabeled break counts as a live exit for the nearest loop,
// even one really captured by a nested loop/switch — only risks a missed flag.
const containsUnlabeledBreak = (node) =>
  anyStatement(node, (n) => n.kind === 'BreakStatement' && !n.label);

// A raw (straight-block) statement completes normally unless its last rendered
// line is an unconditional transfer.
function rawStatementCompletes(source) {
  const lines = String(source).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return true;
  return !/^(return|throw|break|continue)\b/.test(lines[lines.length - 1]);
}

function statementCompletesNormally(node, state) {
  if (!node) return true;
  switch (node.kind) {
    case 'BlockStatement': return sequenceCompletesNormally(node.statements || [], state);
    case 'UnsupportedStatement': return rawStatementCompletes(node.source);
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'ReturnStatement':
    case 'ThrowStatement':
      return false;
    case 'LabeledStatement':
      return statementCompletesNormally(node.statement, state)
        || containsBreakToLabel(node.statement, node.label);
    case 'WhileStatement': {
      statementCompletesNormally(node.body, state); // walk for nested unreachable
      const cond = node.condition && node.condition.kind === 'UnsupportedExpression'
        ? String(node.condition.source).trim() : '';
      return cond === 'true' ? containsUnlabeledBreak(node.body) : true;
    }
    case 'DoWhileStatement':
    case 'ForStatement':
      statementCompletesNormally(node.body, state);
      return true; // conservative: a non-`while (true)` loop may exit
    case 'IfStatement': {
      const thenCompletes = statementCompletesNormally(node.consequent, state);
      const elseCompletes = node.alternate ? statementCompletesNormally(node.alternate, state) : true;
      return thenCompletes || elseCompletes;
    }
    case 'SwitchStatement':
      for (const group of node.groups || []) sequenceCompletesNormally(group.statements || [], state);
      return true; // conservative
    case 'TryStatement': {
      const bodyCompletes = statementCompletesNormally(node.block, state);
      let anyCatchCompletes = false;
      for (const clause of node.catches || []) {
        if (statementCompletesNormally(clause.body, state)) anyCatchCompletes = true;
      }
      if (node.finallyBlock && !statementCompletesNormally(node.finallyBlock, state)) return false;
      return bodyCompletes || anyCatchCompletes;
    }
    case 'SynchronizedStatement': return statementCompletesNormally(node.body, state);
    default: return true;
  }
}

function sequenceCompletesNormally(statements, state) {
  let reachable = true;
  for (const statement of statements) {
    if (!reachable) { state.unreachable = true; return false; }
    reachable = statementCompletesNormally(statement, state);
  }
  return reachable;
}

function hasUnreachableStatement(statements) {
  const state = { unreachable: false };
  sequenceCompletesNormally(statements || [], state);
  return state.unreachable;
}

module.exports = {
  treeToStatements, emitStatements, rawExpression, rawStatement, hasUnreachableStatement,
};
