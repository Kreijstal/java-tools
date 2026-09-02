const test = require('tape');
const { parse } = require('acorn');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');

// The renderer publishes a statement-level fragment list for each positional
// body it emits, so a consumer can outline, partition or environment-lift a
// body by selecting fragments instead of re-parsing the generated JavaScript.
// These assertions pin the contract that consumer depends on.

function compileJavaFixture(t, className, source) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fragment-fixture-'));
  t.teardown(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const sourcePath = path.join(tempDir, `${className}.java`);
  fs.writeFileSync(sourcePath, source);
  execFileSync('javac', ['-g', '-d', tempDir, sourcePath], { stdio: 'inherit' });
  return tempDir;
}

const DIRECTIVE = "'use strict';\n";

function bodyOf(source) {
  return source.startsWith(DIRECTIVE) ? source.slice(DIRECTIVE.length) : source;
}

async function compileMethod(t, className, source, methodName, descriptor) {
  const classpath = compileJavaFixture(t, className, source);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, structuredSsa: true,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, methodName, descriptor);
  return jvm.jit.structuredSsa.compile(method);
}

test('published region fragments reassemble a looping positional body',
  async (t) => {
    const className = 'FragmentLoopHarness';
    const generated = await compileMethod(t, className, `
public final class FragmentLoopHarness {
  static void scale(int[] data, int count, int factor) {
    for (int index = 0; index < count; index += 1) {
      data[index] = data[index] * factor;
    }
  }
}
`, 'scale', '([III)V');
    const fragments = generated?.jvmStructuredRegionFragments;
    t.ok(fragments, 'the renderer publishes region fragments');
    const variant = 'jvmRestoringDirectPositionalSource';
    t.ok(Array.isArray(fragments[variant]),
      'the restoring positional body publishes a fragment list');
    const list = fragments[variant];
    t.equal(list.flatMap((fragment) => fragment.lines).join('\n'),
      bodyOf(generated[variant]),
      'the fragments joined in order are exactly the published source');
    const loops = list.filter((fragment) => fragment.kind === 'loop');
    t.ok(loops.length >= 1, 'the guest loop is its own fragment');
    for (const loop of loops) {
      t.ok(loop.lines.length > 2, 'a loop fragment carries its whole body');
      t.ok(loop.lines[0].trim().includes('while ('),
        'a loop fragment starts at the loop header');
      t.equal(loop.lines[loop.lines.length - 1].trim(), '}',
        'a loop fragment ends at the matching close');
      let depth = 0;
      for (const line of loop.lines) {
        depth += (line.match(/\{/g) || []).length -
          (line.match(/\}/g) || []).length;
      }
      t.equal(depth, 0, 'a loop fragment is balanced');
      t.ok(loop.reads.some((name) => /^local\d+$/.test(name)),
        'a loop fragment reports the enclosing locals it reads');
    }
    t.ok(list.some((fragment) => fragment.reads.includes('helpers')),
      'the fragments report the ambient names the body needs');
    const declared = new Set(list.flatMap((fragment) => fragment.declares));
    for (const fragment of list) {
      for (const name of fragment.declares) {
        t.notOk(fragment.reads.includes(name),
          `${name} is introduced by its own fragment, not read into it`);
      }
    }
    // Every line publishes the statement record behind it, so a consumer
    // relocates statements by rewriting parts lists instead of characters.
    for (const fragment of list) {
      t.equal(fragment.statements.length, fragment.lines.length,
        'every fragment line publishes its statement record');
      for (let index = 0; index < fragment.lines.length; index += 1) {
        const statement = fragment.statements[index];
        t.equal(statement.text, fragment.lines[index],
          'a published statement carries its own emitted line');
        if (statement.parts) {
          t.equal(statement.parts.map((part) => typeof part === 'string'
            ? part
            : part.label !== undefined ? part.label
              : (part.text === undefined ? part.ref : part.text))
            .join('').trim(),
          fragment.lines[index].trim(),
          'a published parts list renders the line it belongs to');
        }
      }
    }
    // A relocatable unit is balanced; the linear runs between them need not
    // be (the restoring tier's own wrapper opens in one of them).
    for (const fragment of list) {
      if (fragment.kind !== 'loop' && fragment.kind !== 'try') continue;
      let nesting = 0;
      for (const statement of fragment.statements) nesting += statement.delta;
      t.equal(nesting, 0, 'the published block deltas balance a unit');
    }
    const loopFragment = list.find((fragment) => fragment.kind === 'loop');
    t.equal(loopFragment.statements[0].opens, 'loop',
      'a loop fragment opens with the loop header it was cut at');
    t.ok(loopFragment.statements.every((statement) => statement.relocatable ||
      statement.parts === null),
    'a relocatable loop keeps every statement rewritable');
    const names = generated.jvmStructuredRegionLocalNames?.[variant];
    t.ok(names, 'the renderer publishes the body-level declaration names');
    for (const name of names.declared) {
      t.ok(declared.has(name),
        `${name} is declared by one of the published fragments`);
      t.ok(names.kinds[name] === 'let' || names.kinds[name] === 'const',
        `${name} publishes its declaration kind`);
    }
    t.end();
  });

test('published region fragments keep a try/catch in one fragment',
  async (t) => {
    const className = 'FragmentTryHarness';
    const generated = await compileMethod(t, className, `
public final class FragmentTryHarness {
  static int guarded(int[] data, int index) {
    int[] copy = new int[index];
    copy[0] = data[0];
    return copy[0];
  }
}
`, 'guarded', '([II)I');
    const fragments = generated?.jvmStructuredRegionFragments || {};
    const variant = 'jvmRestoringDirectPositionalSource';
    const list = fragments[variant];
    t.ok(Array.isArray(list),
      'the restoring positional body publishes a fragment list');
    t.equal(list.flatMap((fragment) => fragment.lines).join('\n'),
      bodyOf(generated[variant]),
      'the fragments joined in order are exactly the published source');
    const tries = list.filter((fragment) => fragment.kind === 'try');
    t.ok(tries.length >= 1,
      'the guest allocation try/catch is one fragment');
    for (const fragment of tries) {
      t.ok(fragment.lines[0].trim().startsWith('try {'),
        'a try fragment starts at its own `try {`');
      let depth = 0;
      for (const line of fragment.lines) {
        depth += (line.match(/\{/g) || []).length -
          (line.match(/\}/g) || []).length;
      }
      t.equal(depth, 0, 'a try fragment is balanced');
    }
    t.end();
  });

// An independent reading of a fragment's own text, used only to check the
// published name sets. The renderer states them from the records its emitters
// built; this oracle recovers them from the syntax, and the two have to
// agree, or a consumer that outlines the fragment would leave a name unbound
// or fail to write one back.
function analyseFragment(text) {
  let program;
  try {
    program = parse(`function* __unit(){\n${text}\n}`,
      { ecmaVersion: 'latest', ranges: true, allowReturnOutsideFunction: true });
  } catch (_error) {
    return null;
  }
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
  const names = (pattern, into) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') into.add(pattern.name);
    else if (pattern.type === 'RestElement') names(pattern.argument, into);
    else if (pattern.type === 'AssignmentPattern') names(pattern.left, into);
    else if (pattern.type === 'ArrayPattern') {
      for (const element of pattern.elements) names(element, into);
    } else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        names(property.value || property.argument, into);
      }
    }
  };
  const declared = new Set();
  const read = new Set();
  const written = new Set();
  const labels = new Set();
  const visit = (node, parent) => {
    if (node.type === 'VariableDeclarator') names(node.id, declared);
    else if (isFunction(node)) {
      if (node.id) declared.add(node.id.name);
      for (const parameter of node.params || []) names(parameter, declared);
    } else if (node.type === 'CatchClause') names(node.param, declared);
    else if (node.type === 'LabeledStatement') labels.add(node.label.name);
    if (node.type === 'AssignmentExpression') names(node.left, written);
    if (node.type === 'UpdateExpression' &&
        node.argument?.type === 'Identifier') {
      written.add(node.argument.name);
    }
    if (node.type === 'Identifier') {
      const property = parent?.type === 'MemberExpression' &&
        parent.property === node && !parent.computed ||
        (parent?.type === 'Property' || parent?.type === 'MethodDefinition') &&
          parent.key === node && !parent.computed && !parent.shorthand;
      const label = (parent?.type === 'LabeledStatement' ||
        parent?.type === 'BreakStatement' ||
        parent?.type === 'ContinueStatement') && parent.label === node;
      if (!property && !label) read.add(node.name);
    }
    for (const child of childrenOf(node)) visit(child, node);
  };
  visit(program.body[0].body, null);
  return { declared, read, written, labels };
}

// Host globals and the module-level captures a generated body closes over.
// Neither is a name an outlined unit has to receive.
const AMBIENT_HOSTS = new Set(['Math', 'Number', 'Array', 'ArrayBuffer',
  'JSON', 'Object', 'String', 'Boolean', 'undefined', 'NaN', 'Infinity',
  'BigInt', 'Symbol', 'Error', 'isNaN', 'parseInt', 'parseFloat', 'Date',
  'Map', 'Set', 'WeakMap', 'globalThis', 'Function', 'RegExp', 'Promise',
  'ssaReturnVoid', 'ssaAsyncInvoke']);

test('published fragment names agree with the fragment\'s own syntax',
  async (t) => {
    const className = 'FragmentNameHarness';
    const repeated = Array.from({ length: 12 },
      () => 'sum += data[index];').join('\n      ');
    const generated = await compileMethod(t, className, `
public final class ${className} {
  static int scan(int[] data, int count) {
    int sum = 0;
    for (int index = 0; index < count; index++) {
      ${repeated}
      sum += 100 / data[index];
      if (data[index] == 99) return sum;
    }
    return sum;
  }
}
`, 'scan', '([II)I');
    let checked = 0;
    for (const [variant, list] of Object.entries(
      generated.jvmStructuredRegionFragments || {})) {
      for (const fragment of list) {
        const analysis = analyseFragment(fragment.lines.join('\n'));
        // A linear run need not be a complete program on its own (the
        // restoring tier's wrapper opens in one); only self-contained
        // fragments can be cross-checked.
        if (!analysis) continue;
        const declared = new Set(fragment.declares);
        const free = [...analysis.read].filter((name) =>
          !declared.has(name) && !analysis.labels.has(name) &&
          !AMBIENT_HOSTS.has(name));
        const missingReads = free.filter(
          (name) => !fragment.reads.includes(name));
        const missingWrites = [...analysis.written].filter((name) =>
          !declared.has(name) && !AMBIENT_HOSTS.has(name) &&
          !fragment.writes.includes(name));
        t.deepEqual(missingReads, [],
          `${variant} #${fragment.id} reports every free name it reads`);
        t.deepEqual(missingWrites, [],
          `${variant} #${fragment.id} reports every enclosing name it writes`);
        for (const name of fragment.writes) {
          t.ok(fragment.reads.includes(name),
            `${variant} #${fragment.id} binds ${name} as well as writing it`);
        }
        checked += 1;
      }
    }
    t.ok(checked > 0, 'the harness publishes fragments to cross-check');
    t.end();
  });
