'use strict';

// The structurer can put the complete continuation in a while(true) body:
//   while (true) { if (guard) { noncompleting arm } continuation }
// Move the guard to the header only when the arm cannot fall through, and
// the continuation cannot repeat/exit this loop or complete normally. Keep
// each protected construct whole and retain every existing transfer target.
function recoverLoopForms(source, proof, {parameterNames = [], retainDiagnostics = false} = {}, form = 'guarded') {
  const counter = form === 'nonrepeating' ? 'conditionalsRecovered'
    : form === 'exitContinuation' ? 'continuationsRecovered' : 'loopsRecovered';
  const unchanged = () => ({source, [counter]: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || !Array.isArray(parameterNames)
      || new Set(parameterNames).size !== parameterNames.length
      || parameterNames.some(name => typeof name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  const parents = new Map(), targets = new Map(), references = new Map(), ids = new Map(), ends = new Map();
  const statementStarts = new Set();
  let refused = false;
  function collect(node) {
    if (node.kind?.endsWith('Statement') && node.range) statementStarts.add(node.range.startOffset);
    children(node, collect);
  }
  collect(parsed);
  function terminator(node) {
    const first = starts.get(node.range?.startOffset);
    if (first === undefined) return null;
    for (let index = first; index < tokens.length; index++) {
      if (index !== first && statementStarts.has(tokens[index].range.startOffset)) return null;
      if (tokens[index].text === ';') return index;
      if (tokens[index].text === '}') return null;
      if (closes.has(index)) index = closes.get(index);
    }
    return null;
  }
  function inspect(node, parent, labels = [], breaks = [], activeLoops = []) {
    parents.set(node, parent); if (!ids.has(node)) ids.set(node, ids.size);
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      const target = node.label ? labels.slice().reverse().find(frame => frame.label === node.label)
        : node.kind === 'ContinueStatement' ? activeLoops.at(-1) : breaks.at(-1);
      const start = starts.get(node.range?.startOffset);
      if (!target || node.kind === 'ContinueStatement' && !(loops.has(target.kind) || loops.has(target.statement?.kind))
          || tokens[start]?.text !== (node.kind === 'BreakStatement' ? 'break' : 'continue')
          || node.label && tokens[start + 1]?.text !== node.label
          || tokens[start + (node.label ? 2 : 1)]?.text !== ';') refused = true;
      else {
        targets.set(node, target);
        if (!references.has(target)) references.set(target, []);
        references.get(target).push(node);
      }
    }
    if (['ExpressionStatement', 'ReturnStatement', 'ThrowStatement', 'AssertStatement', 'BreakStatement', 'ContinueStatement'].includes(node.kind)
        || node.kind === 'LocalVariableDeclarationStatement' && !(parent?.kind === 'ForStatement' && parent.initializer === node)) {
      const end = terminator(node);
      if (end === null) refused = true;
      else ends.set(node, end);
    }
    if (node.kind === 'ExpressionStatement') {
      const expression = node.expression;
      if (!['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(expression?.kind)
          && !(expression?.kind === 'UnaryExpression' && ['++', '--'].includes(expression.operator))) refused = true;
    }
    children(node, child => inspect(child, node,
      node.kind === 'LabeledStatement' ? [...labels, node] : labels,
      loops.has(node.kind) || node.kind === 'SwitchStatement' ? [...breaks, node] : breaks,
      loops.has(node.kind) ? [...activeLoops, node] : activeLoops));
  }
  inspect(parsed, null);
  if (refused || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  const transfer = (kind, target) => kind + ':' + ids.get(target);
  const normal = 'normal', abrupt = kind => new Set([kind]);
  const union = (...sets) => new Set(sets.flatMap(set => [...set]));
  function constantTrue(condition) {
    while (condition?.kind === 'ParenthesizedExpression') condition = condition.expression;
    return condition?.kind === 'LiteralExpression' && condition.literalKind === 'boolean' && condition.value === true;
  }
  function sequence(statements) {
    let result = new Set([normal]);
    for (const statement of statements) {
      if (!result.delete(normal)) { refused = true; return result; }
      result = union(result, completion(statement));
    }
    return result;
  }
  function consume(result, kind, target, replacement = null) {
    if (result.delete(transfer(kind, target)) && replacement) result.add(replacement);
  }
  function completion(node) {
    if (!node) return abrupt(normal);
    switch (node.kind) {
      case 'ReturnStatement': return abrupt('return');
      case 'ThrowStatement': return abrupt('throw');
      case 'BreakStatement': return abrupt(transfer('break', targets.get(node)));
      case 'ContinueStatement': return abrupt(transfer('continue', targets.get(node)));
      case 'BlockStatement': return sequence(node.statements);
      case 'IfStatement': return union(completion(node.consequent), completion(node.alternate));
      case 'LabeledStatement': {
        const result = completion(node.statement); consume(result, 'break', node, normal); return result;
      }
      case 'WhileStatement':
      case 'ForStatement':
      case 'EnhancedForStatement':
      case 'DoWhileStatement': {
        const result = completion(node.body);
        result.delete(normal); consume(result, 'continue', node);
        consume(result, 'break', node, normal);
        const label = parents.get(node);
        if (label?.kind === 'LabeledStatement') {
          consume(result, 'continue', label); consume(result, 'break', label, normal);
        }
        if (node.kind !== 'WhileStatement' || !constantTrue(node.condition)) result.add(normal);
        return result;
      }
      case 'SwitchStatement': {
        // Conservatively allow switch completion/fallthrough; still propagate
        // its nonlocal transfers so a later return cannot hide a loop exit.
        const result = union(abrupt(normal), ...(node.groups || []).map(group => sequence(group.statements || [])));
        consume(result, 'break', node, normal); return result;
      }
      case 'TryStatement': {
        const result = union(completion(node.block), ...(node.catches || []).map(clause => completion(clause.body)));
        if (!node.finallyBlock) return result;
        const final = completion(node.finallyBlock);
        const finalNormal = final.delete(normal);
        // A finally's abrupt completion overrides the pending completion.
        // Keeping all syntactic catches is conservative even if unreachable.
        return union(finalNormal ? result : new Set(), final);
      }
      case 'SynchronizedStatement': return completion(node.body);
      default: return abrupt(normal);
    }
  }
  function nonconstant(node, scope) {
    if (node.kind === 'Identifier') return scope.get(node.name) === true;
    if (node.kind === 'LiteralExpression') return node.literalKind === 'null';
    if (['MethodInvocationExpression', 'AssignmentExpression', 'ArrayAccessExpression', 'NewClassExpression', 'NewArrayExpression'].includes(node.kind)) return true;
    if (node.kind === 'UnaryExpression' && ['++', '--'].includes(node.operator)) return true;
    if (node.kind === 'FieldAccessExpression') return false; // may name a constant
    let dynamic = false; children(node, child => { if (nonconstant(child, scope)) dynamic = true; }); return dynamic;
  }
  function remember(node, scope) {
    if (node?.kind !== 'LocalVariableDeclarationStatement') return;
    for (const variable of node.declarators) scope.set(variable.name, !node.modifiers?.some(modifier => modifier.name === 'final'));
  }
  let candidate;
  function visit(node, scope) {
    if (candidate) return;
    if (node.kind === 'BlockStatement') {
      const nested = new Map(scope);
      for (const statement of node.statements) { visit(statement, nested); remember(statement, nested); }
      return;
    }
    if (node.kind === 'ForStatement') {
      const nested = new Map(scope); remember(node.initializer, nested); visit(node.body, nested); return;
    }
    if (form === 'nonrepeating' && node.kind === 'WhileStatement' && node.body?.kind === 'BlockStatement'
        && nonconstant(node.condition, scope)) {
      const label = parents.get(node)?.kind === 'LabeledStatement' ? parents.get(node) : null;
      const referencesToLoop = [...references.get(node) || [], ...references.get(label) || []];
      const result = completion(node.body);
      // No normal completion or own continue can evaluate the header again.
      // A labeled break remains legal when this labeled while becomes an if;
      // an unlabeled own break would lose its loop destination, so retain it.
      // All inner/nonlocal transfers and protected bodies stay byte identical.
      if (!refused && !result.has(normal)
          && referencesToLoop.every(reference => reference.kind === 'BreakStatement' && reference.label)) {
        candidate = {node, label}; return;
      }
    }
    if (form === 'guarded' && node.kind === 'WhileStatement' && constantTrue(node.condition) && node.body?.kind === 'BlockStatement'
        && node.body.statements.length >= 2) {
      const [guard, ...suffix] = node.body.statements;
      const label = parents.get(node)?.kind === 'LabeledStatement' ? parents.get(node) : null;
      const referencesToLoop = [...references.get(node) || [], ...references.get(label) || []];
      if (guard.kind === 'IfStatement' && !guard.alternate && guard.consequent?.kind === 'BlockStatement'
          && nonconstant(guard.condition, scope)) {
        const arm = completion(guard.consequent), tail = sequence(suffix);
        const armClose = closes.get(starts.get(guard.consequent.range?.startOffset));
        if (!refused && !arm.has(normal) && !tail.has(normal)
            && tokens[armClose]?.text === '}'
            && referencesToLoop.every(reference => reference.kind === 'ContinueStatement'
              && reference.range.startOffset >= guard.consequent.range.startOffset
              && reference.range.startOffset < tokens[armClose].range.endOffset)) {
          candidate = {node, guard, suffix, label}; return;
        }
      }
    }
    if (form === 'terminalExit' && node.kind === 'WhileStatement' && constantTrue(node.condition)
        && node.body?.kind === 'BlockStatement' && node.body.statements.length === 2) {
      const [guard, exit] = node.body.statements;
      if (guard.kind === 'IfStatement' && !guard.alternate && guard.consequent?.kind === 'BlockStatement'
          && nonconstant(guard.condition, scope) && exit.kind === 'BreakStatement' && !exit.label
          && targets.get(exit) === node) {
        const label = parents.get(node)?.kind === 'LabeledStatement' ? parents.get(node) : null;
        // If the arm falls through it must still exit after this iteration.
        // Earlier own continues, including finally overrides, remain legal and
        // evaluate the original guard again at the same point. Keep all arm
        // scopes/protected constructs whole; no inferred value facts are used.
        const arm = completion(guard.consequent);
        if (!refused) { candidate = {node, guard, suffix: [exit], label, headerExit: true, armFallsThrough: arm.has(normal)}; return; }
      }
    }
    if (['trailing', 'terminalExit'].includes(form) && node.kind === 'WhileStatement' && constantTrue(node.condition)
        && node.body?.kind === 'BlockStatement') {
      const statements = node.body.statements;
      const label = parents.get(node)?.kind === 'LabeledStatement' ? parents.get(node) : null;
      const referencesToLoop = [...references.get(node) || [], ...references.get(label) || []];
      const directContinue = statement => {
        if (statement?.kind !== 'IfStatement' || statement.alternate) return null;
        const arm = statement.consequent;
        const jump = arm?.kind === 'BlockStatement' && arm.statements.length === 1 ? arm.statements[0] : arm;
        return jump?.kind === 'ContinueStatement' && [node, label].includes(targets.get(jump)) ? jump : null;
      };
      for (let index = 1; index < statements.length - 1; index++) {
        if (!directContinue(statements[index])) continue;
        let end = index;
        while (end < statements.length && directContinue(statements[end])) end++;
        const prefix = statements.slice(0, index), guards = statements.slice(index, end), suffix = statements.slice(end);
        const jumps = guards.map(directContinue);
        const terminalExit = form === 'terminalExit' && suffix.length === 1 && suffix[0].kind === 'BreakStatement'
          && !suffix[0].label && targets.get(suffix[0]) === node ? suffix[0] : null;
        // Only direct guard backedges may reach this loop. In particular an
        // earlier continue (even in a finally) would now evaluate the predicate
        // where the original skipped it. Own breaks would skip the old suffix.
        // Body-owned locals would lose their scope in the new trailing header
        // or continuation; retain that loop rather than hoist declarations.
        if (!suffix.length || prefix.some(statement => statement.kind === 'LocalVariableDeclarationStatement')
            || form === 'terminalExit' && !terminalExit
            || referencesToLoop.length !== jumps.length + (terminalExit ? 1 : 0)
            || !referencesToLoop.every(reference => jumps.includes(reference) || reference === terminalExit)
            || !guards.some(guard => nonconstant(guard.condition, scope))) continue;
        const head = sequence(prefix), tail = sequence(suffix);
        if (!refused && head.has(normal) && !tail.has(normal)) {
          candidate = {node, label, prefix, guards, suffix, terminalExit}; return;
        }
      }
    }
    if (form === 'exitContinuation' && node.kind === 'WhileStatement' && constantTrue(node.condition)
        && node.body?.kind === 'BlockStatement') {
      const statements = node.body.statements;
      const label = parents.get(node)?.kind === 'LabeledStatement' ? parents.get(node) : null;
      const referencesToLoop = [...references.get(node) || [], ...references.get(label) || []];
      if (referencesToLoop.length && referencesToLoop.every(reference => reference.kind === 'ContinueStatement')) {
        for (let index = 1; index < statements.length; index++) {
          const prefix = statements.slice(0, index), suffix = statements.slice(index), roots = new Set(prefix);
          const inPrefix = reference => {
            for (let ancestor = reference; ancestor && ancestor !== node; ancestor = parents.get(ancestor))
              if (roots.has(ancestor)) return true;
            return false;
          };
          // Every repeating path stays in the intact prefix. Own breaks would
          // skip the old continuation but enter the hoisted one, so refuse all
          // of them, including finally overrides and syntactically dead exits.
          // Never hoist locals or split an if/try/switch/monitor/label construct.
          if (prefix.some(statement => statement.kind === 'LocalVariableDeclarationStatement')
              || !referencesToLoop.every(inPrefix)) continue;
          const head = sequence(prefix), tail = sequence(suffix);
          if (!refused && head.has(normal) && !tail.has(normal)) {
            candidate = {node, label, prefix, suffix}; return;
          }
        }
      }
    }
    children(node, child => visit(child, scope));
  }
  visit(parsed, new Map(parameterNames.map(name => [name, true])));
  if (refused || !candidate) return unchanged();
  const {node, guard, suffix, label} = candidate;
  if (form === 'exitContinuation') {
    const {prefix} = candidate;
    const start = starts.get(node.range.startOffset), bodyOpen = start + 4, bodyClose = closes.get(bodyOpen);
    const rangeStart = label ? starts.get(label.range.startOffset) : start;
    const first = starts.get(prefix[0].range.startOffset), suffixStart = starts.get(suffix[0].range.startOffset);
    if (tokens[start]?.text !== 'while' || tokens[start + 1]?.text !== '(' || tokens[start + 2]?.text !== 'true'
        || tokens[start + 3]?.text !== ')' || tokens[bodyOpen]?.text !== '{' || tokens[bodyClose]?.text !== '}'
        || first !== bodyOpen + 1 || suffixStart === undefined
        || label && (tokens[rangeStart]?.text !== label.label || tokens[rangeStart + 1]?.text !== ':' || rangeStart + 2 !== start)) return unchanged();
    const indentAt = offset => {
      const bytes = wrapped.slice(wrapped.lastIndexOf('\n', offset - 1) + 1, offset);
      return /^[ \t]*$/.test(bytes) ? bytes : '';
    };
    const indent = indentAt(tokens[rangeStart].range.startOffset), prefixIndent = indentAt(tokens[first].range.startOffset);
    const prefixBytes = wrapped.slice(tokens[bodyOpen].range.endOffset, tokens[suffixStart].range.startOffset).trimEnd();
    let tailBytes = wrapped.slice(tokens[suffixStart].range.startOffset, tokens[bodyClose].range.startOffset).trimEnd();
    const retainTailScope = suffix.some(statement => statement.kind === 'LocalVariableDeclarationStatement');
    if (retainTailScope) tailBytes = '{\n' + indent + '  ' + tailBytes + '\n' + indent + '}';
    else {
      const tailIndent = indentAt(tokens[suffixStart].range.startOffset);
      if (tailIndent.startsWith(indent) && tailIndent.length > indent.length)
        tailBytes = tailBytes.split('\n').map((line, index) => index && line.startsWith(tailIndent)
          ? indent + line.slice(tailIndent.length) : line).join('\n');
    }
    // The literal-true header has no effects. Normal prefix completion takes
    // this new bare break; existing continues still repeat without executing
    // the continuation. Nonlocal transfers still leave both sections. The
    // suffix remains at exactly the same enclosing protection/monitor depth.
    let replacement = wrapped.slice(tokens[rangeStart].range.startOffset, tokens[bodyOpen].range.endOffset)
      + prefixBytes + '\n' + prefixIndent + 'break;\n' + indent + '}\n' + indent + tailBytes;
    if (parents.get(label || node)?.kind !== 'BlockStatement') replacement = '{\n' + replacement + '\n' + indent + '}';
    const begin = tokens[rangeStart].range.startOffset, end = tokens[bodyClose].range.endOffset;
    const output = wrapped.slice(0, begin) + replacement + wrapped.slice(end);
    return {source: output.slice(2, -2), continuationsRecovered: 1, ...(retainDiagnostics ? {diagnostics: {
      label: label?.label || null, retainedTailScope: retainTailScope,
      loopRange: {start: begin - 2, end: end - 2},
      prefixRange: {start: tokens[first].range.startOffset - 2, end: tokens[suffixStart].range.startOffset - 2},
      suffixRange: {start: tokens[suffixStart].range.startOffset - 2, end: tokens[bodyClose].range.startOffset - 2},
    }} : {})};
  }
  if (form === 'nonrepeating') {
    const start = starts.get(node.range?.startOffset), close = closes.get(start + 1);
    const bodyOpen = starts.get(node.body.range?.startOffset), bodyClose = closes.get(bodyOpen);
    if (tokens[start]?.text !== 'while' || tokens[start + 1]?.text !== '(' || close === undefined
        || bodyOpen !== close + 1 || tokens[bodyOpen]?.text !== '{' || tokens[bodyClose]?.text !== '}') return unchanged();
    const begin = tokens[start].range.startOffset, end = tokens[start].range.endOffset;
    const output = wrapped.slice(0, begin) + 'if' + wrapped.slice(end);
    return {source: output.slice(2, -2), conditionalsRecovered: 1, ...(retainDiagnostics ? {diagnostics: {
      label: label?.label || null,
      loopRange: {start: begin - 2, end: tokens[bodyClose].range.endOffset - 2},
      headerKeywordRange: {start: begin - 2, end: end - 2},
    }} : {})};
  }
  if (form === 'trailing' || form === 'terminalExit' && !candidate.headerExit) {
    const {prefix, guards} = candidate;
    const start = starts.get(node.range.startOffset), bodyOpen = start + 4, bodyClose = closes.get(bodyOpen);
    const rangeStart = label ? starts.get(label.range.startOffset) : start;
    const first = starts.get(prefix[0].range.startOffset), guardStart = starts.get(guards[0].range.startOffset);
    const suffixStart = starts.get(suffix[0].range.startOffset);
    if (tokens[start]?.text !== 'while' || tokens[start + 1]?.text !== '(' || tokens[start + 2]?.text !== 'true'
        || tokens[start + 3]?.text !== ')' || tokens[bodyOpen]?.text !== '{' || tokens[bodyClose]?.text !== '}'
        || first !== bodyOpen + 1 || suffixStart === undefined
        || label && (tokens[rangeStart]?.text !== label.label || tokens[rangeStart + 1]?.text !== ':' || rangeStart + 2 !== start)) return unchanged();
    const predicates = [];
    let expected = guardStart;
    for (const guard of guards) {
      const begin = starts.get(guard.range.startOffset), conditionEnd = closes.get(begin + 1);
      const armStart = conditionEnd + 1;
      const arm = guard.consequent;
      const jump = arm.kind === 'BlockStatement' ? arm.statements[0] : arm;
      const jumpStart = starts.get(jump.range.startOffset), jumpEnd = ends.get(jump);
      const armEnd = arm.kind === 'BlockStatement' ? closes.get(armStart) : jumpEnd;
      if (begin !== expected || tokens[begin]?.text !== 'if' || tokens[begin + 1]?.text !== '(' || conditionEnd === undefined
          || jumpEnd === undefined || arm.kind === 'BlockStatement' && (tokens[armStart]?.text !== '{'
            || jumpStart !== armStart + 1 || armEnd !== jumpEnd + 1 || tokens[armEnd]?.text !== '}')
          || arm.kind !== 'BlockStatement' && jumpStart !== armStart) return unchanged();
      predicates.push(wrapped.slice(tokens[begin + 1].range.endOffset, tokens[conditionEnd].range.startOffset));
      expected = armEnd + 1;
    }
    if (expected !== suffixStart) return unchanged();
    const indentAt = offset => {
      const bytes = wrapped.slice(wrapped.lastIndexOf('\n', offset - 1) + 1, offset);
      return /^[ \t]*$/.test(bytes) ? bytes : '';
    };
    const indent = indentAt(tokens[rangeStart].range.startOffset);
    const prefixBytes = wrapped.slice(tokens[bodyOpen].range.endOffset, tokens[guardStart].range.startOffset).trimEnd();
    let tailBytes = wrapped.slice(tokens[suffixStart].range.startOffset, tokens[bodyClose].range.startOffset).trimEnd();
    const retainTailScope = suffix.some(statement => statement.kind === 'LocalVariableDeclarationStatement');
    if (retainTailScope) tailBytes = '{\n' + indent + '  ' + tailBytes + '\n' + indent + '}';
    else {
      const tailIndent = indentAt(tokens[suffixStart].range.startOffset);
      if (tailIndent.startsWith(indent) && tailIndent.length > indent.length)
        tailBytes = tailBytes.split('\n').map((line, index) => index && line.startsWith(tailIndent)
          ? indent + line.slice(tailIndent.length) : line).join('\n');
    }
    // Ordered short-circuit OR preserves evaluation of each separate guard,
    // including mutations, unboxing failures, and skipped later callbacks.
    const predicate = predicates.length === 1 ? predicates[0] : predicates.map(bytes => '(' + bytes + ')').join(' || ');
    // In the terminal form every own reference is one of the consumed direct
    // continues or the final bare break. Its loop label consequently has no
    // surviving reference; remove just that definition, never another frame.
    const retainLabel = label && !candidate.terminalExit;
    let replacement = (retainLabel ? label.label + ': ' : '') + 'do {' + prefixBytes + '\n' + indent + '} while (' + predicate + ');'
      + (candidate.terminalExit ? '' : '\n' + indent + tailBytes);
    if (parents.get(label || node)?.kind !== 'BlockStatement') replacement = '{\n' + replacement + '\n' + indent + '}';
    const begin = tokens[rangeStart].range.startOffset, end = tokens[bodyClose].range.endOffset;
    const output = wrapped.slice(0, begin) + replacement + wrapped.slice(end);
    return {source: output.slice(2, -2), loopsRecovered: 1, ...(retainDiagnostics ? {diagnostics: {
      label: label?.label || null, predicates, retainedTailScope: retainTailScope,
      ...(candidate.terminalExit ? {form: 'doWhile', terminalBareBreakRemoved: true, removedLoopLabel: label?.label || null} : {}),
      loopRange: {start: begin - 2, end: end - 2},
      prefixRange: {start: tokens[first].range.startOffset - 2, end: tokens[guardStart].range.startOffset - 2},
      suffixRange: {start: tokens[suffixStart].range.startOffset - 2, end: tokens[bodyClose].range.startOffset - 2},
      removedContinueRanges: guards.map(guard => {
        const jump = guard.consequent.kind === 'BlockStatement' ? guard.consequent.statements[0] : guard.consequent;
        return {start: jump.range.startOffset - 2, end: tokens[ends.get(jump)].range.endOffset - 2};
      }),
    }} : {})};
  }
  const start = starts.get(node.range.startOffset), bodyOpen = start + 4, bodyClose = closes.get(bodyOpen);
  const first = starts.get(guard.range.startOffset), guardClose = closes.get(first + 1);
  const armOpen = guardClose + 1, armClose = closes.get(armOpen);
  const suffixStart = starts.get(suffix[0].range.startOffset);
  if (tokens[start]?.text !== 'while' || tokens[start + 1]?.text !== '(' || tokens[start + 2]?.text !== 'true'
      || tokens[start + 3]?.text !== ')' || tokens[bodyOpen]?.text !== '{' || tokens[bodyClose]?.text !== '}'
      || first !== bodyOpen + 1 || tokens[first]?.text !== 'if' || tokens[first + 1]?.text !== '('
      || tokens[armOpen]?.text !== '{' || tokens[armClose]?.text !== '}' || suffixStart !== armClose + 1) return unchanged();
  const rangeStart = label ? starts.get(label.range.startOffset) : start;
  if (label && (tokens[rangeStart]?.text !== label.label || tokens[rangeStart + 1]?.text !== ':' || rangeStart + 2 !== start)) return unchanged();
  const indentAt = offset => {
    const prefix = wrapped.slice(wrapped.lastIndexOf('\n', offset - 1) + 1, offset);
    return /^[ \t]*$/.test(prefix) ? prefix : '';
  };
  const indent = indentAt(tokens[rangeStart].range.startOffset), armIndent = indentAt(tokens[first].range.startOffset);
  const predicate = wrapped.slice(tokens[first + 1].range.endOffset, tokens[guardClose].range.startOffset);
  let armBytes = wrapped.slice(tokens[armOpen].range.startOffset, tokens[armClose].range.endOffset);
  if (armIndent.startsWith(indent) && armIndent.length > indent.length)
    armBytes = armBytes.split('\n').map((line, index) => index && line.startsWith(armIndent) ? indent + line.slice(armIndent.length) : line).join('\n');
  if (candidate.headerExit) {
    if (ends.get(suffix[0]) + 1 !== bodyClose) return unchanged();
    if (candidate.armFallsThrough) armBytes = armBytes.slice(0, -1).trimEnd() + '\n' + indent + '  break;\n' + indent + '}';
    const begin = tokens[rangeStart].range.startOffset, end = tokens[bodyClose].range.endOffset;
    const replacement = (label ? label.label + ': ' : '') + 'while (' + predicate + ') ' + armBytes;
    const output = wrapped.slice(0, begin) + replacement + wrapped.slice(end);
    return {source: output.slice(2, -2), loopsRecovered: 1, ...(retainDiagnostics ? {diagnostics: {
      label: label?.label || null, form: 'while', predicate, retainedFallthroughBreak: candidate.armFallsThrough,
      terminalBareBreakRemoved: !candidate.armFallsThrough,
      loopRange: {start: begin - 2, end: end - 2},
      armRange: {start: tokens[armOpen].range.startOffset - 2, end: tokens[armClose].range.endOffset - 2},
    }} : {})};
  }
  let tailBytes = wrapped.slice(tokens[suffixStart].range.startOffset, tokens[bodyClose].range.startOffset).trimEnd();
  // A declaration owned by the old loop body must retain a separate scope.
  // Other complete statements already own any declarations nested within them.
  const retainTailScope = suffix.some(statement => statement.kind === 'LocalVariableDeclarationStatement');
  if (retainTailScope) tailBytes = '{\n' + indent + '  ' + tailBytes + '\n' + indent + '}';
  else {
    const tailIndent = indentAt(tokens[suffixStart].range.startOffset);
    if (tailIndent.startsWith(indent) && tailIndent.length > indent.length)
      tailBytes = tailBytes.split('\n').map((line, index) => index && line.startsWith(tailIndent) ? indent + line.slice(tailIndent.length) : line).join('\n');
  }
  let replacement = (label ? label.label + ': ' : '') + 'while (' + predicate + ') ' + armBytes + '\n' + indent + tailBytes;
  if (parents.get(label || node)?.kind !== 'BlockStatement') replacement = '{\n' + replacement + '\n' + indent + '}';
  const begin = tokens[rangeStart].range.startOffset, end = tokens[bodyClose].range.endOffset;
  const output = wrapped.slice(0, begin) + replacement + wrapped.slice(end);
  return {source: output.slice(2, -2), loopsRecovered: 1, ...(retainDiagnostics ? {diagnostics: {
    label: label?.label || null, predicate, retainedTailScope: retainTailScope,
    loopRange: {start: begin - 2, end: end - 2},
    armRange: {start: tokens[armOpen].range.startOffset - 2, end: tokens[armClose].range.endOffset - 2},
    suffixRange: {start: tokens[suffixStart].range.startOffset - 2, end: tokens[bodyClose].range.startOffset - 2},
  }} : {})};
}

function foldGuardedLoopContinuations(source, proof, options) {
  return recoverLoopForms(source, proof, options);
}

function foldNonrepeatingWhileLoops(source, proof, options) {
  return recoverLoopForms(source, proof, options, 'nonrepeating');
}

function foldTrailingLoopContinuations(source, proof, options) {
  return recoverLoopForms(source, proof, options, 'trailing');
}

function foldLoopExitContinuations(source, proof, options) {
  return recoverLoopForms(source, proof, options, 'exitContinuation');
}

function foldTerminalLoopExits(source, proof, options) {
  return recoverLoopForms(source, proof, options, 'terminalExit');
}

module.exports = {foldGuardedLoopContinuations, foldNonrepeatingWhileLoops, foldTrailingLoopContinuations, foldLoopExitContinuations, foldTerminalLoopExits};
