'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {simplifyPredicateNegations: fold} = require('../src/decompiler/javaAstEmitter');
const mode = {booleanValueLogicalNegations: true, complementIntegralRelations: false, retainDiagnostics: true};

test('mixed short-circuit precedence remains explicit in control and value contexts', () => {
  for (const [expression, expected] of [
    ['!(a || b && c)', '(!(a) && (!(b) || !(c)))'],
    ['!(a && b || c)', '((!(a) || !(b)) && !(c))'],
    ['!((a || b) && c)', '((!(a) && !(b)) || !(c))'],
  ]) {
    assert.equal(fold('Object value=' + expression + ';', mode).source, 'Object value=' + expected + ';');
    assert.equal(fold('if(' + expression + '){work();}').source, 'if(' + expected + '){work();}');
  }
});

test('logical values preserve complete atoms, parentheses, order and primitive result', () => {
  const source = 'Object value=!(first()==second() && (saved=probe()) || floating<read());';
  const next = fold(source, mode);
  assert.equal(next.predicatesSimplified, 1);
  assert.equal(next.diagnostics.counts.deMorganOperators, 2);
  assert.ok(next.source.includes('first()!=second()'));
  assert.ok(next.source.includes('(!(saved=probe()))'));
  assert.ok(next.source.includes('!(floating<read())'));
  let replay = source;
  for (const e of next.diagnostics.tokenEdits.slice().reverse()) replay = replay.slice(0, e.start) + e.text + replay.slice(e.end);
  assert.equal(replay, next.source);
});

test('value mode is opt-in and refuses unrelated atoms and unsupported source', () => {
  const source = 'Object value=!(a&&b);';
  assert.equal(fold(source).source, source);
  for (const body of ['Object value=!(!boxed);', 'Object value=!(a&b);', 'Object value=!(a==b);',
    source + '// comment\n', source + 'Runnable callback=()->work();', source + 'class Nested{}']) {
    assert.equal(fold(body, mode).source, body);
  }
  assert.equal(fold(source, {...mode, booleanValueLogicalNegations: 1}).predicatesSimplified, 0);
  assert.equal(fold(source, {...mode, primitiveValueDoubleNegations: true}).predicatesSimplified, 0);
});

test('native values and mixed controls match independent branch oracles with nullable boxing and protected failures', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'logical-value-native-'));
  const run = (command, args) => {
    const files = ['out', 'err'].map(n => path.join(directory, n));
    const fds = files.map(f => fs.openSync(f, 'w'));
    try {
      const r = spawnSync(command, args, {stdio: ['ignore', ...fds]});
      if (r.error) throw r.error;
      assert.equal(r.status, 0, fs.readFileSync(files[1], 'utf8'));
      return fs.readFileSync(files[0], 'utf8').trim();
    } finally {fds.forEach(fd => fs.closeSync(fd));}
  };
  const predicates = [
    ['!(probe(a,0)||probe(b,1)&&probe(c,2))', 'boolean x=probe(a,0);if(!x){boolean y=probe(b,1);if(y)x=probe(c,2);else x=false;}boolean answer=!x;'],
    ['!(probe(a,0)&&probe(b,1)||probe(c,2))', 'boolean x=probe(a,0);if(x)x=probe(b,1);if(!x)x=probe(c,2);boolean answer=!x;'],
    ['!((probe(a,0)||probe(b,1))&&probe(c,2))', 'boolean x=probe(a,0);if(!x)x=probe(b,1);if(x)x=probe(c,2);boolean answer=!x;'],
    ['!(probe(a,0)||probe(b,1)&&!probe(c,2))', 'boolean x=probe(a,0);if(!x){boolean y=probe(b,1);if(y)x=!probe(c,2);else x=false;}boolean answer=!x;'],
    ['!(left==right&&probe(a,0)||floating<0.0f)', 'boolean x=left==right;if(x)x=probe(a,0);if(!x)x=floating<0.0f;boolean answer=!x;'],
    ['!(probe(a,0)&&(saved=probe(b,1))||probe(c,2))', 'boolean x=probe(a,0);if(x){saved=probe(b,1);x=saved;}if(!x)x=probe(c,2);boolean answer=!x;'],
  ];
  const wraps = [s => s, s => `try{${s}}finally{event(6);if(mode==1)return snapshot();if(mode==2)throw OVERRIDE;}`,
    s => `synchronized(lock){event(7);${s}}`,
    s => `try{${s}}catch(IllegalStateException error){event(8);if(error!=FAILURE)throw error;}finally{event(6);}`];
  try {
    let methods = '', models = 0;
    for (const [predicate, oracle] of predicates) for (const wrap of wraps) {
      const old = wrap(`Object result=choose(${predicate});canonical=result==Boolean.TRUE||result==Boolean.FALSE;selected=result==Boolean.TRUE;event(9);`) + 'return snapshot();';
      const next = fold(old, mode);assert.equal(next.predicatesSimplified, 1, old);
      const control = wrap(`boolean answer=false;if(${predicate})answer=true;Object result=choose(answer);canonical=result==Boolean.TRUE||result==Boolean.FALSE;selected=result==Boolean.TRUE;event(9);`) + 'return snapshot();';
      const recoveredControl = fold(control, {complementIntegralRelations: false});assert.equal(recoveredControl.predicatesSimplified, 1);
      const reference = wrap(oracle + 'Object result=choose(answer);canonical=result==Boolean.TRUE||result==Boolean.FALSE;selected=result==Boolean.TRUE;event(9);') + 'return snapshot();';
      for (const [name, body] of [['old', old], ['next', next.source], ['control', recoveredControl.source], ['oracle', reference]]) {
        methods += `static String ${name}${models}(Boolean a,Boolean b,Boolean c,Object left,Object right,float floating,int mode){${body}}\n`;
      }
      models++;
    }
    const java = `public class LogicalValueOracle{
      static int count,failAt;static boolean canonical,selected;static volatile Boolean saved;static Object lock;static StringBuilder trace;
      static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();
      static void event(int n){trace.append(n).append(Thread.holdsLock(lock)?"L":"U");if(count++==failAt)throw FAILURE;}
      static Boolean probe(Boolean value,int stage){event(stage);return value;}
      static Object choose(boolean value){event(4);return value?Boolean.TRUE:Boolean.FALSE;}
      static Object choose(Boolean value){event(5);return value;}
      static String snapshot(){return count+":"+canonical+":"+selected+":"+saved+":"+trace;}
      ${methods}
      static String take(int model,int variant,Boolean a,Boolean b,Boolean c,Object left,Object right,float floating,int mode,boolean nullLock){count=0;canonical=false;selected=false;saved=Boolean.FALSE;lock=nullLock?null:new Object();trace=new StringBuilder();String result;try{switch(model){${Array.from({length: models}, (_, i) => `case ${i}:result=variant==0?old${i}(a,b,c,left,right,floating,mode):variant==1?next${i}(a,b,c,left,right,floating,mode):variant==2?control${i}(a,b,c,left,right,floating,mode):oracle${i}(a,b,c,left,right,floating,mode);break;`).join('')}default:throw new AssertionError();}}catch(Throwable e){result=e==FAILURE?"failure":e==OVERRIDE?"override":e.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("lock leaked");return result+":"+snapshot();}
      public static void main(String[]args){int cases=0;Object first=new Object(),second=new Object();Object[][]refs={{first,first},{first,second},{null,null}};for(int model=0;model<${models};model++)for(Boolean a:new Boolean[]{false,true,null})for(Boolean b:new Boolean[]{false,true,null})for(Boolean c:new Boolean[]{false,true,null})for(Object[]ref:refs)for(float floating:new float[]{Float.NaN,-0.0f,0.0f,Float.NEGATIVE_INFINITY,Float.POSITIVE_INFINITY})for(failAt=-1;failAt<11;failAt++)for(int mode=0;mode<3;mode++)for(boolean nullLock:new boolean[]{false,true}){String expected=take(model,3,a,b,c,ref[0],ref[1],floating,mode,nullLock);for(int variant=0;variant<3;variant++)if(!take(model,variant,a,b,c,ref[0],ref[1],floating,mode,nullLock).equals(expected))throw new AssertionError(model+":"+variant+":"+a+":"+b+":"+c+":"+failAt+":"+mode);cases++;}System.out.println(cases);}}
    `;
    fs.writeFileSync(path.join(directory, 'LogicalValueOracle.java'), java);
    run('javac', ['--release', '8', '-d', directory, path.join(directory, 'LogicalValueOracle.java')]);
    assert.equal(run('java', ['-Xmx128m', '-cp', directory, 'LogicalValueOracle']), '699840');
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});
