'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { structure, printTree, uniquifyLabels, IrreducibleError } = require('../src/decompiler/structurer');

// Build a CFG from a compact description. Each block: { term }.
function cfgFrom(blocks) {
  const succ = blocks.map((b) => succOf(b.term));
  return { n: blocks.length, entry: 0, succ, term: blocks.map((b) => b.term) };
}
function succOf(term) {
  switch (term.kind) {
    case 'return': return [];
    case 'goto': case 'fall': return [term.target];
    case 'cond': return term.taken === term.fall ? [term.taken] : [term.taken, term.fall];
    case 'switch': return [...new Set([...term.cases.map((c) => c.target), ...(term.default != null ? [term.default] : [])])];
    default: throw new Error('bad term');
  }
}

function assertGotoFree(src) {
  assert.ok(!/\bgoto\b/.test(src), `expected no goto in:\n${src}`);
}

// Assert every break/continue resolves to an enclosing label of the right kind.
function assertLabelsResolve(src) {
  const lines = src.split('\n');
  const loopLabels = [];   // stack of {label, indent}
  const blockLabels = [];
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    // pop frames that closed
    const closed = /^\s*}\s*$/.test(line);
    const m = line.match(/^\s*(L\d+):\s*(while \(true\) \{|\{)/);
    if (m) {
      if (m[2].startsWith('while')) loopLabels.push({ label: m[1], indent });
      else blockLabels.push({ label: m[1], indent });
    }
    const br = line.match(/^\s*break (L\d+);/);
    if (br) assert.ok(blockLabels.some((f) => f.label === br[1]) || loopLabels.some((f) => f.label === br[1]),
      `break ${br[1]} has no enclosing label:\n${src}`);
    const co = line.match(/^\s*continue (L\d+);/);
    if (co) assert.ok(loopLabels.some((f) => f.label === co[1]),
      `continue ${co[1]} has no enclosing loop:\n${src}`);
    if (closed) {
      while (loopLabels.length && loopLabels[loopLabels.length - 1].indent >= indent) loopLabels.pop();
      while (blockLabels.length && blockLabels[blockLabels.length - 1].indent >= indent) blockLabels.pop();
    }
  }
}

// The structurer may always fall back on `L: { ... break L; }` around a merge;
// it is correct, just not what a Java compiler emitted. Where the shape is
// avoidable these tests pin that it *was* avoided.
function assertNoLabeledBlock(src) {
  const m = src.match(/^\s*L\d+:\s*\{/m);
  assert.equal(m, null, `expected no labeled block in:\n${src}`);
}

test('straight-line diamond (if/else join) emits the merge once, unlabeled', () => {
  // 0: if -> 1 else 2 ; 1: goto 3 ; 2: goto 3 ; 3: return   (3 is the merge)
  const cfg = cfgFrom([
    { term: { kind: 'cond', taken: 1, fall: 2 } },
    { term: { kind: 'goto', target: 3 } },
    { term: { kind: 'goto', target: 3 } },
    { term: { kind: 'return' } },
  ]);
  const { tree } = structure(cfg);
  const src = printTree(tree);
  assertGotoFree(src);
  assertLabelsResolve(src);
  // The merge is what the structuring has to get right: block 3 dominates
  // nothing but is reached from both arms, so it must appear exactly once,
  // after the join - never duplicated into each arm.
  assert.equal((src.match(/stmt_3\(\);/g) || []).length, 1);
  assert.match(src, /^stmt_0\(\);\nif \(c0\) \{\n {2}stmt_1\(\);\n\} else \{\n {2}stmt_2\(\);\n\}\nstmt_3\(\);$/);
  // A diamond needs no labeled block. Wrapping the merge in `L3: { ... }` and
  // breaking to it from both arms is correct but is not what javac emitted, so
  // dropTailBreaks unwraps it; guard against that regressing.
  assertNoLabeledBlock(src);
});

test('exception region loop exits require an explicit target and transfer mode', () => {
  const src = printTree({
    t: 'loop',
    label: 'L0',
    body: {
      t: 'seq',
      body: [
        { t: 'straight', block: 0 },
        { t: 'regionExit', label: 'L0', mode: 'break' },
      ],
    },
  });
  assert.match(src, /break L0;/);
  for (const exit of [{t: 'regionExit'}, {t: 'regionExit', mode: 'normal'},
    {t: 'regionExit', label: 'missing', mode: 'break'},
    {t: 'regionExit', label: 'L0', mode: 'return'}]) {
    assert.throws(() => printTree({t: 'loop', label: 'L0', body: exit}),
      /requires an explicit enclosing loop and transfer mode/);
  }
  for (const mode of ['break', 'continue']) {
    const nested = printTree({t: 'loop', label: 'Outer', body: {
      t: 'loop', label: 'Inner', body: {t: 'regionExit', label: 'Outer', mode},
    }});
    assert.match(nested, new RegExp(`${mode} Outer;`));
    assert.doesNotMatch(nested, new RegExp(`${mode} Inner;`));
  }
});

test('an ordinary empty if arm inside a loop does not infer a loop exit', () => {
  const tree = { t: 'loop', label: 'L0', body: { t: 'seq', body: [
    { t: 'if', block: 0, then: { t: 'seq', body: [] }, els: { t: 'straight', block: 1 } },
    { t: 'straight', block: 2 }, { t: 'continue', label: 'L0' },
  ] } };
  const src = printTree(tree);
  assert.doesNotMatch(src, /break L0;/);
  assert.match(src, /stmt_2\(\);\n\s*continue L0;/);
});

test('an explicit region loop exit cannot resolve through a shadowing block', () => {
  for (const mode of ['break', 'continue']) {
    const tree = {t: 'loop', label: 'Same', body: {
      t: 'block', label: 'Same', body: {t: 'regionExit', label: 'Same', mode},
    }};
    assert.throws(() => printTree(tree), /requires an explicit enclosing loop and transfer mode/);
    assert.throws(() => uniquifyLabels(tree), /requires an explicit enclosing loop and transfer mode/);
  }
});

test('label uniquification preserves explicit region loop exits', () => {
  const tree = {t: 'loop', label: 'Outer', body: {
    t: 'loop', label: 'Inner', body: {t: 'regionExit', label: 'Outer', mode: 'continue'},
  }};
  uniquifyLabels(tree);
  assert.match(printTree(tree), /continue L0;/);
});

test('a continue to a block is refused before label uniquification', () => {
  const tree = {t: 'loop', label: 'Same', body: {
    t: 'block', label: 'Same', body: {t: 'continue', label: 'Same'},
  }};
  assert.throws(() => uniquifyLabels(tree), /continue target Same is not a loop/);
});

test('printing a control tree repeatedly does not mutate its exits', () => {
  const tree = structure(cfgFrom([
    { term: { kind: 'fall', target: 1 } },
    { term: { kind: 'cond', taken: 2, fall: 3 } },
    { term: { kind: 'goto', target: 3 } },
    { term: { kind: 'cond', taken: 1, fall: 4 } },
    { term: { kind: 'return' } },
  ])).tree;
  const original = JSON.stringify(tree);
  const once = printTree(tree);
  assert.equal(JSON.stringify(tree), original);
  assert.equal(printTree(tree), once);
});

test('simple while loop uses continue to the header', () => {
  // 0: fall 1 ; 1(header): if taken 1 (back) else 2 ; 2: return
  const cfg = cfgFrom([
    { term: { kind: 'fall', target: 1 } },
    { term: { kind: 'cond', taken: 1, fall: 2 } },
    { term: { kind: 'return' } },
  ]);
  const { tree } = structure(cfg);
  const src = printTree(tree);
  assertGotoFree(src);
  assertLabelsResolve(src);
  assert.match(src, /L1: while \(true\) \{/);
  assert.match(src, /continue L1;/);
});

test('loop with a merge inside and an exit break', () => {
  // 0 -> 1(header)
  // 1: if -> 2 else 3
  // 2: goto 4
  // 3: goto 4
  // 4: if -> 1 (back) else 5
  // 5: return
  const cfg = cfgFrom([
    { term: { kind: 'fall', target: 1 } },
    { term: { kind: 'cond', taken: 2, fall: 3 } },
    { term: { kind: 'goto', target: 4 } },
    { term: { kind: 'goto', target: 4 } },
    { term: { kind: 'cond', taken: 1, fall: 5 } },
    { term: { kind: 'return' } },
  ]);
  const { tree } = structure(cfg);
  const src = printTree(tree);
  assertGotoFree(src);
  assertLabelsResolve(src);
  assert.match(src, /L1: while \(true\) \{/);
  assert.match(src, /continue L1;/);   // back edge 4->1
  // Merge node 4 is reached from both arms of the if at 1, so it must be
  // emitted once, after the join - and inside the loop, since 4 carries the
  // back edge. It needs no label of its own once the tail breaks are dropped.
  assert.equal((src.match(/stmt_4\(\);/g) || []).length, 1);
  assert.match(src, /\n {2}stmt_4\(\);\n {2}if \(c4\) \{\n {4}continue L1;/);
  assertNoLabeledBlock(src);
});

test('switch structures each case without goto', () => {
  // 0: switch {0->1, 1->2, default->3} ; 1,2 -> 4 ; 3 -> 4 ; 4: return
  const cfg = cfgFrom([
    { term: { kind: 'switch', cases: [{ key: 0, target: 1 }, { key: 1, target: 2 }], default: 3 } },
    { term: { kind: 'goto', target: 4 } },
    { term: { kind: 'goto', target: 4 } },
    { term: { kind: 'goto', target: 4 } },
    { term: { kind: 'return' } },
  ]);
  const { tree } = structure(cfg);
  const src = printTree(tree);
  assertGotoFree(src);
  assertLabelsResolve(src);
  assert.match(src, /switch \(/);
  assert.equal((src.match(/break L4;/g) || []).length, 3);
});

test('irreducible CFG is rejected with IrreducibleError', () => {
  // classic two-entry loop: 0 -> 1 or 2 ; 1<->2 ; exits
  // 0: if -> 2 else 1
  // 1: if -> 2 else 3   (1 -> 2)
  // 2: if -> 1 else 4   (2 -> 1 forms the irreducible cycle: entered at both 1 and 2)
  // 3: return ; 4: return
  const cfg = cfgFrom([
    { term: { kind: 'cond', taken: 2, fall: 1 } },
    { term: { kind: 'cond', taken: 2, fall: 3 } },
    { term: { kind: 'cond', taken: 1, fall: 4 } },
    { term: { kind: 'return' } },
    { term: { kind: 'return' } },
  ]);
  assert.throws(() => structure(cfg), IrreducibleError);
});

test('nested loops resolve continues to the correct headers', () => {
  // 0 -> 1(outer header)
  // 1: fall 2(inner header)
  // 2: if -> 2 (inner back) else 3
  // 3: if -> 1 (outer back) else 4
  // 4: return
  const cfg = cfgFrom([
    { term: { kind: 'fall', target: 1 } },
    { term: { kind: 'fall', target: 2 } },
    { term: { kind: 'cond', taken: 2, fall: 3 } },
    { term: { kind: 'cond', taken: 1, fall: 4 } },
    { term: { kind: 'return' } },
  ]);
  const { tree } = structure(cfg);
  const src = printTree(tree);
  assertGotoFree(src);
  assertLabelsResolve(src);
  assert.match(src, /L1: while \(true\) \{/);
  assert.match(src, /L2: while \(true\) \{/);
  assert.match(src, /continue L2;/);
  assert.match(src, /continue L1;/);
});

test('uniquifyCatchParameters renames nested catch parameters', () => {
  const { uniquifyCatchParameters } = require('../src/decompiler/structurer');
  // try { } catch (IOException P) { try { } catch (Exception P) { } }
  // Inner P re-declares a name still in scope from the outer catch — javac
  // rejects it. After the pass, every catch varName is unique.
  const tree = {
    t: 'try',
    body: { t: 'seq', body: [] },
    catches: [{
      type: 'java.io.IOException', varName: 'e', carrierName: 'carrier',
      body: {
        t: 'try',
        body: { t: 'seq', body: [] },
        catches: [{ type: 'java.lang.Exception', varName: 'e', carrierName: 'carrier', body: { t: 'seq', body: [] } }],
      },
    }],
  };
  uniquifyCatchParameters(tree);
  const outer = tree.catches[0].varName;
  const inner = tree.catches[0].body.catches[0].varName;
  assert.notEqual(outer, inner, `nested catch params must differ, got ${outer}/${inner}`);
});
