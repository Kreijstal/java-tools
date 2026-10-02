'use strict';

const {
  createNode,
  blockStatement,
  formalParameter,
  classType,
} = require('../java-frontend/ast');
const { JavaParser } = require('../java-frontend/parser');

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

// The CFG structurer expresses every loop as `while (true)` with the exit test
// inside, which is faithful but not what anybody wrote: a plain `for` loop comes
// back as an infinite loop whose false arm carries the entire rest of the method.
// Rotating it back - hoisting the exit arm out and moving the test into the
// header - is only sound when control cannot fall out of that arm into the next
// iteration, so ask whether every path through it leaves.
function alwaysExits(tree, render) {
  if (!tree) return false;
  switch (tree.t) {
    case 'straight': return !!(render.blockTerminates && render.blockTerminates(tree.block));
    case 'seq': return (tree.body || []).some((child) => alwaysExits(child, render));
    // A transfer consumed by this construct completes it normally. It does
    // not leave the surrounding arm, even though its own statement is abrupt.
    // Be conservative about conditional/unreachable breaks: keeping the
    // original loop is safe when we cannot prove the arm always leaves.
    case 'block': return !referencesLabel(tree.body, tree.label, 'break')
      && alwaysExits(tree.body, render);
    case 'loop': return !referencesLabel(tree.body, tree.label, 'break');
    case 'if': return alwaysExits(tree.then, render) && alwaysExits(tree.els, render);
    case 'switch': return !!tree.dflt && tree.cases.every((item) => alwaysExits(item.body, render))
      && alwaysExits(tree.dflt, render);
    case 'break': return true;
    case 'continue': return true;
    default: return false; // try/synchronized and anything new: assume it falls through
  }
}

function referencesLabel(tree, label, transfer = null) {
  if (!tree) return false;
  switch (tree.t) {
    case 'break':
    case 'continue': return tree.label === label && (!transfer || tree.t === transfer);
    case 'seq': return (tree.body || []).some((child) => referencesLabel(child, label, transfer));
    case 'block':
    case 'loop':
    case 'synchronized':
    case 'try': return referencesLabel(tree.body, label, transfer)
      || (tree.catches || []).some((item) => referencesLabel(item.body, label, transfer));
    case 'if': return referencesLabel(tree.then, label, transfer)
      || referencesLabel(tree.els, label, transfer);
    case 'switch': return (tree.cases || []).some((item) => referencesLabel(item.body, label, transfer))
      || referencesLabel(tree.dflt, label, transfer);
    default: return false;
  }
}

// `{loop L, seq[straight, if]}` is the shape the structurer gives a loop whose
// test sits at the top. The straight part has to be empty for the test to move
// into the header - anything computed there runs before the test on every
// iteration and must stay in the body.
function rotatableLoop(tree, render) {
  const body = tree.body;
  if (!body || body.t !== 'seq' || (body.body || []).length < 2) return null;
  const [head, branch, ...rest] = body.body;
  if (!head || head.t !== 'straight' || !branch || branch.t !== 'if') return null;
  if (render.straight(head.block).length) return null;
  return { branch, rest };
}

function endsWithContinueTo(statements, label) {
  const last = statements[statements.length - 1];
  return !!last && last.kind === 'ContinueStatement' && last.label === label;
}

const statementParser = new JavaParser();
// Weak keys keep this proof cache from retaining completed methods or their
// generated source. Parse the whole straight block, not just its first line.
const parsedStraightBlocks = new WeakMap();
function parsedStraightBlock(node) {
  if (!parsedStraightBlocks.has(node)) {
    let parsed = null;
    try {
      parsed = statementParser.parseStatement(`{\n${node.source}\n}`, { requireComplete: true });
    } catch (_) { /* Unknown Java stays in its original scope/control flow. */ }
    parsedStraightBlocks.set(node, parsed);
  }
  return parsedStraightBlocks.get(node);
}

function provenAbrupt(statements) {
  const state = { unreachable: false };
  return !sequenceCompletesNormally(statements, state, true) && !state.unreachable;
}

function continuation(statements) {
  // Removing the enclosing else must not extend a variable or local type's
  // scope into subsequent statements. In doubtful cases keep a plain block.
  const scopedOrNondeclaring = new Set([
    'BlockStatement', 'LabeledStatement', 'IfStatement', 'WhileStatement',
    'ForStatement', 'DoWhileStatement', 'SwitchStatement', 'TryStatement',
    'SynchronizedStatement', 'ExpressionStatement', 'ReturnStatement',
    'ThrowStatement', 'BreakStatement', 'ContinueStatement', 'EmptyStatement',
    'AssertStatement',
  ]);
  const scopeSafe = statements.every((statement) => {
    if (statement.kind !== 'UnsupportedStatement') return scopedOrNondeclaring.has(statement.kind);
    const parsed = parsedStraightBlock(statement);
    return parsed && parsed.statements.every((child) => scopedOrNondeclaring.has(child.kind));
  });
  return scopeSafe ? statements : [block(statements)];
}

function statementCount(statements) {
  let count = 0;
  for (const statement of statements) anyStatement(statement, () => { count++; return false; });
  return count;
}

function literalAssignment(statements) {
  if (statements.length !== 1 || statements[0].kind !== 'UnsupportedStatement') return null;
  const parsed = parsedStraightBlock(statements[0]);
  if (!parsed || parsed.statements.length !== 1) return null;
  const statement = parsed.statements[0];
  const assignment = statement.kind === 'ExpressionStatement' && statement.expression;
  if (!assignment || assignment.kind !== 'AssignmentExpression' || assignment.operator !== '='
      || assignment.left.kind !== 'Identifier') return null;
  let value = assignment.right;
  let sign = '';
  if (value.kind === 'UnaryExpression' && value.prefix && ['-', '+'].includes(value.operator)) {
    sign = value.operator;
    value = value.operand;
  }
  if (value.kind !== 'LiteralExpression') return null;
  if (!sign && value.literalKind === 'boolean') return {
    name: assignment.left.name, type: 'boolean', source: String(value.value),
  };
  if (value.literalKind !== 'number') return null;
  const source = value.raw;
  let type = null;
  // Read the spelling rather than converting through JS Number: large Java
  // integers, negative zero and hexadecimal literals must retain their bits.
  const integer = '(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*)';
  if (new RegExp(`^${integer}$`).test(source)) type = 'int';
  else if (new RegExp(`^${integer}[lL]$`).test(source)) type = 'long';
  else if (/^(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][+-]?[\d_]+)?[fF]$/.test(source)) type = 'float';
  else if (/^(?:\d[\d_]*\.[\d_]*|\.[\d_]+|\d[\d_]*[eE][+-]?[\d_]+)(?:[eE][+-]?[\d_]+)?[dD]?$/.test(source)) type = 'double';
  return type ? {name: assignment.left.name, type, source: sign + source} : null;
}

function valueProducingBranch(condition, thenStatements, elseStatements, localType) {
  if (!localType) return null;
  const taken = literalAssignment(thenStatements);
  const other = literalAssignment(elseStatements);
  if (!taken || !other || taken.name !== other.name || taken.type !== other.type) return null;
  const destination = localType(taken.name);
  // Same-type primitive arms have no conditional numeric promotion, boxing or
  // reference type inference. Require an identical destination type as well:
  // byte/short/char constant assignment permits narrowing that a ternary might
  // reject. An unproven name could be an unqualified (possibly volatile) field.
  if (destination !== taken.type) return null;
  return rawStatement(`${taken.name} = (${condition}) ? ${taken.source} : ${other.source};`);
}

function lowerIfStatements(condition, thenStatements, elseStatements, inverted, localType) {
  const makeIf = (source, body, alternate = null) => createNode('IfStatement', {
    condition: rawExpression(source), consequent: block(body), alternate,
  });
  // All children have already been rendered in CFG order. Only rearrange the
  // resulting AST, because rendering itself binds local names and types.
  const inverse = () => (inverted && inverted()) || `!(${condition})`;
  const value = valueProducingBranch(condition, thenStatements, elseStatements, localType);
  if (value) return [value];
  if (!thenStatements.length && elseStatements.length) {
    return [makeIf(inverse(), elseStatements)];
  }
  if (elseStatements.length) {
    const thenExits = provenAbrupt(thenStatements);
    const elseExits = provenAbrupt(elseStatements);
    // When both arms leave, use the shorter arm as the guard. This avoids
    // retaining a deep conditional ladder in the guard's body.
    if (thenExits && (!elseExits || statementCount(thenStatements) <= statementCount(elseStatements))) {
      return [makeIf(condition, thenStatements), ...continuation(elseStatements)];
    }
    if (elseExits) {
      return [makeIf(inverse(), elseStatements), ...continuation(thenStatements)];
    }
  }
  return [makeIf(condition, thenStatements, elseStatements.length ? block(elseStatements) : null)];
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
    case 'loop': {
      const rotatable = rotatableLoop(tree, render);
      if (rotatable) {
        const { branch, rest } = rotatable;
        // Render in the order the untransformed tree would have: the condition,
        // then the taken arm, then the fall arm. Reordering the *rendered*
        // statements afterwards is safe; reordering the rendering is not, because
        // expression reconstruction binds local names as it goes.
        const taken = render.cond(branch.block);
        const notTaken = render.condInverted ? render.condInverted(branch.block) : null;
        const thenStatements = treeToStatements(branch.then, render);
        const elseStatements = branch.els ? treeToStatements(branch.els, render) : [];
        const restStatements = rest.flatMap((child) => treeToStatements(child, render));
        const restExits = rest.length === 0 || rest.some((child) => alwaysExits(child, render));
        const arms = [
          {
            condition: notTaken, bodyTree: branch.els, body: elseStatements,
            exitTree: branch.then, exit: thenStatements,
          },
          {
            condition: taken, bodyTree: branch.then, body: thenStatements,
            exitTree: branch.els, exit: elseStatements,
          },
        ];
        for (const arm of arms) {
          if (!arm.condition || referencesLabel(arm.exitTree, tree.label)) continue;
          const loopsBack = endsWithContinueTo(arm.body, tree.label);
          // Two shapes reach here. Without trailing statements the other arm is
          // the exit and has to leave on every path, or rotating it out would
          // change an iteration into a fall-through. With trailing statements the
          // other arm must be empty - the test simply falls past the loop - and
          // the statements after it are the exit, which likewise has to leave.
          if (rest.length === 0) {
            if (!loopsBack || !alwaysExits(arm.exitTree, render)) continue;
            return [
              createNode('LabeledStatement', {
                label: tree.label,
                statement: createNode('WhileStatement', {
                  condition: rawExpression(arm.condition),
                  body: block(arm.body.slice(0, -1)),
                }),
              }),
              ...arm.exit,
            ];
          }
          // The trailing statements leave the loop, so nothing in them may jump
          // back into it: a `continue` there is proof they are part of the loop
          // body and not what follows it.
          if (rest.some((child) => referencesLabel(child, tree.label))) continue;
          if (arm.exit.length || !restExits || !referencesLabel(arm.bodyTree, tree.label)) continue;
          // Falling off the end of the body used to land in the trailing
          // statements; they are outside the loop now, so that path breaks.
          const loopBody = loopsBack ? arm.body.slice(0, -1) : [
            ...arm.body, createNode('BreakStatement', { label: null }),
          ];
          return [
            createNode('LabeledStatement', {
              label: tree.label,
              statement: createNode('WhileStatement', {
                condition: rawExpression(arm.condition),
                body: block(loopBody),
              }),
            }),
            ...restStatements,
          ];
        }
        return [createNode('LabeledStatement', {
          label: tree.label,
          statement: createNode('WhileStatement', {
            condition: rawExpression('true'),
            body: block([
              ...(taken === 'true' ? thenStatements : taken === 'false' ? elseStatements
                : lowerIfStatements(taken, thenStatements, elseStatements, () => notTaken, render.localType)),
              ...restStatements,
            ]),
          }),
        })];
      }
      return [createNode('LabeledStatement', {
        label: tree.label,
        statement: createNode('WhileStatement', {
          condition: rawExpression('true'),
          body: block(treeToStatements(tree.body, render)),
        }),
      })];
    }
    case 'if': {
      const conditionSource = render.cond(tree.block);
      if (conditionSource === 'true') return treeToStatements(tree.then, render);
      if (conditionSource === 'false') return tree.els ? treeToStatements(tree.els, render) : [];
      const thenStatements = treeToStatements(tree.then, render);
      const elseStatements = tree.els ? treeToStatements(tree.els, render) : [];
      return lowerIfStatements(conditionSource, thenStatements, elseStatements,
        render.condInverted ? () => render.condInverted(tree.block) : null, render.localType);
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

function statementCompletesNormally(node, state, parseRaw = false) {
  if (!node) return true;
  switch (node.kind) {
    case 'BlockStatement': return sequenceCompletesNormally(node.statements || [], state, parseRaw);
    case 'UnsupportedStatement': {
      if (!parseRaw) return rawStatementCompletes(node.source);
      // Parser-produced unsupported statements have no source and cannot
      // establish a proof. A last-line return alone is not enough: it might
      // belong to an unbraced conditional.
      if (node.source == null) return true;
      const parsed = parsedStraightBlock(node);
      return parsed ? statementCompletesNormally(parsed, state, true) : true;
    }
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'ReturnStatement':
    case 'ThrowStatement':
      return false;
    case 'LabeledStatement':
      return statementCompletesNormally(node.statement, state, parseRaw)
        || containsBreakToLabel(node.statement, node.label);
    case 'WhileStatement': {
      statementCompletesNormally(node.body, state, parseRaw); // walk for nested unreachable
      const cond = node.condition && node.condition.kind === 'UnsupportedExpression'
        ? String(node.condition.source).trim() : '';
      return cond === 'true' ? containsUnlabeledBreak(node.body) : true;
    }
    case 'DoWhileStatement':
    case 'ForStatement':
      statementCompletesNormally(node.body, state, parseRaw);
      return true; // conservative: a non-`while (true)` loop may exit
    case 'IfStatement': {
      const thenCompletes = statementCompletesNormally(node.consequent, state, parseRaw);
      const elseCompletes = node.alternate ? statementCompletesNormally(node.alternate, state, parseRaw) : true;
      return thenCompletes || elseCompletes;
    }
    case 'SwitchStatement':
      for (const group of node.groups || []) sequenceCompletesNormally(group.statements || [], state, parseRaw);
      return true; // conservative
    case 'TryStatement': {
      const bodyCompletes = statementCompletesNormally(node.block, state, parseRaw);
      let anyCatchCompletes = false;
      for (const clause of node.catches || []) {
        if (statementCompletesNormally(clause.body, state, parseRaw)) anyCatchCompletes = true;
      }
      if (node.finallyBlock && !statementCompletesNormally(node.finallyBlock, state, parseRaw)) return false;
      return bodyCompletes || anyCatchCompletes;
    }
    case 'SynchronizedStatement': return statementCompletesNormally(node.body, state, parseRaw);
    default: return true;
  }
}

function sequenceCompletesNormally(statements, state, parseRaw = false) {
  let reachable = true;
  for (const statement of statements) {
    if (!reachable) { state.unreachable = true; return false; }
    reachable = statementCompletesNormally(statement, state, parseRaw);
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
