'use strict';

// Regression tests for src/decompiler/loopTailMerge.js: a loop whose latch
// (`iinc counter; goto head`) was tail-duplicated into both arms of an `if`
// inside the body must decompile to ONE increment (a plain counted `for`),
// not to a `while (true)` with `counter++; continue;` in every arm. The shape is
// the one FunOrb's Geoblox `dm.b([I[IIIIIIII)V` transparent blit ends up in
// after the bytecode pipeline's `cloneSharedLoopIncrementTails`, and the same
// shape obfuscators produce by hand.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('tape');
const { assembleJasminSource } = require('../src/utils/jasminAssembly');
const { decompileClassFile } = require('../src/decompiler/cfr');
const { mergeDuplicateLoopIncrementTails } = require('../src/decompiler/loopTailMerge');

// for (i = -n; i < 0; i++) { v = src[so++]; if (v != 0) dst[do++] = v; else do++; }
// with the latch `iinc 3 1; goto Lhead` present in BOTH arms. In the else arm
// the latch is preceded by a further `iinc 4 1`, so the two copies share only a
// suffix (`iinc 3 1; goto`), exactly like the original gamepack method.
const DUPLICATED_LATCH = `.version 52 0
.class public super TailMerge
.super java/lang/Object

.method public static copy : ([I[II)I
    .code stack 4 locals 7
L0: iload_2
L1: ineg
L2: istore_3
L3: iconst_0
L4: istore 4
L6: iconst_0
L7: istore 6
Lhead: iload_3
L10: ifge Lexit
L13: aload_1
L14: iload 6
L16: iinc 6 1
L19: iaload
L20: istore 5
L22: iload 5
L24: ifeq Lelse
L27: aload_0
L28: iload 4
L30: iinc 4 1
L33: iload 5
L35: iastore
L36: iinc 3 1
L39: goto Lhead
Lelse: iinc 4 1
L45: iinc 3 1
L48: goto Lhead
Lexit: iload 4
L53: ireturn
    .end code
.end method
.end class
`;

function decompileFixture(tempDir, name, source) {
  const classFile = path.join(tempDir, `${name}.class`);
  assembleJasminSource(source, classFile);
  return decompileClassFile(classFile);
}

test('tail-duplicated loop latch decompiles to a single counted for loop', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-loop-tail-merge-'));
  try {
    const source = decompileFixture(tempDir, 'TailMerge', DUPLICATED_LATCH);
    const body = source.slice(source.indexOf('static int copy('));
    t.ok(body.length > 0, 'method found');
    const loopHeader = /(?:for \((\w+) = -param2; \1 < 0; \1\+\+\)|while \((\w+) < 0\))/.exec(body);
    t.ok(loopHeader, `loop counter drives a plain counted loop: ${body.split('\n').find((l) => l.includes('for (') || l.includes('while (')) || '<no loop>'}`);
    if (loopHeader) {
      const counter = loopHeader[1] || loopHeader[2];
      const increments = (body.match(new RegExp(`\\b${counter}\\+\\+`, 'g')) || []).length;
      t.equal(increments, 1, 'loop counter is incremented exactly once in the source');
    }
    t.notOk(/continue/.test(body), 'no continue statements survive the merge');
    t.notOk(/while \(true\)/.test(body), 'no while(true) state loop is emitted');

    // Behaviour check: recompile the decompiled source and compare against
    // the original semantics (copy non-zero pixels, always advance dst).
    fs.writeFileSync(path.join(tempDir, 'TailMerge.java'), source);
    fs.writeFileSync(path.join(tempDir, 'TailMergeRunner.java'),
      'import java.util.Arrays; public class TailMergeRunner { public static void main(String[] a) {' +
      'int[] dst = new int[]{9, 9, 9, 9, 9, 9}; int[] src = new int[]{1, 0, 3, 0, 0, 6};' +
      'int r = TailMerge.copy(dst, src, 6); System.out.print(r + ":" + Arrays.toString(dst)); } }');
    execFileSync('javac', ['-g:none', '-d', tempDir,
      path.join(tempDir, 'TailMerge.java'), path.join(tempDir, 'TailMergeRunner.java')]);
    t.equal(execFileSync('java', ['-cp', tempDir, 'TailMergeRunner'], { encoding: 'utf8', timeout: 10000 }),
      '6:[1, 9, 3, 9, 9, 6]', 'recompiled source behaves like the original bytecode');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});

// Direct unit tests on code items, using the parser's convention that every
// instruction carries an `L<pc>:` labelDef whether or not anything targets it.
function items(list) {
  return list.map(([label, instruction]) => ({ labelDef: `${label}:`, instruction }));
}
function iinc(varnum, incr) { return { op: 'iinc', varnum: String(varnum), incr: String(incr) }; }
function shape(codeItems) {
  return codeItems.map((item) => {
    const insn = item.instruction;
    const text = typeof insn === 'string' ? insn : `${insn.op} ${insn.arg ?? `${insn.varnum} ${insn.incr}`}`;
    return `${item.labelDef} ${text}`;
  });
}

test('mergeDuplicateLoopIncrementTails shares only the common suffix and keeps layout order', (t) => {
  const code = {
    codeItems: items([
      ['L0', 'iload_3'],
      ['L1', { op: 'ifge', arg: 'L20' }],
      ['L4', 'iload_2'],
      ['L5', { op: 'ifeq', arg: 'L14' }],
      ['L8', 'iastore'],
      ['L9', iinc(3, 1)],
      ['L12', { op: 'goto', arg: 'L0' }],
      ['L14', iinc(4, 1)],
      ['L15', iinc(3, 1)],
      ['L18', { op: 'goto', arg: 'L0' }],
      ['L20', 'return'],
    ]),
    exceptionTable: [],
  };
  t.equal(mergeDuplicateLoopIncrementTails(code), 1, 'one duplicate tail merged');
  t.deepEqual(shape(code.codeItems), [
    'L0: iload_3',
    'L1: ifge L20',
    'L4: iload_2',
    'L5: ifeq L14',
    'L8: iastore',
    'L9: goto L15',
    'L12: nop',
    'L14: iinc 4 1',
    'L15: iinc 3 1',
    'L18: goto L0',
    'L20: return',
  ], 'the earlier copy jumps to the shared suffix of the last copy; iinc 4 1 is not shared');
  t.end();
});

test('mergeDuplicateLoopIncrementTails never swallows a referenced label inside a duplicate', (t) => {
  const code = {
    codeItems: items([
      ['L0', 'iload_3'],
      ['L1', { op: 'ifge', arg: 'L20' }],
      ['L4', 'iload_2'],
      ['L5', { op: 'ifeq', arg: 'L14' }],
      ['L6', 'iload_2'],
      ['L7', { op: 'ifgt', arg: 'L11' }], // enters the first copy between its two iincs
      ['L8', iinc(4, 1)],
      ['L11', iinc(3, 1)],
      ['L12', { op: 'goto', arg: 'L0' }],
      ['L14', iinc(4, 1)],
      ['L15', iinc(3, 1)],
      ['L18', { op: 'goto', arg: 'L0' }],
      ['L20', 'return'],
    ]),
    exceptionTable: [],
  };
  t.equal(mergeDuplicateLoopIncrementTails(code), 1, 'one duplicate tail merged');
  t.deepEqual(shape(code.codeItems), [
    'L0: iload_3',
    'L1: ifge L20',
    'L4: iload_2',
    'L5: ifeq L14',
    'L6: iload_2',
    'L7: ifgt L11',
    'L8: iinc 4 1',
    'L11: goto L15',
    'L12: nop',
    'L14: iinc 4 1',
    'L15: iinc 3 1',
    'L18: goto L0',
    'L20: return',
  ], 'the shared suffix starts at the jump target, so `ifgt L11` still increments only the counter');
  t.end();
});

test('mergeDuplicateLoopIncrementTails leaves forward gotos and single tails alone', (t) => {
  const code = {
    codeItems: items([
      ['L0', iinc(1, 1)],
      ['L3', { op: 'goto', arg: 'L10' }],
      ['L6', iinc(1, 1)],
      ['L9', { op: 'goto', arg: 'L10' }],
      ['L10', 'return'],
    ]),
    exceptionTable: [],
  };
  const before = shape(code.codeItems);
  t.equal(mergeDuplicateLoopIncrementTails(code), 0, 'forward gotos are not loop latches');
  t.deepEqual(shape(code.codeItems), before, 'code untouched');
  t.end();
});
