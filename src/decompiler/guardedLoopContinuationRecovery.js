'use strict';

// The structurer can put the complete continuation in a while(true) body:
//   while (true) { if (guard) { noncompleting arm } continuation }
// Move the guard to the header only when the arm cannot fall through, and
// the continuation cannot repeat/exit this loop or complete normally. Keep
// each protected construct whole and retain every existing transfer target.
function recoverLoopForms(source, proof, {parameterNames = [], retainDiagnostics = false} = {}, form = 'guarded') {
  const counter = form === 'naturalExits' ? 'loopExitsRecovered' : form === 'nonrepeating' ? 'conditionalsRecovered'
    : form === 'exitContinuation' ? 'continuationsRecovered' : form === 'terminalTail' ? 'tailsHoisted' : 'loopsRecovered';
  const unchanged = () => ({source, [counter]: 0});
  if (form === 'naturalExits' && source.length > 400000) return unchanged();
  if (!proof || typeof retainDiagnostics !== 'boolean' || !Array.isArray(parameterNames)
      || new Set(parameterNames).size !== parameterNames.length
      || parameterNames.some(name => typeof name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const loops = new Set(['WhileStatement', 'ForStatement', 'EnhancedForStatement', 'DoWhileStatement']);
  const parents = new Map(), targets = new Map(), references = new Map(), ids = new Map(), ends = new Map();
  const statementStarts = new Set(), nearestBreaks = new Map();
  let refused = false;
  function collect(node, depth = 0) {
    if (form === 'naturalExits' && depth > 128) {refused = true; return;}
    if (node.kind?.endsWith('Statement') && node.range) statementStarts.add(node.range.startOffset);
    children(node, child => collect(child, depth + 1));
  }
  collect(parsed);
  if (refused) return unchanged();
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
    if (form === 'naturalExits') nearestBreaks.set(node, breaks.at(-1));
    if (/ClassDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|AnonymousClass/.test(node.kind || '')) refused = true;
    if (form === 'naturalExits' && (/InterfaceDeclaration|EnumDeclaration|RecordDeclaration/.test(node.kind || '')
        || node.kind === 'NewClassExpression' && node.body != null)) refused = true;
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
  if (form === 'naturalExits') {
    let selected, overBudget = false;
    function visitNatural(node, depth = 0) {
      if (depth > 128) {overBudget = true; return;}
      if (selected) return;
      if (loops.has(node.kind) && node.body?.kind === 'BlockStatement') {
        const label = parents.get(node)?.kind === 'LabeledStatement' ? parents.get(node) : null;
        const first = starts.get(node.range?.startOffset), open = starts.get(node.body.range?.startOffset), close = closes.get(open);
        const last = node.body.statements.at(-1);
        if (first !== undefined && tokens[open]?.text === '{' && tokens[close]?.text === '}'
            && tokens[close].range.endOffset - tokens[first].range.startOffset <= 40000) {
          const own = last?.kind === 'ContinueStatement' && [node, label].includes(targets.get(last));
          if (own && nearestBreaks.get(last) === node && ends.get(last) + 1 === close) {
            selected = {node, label, first, open, close, removed: last, localized: [],
              retireLabel: Boolean(label && (references.get(label) || []).every(reference => reference === last))};
            return;
          }
          const inner = last?.kind === 'LabeledStatement' ? last.statement : last;
          const innerFirst = starts.get(inner?.range?.startOffset), innerOpen = starts.get(inner?.body?.range?.startOffset), innerClose = closes.get(innerOpen);
          let innerEnd = innerClose;
          if (inner?.kind === 'DoWhileStatement') {
            const conditionClose = closes.get(innerClose + 2);
            innerEnd = tokens[innerClose + 1]?.text === 'while' && tokens[innerClose + 2]?.text === '('
              && tokens[conditionClose + 1]?.text === ';' ? conditionClose + 1 : null;
          }
          const outward = label && references.get(label) || [];
          const inInner = reference => {
            for (let ancestor = parents.get(reference); ancestor && ancestor !== node; ancestor = parents.get(ancestor))
              if (ancestor === inner) return true;
            return false;
          };
          // There is no statement, protected boundary or update between the
          // final inner loop and normal outer-body completion. A bare inner
          // break therefore takes the same outer update/header as this continue.
          // Refuse a nested switch/loop that would capture the new bare break.
          if (label && loops.has(inner?.kind)
              && inner.body?.kind === 'BlockStatement' && outward.length > 0 && outward.length <= 128
              && tokens[innerFirst]?.text === ({WhileStatement: 'while', ForStatement: 'for', EnhancedForStatement: 'for', DoWhileStatement: 'do'})[inner.kind]
              && tokens[innerOpen]?.text === '{' && tokens[innerClose]?.text === '}' && innerEnd + 1 === close
              && outward.every(reference => reference.kind === 'ContinueStatement'
                && nearestBreaks.get(reference) === inner && inInner(reference))) {
            selected = {node, label, first, open, close, inner, innerFirst, innerOpen, innerClose,
              removed: null, localized: outward, retireLabel: true};
            return;
          }
        }
      }
      children(node, child => visitNatural(child, depth + 1));
    }
    visitNatural(parsed);
    if (!selected || overBudget) return unchanged();
    const {node, label, first, open, close, removed, localized, retireLabel} = selected;
    const range = (a, b) => ({start: tokens[a].range.startOffset - 2, end: tokens[b].range.endOffset - 2});
    const edits = [], transfers = [];
    let retiredLabelRange = null;
    if (retireLabel) {
      const begin = starts.get(label.range.startOffset);
      if (tokens[begin]?.text !== label.label || tokens[begin + 1]?.text !== ':' || begin + 2 !== first) return unchanged();
      retiredLabelRange = {start: tokens[begin].range.startOffset - 2, end: tokens[first].range.startOffset - 2};
      edits.push({...retiredLabelRange, text: ''});
    }
    for (const reference of removed ? [removed] : localized) {
      const begin = starts.get(reference.range.startOffset), end = ends.get(reference);
      if (tokens[begin]?.text !== 'continue' || tokens[end]?.text !== ';') return unchanged();
      const transferRange = range(begin, end);
      const keywordRange = range(begin, begin);
      const labelRange = reference.label ? range(begin + 1, begin + 1) : null;
      if (removed) {
        let start = transferRange.start, finish = transferRange.end;
        const lineStart = source.lastIndexOf('\n', start - 1) + 1, lineEnd = source.indexOf('\n', finish);
        if (lineEnd >= 0 && /^[ \t]*$/.test(source.slice(lineStart, start)) && /^[ \t\r]*$/.test(source.slice(finish, lineEnd))) {
          start = lineStart; finish = lineEnd + 1;
        }
        edits.push({start, end: finish, text: ''});
      } else {
        edits.push({...keywordRange, text: 'break'});
        edits.push({start: keywordRange.end, end: tokens[end].range.startOffset - 2, text: ''});
      }
      transfers.push({range: transferRange, keywordRange, labelRange, removed: Boolean(removed)});
    }
    edits.sort((a, b) => a.start - b.start);
    for (let index = 1; index < edits.length; index++) if (edits[index].start < edits[index - 1].end) return unchanged();
    let output = source;
    for (const edit of edits.slice().reverse()) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    return {source: output, loopExitsRecovered: 1, terminalContinuesRemoved: Number(Boolean(removed)),
      outerContinuesLocalized: localized.length, loopLabelsRemoved: Number(retireLabel),
      labelReferencesRemoved: transfers.filter(transfer => transfer.labelRange).length,
      ...(retainDiagnostics ? {diagnostics: {edits, transfers, retiredLabelRange, label: label?.label || null,
        outerLoopKeywordRange: range(first, first), outerBodyRange: range(open, close), outerLoopKind: node.kind,
        ...(selected.inner ? {innerLoopKeywordRange: range(selected.innerFirst, selected.innerFirst), innerBodyRange: range(selected.innerOpen, selected.innerClose)} : {})}} : {})};
  }
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
    if (form === 'nonlocalExit' && node.kind === 'WhileStatement' && constantTrue(node.condition)
        && node.body?.kind === 'BlockStatement' && node.body.statements.length >= 2) {
      const [guard, ...suffix] = node.body.statements;
      const label = parents.get(node)?.kind === 'LabeledStatement' ? parents.get(node) : null;
      const jump = guard.consequent?.kind === 'BlockStatement' && guard.consequent.statements.length === 1
        ? guard.consequent.statements[0] : null;
      const referencesToLoop = [...references.get(node) || [], ...references.get(label) || []];
      // A leading break to an enclosing frame ends this loop too. Once that
      // guard becomes the header, its exact break follows the loop. An own
      // break (including a finally override) would incorrectly enter that exit,
      // so refuse every own break. Own continues still test the guard at the
      // same next-iteration point. Keep the complete remaining body/protection.
      if (guard.kind === 'IfStatement' && !guard.alternate && jump?.kind === 'BreakStatement' && jump.label
          && targets.get(jump) !== label && targets.get(jump) !== node
          && nonconstant(guard.condition, scope)
          && referencesToLoop.every(reference => reference.kind === 'ContinueStatement')) {
        sequence(suffix);
        if (!refused) { candidate = {node, label, guard, suffix, jump}; return; }
      }
    }
    if (form === 'elseExitGuard' && node.kind === 'WhileStatement' && constantTrue(node.condition)
        && node.body?.kind === 'BlockStatement' && node.body.statements.length === 2) {
      const [branch, exit] = node.body.statements;
      if (branch.kind === 'IfStatement' && branch.consequent?.kind === 'BlockStatement'
          && branch.alternate?.kind === 'BlockStatement' && exit.kind === 'BreakStatement'
          && !exit.label && targets.get(exit) === node
          && !branch.consequent.statements.some(statement => statement.kind === 'LocalVariableDeclarationStatement')) {
        // Keep the false arm in the loop. Its new explicit exit skips the true
        // arm; all original own/nonlocal transfers still target the same frames.
        // Only the empty declaration scope of the true arm is flattened. Refuse
        // declarations/control frames in the moved false arm so declaration and
        // label ordinals cannot exchange places. Protected true-arm constructs
        // remain whole, including finally overrides of break/continue/return.
        const permitted = new Set(['BlockStatement', 'IfStatement', 'ExpressionStatement',
          'EmptyStatement', 'ReturnStatement', 'ThrowStatement', 'BreakStatement',
          'ContinueStatement', 'AssertStatement']);
        let simpleAlternate = true;
        const inspectAlternate = child => {
          if (child.kind?.endsWith('Statement') && !permitted.has(child.kind)) simpleAlternate = false;
          children(child, inspectAlternate);
        };
        inspectAlternate(branch.alternate);
        const arm = completion(branch.consequent), alternate = completion(branch.alternate);
        // The original trailing break must still be reachable after flattening,
        // and the new false-arm break must not create unreachable Java source.
        if (!refused && simpleAlternate && arm.has(normal) && alternate.has(normal)) {
          candidate = {node, guard: branch, suffix: [exit], label: parents.get(node)?.kind === 'LabeledStatement' ? parents.get(node) : null};
          return;
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
        const prefixRoots = new Set(prefix);
        const inPrefix = reference => {
          for (let ancestor = reference; ancestor && ancestor !== node; ancestor = parents.get(ancestor))
            if (prefixRoots.has(ancestor)) return true;
          return false;
        };
        const prefixBreaks = terminalExit ? referencesToLoop.filter(reference =>
          reference.kind === 'BreakStatement' && inPrefix(reference)) : [];
        // Only direct guard backedges may repeat this loop. In particular an
        // earlier continue (even in a finally) would now evaluate the predicate
        // where the original skipped it. A prefix break remains an exit that
        // skips the trailing predicate only when the suffix is a bare own break.
        // Other suffixes must not run after an original prefix break.
        // Body-owned locals would lose their scope in the new trailing header
        // or continuation; retain that loop rather than hoist declarations.
        if (!suffix.length || prefix.some(statement => statement.kind === 'LocalVariableDeclarationStatement')
            || form === 'terminalExit' && !terminalExit
            || referencesToLoop.length !== jumps.length + prefixBreaks.length + (terminalExit ? 1 : 0)
            || !referencesToLoop.every(reference => jumps.includes(reference) || reference === terminalExit || prefixBreaks.includes(reference))
            || !guards.some(guard => nonconstant(guard.condition, scope))) continue;
        const head = sequence(prefix), tail = sequence(suffix);
        if (!refused && head.has(normal) && !tail.has(normal)) {
          candidate = {node, label, prefix, guards, suffix, terminalExit, prefixBreaks}; return;
        }
      }
    }
    if (['exitContinuation', 'terminalTail'].includes(form) && node.kind === 'WhileStatement' && constantTrue(node.condition)
        && node.body?.kind === 'BlockStatement') {
      const statements = node.body.statements;
      const label = parents.get(node)?.kind === 'LabeledStatement' ? parents.get(node) : null;
      const referencesToLoop = [...references.get(node) || [], ...references.get(label) || []];
      const exit = form === 'terminalTail' ? statements.at(-1) : null;
      const terminalExit = exit?.kind === 'BreakStatement' && !exit.label && targets.get(exit) === node;
      const continuations = referencesToLoop.filter(reference => reference !== exit);
      if (continuations.length && (form !== 'terminalTail' || terminalExit)
          && continuations.every(reference => reference.kind === 'ContinueStatement')) {
        for (let index = 1; index < statements.length - (terminalExit ? 1 : 0); index++) {
          const prefix = statements.slice(0, index), suffix = statements.slice(index, terminalExit ? -1 : undefined), roots = new Set(prefix);
          const inPrefix = reference => {
            for (let ancestor = reference; ancestor && ancestor !== node; ancestor = parents.get(ancestor))
              if (roots.has(ancestor)) return true;
            return false;
          };
          // Every repeating path stays in the intact prefix. Earlier own breaks would
          // skip the old continuation but enter the hoisted one, so refuse all
          // of them, including finally overrides and syntactically dead exits.
          // Never hoist locals or split an if/try/switch/monitor/label construct.
          if (prefix.some(statement => statement.kind === 'LocalVariableDeclarationStatement')
              || !continuations.every(inPrefix)) continue;
          const head = sequence(prefix), tail = sequence(suffix);
          if (!refused && head.has(normal) && (terminalExit ? tail.has(normal) : !tail.has(normal))) {
            candidate = {node, label, prefix, suffix, exit: terminalExit ? exit : null}; return;
          }
        }
      }
    }
    children(node, child => visit(child, scope));
  }
  visit(parsed, new Map(parameterNames.map(name => [name, true])));
  if (refused || !candidate) return unchanged();
  const {node, guard, suffix, label} = candidate;
  if (form === 'elseExitGuard') {
    const start = starts.get(node.range.startOffset), bodyOpen = start + 4, bodyClose = closes.get(bodyOpen);
    const rangeStart = label ? starts.get(label.range.startOffset) : start;
    const first = starts.get(guard.range.startOffset), conditionClose = closes.get(first + 1);
    const armOpen = starts.get(guard.consequent.range.startOffset), armClose = closes.get(armOpen);
    const alternateOpen = starts.get(guard.alternate.range.startOffset), alternateClose = closes.get(alternateOpen);
    const exitStart = starts.get(suffix[0].range.startOffset), exitEnd = ends.get(suffix[0]);
    if (tokens[start]?.text !== 'while' || tokens[start + 1]?.text !== '(' || tokens[start + 2]?.text !== 'true'
        || tokens[start + 3]?.text !== ')' || tokens[bodyOpen]?.text !== '{' || tokens[bodyClose]?.text !== '}'
        || first !== bodyOpen + 1 || tokens[first]?.text !== 'if' || tokens[first + 1]?.text !== '('
        || armOpen !== conditionClose + 1 || tokens[armOpen]?.text !== '{' || tokens[armClose]?.text !== '}'
        || tokens[armClose + 1]?.text !== 'else' || alternateOpen !== armClose + 2
        || tokens[alternateOpen]?.text !== '{' || tokens[alternateClose]?.text !== '}'
        || exitStart !== alternateClose + 1 || exitEnd + 1 !== bodyClose
        || label && (tokens[rangeStart]?.text !== label.label || tokens[rangeStart + 1]?.text !== ':' || rangeStart + 2 !== start)) return unchanged();
    const indentAt = offset => {
      const prefix = wrapped.slice(wrapped.lastIndexOf('\n', offset - 1) + 1, offset);
      return /^[ \t]*$/.test(prefix) ? prefix : '';
    };
    const indent = indentAt(tokens[rangeStart].range.startOffset), guardIndent = indentAt(tokens[first].range.startOffset);
    const firstArmToken = tokens[armOpen + 1];
    const armIndent = firstArmToken && armOpen + 1 < armClose ? indentAt(firstArmToken.range.startOffset) : guardIndent;
    const begin = tokens[rangeStart].range.startOffset, end = tokens[bodyClose].range.endOffset;
    const conditionStart = tokens[first + 1].range.endOffset, conditionEnd = tokens[conditionClose].range.startOffset;
    const predicate = wrapped.slice(conditionStart, conditionEnd);
    let armBytes = wrapped.slice(tokens[armOpen].range.endOffset, tokens[armClose].range.startOffset).trim();
    if (armIndent.startsWith(guardIndent) && armIndent.length > guardIndent.length)
      armBytes = armBytes.split('\n').map((line, index) => index && line.startsWith(armIndent)
        ? guardIndent + line.slice(armIndent.length) : line).join('\n');
    const alternateBytes = wrapped.slice(tokens[alternateOpen].range.startOffset, tokens[alternateClose].range.startOffset).trimEnd();
    const exitBytes = wrapped.slice(tokens[exitStart].range.startOffset, tokens[exitEnd].range.endOffset);
    const headerBytes = wrapped.slice(begin, tokens[bodyOpen].range.endOffset);
    const replacement = headerBytes + '\n' + guardIndent + 'if (!(' + predicate + ')) ' + alternateBytes
      + '\n' + guardIndent + '  break;\n' + guardIndent + '}'
      + (armBytes ? '\n' + guardIndent + armBytes : '')
      + '\n' + guardIndent + exitBytes + '\n' + indent + '}';
    const output = wrapped.slice(0, begin) + replacement + wrapped.slice(end);
    return {source: output.slice(2, -2), loopsRecovered: 1, ...(retainDiagnostics ? {diagnostics: {
      label: label?.label || null, predicate,
      loopRange: {start: begin - 2, end: end - 2},
      headerRange: {start: begin - 2, end: tokens[bodyOpen].range.endOffset - 2},
      conditionRange: {start: conditionStart - 2, end: conditionEnd - 2},
      armRange: {start: tokens[armOpen].range.endOffset - 2, end: tokens[armClose].range.startOffset - 2},
      alternateRange: {start: tokens[alternateOpen].range.startOffset - 2, end: tokens[alternateClose].range.startOffset - 2},
      exitRange: {start: tokens[exitStart].range.startOffset - 2, end: tokens[exitEnd].range.endOffset - 2},
    }} : {})};
  }
  if (form === 'nonlocalExit') {
    const {jump} = candidate;
    const start = starts.get(node.range.startOffset), bodyOpen = start + 4, bodyClose = closes.get(bodyOpen);
    const rangeStart = label ? starts.get(label.range.startOffset) : start;
    const first = starts.get(guard.range.startOffset), conditionClose = closes.get(first + 1);
    const armOpen = conditionClose + 1, armClose = closes.get(armOpen);
    const jumpStart = starts.get(jump.range.startOffset), jumpEnd = ends.get(jump);
    const suffixStart = starts.get(suffix[0].range.startOffset);
    if (tokens[start]?.text !== 'while' || tokens[start + 1]?.text !== '(' || tokens[start + 2]?.text !== 'true'
        || tokens[start + 3]?.text !== ')' || tokens[bodyOpen]?.text !== '{' || tokens[bodyClose]?.text !== '}'
        || first !== bodyOpen + 1 || tokens[first]?.text !== 'if' || tokens[first + 1]?.text !== '('
        || tokens[armOpen]?.text !== '{' || jumpStart !== armOpen + 1 || jumpEnd + 1 !== armClose
        || tokens[armClose]?.text !== '}' || suffixStart !== armClose + 1
        || label && (tokens[rangeStart]?.text !== label.label || tokens[rangeStart + 1]?.text !== ':' || rangeStart + 2 !== start)) return unchanged();
    const indentAt = offset => {
      const prefix = wrapped.slice(wrapped.lastIndexOf('\n', offset - 1) + 1, offset);
      return /^[ \t]*$/.test(prefix) ? prefix : '';
    };
    const indent = indentAt(tokens[rangeStart].range.startOffset);
    const begin = tokens[rangeStart].range.startOffset, end = tokens[bodyClose].range.endOffset;
    const conditionStart = tokens[first + 1].range.endOffset, conditionEnd = tokens[conditionClose].range.startOffset;
    const bodyStart = tokens[suffixStart].range.startOffset, bodyEnd = tokens[bodyClose].range.startOffset;
    const exitStart = tokens[jumpStart].range.startOffset, exitEnd = tokens[jumpEnd].range.endOffset;
    const predicate = wrapped.slice(conditionStart, conditionEnd);
    const bodyBytes = wrapped.slice(tokens[armClose].range.endOffset, bodyEnd).trimEnd();
    const jumpBytes = wrapped.slice(exitStart, exitEnd);
    let replacement = (label ? label.label + ': ' : '') + 'while (!(' + predicate + ')) {'
      + bodyBytes + '\n' + indent + '}\n' + indent + jumpBytes;
    const scalarParentWrapped = parents.get(label || node)?.kind !== 'BlockStatement';
    if (scalarParentWrapped) replacement = '{\n' + replacement + '\n' + indent + '}';
    const output = wrapped.slice(0, begin) + replacement + wrapped.slice(end);
    return {source: output.slice(2, -2), loopsRecovered: 1, ...(retainDiagnostics ? {diagnostics: {
      label: label?.label || null, exitTarget: jump.label, predicate, scalarParentWrapped,
      loopRange: {start: begin - 2, end: end - 2},
      loopKeywordRange: {start: tokens[start].range.startOffset - 2, end: tokens[start].range.endOffset - 2},
      conditionRange: {start: conditionStart - 2, end: conditionEnd - 2},
      bodyRange: {start: bodyStart - 2, end: bodyEnd - 2},
      exitRange: {start: exitStart - 2, end: exitEnd - 2},
    }} : {})};
  }
  if (['exitContinuation', 'terminalTail'].includes(form)) {
    const {prefix, exit} = candidate;
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
    const exitStart = exit ? starts.get(exit.range.startOffset) : bodyClose, exitEnd = exit ? ends.get(exit) : null;
    if (exit && (tokens[exitStart]?.text !== 'break' || tokens[exitEnd]?.text !== ';' || exitEnd + 1 !== bodyClose)) return unchanged();
    let tailBytes = wrapped.slice(tokens[suffixStart].range.startOffset, tokens[exitStart].range.startOffset).trimEnd();
    const retainTailScope = suffix.some(statement => statement.kind === 'LocalVariableDeclarationStatement');
    if (retainTailScope) tailBytes = '{\n' + indent + '  ' + tailBytes + '\n' + indent + '}';
    else {
      const tailIndent = indentAt(tokens[suffixStart].range.startOffset);
      if (tailIndent.startsWith(indent) && tailIndent.length > indent.length)
        tailBytes = tailBytes.split('\n').map((line, index) => index && line.startsWith(tailIndent)
          ? indent + line.slice(tailIndent.length) : line).join('\n');
    }
    // The literal-true header has no effects. Normal prefix completion takes
    // this bare break (the original final exit for terminal tails); existing continues still repeat without executing
    // the continuation. Nonlocal transfers still leave both sections. The
    // suffix remains at exactly the same enclosing protection/monitor depth.
    let replacement = wrapped.slice(tokens[rangeStart].range.startOffset, tokens[bodyOpen].range.endOffset)
      + prefixBytes + '\n' + prefixIndent + (exit ? wrapped.slice(tokens[exitStart].range.startOffset, tokens[exitEnd].range.endOffset) : 'break;')
      + '\n' + indent + '}\n' + indent + tailBytes;
    const scalarParentWrapped = parents.get(label || node)?.kind !== 'BlockStatement';
    if (scalarParentWrapped) replacement = '{\n' + replacement + '\n' + indent + '}';
    const begin = tokens[rangeStart].range.startOffset, end = tokens[bodyClose].range.endOffset;
    const output = wrapped.slice(0, begin) + replacement + wrapped.slice(end);
    return {source: output.slice(2, -2), [counter]: 1, ...(retainDiagnostics ? {diagnostics: {
      label: label?.label || null, retainedTailScope: retainTailScope,
      ...(exit ? {scalarParentWrapped,
        headerRange: {start: begin - 2, end: tokens[bodyOpen].range.endOffset - 2},
        exitRange: {start: tokens[exitStart].range.startOffset - 2, end: tokens[exitEnd].range.endOffset - 2},
        closingBraceRange: {start: tokens[bodyClose].range.startOffset - 2, end: tokens[bodyClose].range.endOffset - 2}} : {}),
      loopRange: {start: begin - 2, end: end - 2},
      prefixRange: {start: tokens[first].range.startOffset - 2, end: tokens[suffixStart].range.startOffset - 2},
      suffixRange: {start: tokens[suffixStart].range.startOffset - 2, end: tokens[exitStart].range.startOffset - 2},
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
    const predicates = [], conditionRanges = [];
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
      conditionRanges.push({start: tokens[begin + 1].range.endOffset - 2, end: tokens[conditionEnd].range.startOffset - 2});
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
    // Retain the original loop label when an intact prefix still breaks to it.
    // Otherwise terminal conversion consumes all references to that label.
    const retainLabel = label && (!candidate.terminalExit || candidate.prefixBreaks.some(reference => reference.label));
    let replacement = (retainLabel ? label.label + ': ' : '') + 'do {' + prefixBytes + '\n' + indent + '} while (' + predicate + ');'
      + (candidate.terminalExit ? '' : '\n' + indent + tailBytes);
    if (parents.get(label || node)?.kind !== 'BlockStatement') replacement = '{\n' + replacement + '\n' + indent + '}';
    const begin = tokens[rangeStart].range.startOffset, end = tokens[bodyClose].range.endOffset;
    const output = wrapped.slice(0, begin) + replacement + wrapped.slice(end);
    return {source: output.slice(2, -2), loopsRecovered: 1, ...(retainDiagnostics ? {diagnostics: {
      label: label?.label || null, predicates, conditionRanges, retainedTailScope: retainTailScope,
      ...(candidate.terminalExit ? {form: 'doWhile', terminalBareBreakRemoved: true,
        removedLoopLabel: retainLabel ? null : label?.label || null,
        retainedPrefixBreakRanges: candidate.prefixBreaks.map(jump => ({start: jump.range.startOffset - 2, end: tokens[ends.get(jump)].range.endOffset - 2}))} : {}),
      loopRange: {start: begin - 2, end: end - 2},
      loopKeywordRange: {start: tokens[start].range.startOffset - 2, end: tokens[start].range.endOffset - 2},
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

function foldNonlocalLoopExits(source, proof, options) {
  return recoverLoopForms(source, proof, options, 'nonlocalExit');
}

function foldLoopElseExitGuards(source, proof, options) {
  return recoverLoopForms(source, proof, options, 'elseExitGuard');
}

function foldTerminalLoopTails(source, proof, options) {
  return recoverLoopForms(source, proof, options, 'terminalTail');
}

function foldNaturalLoopExits(source, proof, options) {
  return recoverLoopForms(source, proof, options, 'naturalExits');
}

module.exports = {foldNaturalLoopExits, foldTerminalLoopTails, foldLoopElseExitGuards, foldGuardedLoopContinuations, foldNonrepeatingWhileLoops, foldTrailingLoopContinuations, foldLoopExitContinuations, foldTerminalLoopExits, foldNonlocalLoopExits};
