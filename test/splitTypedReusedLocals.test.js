'use strict';

const test = require('tape');
const { runSplitTypedReusedLocals, splitCode } = require('../src/passes/splitTypedReusedLocals');

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

test('split-typed-reused-locals: preserves a seed that reaches a join around a conditional store', (t) => {
  const makeAst = () => astWith([
    { instruction: 'aconst_null' },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '0' } },
    { instruction: { op: 'getfield', arg: ['Field', 'Demo', ['name', 'Ljava/lang/String;']] } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: 'iconst_0' },
    { instruction: { op: 'ifeq', arg: 'LafterRank0' } },
    { instruction: { op: 'new', arg: 'java/lang/StringBuilder' } },
    { instruction: 'dup' },
    { instruction: { op: 'invokespecial', arg: ['Method', 'java/lang/StringBuilder', ['<init>', '()V']] } },
    { instruction: { op: 'ldc', arg: '<img=0>' } },
    { instruction: { op: 'invokevirtual', arg: ['Method', 'java/lang/StringBuilder', ['append', '(Ljava/lang/String;)Ljava/lang/StringBuilder;']] } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: { op: 'invokevirtual', arg: ['Method', 'java/lang/StringBuilder', ['append', '(Ljava/lang/String;)Ljava/lang/StringBuilder;']] } },
    { instruction: { op: 'invokevirtual', arg: ['Method', 'java/lang/StringBuilder', ['toString', '()Ljava/lang/String;']] } },
    { instruction: { op: 'astore', arg: '1' } },
    { labelDef: 'LafterRank0', instruction: { op: 'new', arg: 'java/lang/StringBuilder' } },
    { instruction: 'dup' },
    { instruction: { op: 'invokespecial', arg: ['Method', 'java/lang/StringBuilder', ['<init>', '()V']] } },
    { instruction: { op: 'ldc', arg: '<img=1>' } },
    { instruction: { op: 'invokevirtual', arg: ['Method', 'java/lang/StringBuilder', ['append', '(Ljava/lang/String;)Ljava/lang/StringBuilder;']] } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: { op: 'invokevirtual', arg: ['Method', 'java/lang/StringBuilder', ['append', '(Ljava/lang/String;)Ljava/lang/StringBuilder;']] } },
    { instruction: 'pop' },
    { instruction: 'return' },
  ]);
  const ast = makeAst();

  const result = runSplitTypedReusedLocals(ast, { preserveOriginalLocals: true });

  t.equal(result.rewrites, 1);
  t.deepEqual(opsAndArgs(ast).slice(2, 9), [
    'aload 0',
    'getfield Field,Demo,name,Ljava/lang/String;',
    'astore_2',
    'aload_2',
    'astore_1',
    'iconst_0',
    'ifeq LafterRank0',
  ]);
  t.equal(opsAndArgs(ast)[14], 'aload_2', 'typed branch load uses the fresh local');
  t.equal(opsAndArgs(ast)[23], 'aload 1', 'join load keeps the original local');

  const skippedAst = makeAst();
  const skipped = runSplitTypedReusedLocals(skippedAst, {
    preserveOriginalLocals: true,
    skipIfReachesUnrewrittenLoad: true,
  });
  t.equal(skipped.rewrites, 0, 'can reject a split whose seed still reaches an unrewritten join');
  t.equal(opsAndArgs(skippedAst)[4], 'astore 1', 'rejected split leaves the original seed intact');
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

test('split-typed-reused-locals: infers invokevirtual receiver type through later stack pushes', (t) => {
  const ast = astWith([
    { instruction: { op: 'aload', arg: '0' } },
    { instruction: { op: 'checkcast', arg: 'sg' } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: { op: 'bipush', arg: '-106' } },
    { instruction: { op: 'invokevirtual', arg: ['Method', 'sg', ['g', '(B)I']] } },
    { instruction: 'pop' },
    { instruction: 'aconst_null' },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: 'return' },
  ]);

  const result = runSplitTypedReusedLocals(ast, { preserveOriginalLocals: true });

  t.equal(result.rewrites, 1);
  t.deepEqual(opsAndArgs(ast), [
    'aload 0',
    'checkcast sg',
    'astore_2',
    'aload_2',
    'bipush -106',
    'invokevirtual Method,sg,g,(B)I',
    'pop',
    'aconst_null',
    'astore 1',
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

test('split-typed-reused-locals: infers primitive-array descriptors from reference array opcodes', (t) => {
  const ast = astWith([
    { instruction: 'iconst_2' },
    { instruction: { op: 'anewarray', arg: '[I' } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: 'iconst_0' },
    { instruction: 'aaload' },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: 'iconst_0' },
    { instruction: 'iaload' },
    { instruction: 'pop' },
    { instruction: 'iconst_3' },
    { instruction: 'iconst_4' },
    { instruction: { op: 'multianewarray', arg: ['[[I', '2'] } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: 'iconst_1' },
    { instruction: 'aaload' },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: 'iconst_0' },
    { instruction: 'iastore' },
    { instruction: 'return' },
  ]);

  const result = runSplitTypedReusedLocals(ast, { preserveOriginalLocals: true });

  t.equal(result.rewrites, 4);
  t.deepEqual(opsAndArgs(ast), [
    'iconst_2',
    'anewarray [I',
    'astore_2',
    'aload_2',
    'iconst_0',
    'aaload',
    'astore_3',
    'aload_3',
    'iconst_0',
    'iaload',
    'pop',
    'iconst_3',
    'iconst_4',
    'multianewarray [[I,2',
    'astore 4',
    'aload 4',
    'iconst_1',
    'aaload',
    'astore 5',
    'aload 5',
    'iconst_0',
    'iastore',
    'return',
  ]);
  t.end();
});

test('split-typed-reused-locals: keeps primitive-array candidates when object candidates exceed cap', (t) => {
  const items = [];
  for (let i = 0; i < 3; i += 1) {
    items.push(
      { instruction: { op: 'aload', arg: '0' } },
      { instruction: { op: 'astore', arg: '1' } },
      { instruction: { op: 'aload', arg: '1' } },
      { instruction: { op: 'getfield', arg: ['Field', 'Demo', ['value', 'I']] } },
      { instruction: 'pop' },
    );
  }
  items.push(
    { instruction: 'iconst_2' },
    { instruction: { op: 'anewarray', arg: '[I' } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: 'iconst_0' },
    { instruction: 'aaload' },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: 'iconst_0' },
    { instruction: 'iaload' },
    { instruction: 'pop' },
    { instruction: 'return' },
  );
  const ast = astWith(items);

  const result = runSplitTypedReusedLocals(ast, { preserveOriginalLocals: true, maxCandidates: 2 });

  t.equal(result.rewrites, 2);
  t.ok(opsAndArgs(ast).includes('anewarray [I'), 'keeps primitive array allocation');
  t.ok(opsAndArgs(ast).includes('iaload'), 'keeps primitive array use');
  t.end();
});

test('split-typed-reused-locals: keeps concrete reference-array candidates when object candidates exceed cap', (t) => {
  const code = {
    localsSize: '10',
    codeItems: [
      { instruction: { op: 'getfield', arg: ['Field', 'owner', ['objects', 'Ljava/lang/Object;']] } },
      { instruction: { op: 'astore', arg: '1' } },
      { instruction: { op: 'aload', arg: '1' } },
      { instruction: { op: 'getfield', arg: ['Field', 'foo', ['foo_i', 'I']] } },
      { instruction: 'pop' },
      { instruction: { op: 'getfield', arg: ['Field', 'owner', ['sgs', '[Lsg;']] } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: 'arraylength' },
      { instruction: 'pop' },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: 'iconst_0' },
      { instruction: 'aaload' },
      { instruction: 'pop' },
      { instruction: { op: 'getfield', arg: ['Field', 'owner', ['other', 'Ljava/lang/Object;']] } },
      { instruction: { op: 'astore', arg: '2' } },
    ],
    exceptionTable: [],
  };

  const rewrites = splitCode(code, { maxCandidates: 1 });
  t.equal(rewrites, 1);
  t.deepEqual(code.codeItems[6].instruction, { op: 'astore', arg: '10' });
  t.deepEqual(code.codeItems[7].instruction, { op: 'aload', arg: '10' });
  t.end();
});

test('split-typed-reused-locals: detects reference array loads with local indexes before primitive slot reuse', (t) => {
  const code = {
    localsSize: '4',
    codeItems: [
      { instruction: { op: 'getfield', arg: ['Field', 'owner', ['sgs', '[Lsg;']] } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'iload', arg: '3' } },
      { instruction: 'aaload' },
      { instruction: 'pop' },
      { instruction: 'iconst_0' },
      { instruction: { op: 'istore', arg: '2' } },
      { instruction: 'aconst_null' },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  const rewrites = splitCode(code, { preserveOriginalLocals: true });

  t.equal(rewrites, 1);
  t.deepEqual(code.codeItems[1].instruction, { op: 'astore', arg: '4' });
  t.deepEqual(code.codeItems[2].instruction, { op: 'aload', arg: '4' });
  t.deepEqual(code.codeItems[7].instruction, { op: 'istore', arg: '2' });
  t.end();
});

test('split-typed-reused-locals: can iterate when aliases expose later array splits', (t) => {
  const ast = astWith([
    { instruction: { op: 'aload', arg: '0' } },
    { instruction: { op: 'invokevirtual', arg: ['Method', 'grb', ['a', '(BII)[[I']] } },
    { instruction: { op: 'astore', arg: '1' } },
    { instruction: { op: 'aload', arg: '1' } },
    { instruction: { op: 'astore', arg: '2' } },
    { instruction: { op: 'aload', arg: '2' } },
    { instruction: 'iconst_2' },
    { instruction: 'aaload' },
    { instruction: { op: 'astore', arg: '3' } },
    { instruction: { op: 'aload', arg: '3' } },
    { instruction: 'iconst_0' },
    { instruction: 'iaload' },
    { instruction: 'pop' },
    { instruction: { op: 'aload', arg: '0' } },
    { instruction: { op: 'astore', arg: '3' } },
    { instruction: 'return' },
  ]);
  ast.classes[0].items[0].method.attributes[0].code.localsSize = '4';

  const result = runSplitTypedReusedLocals(ast, { preserveOriginalLocals: true, maxIterations: 2 });

  t.equal(result.rewrites, 4);
  t.ok(opsAndArgs(ast).includes('astore 7'), 'splits the int-array alias into a fresh local');
  t.ok(opsAndArgs(ast).includes('aload 7'), 'rewrites the typed int-array load');
  t.end();
});
