'use strict';

const {JavaParser} = require('../java-frontend/parser');
const {tokenizeJava} = require('../java-frontend/lexer');

// Outline complete Java statements, retaining their original source bytes.
// Cross-method state consists only of promoted JVM locals and parameters.
// Calls remain in their original protected scopes; helper throws declarations
// reproduce those scopes' catch alternatives and the method's declared throws.
function partitionStructuredVoidBody(lines, options) {
  const {parameters, throwsTypes, parseDeclarations, stripDeclarationType, typeFromAst} = options;
  const requestedBudget = options.sourceBudget ?? 24000;
  if (!Number.isInteger(requestedBudget) || requestedBudget < 1) return null;
  const budget = Math.min(requestedBudget, 24000);
  const fields = new Map();
  const initializers = [];
  let first = 0;
  for (; first < lines.length; first++) {
    const declarations = parseDeclarations(lines[first]);
    if (declarations.length !== 1 || declarations[0].inCatch || declarations[0].inFor) break;
    const {type, name} = declarations[0];
    const match = /^\s*(.+?)\s+([A-Za-z_$][\w$]*)(?:\s*=\s*(.*))?;\s*$/.exec(lines[first]);
    if (!match || match[2] !== name || match[1].trim() !== type) return null;
    if (fields.has(name)) break; // a lazily emitted first store, demoted below
    fields.set(name, type);
    if (match[3] != null) initializers.push(`this.${name} = ${match[3]};`);
  }
  if (fields.has('finished') || parameters.some(param => param.name === 'finished')) return null;
  if (new Set([...fields.keys(), ...parameters.map(param => param.name)]).size !== fields.size + parameters.length)
    return null;
  const body = [];
  for (const line of lines.slice(first)) {
    const declarations = parseDeclarations(line);
    const promoted = declarations.filter(item => fields.has(item.name));
    if (!promoted.length) { body.push(line); continue; }
    if (declarations.length !== 1 || promoted[0].inCatch || promoted[0].inResource ||
        promoted[0].type !== fields.get(promoted[0].name)) return null;
    if (!promoted[0].initialized) continue;
    const assignment = stripDeclarationType(line, promoted[0].name, promoted[0].inFor);
    if (assignment === line) return null;
    body.push(assignment);
  }
  const source = `{\n${body.join('\n')}\n}`;
  let tree, tokens;
  try {
    tree = new JavaParser().parseStatement(source);
    ({tokens} = tokenizeJava(source));
  } catch (error) {
    options.onFailure?.(error.message);
    return null;
  }
  const pairs = new Map(), stack = [], indices = new Map();
  for (let i = 0; i < tokens.length; i++) {
    indices.set(tokens[i].range.startOffset, i);
    if (['(', '[', '{'].includes(tokens[i].text)) stack.push(i);
    else if ([')', ']', '}'].includes(tokens[i].text)) {
      const open = stack.pop();
      if (open == null || '([{'.indexOf(tokens[open].text) !== ')]}'.indexOf(tokens[i].text)) return null;
      pairs.set(open, i);
    }
  }
  if (stack.length) return null;
  const spans = new Map(), edits = [], helpers = [];
  const startOf = node => indices.get(node.range?.startOffset);
  const children = node => Object.entries(node).filter(([key]) => !['range', 'tokens', 'meta'].includes(key))
    .flatMap(([, value]) => Array.isArray(value) ? value : [value])
    .filter(value => value && typeof value === 'object' && value.kind);
  const walk = (node, visitor) => { visitor(node); for (const child of children(node)) walk(child, visitor); };
  // Catch blocks are parsed directly rather than via parseStatement, so stamp
  // their token positions here. Every other body already has a start position.
  const locate = (node, suppliedStart) => {
    const start = suppliedStart ?? startOf(node);
    if (start == null) throw new Error('missing structured statement position');
    let end;
    if (node.kind === 'BlockStatement') {
      if (tokens[start].text !== '{' || !pairs.has(start)) throw new Error('invalid block span');
      end = pairs.get(start);
      for (const statement of node.statements) locate(statement);
    } else if (node.kind === 'IfStatement') {
      end = locate(node.alternate || node.consequent);
      if (node.alternate) locate(node.consequent);
    } else if (['LabeledStatement', 'WhileStatement', 'ForStatement'].includes(node.kind)) {
      end = locate(node.statement || node.body);
    } else if (node.kind === 'TryStatement') {
      if (node.resources?.length || node.finallyBlock) throw new Error('resource/finally scope requires explicit outcome handling');
      end = locate(node.block, start + 1);
      for (const clause of node.catches) {
        if (tokens[end + 1]?.text !== 'catch' || tokens[end + 2]?.text !== '(') throw new Error('invalid catch span');
        end = locate(clause.body, pairs.get(end + 2) + 1);
      }
    } else if (node.kind === 'SwitchStatement') {
      const brace = pairs.get(start + 1) + 1;
      if (tokens[brace]?.text !== '{') throw new Error('invalid switch span');
      end = pairs.get(brace);
      for (const group of node.groups) for (const statement of group.statements) locate(statement);
    } else if (node.kind === 'DoWhileStatement') {
      const tail = locate(node.body) + 1;
      if (tokens[tail]?.text !== 'while' || tokens[tail + 1]?.text !== '(') throw new Error('invalid do-while span');
      end = pairs.get(tail + 1) + 1;
      if (tokens[end]?.text !== ';') throw new Error('missing do-while terminator');
    } else if (['ExpressionStatement', 'ReturnStatement', 'ThrowStatement', 'EmptyStatement', 'LocalVariableDeclarationStatement'].includes(node.kind)) {
      end = start;
      while (end < tokens.length && tokens[end].text !== ';') end = pairs.has(end) ? pairs.get(end) + 1 : end + 1;
      if (tokens[end]?.text !== ';') throw new Error('missing statement terminator');
    } else if (['BreakStatement', 'ContinueStatement'].includes(node.kind)) {
      end = start + (node.label ? 2 : 1);
      if (tokens[end]?.text !== ';') throw new Error('invalid transfer span');
    } else throw new Error(`unsupported outline scope ${node.kind}`);
    spans.set(node, {start: tokens[start].range.startOffset, end: tokens[end].range.endOffset});
    return end;
  };
  const replace = (start, end, localEdits = []) => {
    const selected = [...edits, ...localEdits].filter(edit => edit.start >= start && edit.end <= end)
      .sort((a, b) => a.start - b.start);
    let result = '', cursor = start;
    for (const edit of selected) {
      if (edit.start < cursor) throw new Error('overlapping outline edits');
      result += source.slice(cursor, edit.start) + edit.text;
      cursor = edit.end;
    }
    return result + source.slice(cursor, end);
  };
  const closed = (node, frames = []) => {
    const loop = ['WhileStatement', 'DoWhileStatement', 'ForStatement'].includes(node.kind);
    if (node.kind === 'BreakStatement' || node.kind === 'ContinueStatement') {
      const target = node.label ? [...frames].reverse().find(frame => frame.label === node.label)
        : [...frames].reverse().find(frame => frame.loop || (node.kind === 'BreakStatement' && frame.switch));
      return !!target && (node.kind === 'BreakStatement' || target.loop);
    }
    const next = node.kind === 'LabeledStatement'
      ? [...frames, {label: node.label, loop: ['WhileStatement', 'DoWhileStatement', 'ForStatement'].includes(node.statement.kind)}]
      : loop || node.kind === 'SwitchStatement' ? [...frames, {loop, switch: node.kind === 'SwitchStatement'}] : frames;
    return children(node).every(child => closed(child, next));
  };
  const outline = (block, catches) => {
    const span = spans.get(block);
    if (replace(span.start, span.end).length <= budget) return;
    let group = [], groupReturnGrowth = 0;
    const returnGrowth = statement => {
      let growth = 0;
      walk(statement, node => {
        if (node.kind !== 'ReturnStatement') return;
        const position = spans.get(node);
        if (edits.some(edit => edit.start <= position.start && edit.end >= position.end)) return;
        if (node.expression) throw new Error('non-void outlined return');
        growth += 'finished = true; return;'.length - (position.end - position.start);
      });
      return growth;
    };
    const flush = () => {
      if (!group.length) return;
      if (helpers.length >= 256) throw new Error('structured helper budget exhausted');
      const firstSpan = spans.get(group[0]), lastSpan = spans.get(group[group.length - 1]);
      const returns = [];
      for (const statement of group) walk(statement, node => {
        if (node.kind !== 'ReturnStatement') return;
        const position = spans.get(node);
        if (edits.some(edit => edit.start <= position.start && edit.end >= position.end)) return;
        if (node.expression) throw new Error('non-void outlined return');
        returns.push({...position, text: 'finished = true; return;'});
      });
      const indentation = source.slice(source.lastIndexOf('\n', firstSpan.start - 1) + 1, firstSpan.start);
      const prefix = /^ *$/.test(indentation) ? indentation : '';
      const text = (prefix + replace(firstSpan.start, lastSpan.end, returns)).split('\n')
        .map(line => line.startsWith(prefix) ? line.slice(prefix.length) : line).join('\n');
      const name = `runChunk${helpers.length}`;
      helpers.push({name, text, throwsTypes: [...new Set([...throwsTypes, ...catches])]});
      for (let i = edits.length - 1; i >= 0; i--)
        if (edits[i].start >= firstSpan.start && edits[i].end <= lastSpan.end) edits.splice(i, 1);
      edits.push({start: firstSpan.start, end: lastSpan.end, text: `${name}();\n${prefix}if (finished) return;`});
      group = [];
      groupReturnGrowth = 0;
    };
    for (const statement of block.statements) {
      const position = spans.get(statement);
      // A void return becomes a shared completion flag plus a helper return.
      // Include that expansion while packing, rather than rejecting the fully
      // rewritten helpers afterward and falling back to a dispatcher.
      const growth = returnGrowth(statement);
      const size = replace(position.start, position.end).length + growth + 1;
      if (size > budget) throw new Error('statement cannot safely cross a helper boundary');
      // A small transfer to an enclosing loop/label can stay at its exact
      // original site between outlined runs. It must never enter a helper.
      if (!closed(statement)) { flush(); continue; }
      if (group.length && replace(spans.get(group[0]).start, position.end).length
          + groupReturnGrowth + growth > budget) flush();
      group.push(statement);
      groupReturnGrowth += growth;
    }
    flush();
  };
  const visit = (node, catches, inCatch = false) => {
    if (node.kind === 'LocalVariableDeclarationStatement' && !inCatch)
      throw new Error('unpromoted local scope cannot cross a helper boundary');
    if (node.kind === 'TryStatement') {
      const types = node.catches.flatMap(clause => {
        const type = clause.parameter.parameterType;
        return (type.kind === 'UnionType' ? type.alternatives : [type]).map(typeFromAst);
      });
      visit(node.block, [...catches, ...types], inCatch);
      for (const clause of node.catches) visit(clause.body, catches, true);
    } else {
      for (const child of children(node)) visit(child, catches, inCatch);
      if (node.kind === 'BlockStatement' && !inCatch) outline(node, catches);
    }
  };
  try {
    locate(tree, 0);
    visit(tree, []);
    if (!helpers.length) return null;
    const runBody = replace(1, source.length - 1).trim();
    if (runBody.length > budget + 2 || helpers.some(helper => helper.text.length > budget + 256)) return null;
    const clause = types => types.length ? ` throws ${types.join(', ')}` : '';
    const out = ['class $CfrPartitionedBody {'];
    for (const [name, type] of fields) out.push(`    ${type} ${name};`);
    for (const param of parameters) out.push(`    ${param.type} ${param.name};`);
    out.push('    boolean finished;',
      `    $CfrPartitionedBody(${parameters.map((param, i) => `${param.type} initialParam${i}`).join(', ')}) {`);
    parameters.forEach((param, i) => out.push(`        this.${param.name} = initialParam${i};`));
    for (const line of initializers) out.push(`        ${line}`);
    if (initializers.reduce((size, line) => size + line.length + 1, 0) > budget) return null;
    out.push('    }');
    const emitMethod = (name, text, types) => {
      out.push(`    void ${name}()${clause(types)} {`);
      for (const line of text.split('\n')) out.push(`        ${line}`);
      out.push('    }');
    };
    for (const helper of helpers) emitMethod(helper.name, helper.text, helper.throwsTypes);
    emitMethod('run', runBody, throwsTypes);
    out.push('}', `$CfrPartitionedBody decompiledBody = new $CfrPartitionedBody(${parameters.map(param => param.name).join(', ')});`,
      'decompiledBody.run();');
    return {lines: out, helpers: helpers.length, sharedLocals: fields.size};
  } catch (error) {
    options.onFailure?.(error.message);
    return null;
  }
}

module.exports = {partitionStructuredVoidBody};
