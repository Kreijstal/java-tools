'use strict';

const test = require('tape');
const { runSplitTypedReusedLocals } = require('../src/passes/splitTypedReusedLocals');

function astWith(codeItems) {
  return {
    classes: [{
      className: 'Demo',
      items: [{
        type: 'method',
        method: {
          name: 'f',
          descriptor: '()V',
          attributes: [{
            type: 'code',
            code: {
              localsSize: '2',
              codeItems,
              exceptionTable: [],
              attributes: [],
            },
          }],
        },
      }],
    }],
  };
}

function codeItems(ast) {
  return ast.classes[0].items[0].method.attributes[0].code.codeItems;
}

function opsAndArgs(ast) {
  return codeItems(ast)
    .filter((item) => item && item.instruction)
    .map((item) => {
      const insn = item.instruction;
      if (typeof insn === 'string') return insn;
      return `${insn.op} ${insn.arg}`;
    });
}

test('split-typed-reused-locals: separates reused object and float-array definitions', (t) => {
  const ast = astWith([
    { instruction: { op: 'aload', arg: '0' } },
    { instruction: { op: 'checkcast', arg: 'opa' } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: { op: 'getfield', arg: ['Field', 'opa', ['opa_q', 'I']] } },
    { instruction: 'pop' },
    { instruction: 'iconst_3' },
    { instruction: { op: 'newarray', arg: 'float' } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: 'iconst_0' },
    { instruction: 'faload' },
    { instruction: 'pop' },
    { instruction: 'return' },
  ]);

  const result = runSplitTypedReusedLocals(ast, { preserveOriginalLocals: true });

  t.equal(result.rewrites, 2);
  t.deepEqual(opsAndArgs(ast), [
    'aload 0',
    'checkcast opa',
    'astore_2',
    'aload_2',
    'getfield Field,opa,opa_q,I',
    'pop',
    'iconst_3',
    'newarray float',
    'astore_3',
    'aload_3',
    'iconst_0',
    'faload',
    'pop',
    'return',
  ]);
  t.equal(ast.classes[0].items[0].method.attributes[0].code.localsSize, '4');
  t.end();
});

test('split-typed-reused-locals: infers array element type from reference array load', (t) => {
  const ast = astWith([
    { instruction: { op: 'aload', arg: '0' } },
    { instruction: { op: 'getfield', arg: ['Field', 'Demo', ['matrix', '[[F']] } },
    { instruction: 'iconst_0' },
    { instruction: 'aaload' },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: 'iconst_0' },
    { instruction: 'faload' },
    { instruction: 'pop' },
    { instruction: { op: 'aload', arg: '0' } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: { op: 'getfield', arg: ['Field', 'Demo', ['value', 'I']] } },
    { instruction: 'pop' },
    { instruction: 'return' },
  ]);

  const result = runSplitTypedReusedLocals(ast, { preserveOriginalLocals: true });

  t.equal(result.rewrites, 2);
  t.deepEqual(opsAndArgs(ast), [
    'aload 0',
    'getfield Field,Demo,matrix,[[F',
    'iconst_0',
    'aaload',
    'astore_2',
    'aload_2',
    'iconst_0',
    'faload',
    'pop',
    'aload 0',
    'astore_3',
    'aload_3',
    'getfield Field,Demo,value,I',
    'pop',
    'return',
  ]);
  t.equal(ast.classes[0].items[0].method.attributes[0].code.localsSize, '4');
  t.end();
});

test('split-typed-reused-locals: permits primitive reuse outside candidate range', (t) => {
  const ast = astWith([
    { instruction: 'iconst_0' },
    { instruction: { op: 'istore', arg: '1' } },
    { instruction: { op: 'aload', arg: '0' } },
    { instruction: { op: 'checkcast', arg: 'opa' } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: { op: 'getfield', arg: ['Field', 'opa', ['opa_q', 'I']] } },
    { instruction: 'pop' },
    { instruction: 'iconst_3' },
    { instruction: { op: 'newarray', arg: 'float' } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: 'iconst_0' },
    { instruction: 'faload' },
    { instruction: 'pop' },
    { instruction: 'return' },
  ]);

  const result = runSplitTypedReusedLocals(ast, { preserveOriginalLocals: true });

  t.equal(result.rewrites, 2);
  t.deepEqual(opsAndArgs(ast), [
    'iconst_0',
    'istore 1',
    'aload 0',
    'checkcast opa',
    'astore_2',
    'aload_2',
    'getfield Field,opa,opa_q,I',
    'pop',
    'iconst_3',
    'newarray float',
    'astore_3',
    'aload_3',
    'iconst_0',
    'faload',
    'pop',
    'return',
  ]);
  t.end();
});

test('split-typed-reused-locals: infers invoke argument type through later stack pushes', (t) => {
  const ast = astWith([
    { instruction: { op: 'aload', arg: '0' } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: { op: 'getfield', arg: ['Field', 'Demo', ['value', 'I']] } },
    { instruction: 'pop' },
    { instruction: 'iconst_3' },
    { instruction: { op: 'newarray', arg: 'float' } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: { op: 'iload', arg: '0' } },
    { instruction: { op: 'aload', arg: '0' } },
    { instruction: { op: 'getfield', arg: ['Field', 'Demo', ['values', '[I']] } },
    { instruction: 'iconst_0' },
    { instruction: 'iaload' },
    { instruction: { op: 'invokestatic', arg: ['Method', 'Helper', ['use', '([FII)V']] } },
    { instruction: 'return' },
  ]);

  const result = runSplitTypedReusedLocals(ast, { preserveOriginalLocals: true });

  t.equal(result.rewrites, 2);
  t.deepEqual(opsAndArgs(ast), [
    'aload 0',
    'astore_2',
    'aload_2',
    'getfield Field,Demo,value,I',
    'pop',
    'iconst_3',
    'newarray float',
    'astore_3',
    'aload_3',
    'iload 0',
    'aload 0',
    'getfield Field,Demo,values,[I',
    'iconst_0',
    'iaload',
    'invokestatic Method,Helper,use,([FII)V',
    'return',
  ]);
  t.end();
});

test('split-typed-reused-locals: infers value type from typed object array store', (t) => {
  const ast = astWith([
    { instruction: { op: 'new', arg: 'wfb' } },
    { instruction: 'dup' },
    { instruction: { op: 'invokespecial', arg: ['Method', 'wfb', ['<init>', '()V']] } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'getstatic', arg: ['Field', 'hab', ['hab_g', '[Lwfb;']] } },
    { instruction: 'iconst_0' },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: 'aastore' },
    { instruction: { op: 'aload', arg: '0' } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: { op: 'getfield', arg: ['Field', 'Demo', ['value', 'I']] } },
    { instruction: 'pop' },
    { instruction: 'return' },
  ]);

  const result = runSplitTypedReusedLocals(ast, { preserveOriginalLocals: true });

  t.equal(result.rewrites, 2);
  t.deepEqual(opsAndArgs(ast), [
    'new wfb',
    'dup',
    'invokespecial Method,wfb,<init>,()V',
    'astore_2',
    'getstatic Field,hab,hab_g,[Lwfb;',
    'iconst_0',
    'aload_2',
    'aastore',
    'aload 0',
    'astore_3',
    'aload_3',
    'getfield Field,Demo,value,I',
    'pop',
    'return',
  ]);
  t.end();
});

test('split-typed-reused-locals: treats arraylength as compatible with primitive arrays', (t) => {
  const ast = astWith([
    { instruction: { op: 'new', arg: 'wfb' } },
    { instruction: 'dup' },
    { instruction: { op: 'invokespecial', arg: ['Method', 'wfb', ['<init>', '()V']] } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'getstatic', arg: ['Field', 'hab', ['hab_g', '[Lwfb;']] } },
    { instruction: 'iconst_0' },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: 'aastore' },
    { instruction: 'iconst_4' },
    { instruction: { op: 'newarray', arg: 'int' } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: 'arraylength' },
    { instruction: 'pop' },
    { instruction: 'return' },
  ]);

  const result = runSplitTypedReusedLocals(ast, { preserveOriginalLocals: true });

  t.equal(result.rewrites, 2);
  t.deepEqual(opsAndArgs(ast), [
    'new wfb',
    'dup',
    'invokespecial Method,wfb,<init>,()V',
    'astore_2',
    'getstatic Field,hab,hab_g,[Lwfb;',
    'iconst_0',
    'aload_2',
    'aastore',
    'iconst_4',
    'newarray int',
    'astore_3',
    'aload_3',
    'arraylength',
    'pop',
    'return',
  ]);
  t.end();
});

test('split-typed-reused-locals: splits single-store primitive arrays', (t) => {
  const ast = astWith([
    { instruction: 'iconst_4' },
    { instruction: { op: 'newarray', arg: 'int' } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: 'arraylength' },
    { instruction: 'pop' },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: 'iconst_0' },
    { instruction: 'iconst_1' },
    { instruction: 'iastore' },
    { instruction: 'return' },
  ]);

  const result = runSplitTypedReusedLocals(ast, { preserveOriginalLocals: true });

  t.equal(result.rewrites, 1);
  t.deepEqual(opsAndArgs(ast), [
    'iconst_4',
    'newarray int',
    'astore_2',
    'aload_2',
    'arraylength',
    'pop',
    'aload_2',
    'iconst_0',
    'iconst_1',
    'iastore',
    'return',
  ]);
  t.end();
});
