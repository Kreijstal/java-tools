'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {foldGuardedAssignmentSequences: fold} = require('../src/decompiler/javaAstEmitter');
const {shareExistingExitTails: finish} = require('../src/decompiler/cfr')._internals;
const frame = (yes = 'a=96;b=97;', no = 'b=96;a=97;', guard = 'flag==0', condition = 'probe()') =>
  `Frame:{if(${condition}){${yes}if(${guard}){break Frame;}}${no}}`;

test('the normal emitter reconstructs primitive sequences after scalar selection', () => {
  const source = 'int a=0,b=0;' + frame(), body = source.split('\n');
  finish(body, ['flag'], [{name: 'flag', type: 'int'}]);
  assert.equal(body.join('\n'), 'int a=0,b=0;if ((probe()) && (flag==0)) {a=96;b=97;} else {b=96;a=97;}');
});

test('paired local values use one original condition and one total keep guard', () => {
  const source = 'int a=0,b=0,flag=read();' + frame(), next = fold(source, {retainDiagnostics: true});
  assert.equal(next.sequencesFolded, 1); assert.equal(next.assignmentsSelected, 2);
  assert.equal(next.source, 'int a=0,b=0,flag=read();if ((probe()) && (flag==0)) {a=96;b=97;} else {b=96;a=97;}');
  assert.equal(next.source.split('probe()').length - 1, 1); assert.equal(next.source.split('flag==0').length - 1, 1);
  assert.equal(fold(next.source).sequencesFolded, 0);
});

test('dependent provisional calculations and independent fallback values retain their original order', () => {
  const source = 'int a=0,b=0,flag=read();' + frame('a=a+seed;b=a*31+seed;', 'b=seed*7;a=seed*13;');
  const next = fold(source, {parameters: [{name: 'seed', type: 'int'}]});
  assert.equal(next.sequencesFolded, 1); assert.ok(next.source.includes('{a=a+seed;b=a*31+seed;} else {b=seed*7;a=seed*13;}'));
  const formal = frame(); assert.equal(fold(formal, {parameters: ['a', 'b', 'flag'].map(name => ({name, type: 'int'}))}).sequencesFolded, 1);
});

test('primitive assignment conversions remain on the original statements', () => {
  for (const [type, yes, no] of [
    ['byte', 'a=127;b=-128;', 'b=126;a=-127;'], ['short', 'a=32767;b=-32768;', 'b=1;a=2;'],
    ['char', 'a=65535;b=0;', 'b=42;a=43;'], ['long', 'a=9007199254740993L;b=-9007199254740993L;', 'b=1L;a=2L;'],
    ['float', 'a=-0.0f;b=0x1.000002p0f;', 'b=1e20f;a=2e20f;'], ['double', 'a=1e300;b=-0.0d;', 'b=1d;a=2d;'],
    ['boolean', 'a=true;b=false;', 'b=true;a=false;'],
  ]) {
    const source = `${type} a,b;int flag=read();` + frame(yes, no), next = fold(source);
    assert.equal(next.sequencesFolded, 1, type); assert.ok(next.source.includes('{' + yes + '} else {' + no + '}'));
  }
});

test('statement positions, nested protection and lexical scopes remain', () => {
  for (const source of [
    'int a=0,b=0,flag=0;if(outer())' + frame() + 'else tail();',
    'int a=0,b=0,flag=0;Loop:while(run()){try{synchronized(lock){' + frame() + 'if(stop())continue Loop;}}finally{finish(a,b);}}',
  ]) {const next = fold(source); assert.equal(next.sequencesFolded, 1); assert.equal(fold(next.source).sequencesFolded, 0);}
  assert.equal(fold('{int a=0,b=0;}int flag=0;' + frame()).sequencesFolded, 0);
});

test('destination dependencies, effects, failures and incomplete overwrites refuse', () => {
  for (const [yes, no, guard] of [
    ['a=1;b=2;', 'b=3;a=4;', 'a==1'], ['a=1;b=2;', 'b=3;a=4;', 'b==2'],
    ['a=1;b=2;', 'b=a;a=4;', 'flag==0'], ['a=1;b=2;', 'b=3;a=b;', 'flag==0'],
    ['a=call();b=2;', 'b=3;a=4;', 'flag==0'], ['a=1;b=2;', 'b=call();a=4;', 'flag==0'],
    ['a=1/flag;b=2;', 'b=3;a=4;', 'flag==0'], ['a=1;b=2;', 'b=3;a=4%flag;', 'flag==0'],
    ['a=1;b=2;', 'b=3;a=4;', 'guard()'], ['a=1;b=2;', 'b=3;a=4;', 'boxed'],
    ['a=1;a=2;', 'b=3;a=4;', 'flag==0'], ['a=1;b=2;', 'a=3;a=4;', 'flag==0'],
    ['a=1;b=2;', 'b=3;', 'flag==0'], ['this.a=1;b=2;', 'b=3;this.a=4;', 'flag==0'],
    ['a=1;b=values[0];', 'b=3;a=4;', 'flag==0'],
  ]) {const source = 'int a=0,b=0,flag=0;Boolean boxed=null;' + frame(yes, no, guard); assert.equal(fold(source).source, source, source);}
  for (const source of ['Integer a=0,b=0;int flag=0;' + frame(), 'int a=0,b=0,flag=0;' + frame() + '{int a=0;}',
    'int a=0,b=0,flag=0;' + frame().replace('a=96;', 'a=96;hit();'),
    'int a=0,b=0,flag=0;' + frame().replace('a=96;', 'a=96;if(other())break Frame;')]) assert.equal(fold(source).source, source);
});

test('syntax, translated offsets, nested execution and region limits refuse', () => {
  const source = 'int a=0,b=0,flag=0;' + frame();
  for (const s of [source + ' //comment\n', source + '\\u000a', source + 'Object x=new Object(){};',
    source + 'Runnable r=()->hit();', source + 'if(', source + ' '.repeat(400001),
    'int a=0,b=0,flag=0;' + Array.from({length: 257}, (_, i) => frame().replaceAll('Frame', 'Frame' + i)).join('')]) assert.equal(fold(s).source, s);
  assert.equal(fold(source, {retainDiagnostics: 1}).source, source);
});

test('native sequences match independent value/completion models with condition failures and partial effects', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-sequence-native-'));
  const run = (command, args) => {const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 1024 * 1024}); assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout.trim();};
  const contexts = [body => body, body => `try{${body}}finally{trace.append('F');if(mode==1)return a+":"+b;if(mode==2)throw OVERRIDE;}`,
    body => `synchronized(lock){trace.append('L');${body}}`, body => `try{${body}}catch(IllegalStateException failure){trace.append('C');if(failure!=FAILURE)throw failure;}finally{trace.append('F');}`,
    body => `try{synchronized(lock){trace.append('L');${body}}}finally{trace.append('F');if(mode==1)return a+":"+b;if(mode==2)throw OVERRIDE;}`, body => `{${body}}`];
  const signature = 'int seed,int flag,Boolean boxed,int inject,int mode,Object lock', args = 'seed,flag,boxed,inject,mode,lock';
  const prefix = 'a=a+seed;b=a*31+seed;', fallback = 'b=seed*7;a=seed*13;', condition = '(a=probe(boxed,inject,seed))>0';
  const tail = "event(3);if(inject==3)throw FAILURE;";
  try {
    let methods = '';
    for (let i = 0; i < contexts.length; i++) {
      const old = 'int a=seed,b=seed^31;' + contexts[i](frame(prefix, fallback, 'flag==0', condition) + tail) + 'return a+":"+b;';
      const next = fold(old, {parameters: [{name: 'seed', type: 'int'}, {name: 'flag', type: 'int'}]}); assert.equal(next.sequencesFolded, 1);
      const oracle = 'int a=seed,b=seed^31;' + contexts[i]('int tested=probe(boxed,inject,seed);a=tested;boolean take=tested>0&&flag==0;if(take){a=(int)((long)tested+seed);b=(int)((long)a*31L+seed);}else{b=(int)((long)seed*7L);a=(int)((long)seed*13L);}' + tail) + 'return a+":"+b;';
      methods += `static String old${i}(${signature}){${old}}\nstatic String next${i}(${signature}){${next.source}}\nstatic String oracle${i}(${signature}){${oracle}}\n`;
    }
    const fixture = `public class GuardedSequenceNative {
static final RuntimeException FAILURE=new IllegalStateException("injected"),OVERRIDE=new IllegalStateException("finally");static int effects;static StringBuilder trace;
static void event(int stage){effects=effects*31+stage;trace.append((char)('a'+stage));}
static int probe(Boolean boxed,int inject,int seed){event(0);if(inject==1)throw FAILURE;boolean selected=boxed.booleanValue();event(1);if(inject==2)throw FAILURE;return selected?(seed+1):(-seed);}
${methods}
static String take(int kind,int variant,${signature}){effects=seed;trace=new StringBuilder();String result;try{switch(kind){${contexts.map((_, i) => `case ${i}:result=variant==0?old${i}(${args}):variant==1?next${i}(${args}):oracle${i}(${args});break;`).join('')}default:throw new AssertionError();}}catch(Throwable failure){result=failure==FAILURE?"failure":failure==OVERRIDE?"override":failure.getClass().getName();}if(lock!=null&&Thread.holdsLock(lock))throw new AssertionError("monitor leaked");return result+":"+effects+":"+trace;}
public static void main(String[] args){int cases=0;for(int kind=0;kind<6;kind++)for(int seed:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(int flag:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(Boolean boxed:new Boolean[]{false,true,null})for(int inject=0;inject<4;inject++)for(int mode=0;mode<3;mode++)for(Object lock:new Object[]{null,new Object()}){String want=take(kind,2,${args});for(int variant=0;variant<2;variant++){String got=take(kind,variant,${args});if(!want.equals(got))throw new AssertionError(kind+":"+variant+":"+seed+":"+flag+":"+boxed+":"+inject+":"+mode+"\\n"+want+"\\n"+got);}cases++;}System.out.println(cases+" independent cases / 6 contexts");}}
`;
    const file = path.join(temporary, 'GuardedSequenceNative.java'); fs.writeFileSync(file, fixture);
    run('javac', ['--release', '8', '-d', temporary, file]);
    assert.equal(run('java', ['-XX:-OmitStackTraceInFastThrow', '-Xmx128m', '-cp', temporary, 'GuardedSequenceNative']), '10800 independent cases / 6 contexts');
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});

test('native primitive sequences preserve conversions, long precision, NaNs and signed zero', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-sequence-types-'));
  const run = (command, args) => {const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 1024 * 1024}); assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout.trim();};
  const models = [
    ['byte', '127', '-128', '-127', '126', 'a+":"+b'],
    ['short', '32767', '-32768', '1', '2', 'a+":"+b'],
    ['char', '65535', '0', '42', '43', '(int)a+":"+(int)b'],
    ['long', '9007199254740993L', '-9007199254740993L', '2L', '1L', 'a+":"+b'],
    ['float', '-0.0f', '0x1.000002p0f', 'number', '-number', 'Float.floatToRawIntBits(a)+":"+Float.floatToRawIntBits(b)'],
    ['double', '1e300', '-0.0d', '2d', '1d', 'Double.doubleToRawLongBits(a)+":"+Double.doubleToRawLongBits(b)'],
    ['boolean', 'true', 'false', 'false', 'true', 'a+":"+b'],
  ];
  try {
    let methods = '';
    for (const [i, [type, a, b, x, y, show]] of models.entries()) {
      const old = `${type} a,b;` + frame(`a=${a};b=${b};`, `b=${y};a=${x};`, 'flag==0', 'selected') + `return ${show};`;
      const next = fold(old, {parameters: [{name: 'flag', type: 'int'}, {name: 'number', type: 'float'}]}); assert.equal(next.sequencesFolded, 1);
      const oracle = `${type} a,b;if(selected&&flag==0){a=${a};b=${b};}else{b=${y};a=${x};}return ${show};`;
      for (const [variant, source] of [['old', old], ['next', next.source], ['oracle', oracle]]) methods += `static String ${variant}${i}(boolean selected,int flag,float number){${source}}\n`;
    }
    const fixture = `public class GuardedSequenceTypes {${methods}public static void main(String[] args){int cases=0;for(boolean selected:new boolean[]{false,true})for(int flag:new int[]{-1,0,1})for(float number:new float[]{Float.NaN,Float.NEGATIVE_INFINITY,Float.POSITIVE_INFINITY,-0.0f,0.0f,-1.0f,1.0f}){${models.map((_, i) => `String want${i}=oracle${i}(selected,flag,number);if(!want${i}.equals(old${i}(selected,flag,number))||!want${i}.equals(next${i}(selected,flag,number)))throw new AssertionError("model ${i}");cases++;`).join('')}}System.out.println(cases+" typed cases / 7 models");}}`;
    const file = path.join(temporary, 'GuardedSequenceTypes.java'); fs.writeFileSync(file, fixture);
    run('javac', ['--release', '8', '-d', temporary, file]);
    assert.equal(run('java', ['-Xmx128m', '-cp', temporary, 'GuardedSequenceTypes']), '294 typed cases / 7 models');
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});
