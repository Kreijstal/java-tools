'use strict';

const test = require('tape');
const { collectLinearExplicitCastRanges, splitCode } = require('../src/passes/splitConcreteObjectReachingLocal');

test('moves concrete object store to fresh local', (t) => {
  const code = {
    localsSize: '4',
    stackSize: '1',
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'invokestatic', arg: ['Method', 'x', ['objects', '()[Ljava/lang/Object;']] } },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'fd', ['a', '()Lmh;']] } },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'getfield', arg: ['Field', 'mh', ['mh_c', 'I']] } },
      { instruction: 'pop' },
      { instruction: 'aload_0' },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 1);
  t.equal(code.localsSize, '5');
  t.deepEqual(code.codeItems[3].instruction, { op: 'astore', arg: '4' });
  t.deepEqual(code.codeItems[4].instruction, { op: 'aload', arg: '4' });
  t.deepEqual(code.codeItems[8].instruction, { op: 'astore', arg: '3' });
  t.end();
});

test('does not move concrete object stores from locals also written as primitives', (t) => {
  const code = {
    localsSize: '4',
    stackSize: '1',
    codeItems: [
      { labelDef: 'L0:', instruction: 'iconst_0' },
      { instruction: { op: 'istore', arg: '3' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'fd', ['a', '()Lmh;']] } },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'getfield', arg: ['Field', 'mh', ['mh_c', 'I']] } },
      { instruction: 'pop' },
      { instruction: 'aload_0' },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 0);
  t.equal(code.localsSize, '4');
  t.end();
});

test('does not move concrete object stores used as method arguments', (t) => {
  const code = {
    localsSize: '4',
    stackSize: '2',
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'invokestatic', arg: ['Method', 'x', ['objects', '()[Ljava/lang/Object;']] } },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'sf', ['c', '()Ljava/lang/String;']] } },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'sink', ['a', '(Ljava/lang/String;)V']] } },
      { instruction: 'aload_0' },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 0);
  t.equal(code.localsSize, '4');
  t.end();
});

test('does not split away from a null store to the same local', (t) => {
  const code = {
    localsSize: '2',
    stackSize: '1',
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'aload', arg: '0' } },
      { instruction: { op: 'getfield', arg: ['Field', 'dg', ['dg_f', 'Lbe;']] } },
      { instruction: { op: 'astore', arg: '1' } },
      { instruction: { op: 'aload', arg: '1' } },
      { instruction: { op: 'putfield', arg: ['Field', 'dg', ['dg_g', 'Lbe;']] } },
      { instruction: 'aconst_null' },
      { instruction: { op: 'astore', arg: '1' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 0);
  t.equal(code.localsSize, '2');
  t.end();
});

test('moves constructed object store to fresh local', (t) => {
  const code = {
    localsSize: '4',
    stackSize: '2',
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'anewarray', arg: 'pb' } },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: { op: 'new', arg: 'pb' } },
      { instruction: 'dup' },
      { instruction: { op: 'invokespecial', arg: ['Method', 'pb', ['<init>', '()V']] } },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: { op: 'aload', arg: '3' } },
      { instruction: 'aload_1' },
      { instruction: { op: 'putfield', arg: ['Field', 'pb', ['pb_j', 'Ljava/lang/String;']] } },
      { instruction: 'aload_0' },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 1);
  t.equal(code.localsSize, '5');
  t.deepEqual(code.codeItems[5].instruction, { op: 'astore', arg: '4' });
  t.deepEqual(code.codeItems[6].instruction, { op: 'aload', arg: '4' });
  t.end();
});

test('moves copied concrete object store to fresh local', (t) => {
  const code = {
    localsSize: '5',
    stackSize: '2',
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'new', arg: 'pb' } },
      { instruction: 'dup' },
      { instruction: { op: 'invokespecial', arg: ['Method', 'pb', ['<init>', '()V']] } },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: { op: 'anewarray', arg: 'pb' } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: 'aload_1' },
      { instruction: { op: 'putfield', arg: ['Field', 'pb', ['pb_j', 'Ljava/lang/String;']] } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 1);
  t.equal(code.localsSize, '6');
  t.deepEqual(code.codeItems[7].instruction, { op: 'astore', arg: '5' });
  t.deepEqual(code.codeItems[8].instruction, { op: 'aload', arg: '5' });
  t.end();
});

test('moves adjacent duplicated object store to fresh local', (t) => {
  const code = {
    localsSize: '5',
    stackSize: '2',
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'anewarray', arg: 'pb' } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'new', arg: 'pb' } },
      { instruction: 'dup' },
      { instruction: { op: 'invokespecial', arg: ['Method', 'pb', ['<init>', '()V']] } },
      { instruction: 'dup' },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: 'aload_1' },
      { instruction: { op: 'putfield', arg: ['Field', 'pb', ['pb_j', 'Ljava/lang/String;']] } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 1);
  t.equal(code.localsSize, '6');
  t.deepEqual(code.codeItems[7].instruction, { op: 'astore', arg: '5' });
  t.deepEqual(code.codeItems[8].instruction, { op: 'aload', arg: '5' });
  t.end();
});

test('moves concrete object array store to fresh local', (t) => {
  const code = {
    localsSize: '3',
    stackSize: '5',
    codeItems: [
      { labelDef: 'L0:', instruction: 'iconst_2' },
      { instruction: { op: 'anewarray', arg: 'pb' } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: 'iconst_0' },
      { instruction: 'aload_0' },
      { instruction: { op: 'getfield', arg: ['Field', 'cb', ['cb_g', 'I']] } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'an', ['a', '([Ljava/lang/Object;II)V']] } },
      { instruction: 'aload_0' },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'putfield', arg: ['Field', 'cb', ['cb_f', '[Lpb;']] } },
      { instruction: 'aconst_null' },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 0, 'null merge still blocks array splitting');
  code.codeItems[11].instruction = 'aload_0';
  t.equal(splitCode(code), 1);
  t.equal(code.localsSize, '4');
  t.equal(code.codeItems[2].instruction, 'astore_3');
  t.equal(code.codeItems[3].instruction, 'aload_3');
  t.equal(code.codeItems[9].instruction, 'aload_3');
  t.deepEqual(code.codeItems[10].instruction, { op: 'checkcast', arg: '[Lpb;' });
  t.end();
});

test('collects explicit checkcast object ranges with later conflicting stores', (t) => {
  const code = {
    locals: '20',
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: { op: 'checkcast', arg: 'pi' } },
      { instruction: { op: 'astore', arg: '7' } },
      { instruction: { op: 'aload', arg: '7' } },
      { instruction: { op: 'getfield', arg: ['Field', 'pi', ['lc_i', 'I']] } },
      { instruction: 'pop' },
      { instruction: { op: 'invokestatic', arg: ['Method', 'x', ['sprites', '()[Lck;']] } },
      { instruction: { op: 'astore', arg: '7' } },
      { instruction: { op: 'aload', arg: '7' } },
      { instruction: 'arraylength' },
      { instruction: 'pop' },
      { instruction: 'return' },
    ],
  };

  const ranges = collectLinearExplicitCastRanges(code);
  t.equal(ranges.length, 1);
  t.equal(ranges[0].storeIndex, 2);
  t.equal(ranges[0].local, '7');
  t.equal(ranges[0].desc, 'Lpi;');
  t.equal(ranges[0].loadItems.length, 1);
  t.end();
});

test('splits explicit cast range through copied local used as typed method argument', (t) => {
  const code = {
    locals: '8',
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: { op: 'checkcast', arg: 'lk' } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'ifnull', arg: 'L1' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'getfield', arg: ['Field', 'lk', ['lk_jb', 'I']] } },
      { instruction: 'pop' },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: 'aload_1' },
      { instruction: { op: 'aload', arg: '5' } },
      { instruction: 'iconst_0' },
      { instruction: { op: 'bipush', arg: '-1' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'f', ['a', '(Llk;Llk;IB)I']] } },
      { instruction: 'pop' },
      { labelDef: 'L1:', instruction: { op: 'invokestatic', arg: ['Method', 'x', ['names', '()Ljava/lang/String;']] } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: 'pop' },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 1);
  t.equal(code.locals, '9');
  t.deepEqual(code.codeItems[2].instruction, { op: 'astore', arg: '8' });
  t.deepEqual(code.codeItems[3].instruction, { op: 'aload', arg: '8' });
  t.deepEqual(code.codeItems[5].instruction, { op: 'aload', arg: '8' });
  t.deepEqual(code.codeItems[8].instruction, { op: 'aload', arg: '8' });
  t.deepEqual(code.codeItems[9].instruction, { op: 'checkcast', arg: 'lk' });
  t.deepEqual(code.codeItems[10].instruction, { op: 'astore', arg: '5' });
  t.end();
});

test('splits loop-carried casted cursor before primitive local reuse', (t) => {
  const code = {
    locals: '8',
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'List', ['first', '()LBase;']] } },
      { instruction: { op: 'checkcast', arg: 'Item' } },
      { instruction: { op: 'astore', arg: '4' } },
      { labelDef: 'LTOP:', instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'ifnull', arg: 'LDONE' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: 'aload_1' },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'Item', ['draw', '(LCanvas;)V']] } },
      { instruction: 'aload_0' },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'List', ['next', '()LBase;']] } },
      { instruction: { op: 'checkcast', arg: 'Item' } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'goto', arg: 'LTOP' } },
      { labelDef: 'LDONE:', instruction: 'iconst_0' },
      { instruction: { op: 'istore', arg: '4' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code, { requireDominance: true, preserveOriginalLocals: true }), 2);
  t.equal(code.locals, '9');
  t.deepEqual(code.codeItems[3].instruction, { op: 'astore', arg: '8' });
  t.deepEqual(code.codeItems[4].instruction, { op: 'aload', arg: '8' });
  t.deepEqual(code.codeItems[6].instruction, { op: 'aload', arg: '8' });
  t.deepEqual(code.codeItems[12].instruction, { op: 'astore', arg: '8' });
  t.deepEqual(code.codeItems[15].instruction, { op: 'istore', arg: '4' });
  t.end();
});

test('splits casted object before same local is reused as reference array', (t) => {
  const code = {
    locals: '3',
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'List', ['first', '()Lksa;']] } },
      { instruction: { op: 'checkcast', arg: 'tj' } },
      { instruction: { op: 'astore', arg: '1' } },
      { instruction: { op: 'aload', arg: '1' } },
      { instruction: { op: 'bipush', arg: '1' } },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'tj', ['e', '(I)I']] } },
      { instruction: 'pop' },
      { instruction: { op: 'invokestatic', arg: ['Method', 'World', ['all', '()[Lsg;']] } },
      { instruction: { op: 'astore', arg: '1' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 1);
  t.equal(code.codeItems[2].instruction, 'astore_3');
  t.equal(code.codeItems[3].instruction, 'aload_3');
  t.deepEqual(code.codeItems[8].instruction, { op: 'astore', arg: '1' });
  t.end();
});
