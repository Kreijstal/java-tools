const test = require('tape');
const {parse} = require('acorn');
const {
  partitionOversizedLinearBlocks, liftOversizedUnitLocalsToEnvironment,
  outlineLargeRegionLoops, regionUnit, rawRegionUnit, renderRegionUnit,
  applyRegionStatementEdits, assembleInsertion,
} =
  require('../src/jit/HotCallGraphRegionCompiler');

// Differential coverage for the straight-line partition pass: every case
// builds a synthetic module, partitions it with forced-small thresholds, and
// executes both versions against identical inputs, comparing results and a
// side-effect log. The pass must be a pure refactor at the observable level.
//
// The passes consume the statement records the renderer publishes for a body,
// so each case hands them a fixture-built record list for its handwritten
// source (see `buildRegionUnits`) and compiles the units they return.

const OPTIONS = {
  namespace: '0',
  maximumUnitBytes: 16384,
  targetSegmentBytes: 4096,
  minimumSegmentBytes: 1024,
};

const pad = (tag) => `log.push("${tag}");`.padEnd(120, ' ');

function compile(moduleSource) {
  return new Function(moduleSource)();
}

// The renderer publishes each generated body as an ordered statement list:
// per line, the parts the emitter built, the names it reads and writes, the
// nesting it opens, the label it introduces, the jump it is and how a return
// it carries splits around its returned value. These cases are handwritten
// JavaScript rather than generated bodies, so this builder stands in for that
// publication: it derives the same records from the fixture's own syntax and
// hands the passes exactly the shape the renderer hands them. Parsing here is
// the fixture producing compiler input, not a pass recovering it.
function childrenOf(node) {
  const children = [];
  for (const [key, child] of Object.entries(node || {})) {
    if (key === 'start' || key === 'end' || key === 'loc' ||
        key === 'range') continue;
    if (Array.isArray(child)) {
      for (const entry of child) if (entry?.type) children.push(entry);
    } else if (child?.type) {
      children.push(child);
    }
  }
  return children;
}

const isFunctionNode = (node) => node && (
  node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression' ||
  node.type === 'ArrowFunctionExpression');

function buildRegionUnits(moduleSource) {
  const program = parse(moduleSource, {
    ecmaVersion: 'latest', ranges: true, allowReturnOutsideFunction: true,
  });
  const lines = moduleSource.split('\n');
  const lineStarts = [];
  let cursor = 0;
  for (const line of lines) {
    lineStarts.push(cursor);
    cursor += line.length + 1;
  }
  const lineOf = (offset) => {
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  // Braces inside a string or a comment are not nesting. The renderer never
  // has to ask, because it counts the braces of its own literal chunks; the
  // fixture blanks the literals it parsed instead.
  const masked = moduleSource.split('');
  const references = [];
  const perLine = lines.map(() => ({
    declarators: [], assignments: [], updates: [], returns: [], jumps: [],
    labels: [], yields: 0, functions: 0, hostile: 0, opens: null,
    unrepresentable: 0,
  }));
  const visit = (node, parent) => {
    if (node.type === 'Literal' && typeof node.value === 'string' ||
        node.type === 'TemplateElement') {
      for (let at = node.start; at < node.end; at += 1) masked[at] = ' ';
    }
    const line = perLine[lineOf(node.start)];
    if (node.type === 'YieldExpression') line.yields += 1;
    if (isFunctionNode(node)) line.functions += 1;
    if (node.type === 'ThisExpression' || node.type === 'Super' ||
        node.type === 'AwaitExpression' ||
        node.type === 'VariableDeclaration' && node.kind === 'var') {
      line.hostile += 1;
    }
    if (node.type === 'VariableDeclaration') line.declarators.push(node);
    if (node.type === 'AssignmentExpression') line.assignments.push(node);
    if (node.type === 'UpdateExpression') line.updates.push(node);
    if (node.type === 'ReturnStatement') line.returns.push(node);
    if (node.type === 'BreakStatement' || node.type === 'ContinueStatement') {
      line.jumps.push(node);
    }
    if (node.type === 'LabeledStatement') line.labels.push(node.label.name);
    if (node.type === 'ForStatement' || node.type === 'ForInStatement' ||
        node.type === 'ForOfStatement' || node.type === 'WhileStatement' ||
        node.type === 'DoWhileStatement') line.opens = line.opens || 'loop';
    if (node.type === 'TryStatement') line.opens = line.opens || 'try';
    if (node.type === 'SwitchStatement') line.opens = 'switch';
    if (isFunctionNode(node)) line.opens = 'function';
    if (node.type === 'Property' && node.shorthand) {
      perLine[lineOf(node.start)].unrepresentable += 1;
    }
    if (node.type === 'Identifier' && isReference(node, parent)) {
      references.push(node);
    }
    for (const child of childrenOf(node)) visit(child, node);
  };
  const isReference = (node, parent) => {
    if (!parent) return true;
    if (parent.type === 'MemberExpression' && parent.property === node &&
        !parent.computed) return false;
    if ((parent.type === 'Property' || parent.type === 'MethodDefinition') &&
        parent.key === node && !parent.computed) return false;
    if ((parent.type === 'LabeledStatement' ||
        parent.type === 'BreakStatement' ||
        parent.type === 'ContinueStatement') && parent.label === node) {
      return false;
    }
    if (isFunctionNode(parent) &&
        (parent.id === node || parent.params.includes(node))) return false;
    if (parent.type === 'CatchClause' && parent.param === node) return false;
    return true;
  };
  visit(program, null);
  const maskedSource = masked.join('');
  references.sort((left, right) => left.start - right.start);

  const partsOf = (from, to, own) => {
    const parts = [];
    let at = from;
    for (const reference of own) {
      if (reference.start < from || reference.end > to) continue;
      if (reference.start > at) parts.push(moduleSource.slice(at, reference.start));
      parts.push({ref: reference.name});
      at = reference.end;
    }
    if (at < to) parts.push(moduleSource.slice(at, to));
    return parts;
  };

  const statementFor = (index) => {
    const start = lineStarts[index];
    const end = start + lines[index].length;
    const own = references.filter((reference) =>
      reference.start >= start && reference.end <= end);
    const facts = perLine[index];
    const maskedLine = maskedSource.slice(start, end);
    let delta = 0;
    for (const character of maskedLine) {
      if (character === '{') delta += 1;
      else if (character === '}') delta -= 1;
    }
    const wholeLine = (node) => node.start >= start && node.end <= end;
    const declaration = facts.declarators.find(wholeLine);
    let def = null;
    let declares = null;
    let kind = 'statement';
    if (declaration && declaration.declarations.every((entry) =>
      entry.id.type === 'Identifier')) {
      kind = declaration.kind === 'const' ? 'const'
        : declaration.declarations.some((entry) => entry.init)
          ? 'let' : 'letUninitialized';
      if (declaration.declarations.length === 1) {
        def = declaration.declarations[0].id.name;
      } else {
        declares = declaration.declarations.map((entry) => entry.id.name);
      }
    }
    let write = null;
    const assignment = facts.assignments.find((node) => wholeLine(node) &&
      node.left.type === 'Identifier');
    if (assignment) write = assignment.left.name;
    const update = facts.updates.find((node) => wholeLine(node) &&
      node.argument.type === 'Identifier');
    if (!write && update) write = update.argument.name;
    const reads = [];
    for (const reference of own) {
      if (reference.name === def) continue;
      if (!reads.includes(reference.name)) reads.push(reference.name);
    }
    const returns = facts.returns.filter(wholeLine);
    let exit = null;
    let exitRecognized = facts.returns.length === returns.length;
    if (returns.length === 1 && exitRecognized) {
      const node = returns[0];
      exit = {
        kind: 'return',
        before: partsOf(start, node.start, own),
        value: node.argument
          ? partsOf(node.argument.start, node.argument.end, own) : null,
        after: partsOf(node.end, end, own),
      };
    } else if (returns.length) {
      exitRecognized = false;
    }
    const jumps = facts.jumps.filter(wholeLine);
    let jump = null;
    if (jumps.length === 1 && facts.jumps.length === 1) {
      const node = jumps[0];
      jump = {
        kind: node.type === 'BreakStatement' ? 'break' : 'continue',
        label: node.label ? node.label.name : null,
        before: partsOf(start, node.start, own),
        after: partsOf(node.end, end, own),
      };
    }
    const trimmed = maskedLine.trim();
    return {
      text: lines[index],
      indent: lines[index].slice(0,
        lines[index].length - lines[index].trimStart().length),
      parts: facts.unrepresentable ? null : partsOf(start, end, own),
      kind,
      def,
      declares,
      write,
      writes: write ? [write] : [],
      reads,
      delta,
      label: facts.labels.length ? facts.labels[0] : null,
      jump,
      exit,
      yields: facts.yields > 0,
      continuesBlock: trimmed.startsWith('}') && trimmed.endsWith('{'),
      opens: delta > 0 ? (facts.opens || 'block') : null,
      relocatable: facts.unrepresentable === 0 &&
        facts.functions === 0 && facts.hostile === 0 &&
        exitRecognized && (jump !== null || facts.jumps.length === 0) &&
        !(jump && exit) && facts.opens !== 'switch',
    };
  };

  const units = [];
  let pending = [];
  const flushPending = () => {
    if (!pending.length) return;
    units.push(rawRegionUnit(pending.join('\n')));
    pending = [];
  };
  let line = 0;
  for (const node of program.body) {
    const first = lineOf(node.start);
    const last = lineOf(node.end - 1);
    while (line < first) pending.push(lines[line++]);
    if (node.type === 'FunctionDeclaration') {
      const bodyFirst = lineOf(node.body.start);
      flushPending();
      const statements = [];
      for (let index = bodyFirst + 1; index < last; index += 1) {
        statements.push(statementFor(index));
      }
      units.push(regionUnit({
        name: node.id.name,
        generator: node.generator === true,
        headerLines: lines.slice(first, bodyFirst + 1),
        statements,
        footerLines: [lines[last]],
      }));
    } else {
      for (let index = first; index <= last; index += 1) {
        pending.push(lines[index]);
      }
    }
    line = last + 1;
  }
  while (line < lines.length) pending.push(lines[line++]);
  flushPending();
  return units;
}

// A standalone generator body: the whole source is one unit's statement list,
// the way the renderer hands a continuation-tier body over.
function buildGeneratorBodyUnit(bodySource) {
  const units = buildRegionUnits(
    `function* __fixture() {\n${bodySource}\n}`);
  return regionUnit({...units[0], headerLines: [], footerLines: []});
}

function renderUnits(units) {
  return units.map(renderRegionUnit).join('\n');
}

function partition(moduleSource, options = OPTIONS) {
  const partitioned = partitionOversizedLinearBlocks(
    buildRegionUnits(moduleSource), options);
  return {...partitioned, source: renderUnits(partitioned.units)};
}

function partitionAndCompile(t, moduleSource) {
  const partitioned = partition(moduleSource);
  t.ok(partitioned.count > 0, 'the case is large enough to partition');
  return {fn: compile(partitioned.source), partitioned};
}

function unitSelfSizes(source) {
  const program = parse(source, {
    ecmaVersion: 'latest', ranges: true, allowReturnOutsideFunction: true,
  });
  const childrenOf = (node) => {
    const children = [];
    for (const [key, child] of Object.entries(node || {})) {
      if (key === 'start' || key === 'end' || key === 'loc' ||
          key === 'range') continue;
      if (Array.isArray(child)) {
        for (const entry of child) if (entry?.type) children.push(entry);
      } else if (child?.type) {
        children.push(child);
      }
    }
    return children;
  };
  const isFunction = (node) => node && (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression');
  const sizes = [];
  const walk = (node) => {
    if (isFunction(node)) {
      let nested = 0;
      const measure = (entry) => {
        for (const child of childrenOf(entry)) {
          if (isFunction(child)) {
            nested += child.end - child.start;
            continue;
          }
          measure(child);
        }
      };
      measure(node.body);
      sizes.push(node.end - node.start - nested);
    }
    for (const child of childrenOf(node)) walk(child);
  };
  walk(program);
  return sizes;
}

test('straight-line runs with escaping lets and unbraced returns', (t) => {
  const moduleSource = `'use strict';\n${[
    'function work(a, b, log) {',
    ...Array.from({length: 80}, (_unused, i) => [
      `  let v${i} = (a + ${i}) | 0;`,
      `  ${pad(`s${i}`)}`,
      `  if (v${i} === -1) return -${i};`,
    ].join('\n')),
    '  let sum = 0;',
    ...Array.from({length: 80}, (_unused, i) =>
      `  sum = (sum + v${i}) | 0; ${pad(`t${i}`)}`),
    '  return sum + b;',
    '}',
  ].join('\n')}\nreturn work;`;
  const original = compile(moduleSource);
  const {fn, partitioned} = partitionAndCompile(t, moduleSource);
  for (const [a, b] of [[3, 5], [-1, 0], [-40, 7], [1000, -3]]) {
    const expectedLog = [];
    const actualLog = [];
    t.equal(fn(a, b, actualLog), original(a, b, expectedLog),
      `scalar result matches for (${a}, ${b})`);
    t.deepEqual(actualLog, expectedLog,
      `statement-level effect order matches for (${a}, ${b})`);
  }
  // Run sizing happens before the ABI plumbing (parameters, hoist preamble,
  // live-out epilogue) is emitted, so a name-dense segment may overshoot the
  // requested budget by its plumbing. Twice the budget bounds that overhead.
  const oversized = unitSelfSizes(partitioned.source).filter(
    (size) => size > OPTIONS.maximumUnitBytes * 2);
  t.deepEqual(oversized, [],
    'every emitted unit fits twice the requested budget');
  t.end();
});

test('runs inside loops route outward jumps through the call site', (t) => {
  const moduleSource = `'use strict';\n${[
    'function work(n, log) {',
    '  let total = 0;',
    '  OUTER: for (let i = 0; i < n; i++) {',
    '    let acc = 0;',
    '    for (let j = 0; j < n; j++) {',
    ...Array.from({length: 100}, (_unused, k) => [
      `      acc = (acc + i * ${k + 1} + j) | 0;`,
      `      ${pad(`k${k}`)}`,
      `      if (acc % 97 === ${k}) { log.push("cont${k}"); continue; }`,
      `      if (acc % 89 === ${k}) { log.push("brk${k}"); break; }`,
      `      if (acc % 83 === ${k}) { log.push("co${k}"); continue OUTER; }`,
      `      if (acc % 79 === ${k}) { log.push("bo${k}"); break OUTER; }`,
    ].join('\n')),
    '      total = (total + acc) | 0;',
    '    }',
    '    total = (total + i) | 0;',
    '  }',
    '  return total;',
    '}',
  ].join('\n')}\nreturn work;`;
  const original = compile(moduleSource);
  const {fn} = partitionAndCompile(t, moduleSource);
  for (let n = 1; n < 9; n += 1) {
    const expectedLog = [];
    const actualLog = [];
    t.equal(fn(n, actualLog), original(n, expectedLog),
      `loop result matches for n=${n}`);
    t.deepEqual(actualLog, expectedLog, `jump routing matches for n=${n}`);
  }
  t.end();
});

test('exceptions unwind through segment boundaries with finallys', (t) => {
  const moduleSource = `'use strict';\n${[
    'function work(x, log) {',
    '  let state = 0;',
    '  try {',
    ...Array.from({length: 100}, (_unused, i) => [
      `    state = (state * 31 + ${i} + x) | 0;`,
      `    ${pad(`p${i}`)}`,
      `    try { if (state % 13 === ${i}) throw new Error("boom${i}"); }`,
      `    finally { log.push("f${i}"); }`,
    ].join('\n')),
    '    return state;',
    '  } catch (e) {',
    "    log.push('caught:' + e.message + ':' + state);",
    '    return -state;',
    '  }',
    '}',
  ].join('\n')}\nreturn work;`;
  const original = compile(moduleSource);
  const {fn} = partitionAndCompile(t, moduleSource);
  for (let x = 0; x < 30; x += 1) {
    const expectedLog = [];
    const actualLog = [];
    t.equal(fn(x, actualLog), original(x, expectedLog),
      `throw/catch result matches for x=${x}`);
    t.deepEqual(actualLog, expectedLog,
      `finally and catch ordering matches for x=${x}`);
  }
  t.end();
});

test('multi-function modules compose partitioned callees', (t) => {
  const moduleSource = `'use strict';\n${[
    'function inner(arr, r, log) {',
    '  let s = 0;',
    '  for (let i = 0; i < arr.length; i++) {',
    ...Array.from({length: 90}, (_unused, k) => [
      `    s = (s + ((arr[i] ^ r) + ${k})) | 0;`,
      `    ${pad(`i${k}`)}`,
      '    if (s === 123456789) return -1;',
    ].join('\n')),
    '  }',
    '  return s;',
    '}',
    'function work(arr, mult, rounds, log) {',
    '  let total = 0;',
    '  for (let m = 0; m < mult; m++) {',
    '    for (let r = 0; r < rounds; r++) {',
    ...Array.from({length: 90}, (_unused, k) => [
      `      total = (total + ${k}) | 0;`,
      `      ${pad(`w${k}`)}`,
      `      total = (total - ${k}) | 0;`,
    ].join('\n')),
    '      total = (total + inner(arr, r, log)) | 0;',
    '    }',
    '  }',
    '  return total;',
    '}',
  ].join('\n')}\nreturn work;`;
  const original = compile(moduleSource);
  const {fn} = partitionAndCompile(t, moduleSource);
  const expectedLog = [];
  const actualLog = [];
  t.equal(fn([2, 9, 4, 7], 3, 5, actualLog),
    original([2, 9, 4, 7], 3, 5, expectedLog),
    'composed call-graph result matches');
  t.equal(actualLog.length, expectedLog.length,
    'composed effect counts match');
  t.end();
});

// Drives a generator the way the framed continuation wrapper does: an
// argument-less next() per scheduler turn, and iterator.return() when a
// continuation is abandoned. Returns the yielded values, the completion
// value, and whether the generator ran to completion.
function drive(generatorFactory, args, maximumSteps = Infinity) {
  const iterator = generatorFactory(...args);
  const yields = [];
  let stepCount = 0;
  let step = iterator.next();
  while (!step.done && stepCount < maximumSteps) {
    yields.push(step.value);
    stepCount += 1;
    step = iterator.next();
  }
  if (!step.done) {
    yields.push(step.value);
    iterator.return('abandoned');
    return {yields, value: undefined, done: false};
  }
  return {yields, value: step.value, done: true};
}

test('generator units delegate yield-bearing runs through yield*', (t) => {
  const moduleSource = `'use strict';\n${[
    'function* work(n, log) {',
    '  let total = 0;',
    '  OUTER: for (let i = 0; i < n; i++) {',
    '    for (let j = 0; j < n; j++) {',
    ...Array.from({length: 90}, (_unused, k) => [
      `      total = (total + i * ${k + 1} + j) | 0;`,
      `      ${pad(`g${k}`)}`,
      `      if (total % 101 === ${k}) { log.push("y${k}"); ` +
        `yield {at: ${k}, total: total}; }`,
      `      if (total % 97 === ${k}) { log.push("cont${k}"); continue; }`,
      `      if (total % 89 === ${k}) { log.push("co${k}"); continue OUTER; }`,
      `      if (total % 83 === ${k}) { log.push("bo${k}"); break OUTER; }`,
      `      if (total % 79 === ${k}) { log.push("ret${k}"); ` +
        `return -total; }`,
    ].join('\n')),
    '      total = (total + 1) | 0;',
    '    }',
    '  }',
    '  return total;',
    '}',
  ].join('\n')}\nreturn work;`;
  const original = compile(moduleSource);
  const partitioned = partition(moduleSource);
  t.ok(partitioned.count > 0, 'the generator case partitions');
  t.ok(/function\* jvmRegionSegment/.test(partitioned.source),
    'yield-bearing runs become generator helpers');
  t.ok(/yield\* jvmRegionSegment/.test(partitioned.source),
    'generator helpers are reached through yield*');
  const fn = compile(partitioned.source);
  for (let n = 1; n < 9; n += 1) {
    const expectedLog = [];
    const actualLog = [];
    const expected = drive(original, [n, expectedLog]);
    const actual = drive(fn, [n, actualLog]);
    t.deepEqual(actual, expected, `driven completion matches for n=${n}`);
    t.deepEqual(actualLog, expectedLog, `effect order matches for n=${n}`);
  }
  const oversized = unitSelfSizes(partitioned.source).filter(
    (size) => size > OPTIONS.maximumUnitBytes * 2);
  t.deepEqual(oversized, [],
    'every emitted generator unit fits twice the requested budget');
  t.end();
});

test('iterator.return abandonment runs finallys across yield* boundaries',
  (t) => {
    const moduleSource = `'use strict';\n${[
      'function* work(n, log) {',
      '  let state = 0;',
      '  try {',
      ...Array.from({length: 90}, (_unused, i) => [
        `    state = (state * 31 + ${i} + n) | 0;`,
        `    ${pad(`a${i}`)}`,
        `    try { if (state % 7 === ${i % 7}) { log.push("y${i}"); ` +
          `yield {suspend: ${i}}; } }`,
        `    finally { log.push("f${i}"); }`,
        `    if (state % 13 === ${i % 13}) throw new Error("boom${i}");`,
      ].join('\n')),
      '    return state;',
      '  } catch (e) {',
      "    log.push('caught:' + e.message + ':' + state);",
      '    return -state;',
      '  } finally {',
      "    log.push('outer-finally');",
      '  }',
      '}',
    ].join('\n')}\nreturn work;`;
    const original = compile(moduleSource);
    const partitioned = partition(moduleSource);
    t.ok(partitioned.count > 0, 'the abandonment case partitions');
    const fn = compile(partitioned.source);
    for (let n = 0; n < 20; n += 1) {
      for (const maximumSteps of [0, 1, 2, Infinity]) {
        const expectedLog = [];
        const actualLog = [];
        const expected = drive(original, [n, expectedLog], maximumSteps);
        const actual = drive(fn, [n, actualLog], maximumSteps);
        t.deepEqual(actual, expected,
          `completion matches for n=${n} steps=${maximumSteps}`);
        t.deepEqual(actualLog, expectedLog,
          `finally ordering matches for n=${n} steps=${maximumSteps}`);
      }
    }
    t.end();
  });

test('environment lift is a pure refactor and shrinks call-site plumbing',
  (t) => {
    const moduleSource = `'use strict';\n${[
      'function work(a, b, log) {',
      ...Array.from({length: 70}, (_unused, i) =>
        `  const cache${i} = {id: ${i}, offset: (a + ${i}) | 0};`),
      '  let acc = 0;',
      '  const shadowed = a + 1;',
      '  function reader(k) {',
      '    const shadowed = k * 2;',
      '    return cache3.offset + cache68.id + shadowed;',
      '  }',
      ...Array.from({length: 70}, (_unused, i) => [
        `  acc = (acc + cache${i}.offset + reader(${i}) + shadowed) | 0;`,
        `  ${pad(`e${i}`)}`,
        `  if (acc === -1) return cache${i}.id;`,
      ].join('\n')),
      '  return acc;',
      '}',
    ].join('\n')}\nreturn work;`;
    const original = compile(moduleSource);
    const lifted = liftOversizedUnitLocalsToEnvironment(
      buildRegionUnits(moduleSource), {
        namespace: '0', maximumUnitBytes: OPTIONS.maximumUnitBytes,
      });
    lifted.source = renderUnits(lifted.units);
    t.ok(lifted.liftedNames > 60, 'the top-level cache namespace lifts');
    t.ok(/jvmRegionEnv0_1/.test(lifted.source),
      'an environment array is introduced');
    t.ok(/const shadowed = a \+ 1;/.test(lifted.source),
      'a shadowed name keeps its original declaration');
    const liftedFn = compile(lifted.source);
    const partitionedUnits = partitionOversizedLinearBlocks(
      lifted.units, OPTIONS);
    const partitioned = {...partitionedUnits,
      source: renderUnits(partitionedUnits.units)};
    t.ok(partitioned.count > 0, 'the lifted module partitions');
    const partitionedFn = compile(partitioned.source);
    for (const [a, b] of [[3, 5], [-7, 2], [100, -1]]) {
      const expectedLog = [];
      const liftedLog = [];
      const partitionedLog = [];
      const expected = original(a, b, expectedLog);
      t.equal(liftedFn(a, b, liftedLog), expected,
        `lifted result matches for (${a}, ${b})`);
      t.deepEqual(liftedLog, expectedLog,
        `lifted effect order matches for (${a}, ${b})`);
      t.equal(partitionedFn(a, b, partitionedLog), expected,
        `lift+partition result matches for (${a}, ${b})`);
      t.deepEqual(partitionedLog, expectedLog,
        `lift+partition effect order matches for (${a}, ${b})`);
    }
    const oversized = unitSelfSizes(partitioned.source).filter(
      (size) => size > OPTIONS.maximumUnitBytes * 2);
    t.deepEqual(oversized, [],
      'every lifted unit fits twice the requested budget');
    t.end();
  });

test('framed-style generator: lift then partition end to end', (t) => {
  const moduleSource = `'use strict';\n${[
    'function* work(frame, log) {',
    "  'use strict';",
    ...Array.from({length: 60}, (_unused, i) =>
      `  const site${i} = {id: ${i}, hits: 0};`),
    '  let pc = 0;',
    '  let value = 0;',
    ...Array.from({length: 60}, (_unused, i) => [
      `  site${i}.hits = (site${i}.hits + frame.seed + ${i}) | 0;`,
      `  value = (value * 17 + site${i}.hits) | 0;`,
      `  ${pad(`fr${i}`)}`,
      `  if (value % 11 === ${i % 11}) { pc = ${i}; ` +
        `log.push("deopt${i}"); ` +
        `yield {deopt: true, structuredResumePc: pc}; }`,
      `  if (value % 401 === ${i}) { log.push("exit${i}"); ` +
        `return {returned: true, value: value}; }`,
    ].join('\n')),
    '  return {returned: true, value: value, ' +
      'sites: site0.hits + site59.hits};',
    '}',
  ].join('\n')}\nreturn work;`;
  const original = compile(moduleSource);
  const lifted = liftOversizedUnitLocalsToEnvironment(
    buildRegionUnits(moduleSource), {
      namespace: '0', maximumUnitBytes: OPTIONS.maximumUnitBytes,
    });
  t.ok(lifted.liftedNames > 50, 'the framed-style preamble lifts');
  const partitionedUnits = partitionOversizedLinearBlocks(
    lifted.units, OPTIONS);
  const partitioned = {...partitionedUnits,
    source: renderUnits(partitionedUnits.units)};
  t.ok(partitioned.count > 0, 'the framed-style case partitions');
  t.ok(/yield\* jvmRegionSegment/.test(partitioned.source),
    'the framed-style case delegates through yield*');
  const fn = compile(partitioned.source);
  for (const seed of [0, 1, 5, 12, 100, -3]) {
    for (const maximumSteps of [0, 2, Infinity]) {
      const expectedLog = [];
      const actualLog = [];
      const expected = drive(original, [{seed}, expectedLog], maximumSteps);
      const actual = drive(fn, [{seed}, actualLog], maximumSteps);
      t.deepEqual(actual, expected,
        `framed completion matches for seed=${seed} steps=${maximumSteps}`);
      t.deepEqual(actualLog, expectedLog,
        `framed effect order matches for seed=${seed} steps=${maximumSteps}`);
    }
  }
  const oversized = unitSelfSizes(partitioned.source).filter(
    (size) => size > OPTIONS.maximumUnitBytes * 2);
  t.deepEqual(oversized, [],
    'every framed-style unit fits twice the requested budget');
  t.end();
});

test('loop outlining preserves generator yields and abandonment', (t) => {
  const repeated = Array.from({length: 180}, (_unused, index) =>
    `value = (value + ${index + 1}) | 0;`).join('\n');
  const moduleSource = `function* work(limit, log) {
  let value = 0;
  try {
    for (let index = 0; index < limit; index += 1) {
${repeated}
      log.push(value);
      yield value;
    }
    return value;
  } finally {
    log.push('finally');
  }
}
return work;`;
  const units = buildRegionUnits(moduleSource);
  const work = units.find((unit) => unit.name === 'work');
  const outlined = outlineLargeRegionLoops(work, {
    minimumSourceBytes: 4096, maximumOutlines: 4, namespace: 31,
  });
  t.ok(outlined.count > 0, 'the yield-bearing loop is outlined');
  const transformed = compile(renderUnits(units.flatMap((unit) =>
    unit === work ? [outlined.unit, ...outlined.helpers] : [unit])));
  const original = compile(moduleSource);
  for (const maximumSteps of [0, 1, 3, Infinity]) {
    const expectedLog = [];
    const actualLog = [];
    const expected = drive(original, [6, expectedLog], maximumSteps);
    const actual = drive(transformed, [6, actualLog], maximumSteps);
    t.deepEqual(actual, expected,
      `outlined completion matches through ${maximumSteps} steps`);
    t.deepEqual(actualLog, expectedLog,
      `outlined yield/finally order matches through ${maximumSteps} steps`);
  }
  t.end();
});

test('nested loop outlining threads the shared state array inward', (t) => {
  // The inner loop is outlined first; the next round outlines the outer loop,
  // whose body now calls that helper through the body-scoped state array. The
  // array is declared inside the unit, so the outer helper has to receive it.
  const inner = Array.from({length: 60}, (_unused, index) =>
    `      acc = (acc + ${index + 1} + j) | 0;`).join('\n');
  const outer = Array.from({length: 60}, (_unused, index) =>
    `    total = (total + acc + ${index + 1}) | 0;`).join('\n');
  const moduleSource = `'use strict';\n${[
    'function work(n, log) {',
    '  let total = 0;',
    '  for (let i = 0; i < n; i++) {',
    '    let acc = 0;',
    '    for (let j = 0; j < n; j++) {',
    inner,
    `      ${pad('inner')}`,
    '      if (acc === 123456789) return -1;',
    '    }',
    outer,
    `    ${pad('outer')}`,
    '    if (total === 987654321) return -2;',
    '  }',
    '  return total;',
    '}',
  ].join('\n')}\nreturn work;`;
  const units = buildRegionUnits(moduleSource);
  const work = units.find((unit) => unit.name === 'work');
  const outlined = outlineLargeRegionLoops(work, {
    minimumSourceBytes: 1024, maximumOutlines: 8, namespace: 7,
  });
  t.ok(outlined.count >= 2, 'both the inner and the outer loop are outlined');
  const source = renderUnits(units.flatMap((unit) =>
    unit === work ? [outlined.unit, ...outlined.helpers] : [unit]));
  t.ok(/function jvmRegionOutlinedLoop7_1\([^)]*jvmRegionOutlinedState7/
    .test(source),
  'the outer helper receives the body-scoped state array as a parameter');
  const original = compile(moduleSource);
  const transformed = compile(source);
  for (let n = 0; n < 6; n += 1) {
    const expectedLog = [];
    const actualLog = [];
    t.equal(transformed(n, actualLog), original(n, expectedLog),
      `nested outlining result matches for n=${n}`);
    t.deepEqual(actualLog, expectedLog,
      `nested outlining effect order matches for n=${n}`);
  }
  t.end();
});

test('standalone generator bodies partition with exact source offsets', (t) => {
  const body = [
    'let value = seed | 0;',
    ...Array.from({length: 700}, (_unused, index) =>
      `value = (value + ${index + 1}) | 0;`),
    'yield value;',
    ...Array.from({length: 700}, (_unused, index) =>
      `value = (value ^ ${index + 17}) | 0;`),
    'return value;',
  ].join('\n');
  const partitioned = partitionOversizedLinearBlocks(
    [buildGeneratorBodyUnit(body)], OPTIONS);
  partitioned.source = renderUnits(partitioned.units);
  t.ok(partitioned.attemptedRuns > 0,
    'analysis accepts yields from a standalone generator body');
  t.ok(partitioned.count > 0, 'the standalone body is actually partitioned');
  const build = (source) => new Function(
    `return function* work(seed) { ${source} };`)();
  const original = build(body);
  const transformed = build(partitioned.source);
  for (const maximumSteps of [0, 1, Infinity]) {
    t.deepEqual(drive(transformed, [9], maximumSteps),
      drive(original, [9], maximumSteps),
    `standalone completion matches through ${maximumSteps} steps`);
  }
  t.end();
});

test('a "yield" inside a string is not mistaken for a keyword', (t) => {
  // The generator body used to be made parseable by rewriting `yield` to
  // `void `, which cannot tell a keyword from the same five characters inside
  // a string literal or a comment. Parsing the body as the generator body it
  // is removes the false positive: this run contains no yield at all, so its
  // helper must be an ordinary function called without delegation.
  const body = [
    'let value = seed | 0;',
    'const names = {yield: 3, yieldable: 4};',
    'const label = "yield value; yield* other();";',
    '// yield value; yield* other();',
    ...Array.from({length: 900}, (_unused, index) =>
      `value = (value + ${index + 1}) | 0;`),
    'return value + label.length + names.yield;',
  ].join('\n');
  const partitioned = partitionOversizedLinearBlocks(
    [buildGeneratorBodyUnit(body)], OPTIONS);
  partitioned.source = renderUnits(partitioned.units);
  t.ok(partitioned.count > 0, 'the standalone body is actually partitioned');
  t.ok(!partitioned.source.includes('yield* jvmRegionSegment'),
    'a yield-free run is not delegated to');
  t.ok(!/function\* jvmRegionSegment/.test(partitioned.source),
    'a yield-free run does not become a generator helper');
  const build = (source) => new Function(
    `return function* work(seed) { ${source} };`)();
  for (const maximumSteps of [0, 1, Infinity]) {
    t.deepEqual(drive(build(partitioned.source), [9], maximumSteps),
      drive(build(body), [9], maximumSteps),
      `standalone completion matches through ${maximumSteps} steps`);
  }
  t.end();
});

// A composed body: a callee inserted lexically into a caller, the way
// `rewriteCallBindings` inserts one. The insertion is published the way the
// renderer publishes it -- an insertable source whose exits already assign one
// result token and break one label token, the statement records behind that
// source, and an assembler that binds the callee's parameters by declaration
// inside a labeled block -- so these cases drive `assembleInsertion` and
// `applyRegionStatementEdits` on the shape the region compiler really hands
// them.

const CALLEE_RESULT = 'ssaRegionInlineResult9';
const CALLEE_LABEL = 'ssaRegionInlineBody9';

function buildInsertion(bodyLines, argumentNames) {
  // The exits break out of a label the *caller* declares, so the body only
  // parses inside it. The fixture wraps it exactly as the renderer's own
  // statement-IR verifier does, and keeps the records of the body alone.
  const units = buildRegionUnits(
    `function __callee() {\n${CALLEE_LABEL}: {\n${
      bodyLines.join('\n')}\n}\n}`);
  const all = units.find((unit) => unit.name === '__callee').statements;
  const statements = all.slice(1, all.length - 1);
  const published = {
    serial: 9,
    source: statements.map((statement) => statement.text).join('\n'),
    statements,
    exitCount: 2,
    resultToken: CALLEE_RESULT,
    labelToken: CALLEE_LABEL,
    argumentNames: [...argumentNames],
    entryGuardName: 'nestedEntryGuarded',
    entryGuardValue: '2',
  };
  published.assemble = ({
    source = published.source, argumentValues, resultName, exitLabel,
    namespace, declareResult = true,
  }) => {
    const retargeted = source
      .split(published.resultToken).join(resultName)
      .split(published.labelToken).join(exitLabel);
    return [
      declareResult ? `let ${resultName};` : null,
      ...argumentValues.map((value, index) =>
        `const ${namespace}a${index} = ${value};`),
      `${exitLabel}: {`,
      ...published.argumentNames.map((name, index) =>
        `  const ${name} = ${namespace}a${index};`),
      `  const ${published.entryGuardName} = ${published.entryGuardValue};`,
      ...retargeted.split('\n').map((line) => `  ${line}`),
      '}',
    ].filter((line) => line !== null).join('\n');
  };
  return published;
}

// Insert `insertion` in place of the caller statement that declares `at`,
// exactly as `rewriteCallBindings` does: the assembled text is spliced into
// the caller's source and the same edit is mapped onto its records.
function composeCallee(callerModuleSource, insertion, at, argumentValues) {
  const units = buildRegionUnits(callerModuleSource);
  const unitIndex = units.findIndex((unit) =>
    unit.statements.some((statement) => statement.def === at));
  const unit = units[unitIndex];
  const callIndex = unit.statements.findIndex(
    (statement) => statement.def === at);
  let offset = 0;
  for (let index = 0; index < callIndex; index += 1) {
    offset += unit.statements[index].text.length + 1;
  }
  const call = unit.statements[callIndex];
  const start = offset + call.indent.length;
  const end = offset + call.text.length;
  const namespace = 'jvmRegionInline12_9_';
  const assembled = assembleInsertion(insertion, {
    source: insertion.source,
    statements: insertion.statements,
    argumentValues,
    resultName: at,
    exitLabel: `${namespace}return`,
    namespace,
    declareResult: true,
  });
  const bodySource = unit.statements
    .map((statement) => statement.text).join('\n');
  const composedSource = bodySource.slice(0, start) + assembled.source +
    bodySource.slice(end);
  const composed = applyRegionStatementEdits(unit.statements,
    [{start, end, replacement: assembled.source,
      statements: assembled.statements}],
    composedSource);
  const composedUnit = regionUnit({...unit, statements: composed});
  return {
    assembled,
    composed,
    unit,
    units: units.map((entry, index) =>
      index === unitIndex ? composedUnit : entry),
    exitLabel: `${namespace}return`,
  };
}

const composedCalleeBody = [
  'let local0 = argument0 | 0;',
  'let local1 = argument1 | 0;',
  'log.push("callee-enter");',
  ...Array.from({length: 400}, (_unused, index) =>
    `local0 = (local0 + ${index + 1}) | 0;`),
  'log.push("callee-middle");',
  `if (local1 > 900) { ${CALLEE_RESULT} = local0; break ${CALLEE_LABEL}; }`,
  ...Array.from({length: 400}, (_unused, index) =>
    `local0 = (local0 ^ ${index + 17}) | 0;`),
  'log.push("callee-exit");',
  `{ ${CALLEE_RESULT} = (local0 + local1) | 0; break ${CALLEE_LABEL}; }`,
];

// The caller declares `local0` too, at its own top level. The callee's
// `local0` shadows it inside the inserted block; a pass that resolved names
// with one flat set would hand a relocated statement the wrong binding.
const composedCallerSource = [
  'function work(seed, log) {',
  'let local0 = seed | 0;',
  'let total = 0;',
  ...Array.from({length: 200}, (_unused, index) =>
    `total = (total + local0 + ${index + 1}) | 0;`),
  'log.push("caller-before");',
  'let out = 0;',
  'log.push("caller-after");',
  ...Array.from({length: 200}, (_unused, index) =>
    `total = (total ^ out ^ ${index + 3}) | 0;`),
  'return (total + out + local0) | 0;',
  '}',
  'return work;',
].join('\n');

test('a composed callee splices into the caller as records', (t) => {
  const insertion = buildInsertion(composedCalleeBody,
    ['argument0', 'argument1']);
  const {assembled, composed, unit} = composeCallee(
    composedCallerSource, insertion, 'out', ['local0', 'total']);
  t.ok(assembled && assembled.statements,
    'the assembler publishes records beside the text it produced');
  t.equal(assembled.statements.map((statement) => statement.text).join('\n'),
    assembled.source,
    'the records reproduce the assembled body exactly');
  t.equal(composed.length,
    unit.statements.length - 1 + assembled.statements.length,
    'the call statement is replaced by the whole inserted record list');
  const opaque = composed.filter((statement) => statement.reads === null);
  t.equal(opaque.length, 2,
    'only the two argument staging declarations stay opaque');
  t.ok(composed.some((statement) =>
    statement.text.includes('callee-middle') && statement.reads !== null),
  'the callee body arrives as records the passes can read');
  t.end();
});

test('the partitioner cuts across a composed callee body', (t) => {
  const insertion = buildInsertion(composedCalleeBody,
    ['argument0', 'argument1']);
  const {units, exitLabel} = composeCallee(
    composedCallerSource, insertion, 'out', ['local0', 'total']);
  const composedSource = renderUnits(units);
  const partitioned = partitionOversizedLinearBlocks(units, OPTIONS);
  const partitionedSource = renderUnits(partitioned.units);
  t.ok(partitioned.attemptedRuns > 0,
    'the composed body is walked for runs at all');
  t.ok(partitioned.count > 0, 'the composed body is actually partitioned');
  const helpers = partitioned.units.filter((entry) =>
    entry.name && entry.name.startsWith('jvmRegionSegment'));
  t.ok(helpers.some((helper) => helper.statements.some((statement) =>
    statement.text.includes('callee-middle') ||
    statement.text.includes('callee-exit'))),
  'a segment helper carries statements from inside the inserted body');
  // A run that carries one of the callee's exits carries a jump to a label
  // the caller declares. It may only be extracted when the jump is
  // re-established at the call site, which occupies the run's own block
  // position and therefore sees that label.
  const jumpedOut = helpers.filter((helper) =>
    renderRegionUnit(helper).includes('[0] = 3;'));
  if (jumpedOut.length) {
    t.ok(partitionedSource.includes(`break ${exitLabel};`),
      'an outward jump to the caller\'s exit label is re-established');
  } else {
    t.ok(true, 'no run carried an outward jump');
  }
  const original = compile(composedSource);
  const transformed = compile(partitionedSource);
  for (const seed of [0, 1, 7, 1000, -3]) {
    const expected = [];
    const actual = [];
    t.equal(transformed(seed, actual), original(seed, expected),
      `the partitioned composed body matches for seed=${seed}`);
    t.deepEqual(actual, expected,
      `the partitioned composed body's effect order matches for seed=${seed}`);
  }
  t.end();
});
