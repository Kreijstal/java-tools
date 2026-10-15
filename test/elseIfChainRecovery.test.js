'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {flattenElseIfChains: flatten} = require('../src/decompiler/javaAstEmitter');
const {shareExistingExitTails: recover} = require('../src/decompiler/cfr')._internals;
const finish = source => {const body = [source]; recover(body); return body.join('\n');};

test('ordered chains flatten both branch directions without copying predicates or leaf bodies', () => {
  const source = 'before();if(a){one();}else{if(b){if(c){three();}else{two();}}else{four();}}after();';
  const next = flatten(source, {retainDiagnostics: true});
  assert.equal(next.source, 'before();if ((a)) {one();} else if (!(b)) {four();} else if ((c)) {three();} else {two();}after();');
  assert.equal(next.blocksRemoved, 2);
  assert.equal(next.decisionsRotated, 1);
  assert.equal(flatten(next.source).source, next.source);
  const {edits} = next.diagnostics;
  assert.equal(edits.length, 1);
  const edit = edits[0];
  assert.equal(next.source, source.slice(0, edit.start)
    + edit.segments.map(s => s.text ?? source.slice(s.range.start, s.range.end)).join('') + source.slice(edit.end));
  assert.ok(!Object.hasOwn(flatten(source), 'diagnostics'));
  for (const name of ['a', 'b', 'c', 'one', 'two', 'three', 'four'])
    assert.equal(next.source.match(new RegExp('\\b' + name + '\\b', 'g')).length, 1);
});

test('normal emission automatically flattens inverted branches and retains NaN-safe negation', () => {
  const next = finish('if(first!=3){if(second){work();}else{other();}}else{last();}');
  assert.ok(next.includes('else if'), next);
  assert.match(next, /first\s*==\s*3/);
  assert.ok(!/else\s*{\s*if\b/.test(next), next);
  const floating = finish('if(number<0.0f){if(second){work();}else{other();}}else{last();}');
  assert.ok(floating.includes('!(number<0.0f)'), floating);
  assert.ok(!floating.includes('number>=0.0f'), floating);
});

test('actions, bindings, missing braces, dangling else hazards and unsupported syntax stay intact', () => {
  for (const source of [
    'if(a){work();}else{event();if(b){one();}else{two();}}',
    'if(a){work();}else{int value=read();if(b){one(value);}else{two();}}',
    'if(a){if(b){one();}else{two();}}',
    'if(a)work();else{if(b){one();}else{two();}}',
    'if(parent)if(a){work();}else{if(b){one();}else{two();}}else{last();}',
    'if(parent)while(run())if(a){work();}else{if(b){one();}}else{last();}',
    'if(a){work();}else{/* keep */if(b){one();}else{two();}}',
    'if(a){work();}else{if(b){Runnable r=()->work();}else{two();}}',
    'if(a){work();}else{if(b){Object x=new Object(){void f(){}};}else{two();}}',
    'if(a){work();}else{if(b){\\u0061();}else{two();}}',
  ]) assert.equal(flatten(source).source, source, source);
  const long = 'if(a){work();}else{'.repeat(33) + 'last();' + '}'.repeat(33);
  assert.equal(flatten(long).source, long);
});

test('intact leaf scopes, labels, monitors, catches and finally clauses retain their boundaries', () => {
  const source = 'Outer:while(run()){if(a){int value=1;use(value);}else{if(b){try{synchronized(lock){int value=2;use(value);break Outer;}}catch(Failure error){throw error;}finally{cleanup();}}else{continue;}}}';
  const next = flatten(source);
  assert.equal(next.blocksRemoved, 1);
  assert.ok(next.source.includes('{int value=1;use(value);}'));
  assert.ok(next.source.includes('{try{synchronized(lock){int value=2;use(value);break Outer;}}catch(Failure error){throw error;}finally{cleanup();}}'));
  assert.ok(next.source.endsWith('else {continue;}}'));
  const many = flatten('if(a){x();}else{if(b){y();}}if(c){x();}else{if(d){y();}}');
  assert.equal(many.blocksRemoved, 2);
});

test('native branches match an independent sequential oracle for effects, identity and abrupt completion', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'else-if-native-'));
  function run(command, args) {
    const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 1024 * 1024});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  const conditions = ['probe(a,0)', 'probe(b,1) && floating<0.0f', '(saved=probe(c,2)) && left==right'];
  const leaf = id => `{int value=counter;event(${id + 4});return value*31+${id};}`;
  const contexts = [s => s,
    s => `try{${s}}finally{event(9);if(mode==1)return -7;if(mode==2)throw OVERRIDE;}`,
    s => `synchronized(lock){${s}}`,
    s => `try{synchronized(lock){${s}}}catch(IllegalStateException error){event(8);if(error!=FAILURE)throw error;return -8;}finally{event(9);if(mode==2)throw OVERRIDE;}`];
  try {
    let methods = '', models = 0;
    for (let mask = 0; mask < 8; mask++) for (const protect of contexts) {
      let tree = leaf(3), oracle = '';
      for (let i = 2; i >= 0; i--) {
        const nested = '{' + tree + '}', forward = !!(mask & (1 << i));
        tree = `if(${conditions[i]})${forward ? nested : leaf(i)}else${forward ? leaf(i) : nested}`;
      }
      for (let i = 0; i < 3; i++) oracle += `if((${conditions[i]}) != ${!!(mask & (1 << i))})${leaf(i)}`;
      oracle += leaf(3);
      const original = 'Boolean saved=null;' + protect(tree);
      const transformed = flatten(original);
      assert.equal(transformed.blocksRemoved, 2);
      assert.equal(flatten(transformed.source).source, transformed.source);
      for (const [name, body] of [['old', original], ['next', transformed.source], ['full', finish(original)],
        ['oracle', 'Boolean saved=null;' + protect(oracle)]])
        methods += `static int ${name}${models}(Boolean a,Boolean b,Boolean c,float floating,Object left,Object right,int mode){${body}}\n`;
      models++;
    }
    const java = `public class ElseIfNative {
static int counter,failAt;static StringBuilder trace;static Object lock;
static final RuntimeException FAILURE=new IllegalStateException(),OVERRIDE=new IllegalStateException();
static void event(int id){trace.append(id).append(lock!=null&&Thread.holdsLock(lock)?"L":"U");if(counter++==failAt)throw FAILURE;}
static Boolean probe(Boolean value,int id){event(id);return value;}
${methods}
static String take(int model,int variant,Boolean a,Boolean b,Boolean c,float f,Object left,Object right,int mode,int inject,boolean nullLock){counter=0;failAt=inject;trace=new StringBuilder();lock=nullLock?null:new Object();String result;try{int value;switch(model){
${Array.from({length: models}, (_, i) => `case ${i}:value=variant==0?old${i}(a,b,c,f,left,right,mode):variant==1?next${i}(a,b,c,f,left,right,mode):variant==2?full${i}(a,b,c,f,left,right,mode):oracle${i}(a,b,c,f,left,right,mode);break;`).join('\n')}
default:throw new AssertionError();}result="value:"+value;}catch(Throwable error){result=error==FAILURE?"failure":error==OVERRIDE?"override":error.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+counter+":"+trace;}
public static void main(String[]args){int cases=0;Object x=new Object(),y=new Object();for(int model=0;model<${models};model++)for(Boolean a:new Boolean[]{false,true,null})for(Boolean b:new Boolean[]{false,true,null})for(Boolean c:new Boolean[]{false,true,null})for(float f:new float[]{Float.NaN,-0.0f,0.0f,Float.NEGATIVE_INFINITY,Float.POSITIVE_INFINITY})for(Object[]refs:new Object[][]{{x,x},{x,y},{null,null}})for(int mode=0;mode<3;mode++)for(int inject=0;inject<9;inject++)for(boolean nullLock:new boolean[]{false,true}){String expected=take(model,3,a,b,c,f,refs[0],refs[1],mode,inject,nullLock);for(int variant=0;variant<3;variant++)if(!take(model,variant,a,b,c,f,refs[0],refs[1],mode,inject,nullLock).equals(expected))throw new AssertionError(model+":"+variant+":"+inject);cases++;}System.out.println(cases+" cases, ${models} models");}}
`;
    fs.writeFileSync(path.join(directory, 'ElseIfNative.java'), java);
    run('javac', ['-d', directory, path.join(directory, 'ElseIfNative.java')]);
    assert.equal(run('java', ['-Xmx128m', '-cp', directory, 'ElseIfNative']), '699840 cases, 32 models');
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});
