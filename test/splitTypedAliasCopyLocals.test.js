'use strict';

const test = require('tape');
const { splitCode } = require('../src/passes/splitTypedAliasCopyLocals');
const { splitCode: splitConcrete } = require('../src/passes/splitConcreteObjectReachingLocal');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseJasminSource } = require('../src/utils/jasminAssembly');
const { writeClassAstToClassFile } = require('../src/parsing/classAstToClassFile');
const { decompileClassFile, assertNoFallback } = require('../src/decompiler/cfr');
const { getAST } = require('jvm_parser');
const { convertJson } = require('../src/parsing/convert_tree');

test('split-typed-alias-copy-locals: splits concrete alias copy before polluted reuse', (t) => {
  const code = {
    localsSize: '5',
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'Factory', ['make', '()LItem;']] } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'getfield', arg: ['Field', 'Item', ['bounds', '[I']] } },
      { instruction: 'pop' },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'Use', ['acceptBase', '(LBase;)V']] } },
      { instruction: { op: 'aload', arg: '0' } },
      { instruction: { op: 'getfield', arg: ['Field', 'Owner', ['crbs', '[LCrb;']] } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 1);
  t.equal(code.localsSize, '6');
  t.deepEqual(code.codeItems[1].instruction, { op: 'astore', arg: '5' });
  t.deepEqual(code.codeItems[2].instruction, { op: 'aload', arg: '5' });
  t.deepEqual(code.codeItems[3].instruction, { op: 'astore', arg: '5' });
  t.deepEqual(code.codeItems[4].instruction, { op: 'aload', arg: '5' });
  t.deepEqual(code.codeItems[7].instruction, { op: 'aload', arg: '5' });
  t.deepEqual(code.codeItems[11].instruction, { op: 'astore', arg: '2' });
  t.end();
});

test('split-typed-alias-copy-locals: skips unpolluted alias copies', (t) => {
  const code = {
    localsSize: '5',
    codeItems: [
      { instruction: { op: 'invokestatic', arg: ['Method', 'Factory', ['make', '()LItem;']] } },
      { instruction: { op: 'astore', arg: '4' } },
      { instruction: { op: 'aload', arg: '4' } },
      { instruction: { op: 'astore', arg: '2' } },
      { instruction: { op: 'aload', arg: '2' } },
      { instruction: { op: 'getfield', arg: ['Field', 'Item', ['bounds', '[I']] } },
      { instruction: 'pop' },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  t.equal(splitCode(code), 0);
  t.equal(code.localsSize, '5');
  t.end();
});

function instruction(op, arg) {
  return { instruction: arg === undefined ? op : { op, arg } };
}

for (const variant of ['conditional overwrite', 'lookup overwrite', 'table overwrite', 'handler before overwrite']) {
  test(`alias splitting refuses an incomplete lifetime: ${variant}`, (t) => {
    const make = instruction('invokestatic', ['Method', 'Factory', ['make', '()LItem;']]);
    const use = slot => [instruction('aload', slot),
      instruction('getfield', ['Field', 'Item', ['bounds', '[I']]), instruction('pop')];
    const code = { localsSize: '5', exceptionTable: [], codeItems: [
      { ...make, labelDef: 'Lstart:' }, instruction('astore', '4'),
      instruction('aload', '4'), instruction('astore', '2'),
    ] };
    if (variant !== 'handler before overwrite') {
      const branch = variant === 'lookup overwrite'
        ? instruction('lookupswitch', { defaultLabel: 'Ljoin', pairs: [[0, 'Lwrite']] })
        : variant === 'table overwrite'
          ? { instruction: { op: 'tableswitch', low: '0', labels: ['Lwrite'], defaultLbl: 'Ljoin' } }
          : instruction('ifne', 'Ljoin');
      code.codeItems.push(instruction('iload_0'), branch, { ...make, labelDef: 'Lwrite:' },
        instruction('astore', '2'), { ...use('2')[0], labelDef: 'Ljoin:' }, ...use('2').slice(1));
    } else {
      code.codeItems.push(instruction('invokestatic', ['Method', 'Effects', ['mayThrow', '()V']]),
        instruction('aconst_null'), instruction('astore', '4'), ...use('2'));
      code.exceptionTable.push({ startLbl: 'Lstart', endLbl: 'Lend', handlerLbl: 'Lcatch',
        catchType: 'java/lang/RuntimeException' });
    }
    code.codeItems.push(instruction('iconst_0'), instruction('anewarray', 'Item'), instruction('astore', '2'),
      { labelDef: 'Lend:', instruction: 'return' });
    if (variant === 'handler before overwrite') {
      code.codeItems.push({ labelDef: 'Lcatch:', instruction: 'astore_3' }, ...use('4'), instruction('return'));
    }
    const before = JSON.stringify(code);
    t.equal(splitCode(code), 0, 'all normal and exceptional uses must move with their definition');
    t.equal(JSON.stringify(code), before, 'refusal is atomic');
    t.end();
  });
}

for (const kind of ['lookupswitch', 'tableswitch']) {
  test(`alias splitting preserves complete ${kind} lifetimes`, (t) => {
    const branch = kind === 'lookupswitch'
      ? instruction(kind, { defaultLabel: 'Lsecond', pairs: [[0, 'Lfirst']] })
      : { instruction: { op: kind, low: '0', labels: ['Lfirst'], defaultLbl: 'Lsecond' } };
    const use = label => [{ labelDef: `${label}:`, instruction: { op: 'aload', arg: '2' } },
      instruction('getfield', ['Field', 'Item', ['bounds', '[I']]), instruction('pop')];
    const code = { localsSize: '5', exceptionTable: [], codeItems: [
      instruction('invokestatic', ['Method', 'Factory', ['make', '()LItem;']]),
      instruction('astore', '4'), instruction('aload', '4'), instruction('astore', '2'),
      instruction('iload_0'), branch, ...use('Lfirst'), instruction('goto', 'Lexit'), ...use('Lsecond'),
      { labelDef: 'Lexit:', instruction: 'iconst_0' }, instruction('anewarray', 'Item'),
      instruction('astore', '2'), instruction('return'),
    ] };
    t.equal(splitCode(code), 1, 'a closed branched lifetime can still be split');
    t.equal(code.localsSize, '6');
    t.deepEqual(code.codeItems[6].instruction, { op: 'aload', arg: '5' });
    t.deepEqual(code.codeItems[10].instruction, { op: 'aload', arg: '5' });
    t.end();
  });
}

function run(command, args, directory) {
  const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, JAVA_TOOL_OPTIONS: '-XX:-UsePerfData' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
  return result.stdout;
}

test('alias splitting after concrete splitting preserves a protected cursor backedge', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-alias-backedge-'));
  try {
    const assembly = `.version 49 0
.class public super CursorLoop
.super java/lang/Object
.method public static reset : (I)I
.code stack 2 locals 2
.catch java/lang/RuntimeException from Lstart to Ldone using Lhandler
Lstart: iload_0
 invokestatic Method CursorEffects first (I)Ljava/lang/Object;
 checkcast Item
 astore_1
Ltop: aload_1
 ifnull Ldone
 aload_1
 iconst_0
 putfield Field Item x I
 aload_1
 iconst_0
 putfield Field Item y I
 invokestatic Method CursorEffects next ()Ljava/lang/Object;
 checkcast Item
 astore_1
 goto Ltop
Ldone: invokestatic Method CursorEffects finish ()I
 ireturn
Lhandler: astore_1
 aload_1
 invokestatic Method CursorEffects caught (Ljava/lang/Throwable;)I
 ireturn
.end code
.end method
.end class`;
    const helpers = `class Item {int x=7,y=11; Item next;}
class CursorEffects {
 static Item head,cursor; static int calls,failure; static String trace;
 static Object first(int count) {
   trace="";calls=0;head=null;
   for(int i=0;i<count;i++){Item n=new Item();n.next=head;head=n;}
   cursor=head; if(failure==0)throw new IllegalArgumentException(); return head;
 }
 static Object next() {
   if(++calls>20)throw new IllegalStateException("stalled cursor");
   trace+=cursor.x+","+cursor.y+";";
   if(calls==failure)throw new IllegalArgumentException();
   cursor=cursor.next;return cursor;
 }
 static int finish(){return calls;}
 static int caught(Throwable error){trace+=error.getClass().getSimpleName();return -calls-1;}
 static String snapshot(){String s="";for(Item n=head;n!=null;n=n.next)s+=n.x+","+n.y+";";return s;}
}
class Runner {public static void main(String[] args){
 for(int count:new int[]{0,1,2,5,9})for(int failure:new int[]{-1,0,1,2,5,10}){
   CursorEffects.failure=failure;int result=CursorLoop.reset(count);
   System.out.println(count+":"+failure+":"+result+":"+CursorEffects.trace+":"+CursorEffects.snapshot());
 }
}}`;
    let expected;
    for (const variant of ['original', 'concrete', 'alias']) {
      const output = path.join(directory, variant); fs.mkdirSync(output);
      const file = path.join(output, 'CursorLoop.class');
      writeClassAstToClassFile(parseJasminSource(assembly), file);
      const parsed = getAST(new Uint8Array(fs.readFileSync(file)));
      const ast = convertJson(parsed.ast, parsed.constantPool);
      const code = ast.classes[0].items.find(item => item.method).method.attributes.find(attr => attr.code).code;
      if (variant !== 'original') {
        t.equal(splitConcrete(code, { requireDominance: true, preserveOriginalLocals: true }), 2,
          `${variant}: both cursor stores move together`);
        if (variant === 'alias') {
          const before = JSON.stringify(code);
          t.equal(splitCode(code), 0, 'refuses to detach the update from earlier loop loads');
          t.equal(JSON.stringify(code), before, 'a refused proof leaves the method unchanged');
        }
      }
      writeClassAstToClassFile(ast, file);
      fs.writeFileSync(path.join(output, 'Runner.java'), helpers);
      run('javac', ['--release', '8', '-cp', output, '-d', output, path.join(output, 'Runner.java')], output);
      const actual = run('java', ['-Xverify:all', '-cp', output, 'Runner'], output);
      if (variant === 'original') {
        expected = actual;
        t.equal(actual.trim().split('\n').length, 30);
        t.notOk(actual.includes('IllegalStateException'), 'the oracle terminates without the stall guard');
      } else t.equal(actual, expected, `${variant}: node identity, mutations, iteration and exceptions agree`);
      if (variant === 'alias') {
        const source = decompileClassFile(file, { preserveFieldNames: new Set(['x', 'y']) }); assertNoFallback(source);
        fs.writeFileSync(path.join(output, 'CursorLoop.java'), source);
        run('javac', ['--release', '8', '-cp', output, '-d', output, path.join(output, 'CursorLoop.java')], output);
        t.equal(run('java', ['-Xverify:all', '-cp', output, 'Runner'], output), expected,
          'rebuilt readable Java agrees with original bytecode');
      }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  t.end();
});
