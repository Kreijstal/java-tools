'use strict';

const test = require('tape');
const { parseKrak2Assembly } = require('../src/parse_krak2');
const { convertKrak2AstToClassAst } = require('../src/convert_krak2_ast');
const { evaluateCounterLoops } = require('../src/evaluateCounterLoops');
const { normalizeInstruction } = require('../src/utils/instructionUtils');

function buildAstFromJasmin(source) {
  const parsed = parseKrak2Assembly(source);
  return convertKrak2AstToClassAst(parsed, { sourceText: source });
}

function getMethodCodeItems(ast, className, methodName) {
  const cls = ast.classes.find((c) => c.className === className);
  if (!cls) return null;
  const item = cls.items.find(
    (entry) => entry.type === 'method' && entry.method && entry.method.name === methodName,
  );
  if (!item) return null;
  const codeAttr = item.method.attributes.find((attr) => attr.type === 'code');
  if (!codeAttr) return null;
  return codeAttr.code.codeItems;
}

test('evaluateCounterLoops precomputes factorial example', (t) => {
  const jasmin = `
.class public FactConst
.super java/lang/Object

.method public static main : ()V
    .code stack 2 locals 4
L0:    bipush 10
L2:    istore_1
L3:    iconst_1
L4:    istore_2
L5:    iconst_2
L6:    istore_3
L7:    iload_3
L8:    iload_1
L9:    if_icmpgt L22
L12:    iload_2
L13:    iload_3
L14:    imul
L15:    istore_2
L16:    iinc 3 1
L19:    goto L7
L22:    getstatic Field java/lang/System out Ljava/io/PrintStream;
L25:    iload_2
L26:    invokevirtual Method java/io/PrintStream println (I)V
L29:    return
    .end code
.end method
.end class
`.trim();

  const ast = buildAstFromJasmin(jasmin);
  const result = evaluateCounterLoops(ast);
  t.ok(result.changed, 'pass should report changes');
  const codeItems = getMethodCodeItems(ast, 'FactConst', 'main');
  const instructions = codeItems.map((item) => item.instruction).filter(Boolean);
  t.notOk(
    instructions.some((instr) => typeof instr === 'object' && instr.op === 'if_icmpgt'),
    'loop branch should be removed',
  );
  t.notOk(
    instructions.some((instr) => typeof instr === 'object' && instr.op === 'goto'),
    'loop goto should be removed',
  );
  const ldcIndex = instructions.findIndex(
    (instr) => typeof instr === 'object' && instr.op === 'ldc',
  );
  t.ok(ldcIndex !== -1, 'ldc should be inserted');
  t.same(instructions[ldcIndex], { op: 'ldc', arg: '3628800' }, 'ldc value should be factorial result');
  t.end();
});

test('evaluateCounterLoops leaves unsupported loops untouched', (t) => {
  const jasmin = `
.class public Weird
.super java/lang/Object

.method public static loop : ()V
    .code stack 1 locals 1
L0:    iconst_0
L1:    istore_0
L2:    iload_0
L3:    bipush 5
L4:    if_icmpgt L12
L7:    invokestatic Method Weird sideEffect ()V
L10:   goto L2
L12:   return
    .end code
.end method
.end class
`.trim();

  const ast = buildAstFromJasmin(jasmin);
  const result = evaluateCounterLoops(ast);
  t.notOk(result.changed, 'loops with unsupported instructions should remain');
  const codeItems = getMethodCodeItems(ast, 'Weird', 'loop');
  const branchCount = codeItems.filter(
    (item) => item.instruction && normalizeInstruction(item.instruction)?.op === 'if_icmpgt',
  ).length;
  t.equal(branchCount, 1, 'branch should still exist');
  t.end();
});
