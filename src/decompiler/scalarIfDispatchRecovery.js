'use strict';

// A captured primitive integer can classify a transparent if ladder once.
// Keep all effectful actions and flag guards, in their original lexical order.
// Accept only paths that are contiguous runs or leave the existing plain label;
// never duplicate a shared action or assume another guard's value.
function recoverScalarIfDispatches(source, proof, {retainDiagnostics = false, nestedRegions = false, switchPrefixes = false, opaqueControls = false} = {}) {
  const unchanged = () => ({source, dispatchesRecovered: 0});
  if (!proof || typeof retainDiagnostics !== 'boolean' || typeof nestedRegions !== 'boolean' || typeof switchPrefixes !== 'boolean' || typeof opaqueControls !== 'boolean'
      || source.length > 400000) return unchanged();
  const {wrapped, parsed, tokens, starts, closes, children, labelCounts} = proof;
  const loops = new Set(['WhileStatement', 'ForStatement', 'DoWhileStatement', 'EnhancedForStatement']);
  const parents = new Map(), targets = new Map(), locals = new Map(), names = new Map(), ends = new Map();
  const statementStarts = new Set();
  const walk = (node, visit) => { visit(node); children(node, child => walk(child, visit)); };
  walk(parsed, node => { if (node.kind?.endsWith('Statement') && node.range) statementStarts.add(node.range.startOffset); });
  let invalid = false;
  const strip = node => { while (node?.kind === 'ParenthesizedExpression') node = node.expression; return node; };
  function semicolon(node) {
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
  function inspect(node, parent, labels = [], breakFrames = [], activeLoops = []) {
    parents.set(node, parent);
    if (/ClassDeclaration|InterfaceDeclaration|EnumDeclaration|RecordDeclaration|MethodDeclaration|ConstructorDeclaration|LambdaExpression|MemberReference|MethodReference|AnonymousClass|Pattern/.test(node.kind || '')
        || node.kind === 'NewClassExpression' && node.body != null) invalid = true;
    if (['VariableDeclarator', 'FormalParameter'].includes(node.kind)) names.set(node.name, (names.get(node.name) || 0) + 1);
    if (node.kind === 'LocalVariableDeclarationStatement' && parent?.kind === 'BlockStatement'
        && node.variableType?.kind === 'PrimitiveType' && node.variableType.name === 'int' && !node.annotations?.length) {
      // Some protected block nodes have no source range. A declaration whose
      // AST parent is a block still has exactly one nearest enclosing brace
      // pair. Recover that lexical scope without inventing a type or lifetime.
      let open = starts.get(parent.range?.startOffset);
      if (open === undefined && opaqueControls) {
        const first = starts.get(node.range?.startOffset);
        for (const [begin, end] of closes)
          if (tokens[begin].text === '{' && begin < first && first < end
              && (open === undefined || begin > open)) open = begin;
      }
      const close = closes.get(open), end = semicolon(node);
      if (close !== undefined && end !== null) for (const variable of node.declarators)
        if (!variable.dimensions) locals.set(variable.name, {start: tokens[end].range.endOffset, end: tokens[close].range.startOffset});
    }
    if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      const target = node.label ? labels.slice().reverse().find(label => label.label === node.label)
        : node.kind === 'ContinueStatement' ? activeLoops.at(-1) : breakFrames.at(-1);
      const first = starts.get(node.range?.startOffset);
      if (!target || node.kind === 'ContinueStatement' && !(loops.has(target.kind) || loops.has(target.statement?.kind))
          || tokens[first]?.text !== (node.kind === 'BreakStatement' ? 'break' : 'continue')
          || node.label && tokens[first + 1]?.text !== node.label
          || tokens[first + (node.label ? 2 : 1)]?.text !== ';') invalid = true;
      else targets.set(node, target);
    }
    if (['ExpressionStatement', 'ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement', 'AssertStatement'].includes(node.kind)) {
      const end = semicolon(node); if (end === null) invalid = true; else ends.set(node, end);
    }
    if (node.kind === 'ExpressionStatement' && !['AssignmentExpression', 'MethodInvocationExpression', 'NewClassExpression'].includes(node.expression?.kind)
        && !(node.expression?.kind === 'UnaryExpression' && ['++', '--'].includes(node.expression.operator))) invalid = true;
    children(node, child => inspect(child, node,
      node.kind === 'LabeledStatement' ? [...labels, node] : labels,
      loops.has(node.kind) || node.kind === 'SwitchStatement' ? [...breakFrames, node] : breakFrames,
      loops.has(node.kind) ? [...activeLoops, node] : activeLoops));
  }
  inspect(parsed, null);
  if (invalid || [...labelCounts.values()].some(count => count !== 1)) return unchanged();
  function finish(node) {
    if (ends.has(node)) return ends.get(node);
    const first = starts.get(node.range?.startOffset);
    if (node.kind === 'BlockStatement') return closes.get(first);
    if (node.kind === 'EmptyStatement') return tokens[first]?.text === ';' ? first : null;
    if (node.kind === 'IfStatement') return finish(node.alternate || node.consequent);
    if (node.kind === 'SynchronizedStatement') return closes.get(closes.get(first + 1) + 1);
    if (node.kind === 'SwitchStatement' && opaqueControls) {
      const open = closes.get(first + 1) + 1, end = closes.get(open);
      if (tokens[first]?.text !== 'switch' || tokens[open]?.text !== '{' || tokens[end]?.text !== '}'
          || (node.groups || []).some(g => g.labels.some(l => l.separator !== ':'))) return null;
      return end;
    }
    if (node.kind === 'TryStatement') {
      let end = closes.get(first + 1);
      if (tokens[first + 1]?.text !== '{' || end === undefined) return null;
      for (const clause of node.catches || []) {
        if (tokens[end + 1]?.text !== 'catch') return null;
        end = closes.get(closes.get(end + 2) + 1);
        if (end === undefined) return null;
      }
      if (node.finallyBlock) {
        if (tokens[end + 1]?.text !== 'finally') return null;
        end = closes.get(end + 2);
      }
      return end;
    }
    return null;
  }
  function normal(node) {
    if (!node) return true;
    if (['BreakStatement', 'ContinueStatement', 'ReturnStatement', 'ThrowStatement'].includes(node.kind)) return false;
    if (node.kind === 'IfStatement') { const yes = normal(node.consequent), no = normal(node.alternate); return yes || no; }
    if (node.kind === 'BlockStatement') {
      let reachable = true;
      for (const statement of node.statements) {
        if (!reachable) { invalid = true; return false; }
        reachable = normal(statement);
      }
      return reachable;
    }
    if (node.kind === 'TryStatement') {
      const body = normal(node.block), catches = (node.catches || []).map(clause => normal(clause.body));
      const final = !node.finallyBlock || normal(node.finallyBlock);
      return final && (body || catches.some(Boolean));
    }
    if (node.kind === 'SynchronizedStatement') return normal(node.body);
    if (node.kind === 'LabeledStatement') return normal(node.statement) || exitsTarget(node.statement, node);
    if (node.kind === 'SwitchStatement' && opaqueControls) {
      const groups = node.groups || [];
      if (!groups.some(g => g.labels.some(l => l.labelKind === 'default'))) return true;
      for (let index = 0; index < groups.length; index++) {
        let reachable = true;
        for (const statement of groups[index].statements) {
          if (!reachable) { invalid = true; return false; }
          if (exitsTarget(statement, node)) return true;
          reachable = normal(statement);
        }
        if (reachable && index === groups.length - 1) return true;
      }
      return false;
    }
    return true;
  }
  // A break can complete its exact lexical target, including a plain label.
  // An abrupt finally can override that pending completion. Keep distinct
  // targets through nested control frames rather than inferring from spelling.
  function exitsTarget(node, target) {
    if (!node) return false;
    if (node.kind === 'BreakStatement') return targets.get(node) === target;
    if (node.kind === 'BlockStatement') {
      for (const statement of node.statements) {
        if (exitsTarget(statement, target)) return true;
        if (!normal(statement)) break;
      }
      return false;
    }
    if (node.kind === 'IfStatement') return exitsTarget(node.consequent, target) || exitsTarget(node.alternate, target);
    if (node.kind === 'SynchronizedStatement') return exitsTarget(node.body, target);
    if (node.kind === 'LabeledStatement') return exitsTarget(node.statement, target);
    if (loops.has(node.kind)) return exitsTarget(node.body, target);
    if (node.kind === 'SwitchStatement') return (node.groups || []).some(group => {
      for (const statement of group.statements) {
        if (exitsTarget(statement, target)) return true;
        if (!normal(statement)) break;
      }
      return false;
    });
    if (node.kind === 'TryStatement') return exitsTarget(node.finallyBlock, target)
      || (!node.finallyBlock || normal(node.finallyBlock)) &&
        (exitsTarget(node.block, target) || (node.catches || []).some(clause => exitsTarget(clause.body, target)));
    return false;
  }
  function comparison(node) {
    node = strip(node); let negate = false;
    while (node?.kind === 'UnaryExpression' && node.operator === '!') { negate = !negate; node = strip(node.expression || node.operand); }
    if (node?.kind !== 'BinaryExpression' || !['==', '!='].includes(node.operator)) return null;
    let id = strip(node.left), value = strip(node.right);
    if (id?.kind !== 'Identifier') { id = strip(node.right); value = strip(node.left); }
    let sign = 1;
    if (value?.kind === 'UnaryExpression' && ['+', '-'].includes(value.operator)) {
      sign = value.operator === '-' ? -1 : 1; value = strip(value.expression || value.operand);
    }
    if (id?.kind !== 'Identifier' || value?.kind !== 'LiteralExpression' || !/^(?:0|[1-9][0-9]*)$/.test(value.raw || '')) return null;
    const number = sign * Number(value.raw);
    if (number < -2147483648 || number > 2147483647) return null;
    return {name: id.name, value: number, equal: (node.operator === '==') !== negate, identifier: id};
  }
  const extent = node => {
    const first = starts.get(node?.range?.startOffset), last = finish(node);
    return first !== undefined && last !== null && last !== undefined ? {first, last,
      start: tokens[first].range.startOffset, end: tokens[last].range.endOffset} : null;
  };
  function switchShape(node) {
    if (node?.kind !== 'SwitchStatement') return null;
    const selector = strip(node.expression), local = locals.get(selector?.name), bounds = extent(node);
    if (selector?.kind !== 'Identifier' || names.get(selector.name) !== 1 || !local || !bounds
        || bounds.start < local.start || bounds.end > local.end) return null;
    const header = closes.get(bounds.first + 1), open = header + 1, close = closes.get(open);
    if (tokens[open]?.text !== '{' || close !== bounds.last || bounds.end - bounds.start > 40000) return null;
    const values = new Set(); let defaults = 0;
    for (const group of node.groups || []) for (const label of group.labels || []) {
      if (label.separator !== ':') return null;
      if (label.labelKind === 'default') {if (++defaults > 1) return null;continue;}
      const value = comparison({kind:'BinaryExpression',operator:'==',left:selector,right:label.expression});
      if (!value || values.has(value.value)) return null;
      values.add(value.value);
    }
    return values.size <= 64 ? {...bounds, node, name:selector.name, local, open, close, values} : null;
  }
  function stableCompletion(node) {
    let safe = true;
    walk(node, child => {
      if (!loops.has(child.kind)) return;
      if (child.kind === 'EnhancedForStatement') return;
      let dynamic = false;
      if (child.condition) walk(child.condition, value => {if (value.kind === 'MethodInvocationExpression') dynamic = true;});
      if (!dynamic || child.kind === 'DoWhileStatement') safe = false;
    });
    return safe;
  }
  const sequenceNormal = statements => {
    let reachable = true;
    for (const statement of statements) {
      if (!reachable) {invalid = true;return false;}
      reachable = normal(statement);
    }
    return reachable;
  };
  const replaceRegion = (start, end, text, kind) => ({
    source: (wrapped.slice(0, start) + text + wrapped.slice(end)).slice(2, -2), dispatchesRecovered: 1,
    ...(retainDiagnostics ? {diagnostics:{kind, regionRange:{start:start-2,end:end-2}}} : {}),
  });
  if (opaqueControls && !switchPrefixes) {
    // The comparison and switch both read one primitive local without any
    // intervening work. Add the equality arm as a scoped case before all old
    // cases, so old fallthrough can never enter it. Its source block is kept.
    let guarded = null;
    walk(parsed, node => {
      if (guarded || node.kind !== 'IfStatement' || !node.alternate) return;
      const test = comparison(node.condition);
      if (!test) return;
      const branch = test.equal ? node.alternate : node.consequent,
        action = test.equal ? node.consequent : node.alternate;
      const only = branch?.kind === 'BlockStatement' && branch.statements.length === 1 && branch.statements[0];
      const inner = switchShape(only), outer = extent(node), work = extent(action);
      if (!inner || inner.name !== test.name || !outer || !work || inner.values.has(test.value)
          || inner.values.size >= 64 || outer.start < inner.local.start || outer.end > inner.local.end
          || outer.end - outer.start > 40000 || !stableCompletion(action)) return;
      let retargeted = false;
      walk(action, child => {
        if (child.kind !== 'BreakStatement' || child.label) return;
        let target = targets.get(child);
        while (target && target !== action) target = parents.get(target);
        if (target !== action) retargeted = true;
      });
      if (retargeted) return;
      const completes = normal(action);
      if (invalid) return;
      const actionBytes = wrapped.slice(work.start, work.end), scoped = action.kind === 'BlockStatement'
        ? actionBytes : '{\n' + actionBytes + '\n}';
      guarded = {outer, text: wrapped.slice(inner.start, tokens[inner.open].range.endOffset)
        + '\ncase ' + test.value + ': ' + scoped + (completes ? '\nbreak;' : '') + '\n'
        + wrapped.slice(tokens[inner.open].range.endOffset, inner.end)};
    });
    if (guarded && !invalid) return replaceRegion(guarded.outer.start, guarded.outer.end, guarded.text, 'guarded-switch');

    // A default containing only another switch of the same local and its own
    // outer break is a transparent dispatch layer. Preserve the inner groups
    // in place, forbid incoming fallthrough and overlapping case values, and
    // prevent the final inner group from falling into a later outer group.
    let nested = null;
    walk(parsed, node => {
      if (nested) return;
      const outer = switchShape(node);
      if (!outer) return;
      for (const [index, group] of (node.groups || []).entries()) {
        if (group.labels?.length !== 1 || group.labels[0].labelKind !== 'default' || group.statements?.length !== 2) continue;
        const [innerNode, exit] = group.statements, inner = switchShape(innerNode), end = extent(exit);
        if (!inner || inner.name !== outer.name || !end || exit.kind !== 'BreakStatement' || exit.label
            || targets.get(exit) !== node || [...inner.values].some(value => outer.values.has(value))
            || inner.values.size + outer.values.size > 64) continue;
        // Removing the inner switch must not widen any case-sibling binding.
        if ((innerNode.groups || []).some(g => g.statements.some(s => s.kind === 'LocalVariableDeclarationStatement'))) continue;
        if (index && sequenceNormal(node.groups[index - 1].statements)) continue;
        const last = innerNode.groups?.at(-1);
        if (last && !last.statements.every(stableCompletion)) continue;
        const completes = last && sequenceNormal(last.statements);
        if (invalid) return;
        const before = starts.get(innerNode.range.startOffset) - 1;
        if (tokens[before]?.text !== ':' || tokens[before - 1]?.text !== 'default') continue;
        const start = tokens[before - 1].range.startOffset;
        nested = {start, end:end.end, text:wrapped.slice(tokens[inner.open].range.endOffset, tokens[inner.close].range.startOffset)
          + (completes ? '\nbreak;' : '')};
        break;
      }
    });
    if (nested && !invalid) return replaceRegion(nested.start, nested.end, nested.text, 'default-switch');
  }
  if (switchPrefixes) {
    let chosen;
    walk(parsed, block => {
      if (chosen || block.kind !== 'BlockStatement') return;
      for (let index = 1; index < block.statements.length; index++) {
        const node = block.statements[index];
        if (node.kind !== 'SwitchStatement') continue;
        const selector = strip(node.expression), local = locals.get(selector?.name);
        const first = starts.get(node.range?.startOffset), headerEnd = closes.get(first + 1), open = headerEnd + 1, close = closes.get(open);
        if (selector?.kind !== 'Identifier' || names.get(selector.name) !== 1 || !local
            || tokens[first]?.text !== 'switch' || tokens[open]?.text !== '{' || tokens[close]?.text !== '}'
            || tokens[close].range.endOffset > local.end) continue;
        const values = new Set(); let uncertain = false, defaults = 0;
        for (const group of node.groups || []) for (const label of group.labels || []) {
          if (label.separator !== ':') uncertain = true;
          if (label.labelKind === 'default') { if (++defaults > 1) uncertain = true; continue; }
          const value = comparison({kind:'BinaryExpression',operator:'==',left:selector,right:label.expression});
          if (!value || values.has(value.value)) uncertain = true; else values.add(value.value);
        }
        if (uncertain || values.size > 64) continue;
        const arms = [];let begin = index;
        while (begin > 0) {
          const branch = block.statements[begin - 1], test = branch.kind === 'IfStatement' && comparison(branch.condition);
          if (!test?.equal || test.name !== selector.name || branch.alternate || branch.consequent?.kind !== 'BlockStatement') break;
          if (values.has(test.value)) { uncertain = true; break; }
          let unsafe = false;
          walk(branch.consequent, child => {
            // A bare break outside an inner frame would now exit the switch.
            // Keep the conservative refusal even for inner bare breaks here.
            if (child.kind === 'BreakStatement' && !child.label) unsafe = true;
            const operand = strip(child.kind === 'AssignmentExpression' ? child.left
              : child.kind === 'UnaryExpression' && ['++','--'].includes(child.operator) ? child.expression || child.operand : null);
            if (operand?.kind === 'Identifier' && operand.name === selector.name) unsafe = true;
          });
          if (unsafe || normal(branch.consequent) || invalid) { uncertain = true; break; }
          const start = starts.get(branch.range.startOffset), end = closes.get(start + 1);
          const body = starts.get(branch.consequent.range.startOffset), bodyEnd = closes.get(body);
          if (tokens[start]?.text !== 'if' || tokens[body]?.text !== '{' || tokens[bodyEnd]?.text !== '}'
              || body !== end + 1 || tokens[start].range.startOffset < local.start) { uncertain = true; break; }
          const scoped = branch.consequent.statements.some(statement => statement.kind === 'LocalVariableDeclarationStatement');
          arms.unshift({value:test.value,condition:{start:tokens[start+1].range.endOffset-2,end:tokens[end].range.startOffset-2},
            range:{start:tokens[scoped?body:body+1].range.startOffset-2,end:tokens[scoped?bodyEnd:bodyEnd-1].range.endOffset-2},
            scoped, first: scoped ? body : body+1});
          values.add(test.value);begin--;
          if (arms.length > 32 || values.size > 64) { uncertain=true;break; }
        }
        if (uncertain || !arms.length || invalid) continue;
        const start = starts.get(block.statements[begin].range.startOffset);
        if (tokens[close].range.endOffset - tokens[start].range.startOffset > 40000) continue;
        const identifiers = tokens.slice(first+2,headerEnd).filter(token => token.kind==='identifier' && token.text===selector.name);
        if (identifiers.length!==1) continue;
        chosen={arms,start,first,open,close,selector:selector.name,selectorOrigin:identifiers[0].range.startOffset-2};break;
      }
    });
    if (!chosen || invalid) return unchanged();
    const {arms,start,first,open,close,selector,selectorOrigin}=chosen;
    const line = wrapped.slice(wrapped.lastIndexOf('\n',tokens[start].range.startOffset-1)+1,tokens[start].range.startOffset);
    const indent = (line.match(/^[ \t]*/)||[''])[0];
    const header = wrapped.slice(tokens[first].range.startOffset,tokens[open].range.endOffset),chunks=[header];
    for(const arm of arms){
      const bytes=source.slice(arm.range.start,arm.range.end);
      const oldIndent=wrapped.slice(wrapped.lastIndexOf('\n',tokens[arm.first].range.startOffset-1)+1,tokens[arm.first].range.startOffset);
      const body=bytes.split('\n').map((line,index)=>index && /^[ \t]*$/.test(oldIndent) && line.startsWith(oldIndent)?indent+'    '+line.slice(oldIndent.length):line).join('\n');
      chunks.push(indent+'  case '+arm.value+':'+(arm.scoped?' '+body:'\n'+indent+'    '+body));
    }
    const tail=wrapped.slice(tokens[open].range.endOffset,tokens[close].range.startOffset);
    const oldSwitchIndent=wrapped.slice(wrapped.lastIndexOf('\n',tokens[first].range.startOffset-1)+1,tokens[first].range.startOffset);
    chunks.push(tail.split('\n').map((line,index)=>index && /^[ \t]*$/.test(oldSwitchIndent) && line.startsWith(oldSwitchIndent)?indent+line.slice(oldSwitchIndent.length):line).join('\n').replace(/^[ \t]*\r?\n/,'').trimEnd(),indent+'}');
    const output=wrapped.slice(0,tokens[start].range.startOffset)+chunks.join('\n')+wrapped.slice(tokens[close].range.endOffset);
    return {source:output.slice(2,-2),dispatchesRecovered:1,comparisonsRemoved:arms.length,blocksUnwrapped:arms.filter(arm=>!arm.scoped).length,
      ...(retainDiagnostics?{diagnostics:{selector,selectorOrigin,regionRange:{start:tokens[start].range.startOffset-2,end:tokens[close].range.endOffset-2},
        headerRange:{start:tokens[first].range.startOffset-2,end:tokens[open].range.endOffset-2},
        tailRange:{start:tokens[open].range.endOffset-2,end:tokens[close].range.endOffset-2},
        conditionRanges:arms.map(arm=>arm.condition),actions:arms.map(arm=>({range:arm.range,cases:[arm.value],scoped:arm.scoped}))}}:{})};
  }
  function candidate(frame, block = frame.statement, offset) {
    if (frame.kind !== 'LabeledStatement' || frame.statement?.kind !== 'BlockStatement'
        || block?.kind !== 'BlockStatement') return null;
    const open = starts.get(block.range?.startOffset), close = closes.get(open);
    if (tokens[open]?.text !== '{' || tokens[close]?.text !== '}'
        || tokens[close].range.endOffset - tokens[open].range.startOffset > 40000) return null;
    let first = offset ?? 0;
    if (offset === undefined) while (['ExpressionStatement', 'EmptyStatement'].includes(block.statements[first]?.kind)) first++;
    const initial = block.statements[first], initialTest = initial?.kind === 'IfStatement' && comparison(initial.condition);
    if (!initialTest) return null;
    // The prefix stays byte-for-byte in place, outside the new switch. Its
    // declarations, switches, loop exits and selector writes therefore keep
    // their scopes/destinations. Only the selected suffix is classified.
    const dispatch = {kind: 'BlockStatement', statements: block.statements.slice(first)};
    let refused = false;
    const classifiers = new Map();
    walk(dispatch, node => {
      // Do not merge declaration scopes or change destinations of bare breaks.
      // Inner control frames are opaque until a separate proof supports them.
      if (node.kind === 'LabeledStatement' || !opaqueControls &&
          (node.kind === 'LocalVariableDeclarationStatement' || node.kind === 'SwitchStatement' || loops.has(node.kind) || node.kind === 'BreakStatement' && !node.label)) refused = true;
      if (opaqueControls && loops.has(node.kind)) {
        // Only preserve opaque loops with a nonconstant runtime condition.
        // A method call cannot be a Java constant expression; unconditional
        // loops need a separate completion proof before adding switch exits.
        let dynamic = false;
        if (node.condition) walk(node.condition, child => {
          if (child.kind === 'MethodInvocationExpression') dynamic = true;
        });
        if (!dynamic || node.kind === 'DoWhileStatement') refused = true;
      }
      if (node.kind === 'IfStatement') {
        const test = comparison(node.condition), local = locals.get(test?.name);
        if (test && names.get(test.name) === 1 && local && initial.range.startOffset >= local.start
            && tokens[close].range.endOffset <= local.end) {
          if (!classifiers.has(test.name)) classifiers.set(test.name, new Set());
          classifiers.get(test.name).add(test.value);
        }
      }
    });
    if (refused) return null;
    for (const [name, values] of classifiers) {
      if (values.size < 3 || values.size > 16) continue;
      if (!initialTest || initialTest.name !== name) continue;
      const prefixEnd = tokens[starts.get(initial.range.startOffset)].range.startOffset;
      const actions = [], conditions = [];
      function build(node, depth = 0) {
        if (!node) return {sequence: []};
        if (depth > 32 || actions.length > 128 || conditions.length > 32) return null;
        if (node.kind === 'BlockStatement') {
          const sequence = node.statements.map(statement => build(statement, depth + 1));
          return sequence.every(Boolean) ? {sequence} : null;
        }
        const test = node.kind === 'IfStatement' && comparison(node.condition);
        if (test && test.name === name) {
          const first = starts.get(node.range.startOffset), conditionEnd = closes.get(first + 1);
          if (tokens[first]?.text !== 'if' || conditionEnd === undefined) return null;
          const identifiers = tokens.slice(first + 2, conditionEnd).filter(token => token.kind === 'identifier' && token.text === name);
          if (identifiers.length !== 1) return null;
          conditions.push({start: tokens[first + 1].range.endOffset, end: tokens[conditionEnd].range.startOffset,
            identifierStart: identifiers[0].range.startOffset, value: test.value});
          const yes = build(node.consequent, depth + 1), no = build(node.alternate, depth + 1);
          return yes && no ? {test, yes, no} : null;
        }
        // Direct declarations would lose their old block scope. Declarations
        // inside an opaque action keep that action's complete original bytes.
        if (node.kind === 'LocalVariableDeclarationStatement') return null;
        const end = finish(node), first = starts.get(node.range?.startOffset);
        if (end == null || first === undefined) return null;
        if (opaqueControls) {
          let changedTarget = false;
          walk(node, child => {
            if (child.kind !== 'BreakStatement' || child.label) return;
            let target = targets.get(child);
            while (target && target !== node) target = parents.get(target);
            if (target !== node) changedTarget = true;
          });
          if (changedTarget) return null;
        }
        let writesSelector = false;
        walk(node, child => {
          const operand = strip(child.kind === 'AssignmentExpression' ? child.left
            : child.kind === 'UnaryExpression' && ['++', '--'].includes(child.operator) ? child.expression || child.operand : null);
          if (operand?.kind === 'Identifier' && operand.name === name) writesSelector = true;
        });
        const action = {node, first, end, normal: normal(node), writesSelector,
          ownExit: node.kind === 'BreakStatement' && targets.get(node) === frame};
        actions.push(action); return {action: actions.length - 1};
      }
      normal(dispatch);
      const tree = build(dispatch);
      if (!tree || invalid || conditions.length < 3 || conditions.length > 32 || actions.length > 128) continue;
      // A local can be reused as scratch inside an action after classification.
      // Propagate later classifier tests backward through normal completions.
      // An action that may write before such a test must retain the old ladder.
      let unsafeWrite = false;
      function laterTests(tree, following) {
        if (tree.action !== undefined) {
          const action = actions[tree.action];
          if (action.writesSelector && action.normal && following) unsafeWrite = true;
          return action.normal && following;
        }
        if (tree.test) {laterTests(tree.yes, following);laterTests(tree.no, following);return true;}
        let next = following;
        for (let index = tree.sequence.length - 1; index >= 0; index--) next = laterTests(tree.sequence[index], next);
        return next;
      }
      laterTests(tree, false);
      if (unsafeWrite) continue;
      function path(tree, value, result) {
        if (tree.action !== undefined) {
          result.push(tree.action); return actions[tree.action].normal;
        }
        if (tree.test) return path((value === tree.test.value) === tree.test.equal ? tree.yes : tree.no, value, result);
        for (const child of tree.sequence) if (!path(child, value, result)) return false;
        return true;
      }
      let other = -1; while (values.has(other)) other--;
      const paths = [...values, other].map(value => { const steps = []; path(tree, value, steps); return {value, steps, default: value === other}; });
      const used = new Set(paths.flatMap(path => path.steps));
      if (used.size !== actions.length) continue; // retain even syntactically dead work
      const nexts = actions.map(() => new Set()), entries = actions.map(() => []), empty = [];
      for (const p of paths) {
        if (!p.steps.length) empty.push(p); else entries[p.steps[0]].push(p);
        p.steps.forEach((step, index) => {
          if (actions[step].normal) nexts[step].add(p.steps[index + 1] ?? -1);
        });
      }
      const cuts = new Set(); let compatible = true;
      for (let index = 0; index < actions.length; index++) {
        if (!actions[index].normal) continue;
        const successors = nexts[index];
        if (successors.size === 1 && successors.has(index + 1)) continue;
        // Skipping only a bare break to this plain frame is equivalent to
        // leaving the new switch and falling straight out of that frame.
        if ([...successors].every(next => next === -1 || actions[next]?.ownExit)) cuts.add(index);
        else { compatible = false; break; }
      }
      // Every cut starts a new case entry. Otherwise Java fallthrough would
      // accidentally reach work that an original path never selected.
      for (let index = 1; index < actions.length; index++)
        if ((!actions[index - 1].normal || cuts.has(index - 1)) && !entries[index].length) compatible = false;
      if (!compatible) continue;
      return {frame, open, close, name, prefixEnd, actions, conditions, entries, empty, cuts};
    }
    return null;
  }
  let selected;
  walk(parsed, node => { if (!selected) selected = candidate(node); });
  if (!selected && nestedRegions) {
    let attempts = 0;
    walk(parsed, block => {
      if (selected || attempts >= 128 || block.kind !== 'BlockStatement') return;
      let frame = parents.get(block);
      while (frame && !(frame.kind === 'LabeledStatement' && frame.statement?.kind === 'BlockStatement')) frame = parents.get(frame);
      if (!frame) return;
      for (let index = 0; index < block.statements.length && !selected && attempts < 128; index++) {
        const node = block.statements[index];
        if (node.kind !== 'IfStatement' || !comparison(node.condition)) continue;
        attempts++;
        selected = candidate(frame, block, index);
      }
    });
  }
  if (!selected) return unchanged();
  const {frame, open, close, name, prefixEnd, actions, conditions, entries, empty, cuts} = selected;
  const begin = tokens[open].range.endOffset, end = tokens[close].range.startOffset;
  const line = wrapped.slice(wrapped.lastIndexOf('\n', tokens[open].range.startOffset - 1) + 1, tokens[open].range.startOffset);
  const indent = (line.match(/^[ \t]*/) || [''])[0] + '  ';
  const chunks = [wrapped.slice(begin, prefixEnd).trimEnd() + '\n' + indent + 'switch (' + name + ') {'];
  const labels = entries => entries.map(p => indent + '  ' + (p.default ? 'default:' : 'case ' + p.value + ':'));
  for (let index = 0; index < actions.length; index++) {
    chunks.push(...labels(entries[index]));
    const action = actions[index], bytes = wrapped.slice(tokens[action.first].range.startOffset, tokens[action.end].range.endOffset);
    const originalIndent = wrapped.slice(wrapped.lastIndexOf('\n', tokens[action.first].range.startOffset - 1) + 1, tokens[action.first].range.startOffset);
    chunks.push(indent + '    ' + bytes.split('\n').map((line, offset) => offset && /^[ \t]*$/.test(originalIndent) && line.startsWith(originalIndent)
      ? indent + '    ' + line.slice(originalIndent.length) : line).join('\n'));
    if (cuts.has(index)) chunks.push(indent + '    break;');
  }
  if (empty.length) chunks.push(...labels(empty), indent + '    break;');
  chunks.push(indent + '}', indent.slice(0, -2));
  const output = wrapped.slice(0, begin) + chunks.join('\n') + wrapped.slice(end);
  return {source: output.slice(2, -2), dispatchesRecovered: 1, ...(retainDiagnostics ? {diagnostics: {
    label: frame.label, selector: name, regionRange: {start: begin - 2, end: end - 2},
    prefixRange: {start: begin - 2, end: prefixEnd - 2},
    selectorOrigin: conditions[0].identifierStart - 2,
    conditionRanges: conditions.map(condition => ({start: condition.start - 2, end: condition.end - 2})),
    actions: actions.map((action, index) => ({range: {start: tokens[action.first].range.startOffset - 2, end: tokens[action.end].range.endOffset - 2},
      cases: entries[index].filter(p => !p.default).map(p => p.value), default: entries[index].some(p => p.default), exitAdded: cuts.has(index)})),
    emptyCases: empty.filter(p => !p.default).map(p => p.value), emptyDefault: empty.some(p => p.default),
  }} : {})};
}

module.exports = {recoverScalarIfDispatches};
