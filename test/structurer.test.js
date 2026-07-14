'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { structure, printTree, IrreducibleError } = require('../src/decompiler/structurer');

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

test('straight-line diamond (if/else join) needs a labeled block', () => {
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
  assert.match(src, /L3: \{/);      // block around the merge
  assert.match(src, /break L3;/);   // both arms break to it
  assert.equal((src.match(/break L3;/g) || []).length, 2);
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
  assert.match(src, /L4: \{/);          // merge node 4
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
